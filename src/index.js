const REQUIRED_SECRETS = ['GEMINI_API_KEY', 'GITHUB_TOKEN', 'WORKER_PIN', 'AUTH_TOKEN_SECRET'];

const COOKIE_NAME = 'fuku_session';
const TOKEN_TTL_SECONDS = 7 * 24 * 60 * 60; // 7日（design.md 5章）
const FETCH_TIMEOUT_MS = 10000;

const MAX_MESSAGE_LENGTH = 2000;
const MAX_HISTORY_ITEMS = 40;
const MAX_HISTORY_ITEM_LENGTH = 2000;
const CHAT_BODY_MAX_BYTES = 50 * 1024;
const AUTH_BODY_MAX_BYTES = 256;

const KNOWLEDGE_FILES = {
  家族情報: 'knowledge/family.md',
  契約情報: 'knowledge/contract.md',
  家計情報: 'knowledge/finance.csv',
  ふくちゃんプロンプト: 'prompt/fukuchan.md',
};

export default {
  async fetch(request, env, ctx) {
    const missing = REQUIRED_SECRETS.filter((key) => !env[key]);
    if (missing.length > 0) {
      console.error('missing_secrets', missing.length);
      return jsonResponse({ error: 'server not configured' }, 503);
    }

    const url = new URL(request.url);

    if (url.pathname === '/health' && request.method === 'GET') {
      return jsonResponse({ status: 'ok', message: 'ふくちゃんトーク稼働中🦉' });
    }

    if (url.pathname === '/auth' && request.method === 'POST') {
      return handleAuth(request, env);
    }

    if (url.pathname === '/chat' && request.method === 'POST') {
      return handleChat(request, env);
    }

    // run_worker_first は /auth・/chat・/health のみを対象にしているため、
    // 通常はここに到達しない。念のためのフォールバック。
    if (env.ASSETS) {
      return env.ASSETS.fetch(request);
    }
    return new Response('Not found', { status: 404 });
  },
};

/* ===== /auth ===== */

async function handleAuth(request, env) {
  const rl = await env.AUTH_RATE_LIMITER.limit({ key: clientIp(request) });
  if (!rl.success) {
    return jsonResponse({ error: 'rate limited' }, 429);
  }

  const body = await readJsonWithLimit(request, AUTH_BODY_MAX_BYTES);
  if (body === null || typeof body.pin !== 'string') {
    return jsonResponse({ error: 'invalid request' }, 413);
  }

  if (!timingSafeStringEqual(body.pin, env.WORKER_PIN)) {
    return jsonResponse({ error: 'unauthorized' }, 401);
  }

  const token = await createToken(env.AUTH_TOKEN_SECRET, TOKEN_TTL_SECONDS);
  const headers = new Headers({ 'Content-Type': 'application/json' });
  headers.append(
    'Set-Cookie',
    `${COOKIE_NAME}=${token}; HttpOnly; Secure; SameSite=Strict; Max-Age=${TOKEN_TTL_SECONDS}; Path=/`
  );
  return new Response(JSON.stringify({ ok: true }), { status: 200, headers });
}

/* ===== /chat ===== */

async function handleChat(request, env) {
  const token = getCookie(request, COOKIE_NAME);
  const authorized = await verifyToken(env.AUTH_TOKEN_SECRET, token);
  if (!authorized) {
    return jsonResponse({ error: 'unauthorized' }, 401);
  }

  const rl = await env.CHAT_RATE_LIMITER.limit({ key: clientIp(request) });
  if (!rl.success) {
    return jsonResponse({ error: 'rate limited' }, 429);
  }

  const body = await readJsonWithLimit(request, CHAT_BODY_MAX_BYTES);
  if (body === null) {
    return jsonResponse({ error: 'payload too large or invalid' }, 413);
  }

  const validationError = validateChatBody(body);
  if (validationError) {
    return jsonResponse({ error: validationError }, 413);
  }

  const { message, history } = body;

  let promptText;
  let knowledgeText;
  try {
    [promptText, knowledgeText] = await loadAllKnowledge(env);
  } catch (e) {
    console.error('knowledge_fetch_error', e.name === 'TimeoutError' ? 'timeout' : 'failed');
    return jsonResponse({ error: 'knowledge unavailable' }, statusForUpstreamError(e));
  }

  const systemPrompt = `${promptText}

---

## あなたが持っている情報（ナレッジ）
以下の情報をもとに答えてください。
情報がない質問には、ふくちゃんキャラとして雑談で返してください。

${knowledgeText}
`;

  const contents = history.map((item) => ({ role: item.role, parts: [{ text: item.content }] }));
  contents.push({ role: 'user', parts: [{ text: message }] });

  let reply;
  try {
    reply = await callGemini(env, systemPrompt, contents);
  } catch (e) {
    console.error('gemini_error', e.name === 'TimeoutError' ? 'timeout' : e.message);
    return jsonResponse({ error: 'gemini call failed' }, statusForUpstreamError(e));
  }

  return jsonResponse({ reply });
}

// design.md 6-3：タイムアウトは504、それ以外の上流異常（4xx/5xx・candidates 0件）は502に統一する
export function statusForUpstreamError(e) {
  return e && e.name === 'TimeoutError' ? 504 : 502;
}

export function validateChatBody(body) {
  if (typeof body.message !== 'string' || body.message.length === 0) {
    return 'message is required';
  }
  if (body.message.length > MAX_MESSAGE_LENGTH) {
    return 'message too long';
  }
  if (!Array.isArray(body.history)) {
    return 'history must be an array';
  }
  if (body.history.length > MAX_HISTORY_ITEMS) {
    return 'history too long';
  }
  for (const item of body.history) {
    if (!item || (item.role !== 'user' && item.role !== 'model')) {
      return 'invalid history role';
    }
    if (typeof item.content !== 'string' || item.content.length > MAX_HISTORY_ITEM_LENGTH) {
      return 'invalid history content';
    }
  }
  return null;
}

/* ===== ナレッジ取得（GitHub Contents API、fail-closed） ===== */

async function fetchGithubFile(env, path) {
  const url = `https://api.github.com/repos/${env.GITHUB_REPO}/contents/${path}`;
  const res = await fetchWithTimeout(
    url,
    {
      headers: {
        Authorization: `token ${env.GITHUB_TOKEN}`,
        Accept: 'application/vnd.github.v3.raw',
        'User-Agent': 'fukuchan-app-worker',
      },
    },
    FETCH_TIMEOUT_MS
  );
  if (!res.ok) {
    throw new Error(`github_fetch_failed:${res.status}`);
  }
  return res.text();
}

async function loadAllKnowledge(env) {
  let promptText = '';
  let knowledgeText = '';
  for (const [label, path] of Object.entries(KNOWLEDGE_FILES)) {
    const content = await fetchGithubFile(env, path);
    if (label === 'ふくちゃんプロンプト') {
      promptText = content;
    } else {
      knowledgeText += `\n\n## ${label}\n${content}`;
    }
  }
  return [promptText, knowledgeText];
}

/* ===== Gemini API（REST直接呼び出し） ===== */

async function callGemini(env, systemPrompt, contents) {
  const url = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent';
  const payload = {
    system_instruction: { parts: [{ text: systemPrompt }] },
    contents,
  };

  const res = await fetchWithTimeout(
    url,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-goog-api-key': env.GEMINI_API_KEY,
      },
      body: JSON.stringify(payload),
    },
    FETCH_TIMEOUT_MS
  );

  if (!res.ok) {
    throw new Error(`gemini_failed:${res.status}`);
  }

  const data = await res.json();
  const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
  if (typeof text !== 'string') {
    throw new Error('no_candidates');
  }
  return text;
}

/* ===== 認証トークン（HMAC-SHA256署名、KVを使わない自己完結型） ===== */

async function hmacKey(secret) {
  return crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
}

export async function createToken(secret, ttlSeconds) {
  const expiry = Math.floor(Date.now() / 1000) + ttlSeconds;
  const key = await hmacKey(secret);
  const sigBuf = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(String(expiry)));
  return `${expiry}.${base64url(new Uint8Array(sigBuf))}`;
}

export async function verifyToken(secret, token) {
  if (!token) return false;
  const parts = token.split('.');
  if (parts.length !== 2) return false;
  const [expiryStr, sig] = parts;
  const expiry = Number(expiryStr);
  if (!Number.isFinite(expiry) || expiry < Math.floor(Date.now() / 1000)) return false;

  const key = await hmacKey(secret);
  const expectedBuf = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(expiryStr));
  const expectedSig = base64url(new Uint8Array(expectedBuf));
  return timingSafeStringEqual(sig, expectedSig);
}

function base64url(bytes) {
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function timingSafeStringEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let result = 0;
  for (let i = 0; i < a.length; i++) {
    result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return result === 0;
}

/* ===== ユーティリティ ===== */

function jsonResponse(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function clientIp(request) {
  return request.headers.get('CF-Connecting-IP') || 'unknown';
}

function getCookie(request, name) {
  const header = request.headers.get('Cookie') || '';
  const match = header.match(new RegExp('(?:^|;\\s*)' + name + '=([^;]*)'));
  return match ? decodeURIComponent(match[1]) : null;
}

async function fetchWithTimeout(url, options, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } catch (e) {
    if (e.name === 'AbortError') {
      const timeoutError = new Error('timeout');
      timeoutError.name = 'TimeoutError';
      throw timeoutError;
    }
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

// Content-Lengthヘッダーは欠落・偽装が可能なため信用せず、
// 実際に読み込んだバイト数を積算して上限を判定する（design.md 6-1）
async function readJsonWithLimit(request, maxBytes) {
  if (!request.body) return null;

  const reader = request.body.getReader();
  const chunks = [];
  let total = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }

  const buf = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    buf.set(chunk, offset);
    offset += chunk.byteLength;
  }

  try {
    return JSON.parse(new TextDecoder('utf-8').decode(buf));
  } catch (e) {
    return null;
  }
}

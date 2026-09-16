import {
  FINANCE_TOOL_DECLARATIONS,
  parseFinanceToolCall,
} from '../workers/finance-mcp/src/contracts.js';

const REQUIRED_SECRETS = ['GEMINI_API_KEY', 'GITHUB_TOKEN', 'WORKER_PIN', 'AUTH_TOKEN_SECRET'];

const COOKIE_NAME = 'fuku_session';
const TOKEN_TTL_SECONDS = 7 * 24 * 60 * 60; // 7日（design.md 5章）
const FETCH_TIMEOUT_MS = 10000;
const FINANCE_TOOL_MAX_ROUNDS = 2;
const FINANCE_TOOL_MAX_CALLS_PER_ROUND = 5;
const FINANCE_SYNTHESIS_INSTRUCTION = `

## functionResponse後の最終回答ルール（厳格）
直前のfunctionResponseに含まれるresultを、家計に関する唯一の根拠として使ってください。
ナレッジ本文・過去の会話・モデル自身の知識にある別の金額や期間は無視し、resultにない金額を推測・補完しないでください。
resultにcategoryがある場合は、そのカテゴリのbase_yen・compare_yen・delta_yen・change_rateを優先して説明してください。
resultにエラーがある場合だけ、値を作らず取得できない理由を簡潔に伝えてください。
日本語でふくちゃんらしく、結論を先に短く答えてください。
単一の金額を答えるときは、項目名と主要な金額をMarkdownの太字（例：**食費**は**142,665円**だったよ。）にしてください。
複数の内訳や比較項目があるときだけMarkdownの箇条書きを使ってください。
「ふくのノートによると」「情報は新しいよ」などの定型句、取得日時の長い説明、括弧付きのメタ情報は通常の回答に入れないでください。
result.metaは内部判断に使ってください。freshならasOfやfreshnessを表示せず、stale/expiredのときだけ短い注意を添えてください。利用者が更新日時や鮮度を尋ねた場合はその質問に必要な範囲で答えてください。
`;

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

  const financeMode = resolveFinanceMode(env);
  if (financeMode === 'misconfigured') {
    return jsonResponse({ error: 'finance unavailable' }, 503);
  }

  let promptText;
  let knowledgeText;
  try {
    [promptText, knowledgeText] = await loadAllKnowledge(env, {
      includeFinance: financeMode !== 'enabled',
    });
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

  const financeInstruction = financeMode === 'enabled'
    ? `

## 家計ツール利用ルール
家計に関する金額・比較・資産の質問では、必ず提供されたfinance toolを使ってください。
ツール結果にない金額を推測・補完しないでください。meta.asOfとmeta.freshnessは回答の鮮度判断に使い、通常のfresh回答へ機械的に追記しないでください。
ツールがエラーを返した場合は、家計の値を推測せず、取得できない理由を簡潔に伝えてください。
「今月の食費は先月に比べてどう？」のような質問では、compare_monthsを使い、period_modeは通常autoにしてください。
家計以外の質問ではfinance toolを呼ばず、通常のナレッジまたは雑談として回答してください。
`
    : '';

  const contents = history.map((item) => ({ role: item.role, parts: [{ text: item.content }] }));
  contents.push({ role: 'user', parts: [{ text: message }] });

  let reply;
  try {
    reply = financeMode === 'enabled'
      ? await callGeminiWithFinance(env, `${systemPrompt}${financeInstruction}`, contents)
      : extractGeminiText(await callGemini(env, systemPrompt, contents));
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

export function resolveFinanceMode(env) {
  const enabled = String(env?.FINANCE_TOOL_ENABLED || '').toLowerCase() === 'true';
  if (!enabled) return 'disabled';
  return env?.FINANCE_SERVICE ? 'enabled' : 'misconfigured';
}

export async function fetchGithubFile(env, path, fetchImpl = fetch) {
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
    FETCH_TIMEOUT_MS,
    fetchImpl
  );
  if (!res.ok) {
    throw new Error(`github_fetch_failed:${res.status}`);
  }
  return res.text();
}

export async function loadAllKnowledge(env, { includeFinance = true, fetchImpl = fetch } = {}) {
  let promptText = '';
  let knowledgeText = '';
  for (const [label, path] of Object.entries(KNOWLEDGE_FILES)) {
    if (!includeFinance && label === '家計情報') continue;
    const content = await fetchGithubFile(env, path, fetchImpl);
    if (label === 'ふくちゃんプロンプト') {
      promptText = content;
    } else {
      knowledgeText += `\n\n## ${label}\n${content}`;
    }
  }
  return [promptText, knowledgeText];
}

/* ===== Gemini API（REST直接呼び出し） ===== */

export async function callGemini(env, systemPrompt, contents, { tools, fetchImpl = fetch } = {}) {
  const url = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent';
  const payload = {
    system_instruction: { parts: [{ text: systemPrompt }] },
    contents,
    ...(tools ? { tools } : {}),
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
    FETCH_TIMEOUT_MS,
    fetchImpl
  );

  if (!res.ok) {
    throw new Error(`gemini_failed:${res.status}`);
  }

  return res.json();
}

export function extractGeminiText(data) {
  const parts = data?.candidates?.[0]?.content?.parts;
  const textPart = Array.isArray(parts) ? parts.find((part) => typeof part?.text === 'string') : null;
  if (typeof textPart?.text !== 'string') throw new Error('no_candidates');
  return textPart.text;
}

export function extractGeminiFunctionCalls(data) {
  const parts = data?.candidates?.[0]?.content?.parts;
  if (!Array.isArray(parts)) return [];
  return parts
    .map((part) => part?.functionCall)
    .filter((call) => call && typeof call.name === 'string');
}

function functionResponsePart(call, response) {
  const functionResponse = {
    name: call.name,
    response,
    ...(typeof call.id === 'string' && call.id.length > 0 ? { id: call.id } : {}),
  };
  return { functionResponse };
}

const FINANCE_ERROR_MESSAGES = {
  unknown_tool: 'unknown finance tool',
  invalid_arguments: 'invalid finance tool arguments',
  no_active_sync: 'finance data is unavailable',
  month_not_found: 'the requested finance month is unavailable',
  unsupported_granularity: 'daily comparison data is unavailable',
  invalid_month: 'the requested month is invalid',
  invalid_date: 'the requested date is invalid',
  invalid_direction: 'the requested direction is invalid',
  invalid_period_mode: 'the requested comparison mode is invalid',
  invalid_category: 'the requested category is invalid',
  invalid_limit: 'the requested category limit is invalid',
};

function safeFinanceError(error) {
  const code = typeof error?.code === 'string' && FINANCE_ERROR_MESSAGES[error.code]
    ? error.code
    : 'finance_unavailable';
  return { code, message: FINANCE_ERROR_MESSAGES[code] || 'finance data is unavailable' };
}

export async function executeFinanceToolCall(service, call) {
  const parsed = parseFinanceToolCall(call?.name, call?.args);
  if (!parsed.ok) return functionResponsePart(call || {}, { error: parsed.error });
  if (!service || typeof service[parsed.method] !== 'function') {
    return functionResponsePart(call, {
      error: { code: 'finance_unavailable', message: 'finance data is unavailable' },
    });
  }
  try {
    const result = await service[parsed.method](parsed.args);
    return functionResponsePart(call, { result });
  } catch (error) {
    return functionResponsePart(call, { error: safeFinanceError(error) });
  }
}

export function appendFinanceMetadata(reply, functionParts) {
  const metadata = (functionParts || [])
    .map((part) => part?.functionResponse?.response?.result?.meta)
    .find((meta) => meta && (meta.asOf || meta.freshness));
  if (!metadata || typeof reply !== 'string') return reply;
  if (metadata.freshness !== 'stale' && metadata.freshness !== 'expired') return reply;

  const warning = metadata.freshness === 'expired'
    ? 'データが古い可能性があるよ。'
    : 'データが少し古い可能性があるよ。';
  const asOf = typeof metadata.asOf === 'string' && metadata.asOf
    ? metadata.asOf.slice(0, 10)
    : '';
  const suffix = asOf ? `${warning}最終更新は${asOf}だよ。` : warning;
  if (reply.includes(suffix)) return reply;
  return `${reply.trim()}\n\n${suffix}`;
}

export async function callGeminiWithFinance(
  env,
  systemPrompt,
  contents,
  { service = env?.FINANCE_SERVICE, fetchImpl = fetch, maxRounds = FINANCE_TOOL_MAX_ROUNDS } = {}
) {
  const tools = [{ functionDeclarations: FINANCE_TOOL_DECLARATIONS }];
  const nextContents = contents.map((content) => ({
    ...content,
    parts: Array.isArray(content.parts) ? content.parts.map((part) => ({ ...part })) : content.parts,
  }));
  let response = await callGemini(env, systemPrompt, nextContents, { tools, fetchImpl });
  const executedFunctionParts = [];

  for (let round = 0; round < maxRounds; round += 1) {
    const calls = extractGeminiFunctionCalls(response);
    if (calls.length === 0) return extractGeminiText(response);
    if (calls.length > FINANCE_TOOL_MAX_CALLS_PER_ROUND) {
      throw new Error('finance_tool_call_limit_exceeded');
    }

    const modelContent = response?.candidates?.[0]?.content;
    if (!modelContent || !Array.isArray(modelContent.parts)) {
      throw new Error('invalid_function_call_response');
    }
    // Geminiの候補contentはモデルターンとしてそのまま再送する。
    // 応答側でroleが省略されるケースにも対応するため、roleだけは明示する。
    nextContents.push({ ...modelContent, role: 'model' });
    const functionParts = await Promise.all(calls.map((call) => executeFinanceToolCall(service, call)));
    executedFunctionParts.push(...functionParts);
    nextContents.push({ role: 'user', parts: functionParts });
    response = await callGemini(env, `${systemPrompt}${FINANCE_SYNTHESIS_INSTRUCTION}`, nextContents, {
      tools,
      fetchImpl,
    });
    if (extractGeminiFunctionCalls(response).length === 0) {
      return appendFinanceMetadata(extractGeminiText(response), executedFunctionParts);
    }
  }

  if (extractGeminiFunctionCalls(response).length > 0) {
    throw new Error('finance_tool_loop_exceeded');
  }
  return appendFinanceMetadata(extractGeminiText(response), executedFunctionParts);
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

async function fetchWithTimeout(url, options, timeoutMs, fetchImpl = fetch) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetchImpl(url, { ...options, signal: controller.signal });
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

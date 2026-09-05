import { describe, it, expect } from 'vitest';
import { SELF } from 'cloudflare:test';
import {
  validateChatBody,
  timingSafeStringEqual,
  createToken,
  verifyToken,
  statusForUpstreamError,
} from './index.js';

const TEST_PIN = '9999'; // vitest.config.js の miniflare.bindings.WORKER_PIN と一致させる
const TEST_SECRET = 'test-auth-token-secret-not-for-production-use';

/* ===== 純粋関数の単体テスト（外部fetch不要） ===== */

describe('validateChatBody', () => {
  it('正常な入力ではnullを返す', () => {
    const err = validateChatBody({
      message: 'こんにちは',
      history: [{ role: 'user', content: 'hi' }],
    });
    expect(err).toBeNull();
  });

  it('messageが無いと413相当のエラー文字列を返す', () => {
    expect(validateChatBody({ message: '', history: [] })).not.toBeNull();
    expect(validateChatBody({ history: [] })).not.toBeNull();
  });

  it('messageが2000文字を超えるとエラーになる', () => {
    const err = validateChatBody({ message: 'a'.repeat(2001), history: [] });
    expect(err).toBe('message too long');
  });

  it('historyが40件を超えるとエラーになる', () => {
    const history = Array.from({ length: 41 }, () => ({ role: 'user', content: 'x' }));
    const err = validateChatBody({ message: 'hi', history });
    expect(err).toBe('history too long');
  });

  it('historyのroleがuser/model以外だとエラーになる（OpenAI系assistant等）', () => {
    const err = validateChatBody({
      message: 'hi',
      history: [{ role: 'assistant', content: 'x' }],
    });
    expect(err).toBe('invalid history role');
  });

  it('historyのcontentが2000文字を超えるとエラーになる', () => {
    const err = validateChatBody({
      message: 'hi',
      history: [{ role: 'user', content: 'a'.repeat(2001) }],
    });
    expect(err).toBe('invalid history content');
  });

  it('historyが配列でないとエラーになる', () => {
    const err = validateChatBody({ message: 'hi', history: 'not-an-array' });
    expect(err).toBe('history must be an array');
  });
});

describe('timingSafeStringEqual', () => {
  it('同じ文字列はtrue', () => {
    expect(timingSafeStringEqual('abc123', 'abc123')).toBe(true);
  });

  it('異なる文字列はfalse', () => {
    expect(timingSafeStringEqual('abc123', 'abc124')).toBe(false);
  });

  it('長さが異なる場合はfalse', () => {
    expect(timingSafeStringEqual('abc', 'abcd')).toBe(false);
  });
});

describe('createToken / verifyToken', () => {
  it('発行直後のトークンは有効と判定される', async () => {
    const token = await createToken(TEST_SECRET, 60);
    expect(await verifyToken(TEST_SECRET, token)).toBe(true);
  });

  it('期限切れのトークンは無効と判定される', async () => {
    const token = await createToken(TEST_SECRET, -1);
    expect(await verifyToken(TEST_SECRET, token)).toBe(false);
  });

  it('署名が改ざんされたトークンは無効と判定される', async () => {
    const token = await createToken(TEST_SECRET, 60);
    const [expiry] = token.split('.');
    const tampered = `${expiry}.tamperedSignatureValue`;
    expect(await verifyToken(TEST_SECRET, tampered)).toBe(false);
  });

  it('別の鍵で署名されたトークンは無効と判定される', async () => {
    const token = await createToken('a-different-secret', 60);
    expect(await verifyToken(TEST_SECRET, token)).toBe(false);
  });
});

/* ===== エンドポイントの契約テスト（GitHub/Geminiを呼ばない範囲） ===== */

describe('GET /health', () => {
  it('200とステータスを返す', async () => {
    const res = await SELF.fetch('https://example.com/health');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe('ok');
  });
});

describe('POST /auth', () => {
  it('正しいPINでCookieを発行する', async () => {
    const res = await SELF.fetch('https://example.com/auth', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pin: TEST_PIN }),
    });
    expect(res.status).toBe(200);
    const setCookie = res.headers.get('Set-Cookie') || '';
    expect(setCookie).toContain('fuku_session=');
    expect(setCookie).toContain('HttpOnly');
    expect(setCookie).toContain('SameSite=Strict');
  });

  it('誤ったPINは401になる', async () => {
    const res = await SELF.fetch('https://example.com/auth', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pin: '0000' }),
    });
    expect(res.status).toBe(401);
  });

  it('ボディが大きすぎる場合は413になる（Content-Lengthを偽装しても実バイト数で判定）', async () => {
    const hugeBody = JSON.stringify({ pin: 'x'.repeat(1000) });
    const res = await SELF.fetch('https://example.com/auth', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' }, // Content-Lengthは意図的に付けない
      body: hugeBody,
    });
    expect(res.status).toBe(413);
  });
});

describe('POST /chat の認証・入力検証', () => {
  it('Cookie無しでは401になる', async () => {
    const res = await SELF.fetch('https://example.com/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: 'hi', history: [] }),
    });
    expect(res.status).toBe(401);
  });

  it('無効なCookieでは401になる', async () => {
    const res = await SELF.fetch('https://example.com/chat', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: 'fuku_session=invalid.token',
      },
      body: JSON.stringify({ message: 'hi', history: [] }),
    });
    expect(res.status).toBe(401);
  });

  it('正しいCookieでもmessageが長すぎると413になる', async () => {
    const authRes = await SELF.fetch('https://example.com/auth', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pin: TEST_PIN }),
    });
    const cookie = (authRes.headers.get('Set-Cookie') || '').split(';')[0];

    const res = await SELF.fetch('https://example.com/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ message: 'a'.repeat(2001), history: [] }),
    });
    expect(res.status).toBe(413);
  });
});

/* ===== 上流エラーのステータスマッピング（design.md 6-3） ===== */

// 注記：@cloudflare/vitest-plugin（1.1.4時点）はGitHub/Gemini等の外部fetchを
// インターセプトする仕組み（fetchMock等）を提供していないため、実際のGitHub Contents
// API・Gemini API呼び出しを含む統合テストはここでは行わない。502/504の分岐ロジック
// 自体はこの純粋関数として切り出してあり、ここで固定する。実際の外部API疎通・
// fail-closed動作は`wrangler dev`での手動確認（implementation-plan.md フェーズ3）で検証する。
describe('statusForUpstreamError', () => {
  it('TimeoutErrorは504にマッピングされる', () => {
    const e = new Error('timeout');
    e.name = 'TimeoutError';
    expect(statusForUpstreamError(e)).toBe(504);
  });

  it('それ以外のエラー（GitHub/Geminiの4xx・5xx・candidates 0件等）は502にマッピングされる', () => {
    expect(statusForUpstreamError(new Error('github_fetch_failed:500'))).toBe(502);
    expect(statusForUpstreamError(new Error('gemini_failed:400'))).toBe(502);
    expect(statusForUpstreamError(new Error('no_candidates'))).toBe(502);
  });
});

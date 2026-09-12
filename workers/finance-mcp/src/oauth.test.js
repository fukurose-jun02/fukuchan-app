import { describe, expect, it } from 'vitest';
import {
  beginGitHubAuthorization,
  completeGitHubAuthorization,
  handleDefaultRequest,
} from './oauth.js';

class MemoryKV {
  constructor() { this.values = new Map(); }
  async put(key, value) { this.values.set(key, value); }
  async get(key) { return this.values.get(key) ?? null; }
  async delete(key) { this.values.delete(key); }
}

function env(overrides = {}) {
  return {
    GITHUB_CLIENT_ID: 'client-id',
    GITHUB_CLIENT_SECRET: 'client-secret',
    GITHUB_ALLOWED_LOGIN: 'fukurosejun',
    COOKIE_ENCRYPTION_KEY: 'local-only-key',
    OAUTH_KV: new MemoryKV(),
    OAUTH_PROVIDER: {
      async parseAuthRequest() {
        return {
          responseType: 'code',
          clientId: 'inspector',
          redirectUri: 'http://127.0.0.1/callback',
          scope: ['mcp:read'],
          state: 'client-state',
          codeChallenge: 'challenge',
          codeChallengeMethod: 'S256',
        };
      },
      async completeAuthorization() { return { redirectTo: 'http://127.0.0.1/callback?code=issued' }; },
    },
    ...overrides,
  };
}

describe('GitHub OAuth bridge', () => {
  it('認可開始時にOAuth requestを短TTLのstateへ保存してGitHubへリダイレクトする', async () => {
    const testEnv = env();
    const response = await beginGitHubAuthorization(
      new Request('https://finance.example.com/authorize'),
      testEnv
    );
    expect(response.status).toBe(302);
    const location = new URL(response.headers.get('Location'));
    expect(location.origin).toBe('https://github.com');
    expect(location.pathname).toBe('/login/oauth/authorize');
    expect(location.searchParams.get('client_id')).toBe('client-id');
    expect(location.searchParams.get('redirect_uri')).toBe('https://finance.example.com/github/callback');
    expect(testEnv.OAUTH_KV.values.size).toBe(1);
  });

  it('必須設定がない場合はOAuthを開始せず503にする', async () => {
    const response = await beginGitHubAuthorization(
      new Request('https://finance.example.com/authorize'),
      env({ GITHUB_CLIENT_SECRET: '' })
    );
    expect(response.status).toBe(503);
  });

  it('GitHub login許可後だけcompleteAuthorizationを実行する', async () => {
    const testEnv = env();
    testEnv.OAUTH_KV.values.set(
      'github-oauth-state:state-1',
      JSON.stringify({ responseType: 'code', clientId: 'inspector', redirectUri: 'http://127.0.0.1/callback', scope: ['mcp:read'], state: 'client-state' })
    );
    let completed;
    testEnv.OAUTH_PROVIDER.completeAuthorization = async (options) => {
      completed = options;
      return { redirectTo: 'http://127.0.0.1/callback?code=issued' };
    };
    const fetchImpl = async (url) => {
      if (url.includes('access_token')) return Response.json({ access_token: 'github-token' });
      return Response.json({ login: 'FukuroseJun' });
    };
    const response = await completeGitHubAuthorization(
      new Request('https://finance.example.com/github/callback?code=code-1&state=state-1'),
      testEnv,
      fetchImpl
    );
    expect(response.status).toBe(302);
    expect(completed.userId).toBe('github:fukurosejun');
    expect(completed.props).toEqual({ githubLogin: 'fukurosejun' });
    expect(testEnv.OAUTH_KV.values.size).toBe(0);
  });

  it('scope省略時は唯一のmcp:read scopeを既定付与する', async () => {
    const testEnv = env();
    testEnv.OAUTH_KV.values.set(
      'github-oauth-state:state-no-scope',
      JSON.stringify({ responseType: 'code', clientId: 'inspector', redirectUri: 'http://127.0.0.1/callback', scope: [], state: 'client-state' })
    );
    let completed;
    testEnv.OAUTH_PROVIDER.completeAuthorization = async (options) => {
      completed = options;
      return { redirectTo: 'http://127.0.0.1/callback?code=issued' };
    };
    const fetchImpl = async (url) => url.includes('access_token')
      ? Response.json({ access_token: 'github-token' })
      : Response.json({ login: 'fukurosejun' });
    const response = await completeGitHubAuthorization(
      new Request('https://finance.example.com/github/callback?code=code-no-scope&state=state-no-scope'),
      testEnv,
      fetchImpl
    );
    expect(response.status).toBe(302);
    expect(completed.scope).toEqual(['mcp:read']);
  });

  it('未対応scopeを明示した場合はgrantを発行しない', async () => {
    const testEnv = env();
    testEnv.OAUTH_KV.values.set('github-oauth-state:state-invalid-scope', JSON.stringify({
      scope: ['openid'],
      redirectUri: 'http://127.0.0.1/callback',
      state: 'client-state',
    }));
    let completed = false;
    testEnv.OAUTH_PROVIDER.completeAuthorization = async () => { completed = true; return {}; };
    const response = await completeGitHubAuthorization(
      new Request('https://finance.example.com/github/callback?code=code-invalid-scope&state=state-invalid-scope'),
      testEnv,
      async (url) => url.includes('access_token')
        ? Response.json({ access_token: 'github-token' })
        : Response.json({ login: 'fukurosejun' })
    );
    expect(response.status).toBe(302);
    expect(new URL(response.headers.get('Location')).searchParams.get('error')).toBe('invalid_scope');
    expect(completed).toBe(false);
  });

  it('許可リスト外のGitHub loginは403で、grantを発行しない', async () => {
    const testEnv = env();
    testEnv.OAUTH_KV.values.set('github-oauth-state:state-2', JSON.stringify({
      scope: ['mcp:read'],
      redirectUri: 'http://127.0.0.1/callback',
      state: 'client-state',
    }));
    let completed = false;
    testEnv.OAUTH_PROVIDER.completeAuthorization = async () => { completed = true; return {}; };
    const response = await completeGitHubAuthorization(
      new Request('https://finance.example.com/github/callback?code=code-2&state=state-2'),
      testEnv,
      async (url) => url.includes('access_token')
        ? Response.json({ access_token: 'github-token' })
        : Response.json({ login: 'someone-else' })
    );
    expect(response.status).toBe(302);
    expect(new URL(response.headers.get('Location')).searchParams.get('error')).toBe('access_denied');
    expect(completed).toBe(false);
  });

  it('GitHub側の拒否はcodeなしでもクライアントへaccess_deniedを返す', async () => {
    const testEnv = env();
    testEnv.OAUTH_KV.values.set('github-oauth-state:state-denied', JSON.stringify({
      scope: ['mcp:read'],
      redirectUri: 'http://127.0.0.1/callback',
      state: 'client-state',
    }));
    const response = await completeGitHubAuthorization(
      new Request('https://finance.example.com/github/callback?error=access_denied&state=state-denied'),
      testEnv,
      async () => { throw new Error('must not call GitHub'); }
    );
    expect(response.status).toBe(302);
    const location = new URL(response.headers.get('Location'));
    expect(location.searchParams.get('error')).toBe('access_denied');
    expect(location.searchParams.get('state')).toBe('client-state');
  });

  it('GitHub upstream失敗は詳細を漏らさず502にする', async () => {
    const testEnv = env();
    testEnv.OAUTH_KV.values.set('github-oauth-state:state-3', JSON.stringify({ scope: ['mcp:read'] }));
    const response = await completeGitHubAuthorization(
      new Request('https://finance.example.com/github/callback?code=code-3&state=state-3'),
      testEnv,
      async () => new Response('secret upstream body', { status: 500 })
    );
    expect(response.status).toBe(502);
    expect(await response.text()).not.toContain('secret upstream body');
  });

  it('default handlerはhealth以外の未認証MCP経路を公開しない', async () => {
    const response = await handleDefaultRequest(
      new Request('https://finance.example.com/mcp', { method: 'GET' }),
      env()
    );
    expect(response.status).toBe(404);
  });
});

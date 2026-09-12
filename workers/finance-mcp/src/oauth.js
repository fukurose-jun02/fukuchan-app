import { AuthorizationError } from '@cloudflare/workers-oauth-provider';

const AUTH_REQUEST_TTL_SECONDS = 600;
const GITHUB_TIMEOUT_MS = 10_000;
const AUTH_STATE_PREFIX = 'github-oauth-state:';

function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...headers },
  });
}

function missingConfig(env) {
  const missing = [
    'GITHUB_CLIENT_ID',
    'GITHUB_CLIENT_SECRET',
    'GITHUB_ALLOWED_LOGIN',
    'COOKIE_ENCRYPTION_KEY',
  ].filter((name) => typeof env?.[name] !== 'string' || env[name].trim() === '');
  if (env?.GITHUB_ALLOWED_LOGIN?.trim() === 'replace-with-github-login') {
    missing.push('GITHUB_ALLOWED_LOGIN');
  }
  return [...new Set(missing)];
}

function callbackUrl(request, env) {
  const configured = env?.GITHUB_OAUTH_CALLBACK_URL?.trim();
  return configured || `${new URL(request.url).origin}/github/callback`;
}

function allowedLogins(env) {
  return new Set(
    String(env.GITHUB_ALLOWED_LOGIN || '')
      .split(',')
      .map((login) => login.trim().toLowerCase())
      .filter(Boolean)
  );
}

function localAuthorizationError(error) {
  // redirectUriがないエラーは、未検証のURIへリダイレクトしてはいけない。
  return json({ error: error.code || 'invalid_request', error_description: error.description || 'invalid authorization request' }, 400);
}

function redirectAuthorizationError(error) {
  const redirect = new URL(error.redirectUri);
  redirect.searchParams.set('error', error.code);
  redirect.searchParams.set('error_description', error.description);
  if (error.state) redirect.searchParams.set('state', error.state);
  if (error.issuer) redirect.searchParams.set('iss', error.issuer);
  return Response.redirect(redirect, 302);
}

function redirectClientError(authRequest, code, description) {
  if (!authRequest?.redirectUri) return json({ error: code, error_description: description }, 400);
  const redirect = new URL(authRequest.redirectUri);
  redirect.searchParams.set('error', code);
  redirect.searchParams.set('error_description', description);
  if (authRequest.state) redirect.searchParams.set('state', authRequest.state);
  if (authRequest.issuer) redirect.searchParams.set('iss', authRequest.issuer);
  return Response.redirect(redirect, 302);
}

export async function beginGitHubAuthorization(request, env) {
  const missing = missingConfig(env);
  if (missing.length > 0) return json({ error: 'oauth_not_configured' }, 503);

  let authRequest;
  try {
    authRequest = await env.OAUTH_PROVIDER.parseAuthRequest(request);
  } catch (error) {
    if (error instanceof AuthorizationError) {
      return error.redirectUri ? redirectAuthorizationError(error) : localAuthorizationError(error);
    }
    return json({ error: 'oauth_request_failed' }, 503);
  }

  const state = crypto.randomUUID();
  await env.OAUTH_KV.put(`${AUTH_STATE_PREFIX}${state}`, JSON.stringify(authRequest), {
    expirationTtl: AUTH_REQUEST_TTL_SECONDS,
  });

  const github = new URL('https://github.com/login/oauth/authorize');
  github.searchParams.set('client_id', env.GITHUB_CLIENT_ID);
  github.searchParams.set('redirect_uri', callbackUrl(request, env));
  github.searchParams.set('state', state);
  // GitHub identity lookup only needs read:user; no repository access is requested.
  github.searchParams.set('scope', 'read:user');
  return Response.redirect(github, 302);
}

async function githubFetch(url, init = {}, fetchImpl = fetch) {
  const signal = typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function'
    ? AbortSignal.timeout(GITHUB_TIMEOUT_MS)
    : undefined;
  return fetchImpl(url, { ...init, ...(signal ? { signal } : {}) });
}

export async function exchangeGitHubCode(code, env, fetchImpl = fetch) {
  const tokenResponse = await githubFetch(
    'https://github.com/login/oauth/access_token',
    {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        'User-Agent': 'fukuchan-finance-mcp',
      },
      body: JSON.stringify({
        client_id: env.GITHUB_CLIENT_ID,
        client_secret: env.GITHUB_CLIENT_SECRET,
        code,
      }),
    },
    fetchImpl
  );
  if (!tokenResponse.ok) throw new Error('github token exchange failed');
  const tokenBody = await tokenResponse.json();
  if (!tokenBody?.access_token || typeof tokenBody.access_token !== 'string') {
    throw new Error('github token exchange returned no access token');
  }
  return tokenBody.access_token;
}

export async function fetchGitHubLogin(accessToken, fetchImpl = fetch) {
  const response = await githubFetch(
    'https://api.github.com/user',
    {
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${accessToken}`,
        'User-Agent': 'fukuchan-finance-mcp',
      },
    },
    fetchImpl
  );
  if (!response.ok) throw new Error('github user lookup failed');
  const body = await response.json();
  if (typeof body?.login !== 'string' || body.login.trim() === '') {
    throw new Error('github user lookup returned no login');
  }
  return body.login.trim();
}

export async function completeGitHubAuthorization(request, env, fetchImpl = fetch) {
  const url = new URL(request.url);
  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');
  const githubError = url.searchParams.get('error');
  if (!state || state.length > 256 || (code && code.length > 2048)) {
    return json({ error: 'invalid_callback' }, 400);
  }

  const stateKey = `${AUTH_STATE_PREFIX}${state}`;
  const stored = await env.OAUTH_KV.get(stateKey);
  // State is single-use even when GitHub returns a denial or an upstream error.
  await env.OAUTH_KV.delete(stateKey);
  if (!stored) return json({ error: 'invalid_callback' }, 400);

  let authRequest;
  try {
    authRequest = JSON.parse(stored);
  } catch {
    return json({ error: 'invalid_callback' }, 400);
  }
  if (githubError) {
    return redirectClientError(authRequest, 'access_denied', 'GitHub authorization was denied');
  }
  if (!code) return json({ error: 'invalid_callback' }, 400);

  let login;
  try {
    const accessToken = await exchangeGitHubCode(code, env, fetchImpl);
    login = await fetchGitHubLogin(accessToken, fetchImpl);
  } catch {
    // Do not expose GitHub response bodies, access tokens, or upstream details.
    return json({ error: 'github_upstream_failed' }, 502);
  }
  if (!allowedLogins(env).has(login.toLowerCase())) {
    return redirectClientError(authRequest, 'access_denied', 'GitHub user is not allowed');
  }

  try {
    const requestedScopes = Array.isArray(authRequest.scope)
      ? authRequest.scope
      : typeof authRequest.scope === 'string'
        ? authRequest.scope.split(' ').filter(Boolean)
        : [];
    // OAuth clients may omit scope when the authorization server has a
    // single supported scope. Default that case to mcp:read, while rejecting
    // any explicitly requested scope that this server does not support.
    const grantedScope = requestedScopes.length === 0 ? ['mcp:read'] : requestedScopes;
    if (grantedScope.some((scope) => scope !== 'mcp:read')) {
      return redirectClientError(authRequest, 'invalid_scope', 'mcp:read scope is required');
    }
    const result = await env.OAUTH_PROVIDER.completeAuthorization({
      request: authRequest,
      userId: `github:${login.toLowerCase()}`,
      metadata: { provider: 'github' },
      scope: grantedScope,
      props: { githubLogin: login.toLowerCase() },
    });
    return Response.redirect(result.redirectTo, 302);
  } catch {
    return json({ error: 'oauth_completion_failed' }, 503);
  }
}

export async function handleDefaultRequest(request, env) {
  const url = new URL(request.url);
  if (url.pathname === '/health' && request.method === 'GET') {
    return json({ status: 'ok', service: 'fukuchan-finance-mcp' });
  }
  if (url.pathname === '/authorize' && request.method === 'GET') {
    return beginGitHubAuthorization(request, env);
  }
  if (url.pathname === '/github/callback' && request.method === 'GET') {
    return completeGitHubAuthorization(request, env);
  }
  return new Response('Not found', { status: 404 });
}

export { missingConfig, allowedLogins };

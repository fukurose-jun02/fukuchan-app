import { describe, expect, it } from 'vitest';

import {
  classifyLoginState,
  constantTimeEquals,
  getSafeLocation,
  hasRequiredPocSecrets,
  isAuthorizedPocRequest,
  selectors,
} from './logic.js';

describe('finance-sync login PoC logic', () => {
  it('keeps only origin and path from a browser URL', () => {
    expect(getSafeLocation('https://example.test/account?token=secret#fragment')).toEqual({
      origin: 'https://example.test',
      path: '/account',
    });
  });

  it('rejects malformed URLs', () => {
    expect(getSafeLocation('not a url')).toEqual({ origin: null, path: null });
  });

  it('compares bearer tokens without exposing values', () => {
    expect(constantTimeEquals('token', 'token')).toBe(true);
    expect(constantTimeEquals('token', 'other')).toBe(false);
    expect(constantTimeEquals(undefined, 'token')).toBe(false);
  });

  it('accepts only the configured PoC bearer token', () => {
    const request = new Request('https://poc.test/poc/login', {
      method: 'POST',
      headers: { authorization: 'Bearer test-token' },
    });
    expect(isAuthorizedPocRequest(request, 'test-token')).toBe(true);
    expect(isAuthorizedPocRequest(request, 'wrong-token')).toBe(false);
  });

  it('targets the current Money Forward submit button first', () => {
    expect(selectors.submit).toContain('button#submitto');
  });

  it('supports the dedicated token header as a fallback', () => {
    const request = new Request('https://poc.test/poc/login', {
      method: 'POST',
      headers: { 'x-sync-poc-token': 'test-token' },
    });
    expect(isAuthorizedPocRequest(request, 'test-token')).toBe(true);
  });

  it('requires all three PoC secrets', () => {
    expect(hasRequiredPocSecrets({
      MF_LOGIN_EMAIL: 'email',
      MF_LOGIN_PASSWORD: 'password',
      SYNC_POC_TOKEN: 'token',
    })).toBe(true);
    expect(hasRequiredPocSecrets({
      MF_LOGIN_EMAIL: 'email',
      MF_LOGIN_PASSWORD: '',
      SYNC_POC_TOKEN: 'token',
    })).toBe(false);
  });

  it('classifies OTP and bot challenges before generic redirects', () => {
    expect(classifyLoginState({
      location: { origin: 'https://id.moneyforward.com', path: '/verify' },
    })).toBe('OTP_REQUIRED');
    expect(classifyLoginState({
      location: { origin: 'https://id.moneyforward.com', path: '/sign_in' },
      botCount: 1,
    })).toBe('BOT_BLOCKED');
    expect(classifyLoginState({
      location: { origin: 'https://id.moneyforward.com', path: '/sign_in' },
      errorCount: 1,
    })).toBe('AUTH_FAILED');
    expect(classifyLoginState({
      location: { origin: 'https://moneyforward.com', path: '/' },
    })).toBe('AUTHENTICATED');
  });
});

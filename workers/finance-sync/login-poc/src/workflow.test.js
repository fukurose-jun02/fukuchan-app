import { describe, expect, it } from 'vitest';

import {
  HANDOFF_TIMEOUT_MS,
  buildHandoffRequest,
  classifyPostAuthState,
  extractAggregateSnapshot,
  normalizeAggregateSnapshot,
} from './workflow.js';
import {
  authenticatedAggregateFixture,
  botBlockedFixture,
  otpRequiredFixture,
  selectorChangedFixture,
} from './fixtures/post-auth.js';

describe('finance-sync OTP/HITL workflow contract', () => {
  it('creates a short-lived Live View handoff without an OTP field', () => {
    const request = buildHandoffRequest('https://live.browser.run/ui/view?jwt=test-jwt');

    expect(request).toEqual({
      liveViewUrl: 'https://live.browser.run/ui/view?jwt=test-jwt',
      mode: 'tab',
      timeoutMs: HANDOFF_TIMEOUT_MS,
      instructions: expect.stringContaining('OTPをこのAPIへ送信しないでください'),
    });
    expect(Object.keys(request)).not.toContain('otp');
  });

  it('rejects a Live View URL from an unexpected origin', () => {
    expect(() => buildHandoffRequest('https://evil.example/view?jwt=test')).toThrow('invalid_live_view_url');
  });

  it('prioritizes OTP and bot states over a generic authenticated result', () => {
    expect(classifyPostAuthState({ pageReady: true, aggregateCount: 1, otpCount: 1 })).toBe('OTP_REQUIRED');
    expect(classifyPostAuthState({ pageReady: true, aggregateCount: 1, botCount: 1 })).toBe('BOT_BLOCKED');
    expect(classifyPostAuthState({ pageReady: true, aggregateCount: 1 })).toBe('AUTHENTICATED');
  });

  it('classifies timeout and missing aggregate candidates as terminal states', () => {
    expect(classifyPostAuthState({ timedOut: true })).toBe('AUTH_TIMEOUT');
    expect(classifyPostAuthState({ pageReady: true })).toBe('UNEXPECTED_STATE');
    expect(classifyPostAuthState({ loginFormCount: 1 })).toBe('AUTH_FAILED');
    expect(classifyPostAuthState({ accountSelectionCount: 1 })).toBe('ACCOUNT_SELECTION_REQUIRED');
  });

  it('extracts only an authenticated aggregate fixture', () => {
    expect(extractAggregateSnapshot(authenticatedAggregateFixture)).toEqual(
      authenticatedAggregateFixture.snapshot,
    );
  });

  it('rejects OTP and bot fixtures before reading an aggregate', () => {
    expect(() => extractAggregateSnapshot(otpRequiredFixture)).toThrow('post_auth_state:OTP_REQUIRED');
    expect(() => extractAggregateSnapshot(botBlockedFixture)).toThrow('post_auth_state:BOT_BLOCKED');
  });

  it('fails closed when selector changes remove required aggregate fields', () => {
    expect(() => extractAggregateSnapshot(selectorChangedFixture)).toThrow('invalid_monthly_count');
  });

  it('keeps only the aggregate contract and drops unknown top-level fields', () => {
    expect(normalizeAggregateSnapshot({
      status: 'READY',
      asOf: '2026-09-14T00:00:00+09:00',
      sourceDate: '2026-09-14',
      counts: { daily: 1, monthly: 1, categories: 2, assets: 1 },
      summaries: { monthly: { incomeYen: 100, expenseYen: 80 } },
      unexpected: 'discarded',
    })).toEqual({
      status: 'READY',
      granularity: 'daily',
      asOf: '2026-09-14T00:00:00+09:00',
      sourceDate: '2026-09-14',
      counts: { daily: 1, monthly: 1, categories: 2, assets: 1 },
      summaries: { monthly: { incomeYen: 100, expenseYen: 80 } },
    });
  });

  it('rejects sensitive browser data in an aggregate result', () => {
    expect(() => normalizeAggregateSnapshot({
      status: 'READY',
      asOf: '2026-09-14T00:00:00+09:00',
      sourceDate: '2026-09-14',
      counts: { daily: 1, monthly: 1, categories: 1, assets: 1 },
      summaries: { rawHtml: '<div>secret</div>' },
    })).toThrow('sensitive_field');
  });

  it('fails closed for incomplete counts', () => {
    expect(() => normalizeAggregateSnapshot({
      status: 'READY',
      asOf: '2026-09-14T00:00:00+09:00',
      sourceDate: '2026-09-14',
      counts: { daily: 1 },
      summaries: {},
    })).toThrow('invalid_monthly_count');
  });
});

export const authenticatedAggregateFixture = Object.freeze({
  state: 'AUTHENTICATED',
  snapshot: Object.freeze({
    status: 'READY',
    granularity: 'daily',
    asOf: '2026-09-14T00:00:00+09:00',
    sourceDate: '2026-09-14',
    counts: Object.freeze({ daily: 2, monthly: 1, categories: 2, assets: 1 }),
    summaries: Object.freeze({
      monthly: Object.freeze({ incomeYen: 120000, expenseYen: 45000, balanceYen: 75000 }),
      categories: Object.freeze({ foodYen: 18000, housingYen: 27000 }),
      assets: Object.freeze({ netWorthYen: 300000 }),
    }),
  }),
});

export const otpRequiredFixture = Object.freeze({
  state: 'OTP_REQUIRED',
  snapshot: null,
});

export const botBlockedFixture = Object.freeze({
  state: 'BOT_BLOCKED',
  snapshot: null,
});

export const selectorChangedFixture = Object.freeze({
  state: 'AUTHENTICATED',
  snapshot: Object.freeze({
    status: 'READY',
    asOf: '2026-09-14T00:00:00+09:00',
    sourceDate: '2026-09-14',
    counts: Object.freeze({ daily: 2 }),
    summaries: Object.freeze({}),
  }),
});

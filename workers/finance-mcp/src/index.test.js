import { describe, expect, it } from 'vitest';

import { FinanceMcpApi } from './index.js';

class MockD1 {
  prepare(sql) {
    const normalized = sql.replace(/\s+/g, ' ').trim();
    return {
      bind: (...params) => ({
        first: async () => {
          if (normalized.includes('FROM sync_runs')) {
            return {
              sync_id: 'rpc-sync',
              completed_at: '2026-09-11T06:30:00+09:00',
              source_version: 'fixture',
              source_max_date: '2026-09-11',
              daily_count: 8,
              monthly_count: 2,
              category_count: 4,
              asset_count: 2,
              status: 'active',
            };
          }
          if (normalized.includes('FROM monthly_summaries')) {
            return params[1] === '2026-09'
              ? {
                  month: '2026-09',
                  income_yen: 100000,
                  expense_yen: 22000,
                  balance_yen: 78000,
                  transaction_count: 5,
                }
              : null;
          }
          return null;
        },
        all: async () => ({ results: [] }),
      }),
    };
  }
}

function rpcApi(db = new MockD1()) {
  const api = Object.create(FinanceMcpApi.prototype);
  api.env = { FINANCE_DB: db };
  return api;
}

describe('finance Worker Service Binding RPC', () => {
  it('P0の5メソッドを公開する', () => {
    expect([
      'getDataFreshness',
      'getMonthlySummary',
      'getCategoryBreakdown',
      'compareMonths',
      'getAssetSummary',
    ].every((name) => typeof FinanceMcpApi.prototype[name] === 'function')).toBe(true);
  });

  it('MCPと同じquery層を使って月次結果を返す', async () => {
    const result = await rpcApi().getMonthlySummary({ month: '2026-09' });
    expect(result.data).toMatchObject({ month: '2026-09', expense_yen: 22000 });
    expect(result.meta.currency).toBe('JPY');
  });

  it('RPC引数をWorker側でも検証し、未定義の粒度を受け付けない', async () => {
    await expect(rpcApi().getCategoryBreakdown({ month: '2026-13' }))
      .rejects.toMatchObject({ name: 'ZodError' });
  });
});


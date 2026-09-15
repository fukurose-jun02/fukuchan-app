import { describe, expect, it } from 'vitest';

import {
  buildD1SyncPlan,
  validateAggregateSnapshotForD1,
  writeAggregateSnapshotToD1,
} from './d1-sync.js';

function fixture(overrides = {}) {
  const snapshot = {
    status: 'READY',
    asOf: '2026-09-14T12:00:00.000Z',
    sourceDate: '2026-09-02',
    counts: { daily: 2, monthly: 1, categories: 3, assets: 1 },
    summaries: {
      daily: [
        { date: '2026-09-01', incomeYen: 100000, expenseYen: 20000, balanceYen: 80000, transactionCount: 2 },
        { date: '2026-09-02', incomeYen: 0, expenseYen: 30000, balanceYen: -30000, transactionCount: 1 },
      ],
      monthly: {
        month: '2026-09', incomeYen: 100000, expenseYen: 50000, balanceYen: 50000, transactionCount: 3,
      },
      categoryDaily: [
        { date: '2026-09-01', direction: 'income', category: '給与', amountYen: 100000, transactionCount: 1 },
        { date: '2026-09-01', direction: 'expense', category: '食費', amountYen: 20000, transactionCount: 1 },
        { date: '2026-09-02', direction: 'expense', category: '住居費', amountYen: 30000, transactionCount: 1 },
      ],
      categories: [
        { month: '2026-09', direction: 'expense', category: '住居費', amountYen: 30000, transactionCount: 1 },
        { month: '2026-09', direction: 'expense', category: '食費', amountYen: 20000, transactionCount: 1 },
        { month: '2026-09', direction: 'income', category: '給与', amountYen: 100000, transactionCount: 1 },
      ],
      assets: [{ asOfDate: '2026-09-02', assetType: '預金', amountYen: 500000 }],
    },
  };
  return {
    ...snapshot,
    ...overrides,
    summaries: { ...snapshot.summaries, ...(overrides.summaries ?? {}) },
  };
}

class FakeD1 {
  constructor() {
    this.batchCalls = [];
  }

  prepare(sql) {
    return {
      bind: (...params) => ({ sql, params }),
    };
  }

  async batch(statements) {
    this.batchCalls.push(statements);
    return statements.map(() => ({ success: true }));
  }
}

class TransactionalFakeD1 extends FakeD1 {
  constructor({ failAt } = {}) {
    super();
    this.failAt = failAt;
    this.syncRuns = [{ sync_id: 'old-active', status: 'active' }];
  }

  async batch(statements) {
    const before = this.syncRuns.map((row) => ({ ...row }));
    this.batchCalls.push(statements);
    try {
      statements.forEach(({ sql }, index) => {
        if (index === this.failAt) throw new Error('simulated_d1_failure');
        if (sql.includes("status = 'superseded'")) {
          this.syncRuns = this.syncRuns.map((row) => (
            row.status === 'active' ? { ...row, status: 'superseded' } : row
          ));
        }
        if (sql.includes("SET status = 'active'")) {
          this.syncRuns.push({ sync_id: 'sync-test-1', status: 'active' });
        }
      });
      return statements.map(() => ({ success: true }));
    } catch (error) {
      this.syncRuns = before;
      throw error;
    }
  }
}

const metadata = {
  syncId: 'sync-test-1',
  sourceVersion: 'money-forward-web-v1',
  startedAt: '2026-09-14T12:00:00.000Z',
  completedAt: '2026-09-14T12:00:05.000Z',
};

describe('D1 staging/active sync writer', () => {
  it('creates only bound, aggregate-only statements and activates last', () => {
    const plan = buildD1SyncPlan(fixture(), metadata);
    expect(plan.status).toBe('active');
    expect(plan.statements).toHaveLength(13);
    expect(plan.statements[0].sql).toContain("VALUES (?, ?, ?, 'staging'");
    expect(plan.statements.at(-2).sql).toContain("status = 'superseded'");
    expect(plan.statements.at(-1).sql).toContain("status = 'active'");
    expect(JSON.stringify(plan).toLowerCase()).not.toMatch(/merchant|memo|account|cookie|password|otp|html/);
    expect(plan.statements.every(({ sql }) => !sql.includes('DELETE') && !sql.includes('DROP'))).toBe(true);
  });

  it('writes the complete plan through one D1 batch', async () => {
    const db = new FakeD1();
    const result = await writeAggregateSnapshotToD1(db, fixture(), metadata);
    expect(result).toMatchObject({ syncId: 'sync-test-1', status: 'active' });
    expect(db.batchCalls).toHaveLength(1);
    expect(db.batchCalls[0]).toHaveLength(13);
    expect(db.batchCalls[0][0].params).toEqual([
      'sync-test-1', '2026-09-14T12:00:00.000Z', 'money-forward-web-v1', '2026-09-02', 2, 1, 3, 1,
    ]);
  });

  it('rejects inconsistent monthly totals before calling D1', async () => {
    const db = new FakeD1();
    const invalid = fixture({ summaries: {
      monthly: { month: '2026-09', incomeYen: 100000, expenseYen: 51000, balanceYen: 49000, transactionCount: 3 },
    } });
    await expect(writeAggregateSnapshotToD1(db, invalid, metadata))
      .rejects.toThrow('inconsistent_monthly_expense');
    expect(db.batchCalls).toHaveLength(0);
  });

  it('keeps the old active snapshot when the atomic batch fails during activation', async () => {
    const db = new TransactionalFakeD1({ failAt: 12 });
    await expect(writeAggregateSnapshotToD1(db, fixture(), metadata))
      .rejects.toThrow('simulated_d1_failure');
    expect(db.syncRuns).toEqual([{ sync_id: 'old-active', status: 'active' }]);
  });

  it('rejects invalid direction and sensitive fields at the boundary', () => {
    expect(() => validateAggregateSnapshotForD1(fixture({ summaries: {
      categoryDaily: [{ date: '2026-09-01', direction: 'transfer', category: '食費', amountYen: 1, transactionCount: 1 }],
    } }))).toThrow('invalid_direction');
    expect(() => validateAggregateSnapshotForD1(fixture({ summaries: {
      categories: [{ month: '2026-09', direction: 'expense', category: '食費', amountYen: 1, transactionCount: 1, memo: 'x' }],
    } }))).toThrow(/sensitive_field/);
  });

  it('accepts a monthly-only snapshot without inventing daily rows', () => {
    const monthlyOnly = {
      status: 'READY',
      granularity: 'monthly_only',
      asOf: '2026-09-14T12:00:00.000Z',
      sourceDate: '2026-08-31',
      counts: { daily: 0, monthly: 2, categories: 3, assets: 0 },
      summaries: {
        daily: [],
        monthly: [
          { month: '2026-07', incomeYen: 0, expenseYen: 30000, balanceYen: -30000, transactionCount: 2 },
          { month: '2026-08', incomeYen: 100000, expenseYen: 25000, balanceYen: 75000, transactionCount: 3 },
        ],
        categoryDaily: [],
        categories: [
          { month: '2026-07', direction: 'expense', category: '食費', amountYen: 30000, transactionCount: 2 },
          { month: '2026-08', direction: 'expense', category: '食費', amountYen: 25000, transactionCount: 2 },
          { month: '2026-08', direction: 'income', category: '給与', amountYen: 100000, transactionCount: 1 },
        ],
        assets: [],
      },
    };
    const plan = buildD1SyncPlan(monthlyOnly, metadata);
    expect(plan).toMatchObject({ status: 'active', granularity: 'monthly_only' });
    expect(plan.statements.filter(({ sql }) => sql.includes('daily_summaries'))).toHaveLength(0);
    expect(plan.statements.filter(({ sql }) => sql.includes('category_daily_totals'))).toHaveLength(0);
    expect(plan.statements).toHaveLength(8);
  });

  it('rejects monthly-only snapshots that contain fabricated daily data', () => {
    const monthlyOnly = {
      status: 'READY',
      granularity: 'monthly_only',
      asOf: '2026-09-14T12:00:00.000Z',
      sourceDate: '2026-08-31',
      counts: { daily: 1, monthly: 1, categories: 1, assets: 0 },
      summaries: {
        daily: [{ date: '2026-08-31', incomeYen: 0, expenseYen: 100, balanceYen: -100, transactionCount: 1 }],
        monthly: [{ month: '2026-08', incomeYen: 0, expenseYen: 100, balanceYen: -100, transactionCount: 1 }],
        categoryDaily: [],
        categories: [{ month: '2026-08', direction: 'expense', category: '食費', amountYen: 100, transactionCount: 1 }],
        assets: [],
      },
    };
    expect(() => validateAggregateSnapshotForD1(monthlyOnly)).toThrow('monthly_only_contains_daily');
  });
});

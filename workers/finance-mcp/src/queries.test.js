import { describe, expect, it } from 'vitest';
import {
  FinanceQueryError,
  compareMonths,
  getAssetSummary,
  getCategoryBreakdown,
  getDataFreshness,
  getMonthlySummary,
} from './queries.js';

class MemoryD1 {
  constructor(seed) {
    this.tables = seed;
    this.sqlLog = [];
  }

  prepare(sql) {
    const normalized = sql.replace(/\s+/g, ' ').trim();
    this.sqlLog.push(normalized);
    return {
      bind: (...params) => ({
        first: async () => this.execute(normalized, params)[0] ?? null,
        all: async () => ({ results: this.execute(normalized, params) }),
      }),
    };
  }

  execute(sql, params) {
    const { sync_runs, daily_summaries, monthly_summaries, category_daily_totals, category_totals, asset_summaries } = this.tables;
    if (sql.includes('FROM sync_runs')) {
      return sync_runs
        .filter((row) => row.status === 'active')
        .sort((a, b) => b.completed_at.localeCompare(a.completed_at));
    }
    if (sql.includes('FROM daily_summaries') && sql.includes('COUNT(*)')) {
      return [{ row_count: daily_summaries.filter((row) => row.sync_id === params[0]).length }];
    }
    if (sql.includes('FROM daily_summaries')) {
      const [syncId, start, end] = params;
      const rows = daily_summaries.filter(
        (row) => row.sync_id === syncId && row.date >= start && row.date <= end
      );
      return [rows.reduce((result, row) => ({
        income_yen: result.income_yen + row.income_yen,
        expense_yen: result.expense_yen + row.expense_yen,
        balance_yen: result.balance_yen + row.balance_yen,
        transaction_count: result.transaction_count + row.transaction_count,
      }), { income_yen: 0, expense_yen: 0, balance_yen: 0, transaction_count: 0 })];
    }
    if (sql.includes('FROM monthly_summaries')) {
      if (sql.includes('SELECT month FROM')) {
        const rows = monthly_summaries
          .filter((row) => row.sync_id === params[0])
          .sort((a, b) => b.month.localeCompare(a.month));
        return sql.includes('LIMIT 1') ? rows.slice(0, 1) : rows;
      }
      const [syncId, month] = params;
      return monthly_summaries.filter((row) => row.sync_id === syncId && row.month === month);
    }
    if (sql.includes('FROM category_daily_totals') && sql.includes('COUNT(*)')) {
      return [{ row_count: category_daily_totals.filter((row) => row.sync_id === params[0]).length }];
    }
    if (sql.includes('FROM category_daily_totals')) {
      const [syncId, start, end, direction, category] = params;
      const rows = category_daily_totals.filter(
        (row) => row.sync_id === syncId && row.date >= start && row.date <= end
          && row.direction === direction && row.category === category
      );
      return [{ amount_yen: rows.reduce((sum, row) => sum + row.amount_yen, 0) }];
    }
    if (sql.includes('FROM category_totals')) {
      if (sql.includes('SELECT category')) {
        const [syncId, month, direction, limit] = params;
        return category_totals
          .filter((row) => row.sync_id === syncId && row.month === month && row.direction === direction)
          .sort((a, b) => b.amount_yen - a.amount_yen || a.category.localeCompare(b.category))
          .slice(0, limit);
      }
      const [syncId, month, direction] = params;
      return [{
        total_yen: category_totals
          .filter((row) => row.sync_id === syncId && row.month === month && row.direction === direction)
          .reduce((sum, row) => sum + row.amount_yen, 0),
      }];
    }
    if (sql.includes('FROM asset_summaries')) {
      if (sql.includes('SELECT as_of_date')) {
        const rows = asset_summaries
          .filter((row) => row.sync_id === params[0])
          .sort((a, b) => b.as_of_date.localeCompare(a.as_of_date));
        return rows.slice(0, 1);
      }
      const [syncId, asOf] = params;
      return asset_summaries.filter((row) => row.sync_id === syncId && row.as_of_date === asOf);
    }
    throw new Error(`Unhandled SQL in test double: ${sql}`);
  }
}

function fixture({ withDaily = true } = {}) {
  const syncId = 'demo-sync';
  return new MemoryD1({
    sync_runs: [{
      sync_id: syncId,
      completed_at: '2026-09-11T06:30:00+09:00',
      source_version: 'fixture',
      status: 'active',
      source_max_date: '2026-09-11',
      daily_count: 8,
      monthly_count: 2,
      category_count: 4,
      asset_count: 2,
    }],
    daily_summaries: withDaily ? [
      { sync_id: syncId, date: '2026-08-01', income_yen: 0, expense_yen: 3000, balance_yen: -3000, transaction_count: 1 },
      { sync_id: syncId, date: '2026-08-02', income_yen: 0, expense_yen: 2000, balance_yen: -2000, transaction_count: 1 },
      { sync_id: syncId, date: '2026-08-03', income_yen: 0, expense_yen: 1000, balance_yen: -1000, transaction_count: 1 },
      { sync_id: syncId, date: '2026-08-11', income_yen: 100000, expense_yen: 5000, balance_yen: 95000, transaction_count: 2 },
      { sync_id: syncId, date: '2026-09-01', income_yen: 0, expense_yen: 4000, balance_yen: -4000, transaction_count: 1 },
      { sync_id: syncId, date: '2026-09-02', income_yen: 0, expense_yen: 5000, balance_yen: -5000, transaction_count: 1 },
      { sync_id: syncId, date: '2026-09-03', income_yen: 0, expense_yen: 6000, balance_yen: -6000, transaction_count: 1 },
      { sync_id: syncId, date: '2026-09-11', income_yen: 100000, expense_yen: 7000, balance_yen: 93000, transaction_count: 2 },
    ] : [],
    monthly_summaries: [
      { sync_id: syncId, month: '2026-08', income_yen: 100000, expense_yen: 11000, balance_yen: 89000, transaction_count: 5 },
      { sync_id: syncId, month: '2026-09', income_yen: 100000, expense_yen: 22000, balance_yen: 78000, transaction_count: 5 },
    ],
    category_daily_totals: withDaily ? [
      { sync_id: syncId, date: '2026-08-01', direction: 'expense', category: '食費', amount_yen: 2000, transaction_count: 1 },
      { sync_id: syncId, date: '2026-08-02', direction: 'expense', category: '食費', amount_yen: 2000, transaction_count: 1 },
      { sync_id: syncId, date: '2026-08-03', direction: 'expense', category: '食費', amount_yen: 1000, transaction_count: 1 },
      { sync_id: syncId, date: '2026-08-11', direction: 'expense', category: '食費', amount_yen: 4000, transaction_count: 1 },
      { sync_id: syncId, date: '2026-09-01', direction: 'expense', category: '食費', amount_yen: 3000, transaction_count: 1 },
      { sync_id: syncId, date: '2026-09-02', direction: 'expense', category: '食費', amount_yen: 4000, transaction_count: 1 },
      { sync_id: syncId, date: '2026-09-03', direction: 'expense', category: '食費', amount_yen: 5000, transaction_count: 1 },
      { sync_id: syncId, date: '2026-09-11', direction: 'expense', category: '食費', amount_yen: 6000, transaction_count: 1 },
    ] : [],
    category_totals: [
      { sync_id: syncId, month: '2026-08', direction: 'expense', category: '食費', amount_yen: 9000, transaction_count: 4 },
      { sync_id: syncId, month: '2026-08', direction: 'expense', category: '住居費', amount_yen: 2000, transaction_count: 1 },
      { sync_id: syncId, month: '2026-09', direction: 'expense', category: '食費', amount_yen: 18000, transaction_count: 4 },
      { sync_id: syncId, month: '2026-09', direction: 'expense', category: '住居費', amount_yen: 4000, transaction_count: 1 },
    ],
    asset_summaries: [
      { sync_id: syncId, as_of_date: '2026-09-11', asset_type: '預金', amount_yen: 1000000 },
      { sync_id: syncId, as_of_date: '2026-09-11', asset_type: '負債', amount_yen: -200000 },
    ],
  });
}

const NOW = new Date('2026-09-11T12:00:00+09:00');

describe('finance query layer', () => {
  it('activeスナップショットの鮮度と件数を返す', async () => {
    const db = fixture();
    const result = await getDataFreshness(db, { now: NOW });
    expect(result.data.status).toBe('active');
    expect(result.data.counts.daily).toBe(8);
    expect(result.meta.freshness).toBe('fresh');
  });

  it('同期完了から24時間超でstale、72時間超でexpiredになる', async () => {
    const db = fixture();
    expect((await getDataFreshness(db, {
      now: new Date('2026-09-12T07:31:00+09:00'),
    })).meta.freshness).toBe('stale');
    expect((await getDataFreshness(db, {
      now: new Date('2026-09-14T07:31:00+09:00'),
    })).meta.freshness).toBe('expired');
  });

  it('月次サマリーは指定月だけを返し、存在しない月を補正しない', async () => {
    const db = fixture();
    const result = await getMonthlySummary(db, { month: '2026-07' }, { now: NOW });
    expect(result.data).toBeNull();
    expect(result.available_months).toEqual(['2026-09', '2026-08']);
  });

  it('カテゴリ一覧は金額順とlimitを適用する', async () => {
    const db = fixture();
    const result = await getCategoryBreakdown(
      db,
      { month: '2026-09', direction: 'expense', limit: 1 },
      { now: NOW }
    );
    expect(result.data.items).toEqual([{ category: '食費', amount_yen: 18000, transaction_count: 4 }]);
    expect(result.data.total_yen).toBe(22000);
    expect(result.data.other_yen).toBe(4000);
  });

  it('月・日付・limitの入力形式を検証する', async () => {
    const db = fixture();
    await expect(getMonthlySummary(db, { month: '2026-13' }, { now: NOW }))
      .rejects.toMatchObject({ code: 'invalid_month' });
    await expect(compareMonths(
      db,
      { base_month: '2026-09', compare_month: '2026-08', as_of: '2026-02-30' },
      { now: NOW }
    )).rejects.toMatchObject({ code: 'invalid_date' });
    await expect(getCategoryBreakdown(
      db,
      { month: '2026-09', limit: 21 },
      { now: NOW }
    )).rejects.toMatchObject({ code: 'invalid_limit' });
  });

  it('今月の食費は当日までと先月同日までを比較する', async () => {
    const db = fixture();
    const result = await compareMonths(
      db,
      {
        base_month: '2026-09',
        compare_month: '2026-08',
        category: '食費',
        direction: 'expense',
      },
      { now: NOW }
    );
    expect(result.data.period_mode).toBe('month_to_date_same_day');
    expect(result.data.periods).toEqual({
      base: { start: '2026-09-01', end: '2026-09-11' },
      compare: { start: '2026-08-01', end: '2026-08-11' },
    });
    expect(result.data.category.base_yen).toBe(18000);
    expect(result.data.category.compare_yen).toBe(9000);
    expect(result.data.category.delta_yen).toBe(9000);
    expect(result.data.category.change_rate).toBe(1);
    expect(result.data.metrics.expense.delta_yen).toBe(11000);
  });

  it('同日比較で比較先の月末へ日付を丸める', async () => {
    const db = fixture();
    const result = await compareMonths(
      db,
      { base_month: '2026-09', compare_month: '2026-02', period_mode: 'month_to_date_same_day' },
      { now: new Date('2026-09-30T12:00:00+09:00') }
    );
    expect(result.data.periods.base.end).toBe('2026-09-30');
    expect(result.data.periods.compare.end).toBe('2026-02-28');
  });

  it('full_monthでは月次集計を使い、分母0の増減率はnullにする', async () => {
    const db = fixture();
    const result = await compareMonths(
      db,
      {
        base_month: '2026-09',
        compare_month: '2026-08',
        period_mode: 'full_month',
        category: '未分類',
      },
      { now: NOW }
    );
    expect(result.data.period_mode).toBe('full_month');
    expect(result.data.category.base_yen).toBe(0);
    expect(result.data.category.compare_yen).toBe(0);
    expect(result.data.category.change_rate).toBeNull();
  });

  it('日次データがない同期間比較はunsupported_granularityで停止する', async () => {
    const db = fixture({ withDaily: false });
    await expect(compareMonths(
      db,
      { base_month: '2026-09', compare_month: '2026-08' },
      { now: NOW }
    )).rejects.toMatchObject({ code: 'unsupported_granularity' });
  });

  it('資産は負債と純資産を分離して返す', async () => {
    const db = fixture();
    const result = await getAssetSummary(db, {}, { now: NOW });
    expect(result.data.total_assets_yen).toBe(1000000);
    expect(result.data.total_liabilities_yen).toBe(200000);
    expect(result.data.net_assets_yen).toBe(800000);
  });

  it('query層はSELECT以外のSQLを発行しない', async () => {
    const db = fixture();
    await getDataFreshness(db, { now: NOW });
    await getMonthlySummary(db, { month: '2026-09' }, { now: NOW });
    await getCategoryBreakdown(db, { month: '2026-09' }, { now: NOW });
    await compareMonths(
      db,
      { base_month: '2026-09', compare_month: '2026-08', category: '食費' },
      { now: NOW }
    );
    await getAssetSummary(db, {}, { now: NOW });
    expect(db.sqlLog.every((sql) => /^SELECT\b/i.test(sql))).toBe(true);
  });

  it('activeスナップショットがない場合は値を返さない', async () => {
    const db = fixture();
    db.tables.sync_runs[0].status = 'failed';
    await expect(getMonthlySummary(db, { month: '2026-09' }, { now: NOW }))
      .rejects.toBeInstanceOf(FinanceQueryError);
    const freshness = await getDataFreshness(db, { now: NOW });
    expect(freshness.data.status).toBe('unavailable');
  });
});

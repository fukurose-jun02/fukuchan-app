import { describe, expect, it } from 'vitest';

import { importDetailedCsv, importMonthlyCsv, parseCsvRows } from './csv-importer.js';

describe('manual monthly CSV importer', () => {
  it('aggregates monthly categories and discards memo columns', () => {
    const csv = [
      '年月,カテゴリ,金額,メモ,方向',
      '2026-07,食費,"1,200円",秘密の店舗名,支出',
      '2026/07,食費,800,別のメモ,支出',
      '2026年8月,住居費,70000,非公開メモ,支出',
      '2026-08,給与,-100000,給与のメモ,収入',
    ].join('\n');

    const snapshot = importMonthlyCsv(csv, { asOf: '2026-09-14T12:00:00.000Z' });

    expect(snapshot).toMatchObject({
      status: 'READY',
      granularity: 'monthly_only',
      sourceDate: '2026-08-31',
      counts: { daily: 0, monthly: 2, categories: 3, assets: 0 },
    });
    expect(snapshot.summaries.monthly).toEqual([
      { month: '2026-07', incomeYen: 0, expenseYen: 2000, balanceYen: -2000, transactionCount: 2 },
      { month: '2026-08', incomeYen: 100000, expenseYen: 70000, balanceYen: 30000, transactionCount: 2 },
    ]);
    expect(snapshot.summaries.categories).toEqual([
      { month: '2026-07', direction: 'expense', category: '食費', amountYen: 2000, transactionCount: 2 },
      { month: '2026-08', direction: 'expense', category: '住居費', amountYen: 70000, transactionCount: 1 },
      { month: '2026-08', direction: 'income', category: '給与', amountYen: 100000, transactionCount: 1 },
    ]);
    expect(JSON.stringify(snapshot)).not.toContain('秘密の店舗名');
    expect(JSON.stringify(snapshot)).not.toContain('メモ');
  });

  it('supports quoted newlines and escaped quotes without returning raw fields', () => {
    const rows = parseCsvRows('年月,カテゴリ,金額,メモ\n2026-08,"食費",1,"秘密\n""メモ"""');
    expect(rows).toHaveLength(2);
    const snapshot = importMonthlyCsv(rows.map((row) => row.map((value) => (
      value.includes(',') || value.includes('\n') ? `"${value.replaceAll('"', '""')}"` : value
    )).join(',')).join('\n'), { asOf: '2026-09-14T12:00:00.000Z' });
    expect(snapshot.summaries.categories[0]).toMatchObject({ category: '食費', amountYen: 1 });
    expect(JSON.stringify(snapshot)).not.toContain('秘密');
  });

  it('fails closed for missing headers and invalid amounts', () => {
    expect(() => importMonthlyCsv('年月,カテゴリ\n2026-08,食費', { asOf: '2026-09-14T00:00:00Z' }))
      .toThrow('required_csv_header_missing');
    expect(() => importMonthlyCsv('年月,カテゴリ,金額\n2026-08,食費,1.5', { asOf: '2026-09-14T00:00:00Z' }))
      .toThrow('invalid_csv_amount');
  });

  it('aggregates Money Forward detail CSV by month and ignores transfers and sensitive columns', () => {
    const csv = [
      '計算対象,日付,内容,金額（円）,保有金融機関,大項目,中項目,メモ,振替,ID',
      '対象,2026/08/01,秘密の店舗,-1200,秘密の銀行,食費,外食,秘密のメモ,,id-1',
      '対象,2026/08/02,給与,100000,秘密の銀行,給与,給与,秘密のメモ,,id-2',
      '０,2026/08/02,対象外の明細,-99999,秘密の銀行,食費,対象外,秘密のメモ,,id-0',
      '対象,2026/08/03,振替,-5000,秘密の銀行,食費,移動,秘密のメモ,振替,id-3',
    ].join('\n');

    const snapshot = importDetailedCsv(csv, { asOf: '2026-09-15T00:00:00+09:00' });

    expect(snapshot.summaries.monthly).toEqual([
      { month: '2026-08', incomeYen: 100000, expenseYen: 1200, balanceYen: 98800, transactionCount: 2 },
    ]);
    expect(snapshot.summaries.categories).toEqual([
      { month: '2026-08', direction: 'expense', category: '食費', amountYen: 1200, transactionCount: 1 },
      { month: '2026-08', direction: 'income', category: '給与', amountYen: 100000, transactionCount: 1 },
    ]);
    expect(JSON.stringify(snapshot)).not.toMatch(/秘密の店舗|秘密の銀行|秘密のメモ|id-1/);
  });
});

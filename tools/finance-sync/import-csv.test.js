import { describe, expect, it } from 'vitest';

import { renderD1Sql } from './import-csv.mjs';

describe('manual CSV SQL renderer', () => {
  it('binds and escapes only aggregate values', () => {
    const sql = renderD1Sql({
      statements: [{
        sql: 'INSERT INTO category_totals (category, amount_yen) VALUES (?, ?)',
        params: ["食費'その他", 1200],
      }],
    });
    expect(sql).toContain("'食費''その他'");
    expect(sql).toContain('1200');
    expect(sql).not.toContain('?');
    expect(sql).not.toContain('BEGIN TRANSACTION');
    expect(sql).not.toContain('memo');
  });
});

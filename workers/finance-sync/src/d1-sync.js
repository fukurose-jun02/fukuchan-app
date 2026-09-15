import { normalizeAggregateSnapshot } from '../login-poc/src/workflow.js';

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const ISO_MONTH = /^(\d{4})-(0[1-9]|1[0-2])$/;
const SAFE_ID = /^[A-Za-z0-9_-]{1,128}$/;
const SAFE_VERSION = /^[A-Za-z0-9._-]{1,64}$/;
const DIRECTIONS = new Set(['income', 'expense']);

function fail(code) {
  throw new Error(code);
}

function isValidCalendarDate(value) {
  const match = ISO_DATE.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const candidate = new Date(Date.UTC(year, month - 1, day));
  return candidate.getUTCFullYear() === year
    && candidate.getUTCMonth() === month - 1
    && candidate.getUTCDate() === day;
}

function validateDate(value, field) {
  if (typeof value !== 'string' || !isValidCalendarDate(value)) fail(`invalid_${field}`);
  return value;
}

function validateMonth(value, field) {
  if (typeof value !== 'string' || !ISO_MONTH.test(value)) fail(`invalid_${field}`);
  return value;
}

function validateInteger(value, field, { min = Number.MIN_SAFE_INTEGER } = {}) {
  if (!Number.isSafeInteger(value) || value < min) fail(`invalid_${field}`);
  return value;
}

function validateText(value, field, maxLength) {
  if (typeof value !== 'string' || value.trim() === '' || value.length > maxLength) {
    fail(`invalid_${field}`);
  }
  return value;
}

function validateDirection(value) {
  if (!DIRECTIONS.has(value)) fail('invalid_direction');
  return value;
}

function validateDateTime(value, field) {
  if (typeof value !== 'string' || Number.isNaN(Date.parse(value))) fail(`invalid_${field}`);
  return value;
}

function rowKey(...values) {
  return values.join('|');
}

function addTotals(target, key, row) {
  const current = target.get(key) ?? { amountYen: 0, transactionCount: 0 };
  current.amountYen += row.amountYen;
  current.transactionCount += row.transactionCount;
  target.set(key, current);
}

function addDailyTotals(target, key, row) {
  const current = target.get(key) ?? {
    incomeYen: 0,
    expenseYen: 0,
    balanceYen: 0,
    transactionCount: 0,
  };
  current.incomeYen += row.incomeYen;
  current.expenseYen += row.expenseYen;
  current.balanceYen += row.balanceYen;
  current.transactionCount += row.transactionCount;
  target.set(key, current);
}

function assertEqual(actual, expected, code) {
  if (actual !== expected) fail(code);
}

function normalizeMonthlyRows(monthly) {
  if (Array.isArray(monthly)) return monthly;
  if (monthly && typeof monthly === 'object') return [monthly];
  fail('invalid_monthly_summaries');
}

function validateDailyRows(rows) {
  if (!Array.isArray(rows)) fail('invalid_daily_summaries');
  const keys = new Set();
  return rows.map((row) => {
    const date = validateDate(row?.date, 'daily_date');
    if (keys.has(date)) fail('duplicate_daily_date');
    keys.add(date);
    return {
      date,
      incomeYen: validateInteger(row.incomeYen, 'daily_income_yen', { min: 0 }),
      expenseYen: validateInteger(row.expenseYen, 'daily_expense_yen', { min: 0 }),
      balanceYen: validateInteger(row.balanceYen, 'daily_balance_yen'),
      transactionCount: validateInteger(row.transactionCount, 'daily_transaction_count', { min: 0 }),
    };
  });
}

function validateMonthlyRows(rows) {
  const keys = new Set();
  return rows.map((row) => {
    const month = validateMonth(row?.month, 'monthly_month');
    if (keys.has(month)) fail('duplicate_monthly_month');
    keys.add(month);
    return {
      month,
      incomeYen: validateInteger(row.incomeYen, 'monthly_income_yen', { min: 0 }),
      expenseYen: validateInteger(row.expenseYen, 'monthly_expense_yen', { min: 0 }),
      balanceYen: validateInteger(row.balanceYen, 'monthly_balance_yen'),
      transactionCount: validateInteger(row.transactionCount, 'monthly_transaction_count', { min: 0 }),
    };
  });
}

function validateCategoryRows(rows, { daily }) {
  if (!Array.isArray(rows)) fail(daily ? 'invalid_category_daily_totals' : 'invalid_category_totals');
  const keys = new Set();
  return rows.map((row) => {
    const periodField = daily ? 'category_daily_date' : 'category_month';
    const period = daily
      ? validateDate(row?.date, periodField)
      : validateMonth(row?.month, periodField);
    const direction = validateDirection(row?.direction);
    const category = validateText(row?.category, 'category', 200);
    const key = rowKey(period, direction, category);
    if (keys.has(key)) fail(daily ? 'duplicate_category_daily_total' : 'duplicate_category_total');
    keys.add(key);
    return {
      ...(daily ? { date: period } : { month: period }),
      direction,
      category,
      amountYen: validateInteger(row.amountYen, 'category_amount_yen', { min: 0 }),
      transactionCount: validateInteger(row.transactionCount, 'category_transaction_count', { min: 0 }),
    };
  });
}

function validateAssetRows(rows) {
  if (!Array.isArray(rows)) fail('invalid_asset_summaries');
  const keys = new Set();
  return rows.map((row) => {
    const asOfDate = validateDate(row?.asOfDate, 'asset_as_of_date');
    const assetType = validateText(row?.assetType, 'asset_type', 100);
    const key = rowKey(asOfDate, assetType);
    if (keys.has(key)) fail('duplicate_asset_summary');
    keys.add(key);
    return {
      asOfDate,
      assetType,
      amountYen: validateInteger(row.amountYen, 'asset_amount_yen'),
    };
  });
}

function assertConsistentTotals(daily, monthly, categoryDaily, categories) {
  const monthlyByMonth = new Map(monthly.map((row) => [row.month, row]));
  const dailyByMonth = new Map();
  for (const row of daily) {
    addDailyTotals(dailyByMonth, row.date.slice(0, 7), row);
  }
  for (const [month, totals] of dailyByMonth) {
    const expected = monthlyByMonth.get(month);
    if (!expected) fail('daily_month_not_in_monthly');
    assertEqual(totals.incomeYen, expected.incomeYen, 'inconsistent_monthly_income');
    assertEqual(totals.expenseYen, expected.expenseYen, 'inconsistent_monthly_expense');
    assertEqual(totals.balanceYen, expected.balanceYen, 'inconsistent_monthly_balance');
    assertEqual(totals.transactionCount, expected.transactionCount, 'inconsistent_monthly_transaction_count');
  }
  for (const month of monthlyByMonth.keys()) {
    const totals = dailyByMonth.get(month) ?? { incomeYen: 0, expenseYen: 0, balanceYen: 0, transactionCount: 0 };
    const expected = monthlyByMonth.get(month);
    assertEqual(totals.incomeYen, expected.incomeYen, 'inconsistent_monthly_income');
    assertEqual(totals.expenseYen, expected.expenseYen, 'inconsistent_monthly_expense');
    assertEqual(totals.balanceYen, expected.balanceYen, 'inconsistent_monthly_balance');
    assertEqual(totals.transactionCount, expected.transactionCount, 'inconsistent_monthly_transaction_count');
  }

  const dailyCategoryByKey = new Map();
  for (const row of categoryDaily) {
    addTotals(dailyCategoryByKey, rowKey(row.date, row.direction, row.category), row);
  }
  const categoryByKey = new Map();
  for (const row of categories) {
    addTotals(categoryByKey, rowKey(`${row.month}`, row.direction, row.category), row);
  }
  const dailyCategoryByMonthKey = new Map();
  for (const row of categoryDaily) {
    addTotals(dailyCategoryByMonthKey, rowKey(row.date.slice(0, 7), row.direction, row.category), row);
  }
  for (const row of categories) {
    const dailyTotal = dailyCategoryByMonthKey.get(rowKey(row.month, row.direction, row.category));
    if (!dailyTotal) fail('category_daily_missing');
    assertEqual(dailyTotal.amountYen, row.amountYen, 'inconsistent_category_amount');
    assertEqual(dailyTotal.transactionCount, row.transactionCount, 'inconsistent_category_transaction_count');
  }
  for (const [key, dailyTotal] of dailyCategoryByMonthKey) {
    const categoryTotal = categoryByKey.get(key);
    if (!categoryTotal) fail('category_month_missing');
    assertEqual(dailyTotal.amountYen, categoryTotal.amountYen, 'inconsistent_category_amount');
    assertEqual(dailyTotal.transactionCount, categoryTotal.transactionCount, 'inconsistent_category_transaction_count');
  }
  for (const row of categoryDaily) {
    const dateTotal = dailyCategoryByKey.get(rowKey(row.date, row.direction, row.category));
    if (!dateTotal) fail('category_daily_missing');
  }
}

function assertMonthlyCategoryTotals(monthly, categories) {
  const monthlyByKey = new Map();
  for (const row of monthly) {
    monthlyByKey.set(row.month, row);
  }

  const categoryByMonth = new Map();
  for (const row of categories) {
    const totals = categoryByMonth.get(row.month) ?? {
      incomeYen: 0,
      expenseYen: 0,
      transactionCount: 0,
    };
    if (row.direction === 'income') totals.incomeYen += row.amountYen;
    else totals.expenseYen += row.amountYen;
    totals.transactionCount += row.transactionCount;
    categoryByMonth.set(row.month, totals);
  }

  for (const [month, expected] of monthlyByKey) {
    const actual = categoryByMonth.get(month) ?? {
      incomeYen: 0,
      expenseYen: 0,
      transactionCount: 0,
    };
    assertEqual(actual.incomeYen, expected.incomeYen, 'inconsistent_monthly_income');
    assertEqual(actual.expenseYen, expected.expenseYen, 'inconsistent_monthly_expense');
    assertEqual(actual.transactionCount, expected.transactionCount, 'inconsistent_monthly_transaction_count');
    assertEqual(expected.balanceYen, expected.incomeYen - expected.expenseYen, 'inconsistent_monthly_balance');
  }

  for (const month of categoryByMonth.keys()) {
    if (!monthlyByKey.has(month)) fail('category_month_missing');
  }
}

export function validateAggregateSnapshotForD1(value) {
  const snapshot = normalizeAggregateSnapshot(value);
  const daily = validateDailyRows(snapshot.summaries.daily);
  const monthly = validateMonthlyRows(normalizeMonthlyRows(snapshot.summaries.monthly));
  const categoryDaily = validateCategoryRows(snapshot.summaries.categoryDaily, { daily: true });
  const categories = validateCategoryRows(snapshot.summaries.categories, { daily: false });
  const assets = validateAssetRows(snapshot.summaries.assets);

  assertEqual(snapshot.counts.daily, daily.length, 'daily_count_mismatch');
  assertEqual(snapshot.counts.monthly, monthly.length, 'monthly_count_mismatch');
  assertEqual(snapshot.counts.categories, categories.length, 'category_count_mismatch');
  assertEqual(snapshot.counts.assets, assets.length, 'asset_count_mismatch');
  if (snapshot.granularity === 'monthly_only') {
    if (daily.length > 0) fail('monthly_only_contains_daily');
    if (categoryDaily.length > 0) fail('monthly_only_contains_category_daily');
    assertMonthlyCategoryTotals(monthly, categories);
  } else {
    assertConsistentTotals(daily, monthly, categoryDaily, categories);
  }

  return {
    ...snapshot,
    counts: { ...snapshot.counts },
    summaries: { daily, monthly, categoryDaily, categories, assets },
  };
}

function validateMetadata(metadata = {}) {
  const syncId = metadata.syncId;
  if (typeof syncId !== 'string' || !SAFE_ID.test(syncId)) fail('invalid_sync_id');
  const sourceVersion = metadata.sourceVersion ?? 'money-forward-web-v1';
  if (typeof sourceVersion !== 'string' || !SAFE_VERSION.test(sourceVersion)) fail('invalid_source_version');
  const startedAt = validateDateTime(metadata.startedAt, 'started_at');
  const completedAt = validateDateTime(metadata.completedAt, 'completed_at');
  return { syncId, sourceVersion, startedAt, completedAt };
}

function statement(sql, params) {
  return { sql, params };
}

export function buildD1SyncPlan(value, metadata) {
  const snapshot = validateAggregateSnapshotForD1(value);
  const { syncId, sourceVersion, startedAt, completedAt } = validateMetadata(metadata);
  const { counts, sourceDate } = snapshot;
  const { daily, monthly, categoryDaily, categories, assets } = snapshot.summaries;
  const statements = [statement(
    `INSERT INTO sync_runs
      (sync_id, started_at, source_version, status, source_max_date,
       daily_count, monthly_count, category_count, asset_count)
     VALUES (?, ?, ?, 'staging', ?, ?, ?, ?, ?)`,
    [syncId, startedAt, sourceVersion, sourceDate, counts.daily, counts.monthly, counts.categories, counts.assets]
  )];

  for (const row of daily) {
    statements.push(statement(
      `INSERT INTO daily_summaries
        (sync_id, date, income_yen, expense_yen, balance_yen, transaction_count)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [syncId, row.date, row.incomeYen, row.expenseYen, row.balanceYen, row.transactionCount]
    ));
  }
  for (const row of monthly) {
    statements.push(statement(
      `INSERT INTO monthly_summaries
        (sync_id, month, income_yen, expense_yen, balance_yen, transaction_count)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [syncId, row.month, row.incomeYen, row.expenseYen, row.balanceYen, row.transactionCount]
    ));
  }
  for (const row of categoryDaily) {
    statements.push(statement(
      `INSERT INTO category_daily_totals
        (sync_id, date, direction, category, amount_yen, transaction_count)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [syncId, row.date, row.direction, row.category, row.amountYen, row.transactionCount]
    ));
  }
  for (const row of categories) {
    statements.push(statement(
      `INSERT INTO category_totals
        (sync_id, month, direction, category, amount_yen, transaction_count)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [syncId, row.month, row.direction, row.category, row.amountYen, row.transactionCount]
    ));
  }
  for (const row of assets) {
    statements.push(statement(
      `INSERT INTO asset_summaries
        (sync_id, as_of_date, asset_type, amount_yen)
       VALUES (?, ?, ?, ?)`,
      [syncId, row.asOfDate, row.assetType, row.amountYen]
    ));
  }

  // D1 batch is atomic: if activation fails, the previous active snapshot stays active.
  statements.push(statement(
    `UPDATE sync_runs
        SET status = 'superseded'
      WHERE status = 'active' AND sync_id <> ?`,
    [syncId]
  ));
  statements.push(statement(
    `UPDATE sync_runs
        SET status = 'active', completed_at = ?
      WHERE sync_id = ? AND status = 'staging'`,
    [completedAt, syncId]
  ));

  return { syncId, status: 'active', granularity: snapshot.granularity, counts, statements };
}

export async function writeAggregateSnapshotToD1(db, value, metadata) {
  if (!db || typeof db.prepare !== 'function' || typeof db.batch !== 'function') {
    throw new Error('d1_binding_required');
  }
  const plan = buildD1SyncPlan(value, metadata);
  const batch = plan.statements.map(({ sql, params }) => db.prepare(sql).bind(...params));
  const result = await db.batch(batch);
  return {
    syncId: plan.syncId,
    status: plan.status,
    granularity: plan.granularity,
    counts: plan.counts,
    result,
  };
}

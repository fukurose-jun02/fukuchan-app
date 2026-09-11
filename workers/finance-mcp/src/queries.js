const ISO_MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const VALID_DIRECTIONS = new Set(['income', 'expense']);
const VALID_PERIOD_MODES = new Set(['auto', 'month_to_date_same_day', 'full_month']);
const FRESH_MS = 24 * 60 * 60 * 1000;
const EXPIRED_MS = 72 * 60 * 60 * 1000;

export class FinanceQueryError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'FinanceQueryError';
    this.code = code;
    this.details = details;
  }
}

export function validateMonth(month) {
  if (typeof month !== 'string' || !ISO_MONTH.test(month)) {
    throw new FinanceQueryError('invalid_month', 'month must be YYYY-MM');
  }
  return month;
}

export function validateDate(date, field = 'date') {
  if (typeof date !== 'string' || !ISO_DATE.test(date)) {
    throw new FinanceQueryError('invalid_date', `${field} must be YYYY-MM-DD`);
  }
  const [year, month, day] = date.split('-').map(Number);
  if (month < 1 || month > 12) {
    throw new FinanceQueryError('invalid_date', `${field} is not a calendar date`);
  }
  if (day < 1 || day > daysInMonth(year, month)) {
    throw new FinanceQueryError('invalid_date', `${field} is not a calendar date`);
  }
  return date;
}

export function validateDirection(direction = 'expense') {
  if (!VALID_DIRECTIONS.has(direction)) {
    throw new FinanceQueryError('invalid_direction', 'direction must be income or expense');
  }
  return direction;
}

export function validatePeriodMode(periodMode = 'auto') {
  if (!VALID_PERIOD_MODES.has(periodMode)) {
    throw new FinanceQueryError(
      'invalid_period_mode',
      'period_mode must be auto, month_to_date_same_day, or full_month'
    );
  }
  return periodMode;
}

function number(value) {
  const result = Number(value);
  return Number.isFinite(result) ? result : 0;
}

function isoDateInTokyo(now = new Date()) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Tokyo',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(now);
  const values = Object.fromEntries(parts.map(({ type, value }) => [type, value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function daysInMonth(year, month) {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function monthEnd(month) {
  const [year, monthNumber] = month.split('-').map(Number);
  return `${month}-${String(daysInMonth(year, monthNumber)).padStart(2, '0')}`;
}

function monthStart(month) {
  return `${month}-01`;
}

function clampDay(month, day) {
  const [year, monthNumber] = month.split('-').map(Number);
  return `${month}-${String(Math.min(day, daysInMonth(year, monthNumber))).padStart(2, '0')}`;
}

function change(baseYen, compareYen) {
  const deltaYen = baseYen - compareYen;
  return {
    base_yen: baseYen,
    compare_yen: compareYen,
    delta_yen: deltaYen,
    change_rate: compareYen === 0 ? null : deltaYen / compareYen,
  };
}

function freshness(completedAt, now = new Date()) {
  const completedMs = Date.parse(completedAt || '');
  // テストと再現可能な照会のため、呼び出し側のnowを使う。
  const referenceMs = now instanceof Date ? now.getTime() : Date.parse(now);
  const age = referenceMs - completedMs;
  if (!Number.isFinite(completedMs) || age > EXPIRED_MS) return 'expired';
  if (age > FRESH_MS) return 'stale';
  return 'fresh';
}

function metaFor(sync, now = new Date(), extra = {}) {
  return {
    syncId: sync?.sync_id ?? null,
    asOf: sync?.completed_at ?? null,
    freshness: sync ? freshness(sync.completed_at, now) : 'expired',
    currency: 'JPY',
    sourceMaxDate: sync?.source_max_date ?? null,
    ...extra,
  };
}

async function first(db, sql, params = []) {
  return db.prepare(sql).bind(...params).first();
}

async function all(db, sql, params = []) {
  const result = await db.prepare(sql).bind(...params).all();
  return result?.results ?? [];
}

async function activeSync(db) {
  const sync = await first(
    db,
    `SELECT sync_id, completed_at, source_version, source_max_date,
            daily_count, monthly_count, category_count, asset_count
       FROM sync_runs
      WHERE status = 'active'
      ORDER BY completed_at DESC
      LIMIT 1`
  );
  if (!sync) {
    throw new FinanceQueryError('no_active_sync', 'active finance snapshot is unavailable');
  }
  return sync;
}

export async function getDataFreshness(db, { now = new Date() } = {}) {
  const sync = await first(
    db,
    `SELECT sync_id, completed_at, source_version, source_max_date,
            daily_count, monthly_count, category_count, asset_count, status
       FROM sync_runs
      WHERE status = 'active'
      ORDER BY completed_at DESC
      LIMIT 1`
  );
  if (!sync) {
    return {
      data: { status: 'unavailable', reason: 'no_active_sync' },
      meta: metaFor(null, now),
    };
  }
  return {
    data: {
      status: sync.status,
      completed_at: sync.completed_at,
      source_version: sync.source_version,
      source_max_date: sync.source_max_date,
      counts: {
        daily: number(sync.daily_count),
        monthly: number(sync.monthly_count),
        category: number(sync.category_count),
        asset: number(sync.asset_count),
      },
    },
    meta: metaFor(sync, now),
  };
}

export async function getMonthlySummary(db, { month } = {}, { now = new Date() } = {}) {
  const sync = await activeSync(db);
  const targetMonth = month
    ? validateMonth(month)
    : (await first(
        db,
        `SELECT month FROM monthly_summaries WHERE sync_id = ? ORDER BY month DESC LIMIT 1`,
        [sync.sync_id]
      ))?.month;
  if (!targetMonth) {
    return { data: null, meta: metaFor(sync, now), available_months: [] };
  }

  const row = await first(
    db,
    `SELECT month, income_yen, expense_yen, balance_yen, transaction_count
       FROM monthly_summaries
      WHERE sync_id = ? AND month = ?`,
    [sync.sync_id, targetMonth]
  );
  if (!row) {
    const available = await all(
      db,
      `SELECT month FROM monthly_summaries WHERE sync_id = ? ORDER BY month DESC`,
      [sync.sync_id]
    );
    return { data: null, meta: metaFor(sync, now), available_months: available.map((item) => item.month) };
  }
  return {
    data: {
      month: row.month,
      income_yen: number(row.income_yen),
      expense_yen: number(row.expense_yen),
      balance_yen: number(row.balance_yen),
      transaction_count: number(row.transaction_count),
    },
    meta: metaFor(sync, now),
  };
}

export async function getCategoryBreakdown(
  db,
  { month, direction = 'expense', limit = 10 } = {},
  { now = new Date() } = {}
) {
  const sync = await activeSync(db);
  const targetMonth = validateMonth(month);
  const targetDirection = validateDirection(direction);
  const targetLimit = limit === undefined ? 10 : Number(limit);
  if (!Number.isInteger(targetLimit) || targetLimit < 1 || targetLimit > 20) {
    throw new FinanceQueryError('invalid_limit', 'limit must be an integer between 1 and 20');
  }

  const rows = await all(
    db,
    `SELECT category, amount_yen, transaction_count
       FROM category_totals
      WHERE sync_id = ? AND month = ? AND direction = ?
      ORDER BY amount_yen DESC, category ASC
      LIMIT ?`,
    [sync.sync_id, targetMonth, targetDirection, targetLimit]
  );
  const totalRow = await first(
    db,
    `SELECT COALESCE(SUM(amount_yen), 0) AS total_yen
       FROM category_totals
      WHERE sync_id = ? AND month = ? AND direction = ?`,
    [sync.sync_id, targetMonth, targetDirection]
  );
  const totalYen = number(totalRow?.total_yen);
  const items = rows.map((row) => ({
    category: row.category,
    amount_yen: number(row.amount_yen),
    transaction_count: number(row.transaction_count),
  }));
  const listedYen = items.reduce((sum, item) => sum + item.amount_yen, 0);
  return {
    data: {
      month: targetMonth,
      direction: targetDirection,
      items,
      total_yen: totalYen,
      other_yen: Math.max(0, totalYen - listedYen),
    },
    meta: metaFor(sync, now),
  };
}

function resolvePeriods(baseMonth, compareMonth, periodMode, effectiveDate) {
  const effectiveMonth = effectiveDate.slice(0, 7);
  const actualMode = periodMode === 'auto'
    ? (baseMonth === effectiveMonth ? 'month_to_date_same_day' : 'full_month')
    : periodMode;
  if (actualMode === 'full_month') {
    return {
      actualMode,
      base: { start: monthStart(baseMonth), end: monthEnd(baseMonth) },
      compare: { start: monthStart(compareMonth), end: monthEnd(compareMonth) },
    };
  }
  const day = Number(effectiveDate.slice(8, 10));
  return {
    actualMode,
    base: { start: monthStart(baseMonth), end: clampDay(baseMonth, day) },
    compare: { start: monthStart(compareMonth), end: clampDay(compareMonth, day) },
  };
}

async function dailySummary(db, syncId, period) {
  const available = await first(
    db,
    `SELECT COUNT(*) AS row_count FROM daily_summaries WHERE sync_id = ?`,
    [syncId]
  );
  if (number(available?.row_count) === 0) {
    throw new FinanceQueryError(
      'unsupported_granularity',
      'daily summaries are required for same-period comparison'
    );
  }
  return first(
    db,
    `SELECT COALESCE(SUM(income_yen), 0) AS income_yen,
            COALESCE(SUM(expense_yen), 0) AS expense_yen,
            COALESCE(SUM(balance_yen), 0) AS balance_yen,
            COALESCE(SUM(transaction_count), 0) AS transaction_count
       FROM daily_summaries
      WHERE sync_id = ? AND date BETWEEN ? AND ?`,
    [syncId, period.start, period.end]
  );
}

async function monthlySummary(db, syncId, month) {
  return first(
    db,
    `SELECT income_yen, expense_yen, balance_yen, transaction_count
       FROM monthly_summaries
      WHERE sync_id = ? AND month = ?`,
    [syncId, month]
  );
}

async function categoryPeriodTotal(db, syncId, period, category, direction, daily) {
  const table = daily ? 'category_daily_totals' : 'category_totals';
  const dateOrMonth = daily ? 'date' : 'month';
  const sql = daily
    ? `SELECT COALESCE(SUM(amount_yen), 0) AS amount_yen
         FROM ${table}
        WHERE sync_id = ? AND ${dateOrMonth} BETWEEN ? AND ?
          AND direction = ? AND category = ?`
    : `SELECT COALESCE(SUM(amount_yen), 0) AS amount_yen
         FROM ${table}
        WHERE sync_id = ? AND ${dateOrMonth} = ?
          AND direction = ? AND category = ?`;
  const params = daily
    ? [syncId, period.start, period.end, direction, category]
    : [syncId, period.month, direction, category];
  return first(db, sql, params);
}

async function ensureDailyCategoryData(db, syncId) {
  const available = await first(
    db,
    `SELECT COUNT(*) AS row_count FROM category_daily_totals WHERE sync_id = ?`,
    [syncId]
  );
  if (number(available?.row_count) === 0) {
    throw new FinanceQueryError(
      'unsupported_granularity',
      'daily category summaries are required for category comparison'
    );
  }
}

export async function compareMonths(
  db,
  {
    base_month: baseMonth,
    compare_month: compareMonth,
    category,
    direction = 'expense',
    period_mode: periodMode = 'auto',
    as_of: asOf,
  } = {},
  { now = new Date() } = {}
) {
  const sync = await activeSync(db);
  const base = validateMonth(baseMonth);
  const compare = validateMonth(compareMonth);
  const targetDirection = validateDirection(direction);
  const requestedMode = validatePeriodMode(periodMode);
  const effectiveDate = asOf ? validateDate(asOf, 'as_of') : isoDateInTokyo(now);
  const periods = resolvePeriods(base, compare, requestedMode, effectiveDate);
  const daily = periods.actualMode === 'month_to_date_same_day';

  const [baseRow, compareRow] = daily
    ? await Promise.all([
        dailySummary(db, sync.sync_id, periods.base),
        dailySummary(db, sync.sync_id, periods.compare),
      ])
    : await Promise.all([
        monthlySummary(db, sync.sync_id, base),
        monthlySummary(db, sync.sync_id, compare),
      ]);
  if (!baseRow || !compareRow) {
    throw new FinanceQueryError('month_not_found', 'one or both comparison months are unavailable', {
      base_month: base,
      compare_month: compare,
    });
  }

  const metrics = {};
  for (const key of ['income_yen', 'expense_yen', 'balance_yen']) {
    metrics[key.replace('_yen', '')] = change(number(baseRow[key]), number(compareRow[key]));
  }

  let categoryComparison = null;
  if (category !== undefined && category !== null && category !== '') {
    if (typeof category !== 'string' || category.length > 100) {
      throw new FinanceQueryError('invalid_category', 'category must be a string up to 100 characters');
    }
    if (daily) await ensureDailyCategoryData(db, sync.sync_id);
    const [baseCategory, compareCategory] = await Promise.all([
      categoryPeriodTotal(db, sync.sync_id, daily ? periods.base : { month: base }, category, targetDirection, daily),
      categoryPeriodTotal(db, sync.sync_id, daily ? periods.compare : { month: compare }, category, targetDirection, daily),
    ]);
    categoryComparison = {
      category,
      direction: targetDirection,
      ...change(number(baseCategory?.amount_yen), number(compareCategory?.amount_yen)),
    };
  }

  const lastPeriodDate = periods.base.end > periods.compare.end ? periods.base.end : periods.compare.end;
  const sourceCoverage = sync.source_max_date && sync.source_max_date < lastPeriodDate
    ? 'source_data_before_period_end'
    : null;
  return {
    data: {
      base_month: base,
      compare_month: compare,
      period_mode: periods.actualMode,
      periods: { base: periods.base, compare: periods.compare },
      metrics,
      category: categoryComparison,
      source_coverage: sourceCoverage,
    },
    meta: metaFor(sync, now),
  };
}

export async function getAssetSummary(db, { as_of: asOf } = {}, { now = new Date() } = {}) {
  const sync = await activeSync(db);
  const targetDate = asOf
    ? validateDate(asOf, 'as_of')
    : (await first(
        db,
        `SELECT as_of_date FROM asset_summaries WHERE sync_id = ? ORDER BY as_of_date DESC LIMIT 1`,
        [sync.sync_id]
      ))?.as_of_date;
  if (!targetDate) {
    return { data: null, meta: metaFor(sync, now) };
  }
  const rows = await all(
    db,
    `SELECT asset_type, amount_yen
       FROM asset_summaries
      WHERE sync_id = ? AND as_of_date = ?
      ORDER BY asset_type ASC`,
    [sync.sync_id, targetDate]
  );
  if (rows.length === 0) {
    return { data: null, meta: metaFor(sync, now) };
  }
  const items = rows.map((row) => ({ asset_type: row.asset_type, amount_yen: number(row.amount_yen) }));
  const totalAssets = items
    .filter((item) => item.amount_yen >= 0)
    .reduce((sum, item) => sum + item.amount_yen, 0);
  const totalLiabilities = items
    .filter((item) => item.amount_yen < 0)
    .reduce((sum, item) => sum + Math.abs(item.amount_yen), 0);
  return {
    data: {
      as_of: targetDate,
      items,
      total_assets_yen: totalAssets,
      total_liabilities_yen: totalLiabilities,
      net_assets_yen: totalAssets - totalLiabilities,
    },
    meta: metaFor(sync, now),
  };
}

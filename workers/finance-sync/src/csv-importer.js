import { normalizeAggregateSnapshot } from '../login-poc/src/workflow.js';

const REQUIRED_HEADERS = {
  month: ['年月', '月', 'month', '年月(YYYY-MM)'],
  category: ['カテゴリ', 'カテゴリー', 'category'],
  amount: ['金額', '金額(円)', 'amount', 'amount_yen'],
};

const OPTIONAL_HEADERS = {
  direction: ['方向', '収支', '区分', 'direction', 'type'],
};

const DETAIL_HEADERS = {
  date: ['日付', 'date'],
  amount: ['金額（円）', '金額(円)', '金額', 'amount', 'amount_yen'],
  category: ['大項目', 'カテゴリ', 'カテゴリー', 'category'],
  subcategory: ['中項目', 'subcategory'],
  transfer: ['振替', 'transfer'],
  calculation: ['計算対象', 'calculation_target'],
};

const DIRECTION_ALIASES = new Map([
  ['income', 'income'],
  ['expense', 'expense'],
  ['収入', 'income'],
  ['支出', 'expense'],
]);

function fail(code) {
  throw new Error(code);
}

function isBlankRow(row) {
  return row.every((value) => value.trim() === '');
}

/**
 * Parse RFC 4180-style CSV without exposing row contents in errors.
 * Blank rows are ignored; malformed quoting fails closed.
 */
export function parseCsvRows(csvText) {
  if (typeof csvText !== 'string' || csvText.length === 0) fail('empty_csv');

  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  let closedQuote = false;

  const pushField = () => {
    row.push(field);
    field = '';
    closedQuote = false;
  };
  const pushRow = () => {
    pushField();
    if (!isBlankRow(row)) rows.push(row);
    row = [];
  };

  for (let index = 0; index < csvText.length; index += 1) {
    const character = csvText[index];
    if (inQuotes) {
      if (character === '"') {
        if (csvText[index + 1] === '"') {
          field += '"';
          index += 1;
        } else {
          inQuotes = false;
          closedQuote = true;
        }
      } else {
        field += character;
      }
      continue;
    }

    if (closedQuote) {
      if (character === ',') {
        pushField();
      } else if (character === '\n') {
        pushRow();
      } else if (character === '\r') {
        if (csvText[index + 1] === '\n') index += 1;
        pushRow();
      } else if (character.trim() !== '') {
        fail('invalid_csv_quote');
      }
      continue;
    }

    if (character === '"' && field === '') {
      inQuotes = true;
    } else if (character === ',') {
      pushField();
    } else if (character === '\n') {
      pushRow();
    } else if (character === '\r') {
      if (csvText[index + 1] === '\n') index += 1;
      pushRow();
    } else {
      field += character;
    }
  }

  if (inQuotes) fail('unterminated_csv_quote');
  if (field !== '' || row.length > 0) pushRow();
  if (rows.length < 2) fail('csv_header_or_rows_missing');
  return rows;
}

function normalizeHeader(value) {
  return value.replace(/^\uFEFF/, '').trim().toLowerCase();
}

function findHeaderIndex(headers, aliases, { required = true } = {}) {
  const normalizedAliases = new Set(aliases.map((alias) => normalizeHeader(alias)));
  const indexes = headers
    .map((header, index) => (normalizedAliases.has(normalizeHeader(header)) ? index : -1))
    .filter((index) => index >= 0);
  if (indexes.length > 1) fail('duplicate_csv_header');
  if (required && indexes.length === 0) fail('required_csv_header_missing');
  return indexes[0] ?? -1;
}

function validateCalendarMonth(value) {
  const normalized = value.trim()
    .replace(/[年\/-]/g, '-')
    .replace(/月$/, '');
  const match = /^(\d{4})-(\d{1,2})$/.exec(normalized);
  if (!match) fail('invalid_csv_month');
  const year = Number(match[1]);
  const month = Number(match[2]);
  if (month < 1 || month > 12) fail('invalid_csv_month');
  return `${year}-${String(month).padStart(2, '0')}`;
}

function monthEnd(month) {
  const [year, monthNumber] = month.split('-').map(Number);
  return new Date(Date.UTC(year, monthNumber, 0)).toISOString().slice(0, 10);
}

function parseAmount(value) {
  return Math.abs(parseSignedAmount(value));
}

function parseSignedAmount(value) {
  const normalized = value.trim()
    .replace(/[−ー]/g, '-')
    .replace(/[円,\s]/g, '');
  if (!/^[+-]?\d+$/.test(normalized)) fail('invalid_csv_amount');
  const amount = Number(normalized);
  if (!Number.isSafeInteger(amount) || amount === 0) fail('invalid_csv_amount');
  return amount;
}

function parseDirection(value) {
  const direction = DIRECTION_ALIASES.get(value.trim().toLowerCase());
  if (!direction) fail('invalid_csv_direction');
  return direction;
}

function requireAsOf(asOf) {
  if (typeof asOf !== 'string' || Number.isNaN(Date.parse(asOf))) fail('invalid_as_of');
  const match = /^(\d{4}-\d{2}-\d{2})/.exec(asOf);
  return match ? match[1] : new Date(asOf).toISOString().slice(0, 10);
}

function parseDate(value) {
  const normalized = value.trim()
    .replace(/[年\/-]/g, '-')
    .replace(/月|日/g, '');
  const match = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(normalized);
  if (!match) fail('invalid_csv_date');
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const candidate = new Date(Date.UTC(year, month - 1, day));
  if (candidate.getUTCFullYear() !== year
    || candidate.getUTCMonth() !== month - 1
    || candidate.getUTCDate() !== day) {
    fail('invalid_csv_date');
  }
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function addMonthly(map, row) {
  const current = map.get(row.month) ?? {
    month: row.month,
    incomeYen: 0,
    expenseYen: 0,
    balanceYen: 0,
    transactionCount: 0,
  };
  if (row.direction === 'income') current.incomeYen += row.amountYen;
  else current.expenseYen += row.amountYen;
  current.balanceYen = current.incomeYen - current.expenseYen;
  current.transactionCount += 1;
  map.set(row.month, current);
}

function addCategory(map, row) {
  const key = `${row.month}|${row.direction}|${row.category}`;
  const current = map.get(key) ?? {
    month: row.month,
    direction: row.direction,
    category: row.category,
    amountYen: 0,
    transactionCount: 0,
  };
  current.amountYen += row.amountYen;
  current.transactionCount += 1;
  map.set(key, current);
}

function sortMonthly(left, right) {
  return left.month.localeCompare(right.month);
}

function sortCategory(left, right) {
  return left.month.localeCompare(right.month)
    || left.direction.localeCompare(right.direction)
    || left.category.localeCompare(right.category);
}

function buildMonthlyOnlySnapshot(records, { asOf } = {}) {
  const monthly = new Map();
  const categories = new Map();
  for (const record of records) {
    addMonthly(monthly, record);
    addCategory(categories, record);
  }

  if (monthly.size === 0) fail('csv_rows_missing');
  const asOfDate = requireAsOf(asOf);
  const latestMonth = [...monthly.keys()].sort().at(-1);
  const latestMonthEnd = monthEnd(latestMonth);
  const sourceDate = latestMonthEnd < asOfDate ? latestMonthEnd : asOfDate;

  return normalizeAggregateSnapshot({
    status: 'READY',
    granularity: 'monthly_only',
    asOf,
    sourceDate,
    counts: {
      daily: 0,
      monthly: monthly.size,
      categories: categories.size,
      assets: 0,
    },
    summaries: {
      daily: [],
      monthly: [...monthly.values()].sort(sortMonthly),
      categoryDaily: [],
      categories: [...categories.values()].sort(sortCategory),
      assets: [],
    },
  });
}

function importMonthlyRows(rows, { asOf } = {}) {
  const headers = rows[0];
  const monthIndex = findHeaderIndex(headers, REQUIRED_HEADERS.month);
  const categoryIndex = findHeaderIndex(headers, REQUIRED_HEADERS.category);
  const amountIndex = findHeaderIndex(headers, REQUIRED_HEADERS.amount);
  const directionIndex = findHeaderIndex(headers, OPTIONAL_HEADERS.direction, { required: false });

  const records = [];
  for (const row of rows.slice(1)) {
    const month = validateCalendarMonth(row[monthIndex] ?? '');
    const category = (row[categoryIndex] ?? '').trim();
    if (category === '' || category.length > 200) fail('invalid_csv_category');
    const amountYen = parseAmount(row[amountIndex] ?? '');
    const direction = directionIndex >= 0
      ? parseDirection(row[directionIndex] ?? '')
      : 'expense';
    records.push({ month, category, amountYen, direction });
  }
  return buildMonthlyOnlySnapshot(records, { asOf });
}

function isTruthyFlag(value) {
  const normalized = value.trim().toLowerCase();
  return normalized !== '' && !['-', 'なし', 'false', '0', 'no'].includes(normalized);
}

function shouldSkipDetailRow(row, transferIndex, calculationIndex) {
  if (transferIndex >= 0 && isTruthyFlag(row[transferIndex] ?? '')) return true;
  if (calculationIndex >= 0) {
    const calculation = (row[calculationIndex] ?? '').trim()
      .replace('０', '0');
    if (calculation === '0' || calculation === '対象外' || calculation === '除外') return true;
  }
  return false;
}

function importDetailedRows(rows, { asOf } = {}) {
  const headers = rows[0];
  const dateIndex = findHeaderIndex(headers, DETAIL_HEADERS.date);
  const amountIndex = findHeaderIndex(headers, DETAIL_HEADERS.amount);
  let categoryIndex = findHeaderIndex(headers, DETAIL_HEADERS.category, { required: false });
  if (categoryIndex < 0) categoryIndex = findHeaderIndex(headers, DETAIL_HEADERS.subcategory);
  const transferIndex = findHeaderIndex(headers, DETAIL_HEADERS.transfer, { required: false });
  const calculationIndex = findHeaderIndex(headers, DETAIL_HEADERS.calculation, { required: false });

  const records = [];
  for (const row of rows.slice(1)) {
    if (shouldSkipDetailRow(row, transferIndex, calculationIndex)) continue;
    const signedAmount = parseSignedAmount(row[amountIndex] ?? '');
    const category = (row[categoryIndex] ?? '').trim() || '未分類';
    if (category.length > 200) fail('invalid_csv_category');
    records.push({
      month: parseDate(row[dateIndex] ?? '').slice(0, 7),
      category,
      amountYen: Math.abs(signedAmount),
      direction: signedAmount >= 0 ? 'income' : 'expense',
    });
  }
  return buildMonthlyOnlySnapshot(records, { asOf });
}

/**
 * Import the current manual monthly CSV contract (年月・カテゴリ・金額).
 * Extra columns such as メモ are deliberately read only to advance the CSV
 * parser and are never included in the returned aggregate snapshot.
 */
export function importMonthlyCsv(csvText, { asOf } = {}) {
  return importMonthlyRows(parseCsvRows(csvText), { asOf });
}

export function importDetailedCsv(csvText, { asOf } = {}) {
  return importDetailedRows(parseCsvRows(csvText), { asOf });
}

export function importFinanceCsv(csvText, { asOf } = {}) {
  const rows = parseCsvRows(csvText);
  const headers = rows[0];
  const hasDetailDate = findHeaderIndex(headers, DETAIL_HEADERS.date, { required: false }) >= 0;
  const hasDetailAmount = findHeaderIndex(headers, DETAIL_HEADERS.amount, { required: false }) >= 0;
  if (hasDetailDate && hasDetailAmount) return importDetailedRows(rows, { asOf });
  return importMonthlyRows(rows, { asOf });
}

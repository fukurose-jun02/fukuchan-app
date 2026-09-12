import { z } from 'zod';

const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

const monthSchema = z.string().regex(MONTH, 'month must be YYYY-MM');
const dateSchema = z.string().regex(DATE, 'date must be YYYY-MM-DD');

/**
 * One input contract is shared by MCP, Service Binding RPC, and Gemini.
 * Gemini receives the JSON declarations below; the Worker still validates the
 * model-produced arguments with these zod schemas before touching D1.
 */
export const financeToolSchemas = {
  get_data_freshness: z.object({}).strict(),
  get_monthly_summary: z.object({ month: monthSchema.optional() }).strict(),
  get_category_breakdown: z.object({
    month: monthSchema,
    direction: z.enum(['income', 'expense']).default('expense'),
    limit: z.number().int().min(1).max(20).default(10),
  }).strict(),
  compare_months: z.object({
    base_month: monthSchema,
    compare_month: monthSchema,
    category: z.string().max(100).optional(),
    direction: z.enum(['income', 'expense']).default('expense'),
    period_mode: z.enum(['auto', 'month_to_date_same_day', 'full_month']).default('auto'),
    as_of: dateSchema.optional(),
  }).strict(),
  get_asset_summary: z.object({ as_of: dateSchema.optional() }).strict(),
};

export const FINANCE_TOOL_METHODS = Object.freeze({
  get_data_freshness: 'getDataFreshness',
  get_monthly_summary: 'getMonthlySummary',
  get_category_breakdown: 'getCategoryBreakdown',
  compare_months: 'compareMonths',
  get_asset_summary: 'getAssetSummary',
});

const objectParameters = (properties, required = []) => ({
  type: 'object',
  properties,
  ...(required.length > 0 ? { required } : {}),
});

const stringProperty = (description) => ({ type: 'string', description });

/** Gemini REST generateContent function declarations. */
export const FINANCE_TOOL_DECLARATIONS = Object.freeze([
  {
    name: 'get_data_freshness',
    description: '家計データの最終同期日時、対象期間、件数、鮮度を確認する。',
    parameters: objectParameters({}),
  },
  {
    name: 'get_monthly_summary',
    description: '指定月の収入、支出、収支、取引件数を取得する。monthを省略すると最新月を取得する。',
    parameters: objectParameters({
      month: stringProperty('対象月。YYYY-MM形式。省略時はデータ上の最新月。'),
    }),
  },
  {
    name: 'get_category_breakdown',
    description: '指定月の収入または支出をカテゴリ別に取得する。',
    parameters: objectParameters({
      month: stringProperty('対象月。YYYY-MM形式。'),
      direction: { type: 'string', enum: ['income', 'expense'], description: 'incomeまたはexpense。既定はexpense。' },
      limit: { type: 'integer', description: '返すカテゴリ数。1〜20。既定は10。' },
    }, ['month']),
  },
  {
    name: 'compare_months',
    description: '2か月の収支を比較する。今月を指定したautoでは当日までの同期間を比較する。食費などカテゴリ指定も可能。',
    parameters: objectParameters({
      base_month: stringProperty('比較元の月。YYYY-MM形式。'),
      compare_month: stringProperty('比較先の月。YYYY-MM形式。'),
      category: stringProperty('比較するカテゴリ名。例: 食費。省略時は月全体。'),
      direction: { type: 'string', enum: ['income', 'expense'], description: 'incomeまたはexpense。既定はexpense。' },
      period_mode: {
        type: 'string',
        enum: ['auto', 'month_to_date_same_day', 'full_month'],
        description: '比較期間。既定はauto。',
      },
      as_of: stringProperty('基準日。YYYY-MM-DD形式。通常は省略する。'),
    }, ['base_month', 'compare_month']),
  },
  {
    name: 'get_asset_summary',
    description: '資産カテゴリ別の集計、総資産、総負債、純資産を取得する。口座番号や個別明細は返さない。',
    parameters: objectParameters({
      as_of: stringProperty('資産基準日。YYYY-MM-DD形式。省略時は最新日。'),
    }),
  },
]);

export function parseFinanceToolCall(name, input) {
  const method = FINANCE_TOOL_METHODS[name];
  if (!method) {
    return { ok: false, error: { code: 'unknown_tool', message: 'unknown finance tool' } };
  }
  const schema = financeToolSchemas[name];
  const parsed = schema.safeParse(input ?? {});
  if (!parsed.success) {
    return { ok: false, method, error: { code: 'invalid_arguments', message: 'invalid finance tool arguments' } };
  }
  return { ok: true, method, args: parsed.data };
}


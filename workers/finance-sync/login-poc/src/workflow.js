export const HANDOFF_TIMEOUT_MS = 10 * 60 * 1000;
export const HANDOFF_INSTRUCTIONS = 'Live ViewでMoney ForwardのOTPを直接入力してください。アカウント選択画面が表示されたらMoney Forward MEの現在のアカウントを選び、moneyforward.comの家計簿画面まで進んでからDoneを選択してください。OTPをこのAPIへ送信しないでください。';

const SAFE_LIVE_VIEW_ORIGIN = 'https://live.browser.run';
const FORBIDDEN_FIELD = /^(?:html|body|raw(?:html|text)?|page(?:html|text)?|text|cookie|storage(?:state)?|otp|password|email|session|screenshot|recording|memo|merchant|transaction|account(?:number)?|card(?:number)?)$/i;
const AGGREGATE_GRANULARITIES = new Set(['daily', 'monthly_only']);

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function assertNoSensitiveFields(value, path = '$') {
  if (Array.isArray(value)) {
    for (const [index, item] of value.entries()) {
      assertNoSensitiveFields(item, `${path}[${index}]`);
    }
    return;
  }
  if (!isPlainObject(value)) return;

  for (const [key, child] of Object.entries(value)) {
    if (FORBIDDEN_FIELD.test(key)) {
      throw new Error(`sensitive_field:${path}.${key}`);
    }
    assertNoSensitiveFields(child, `${path}.${key}`);
  }
}

function requireIsoDateTime(value, field) {
  if (typeof value !== 'string' || Number.isNaN(Date.parse(value))) {
    throw new Error(`invalid_${field}`);
  }
  return value;
}

function requireDate(value, field) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new Error(`invalid_${field}`);
  }
  return value;
}

function requireCount(value, field) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`invalid_${field}`);
  }
  return value;
}

function requireGranularity(value) {
  const granularity = value ?? 'daily';
  if (!AGGREGATE_GRANULARITIES.has(granularity)) {
    throw new Error('invalid_granularity');
  }
  return granularity;
}

/**
 * Build the only handoff payload the PoC may expose to the operator.
 * The OTP itself is intentionally not an input to this function.
 */
export function buildHandoffRequest(liveViewUrl) {
  const url = new URL(liveViewUrl);
  if (url.protocol !== 'https:' || url.origin !== SAFE_LIVE_VIEW_ORIGIN) {
    throw new Error('invalid_live_view_url');
  }

  return {
    liveViewUrl: url.toString(),
    mode: 'tab',
    timeoutMs: HANDOFF_TIMEOUT_MS,
    instructions: HANDOFF_INSTRUCTIONS,
  };
}

/**
 * Classify only the post-login state. Aggregate selectors are intentionally
 * supplied by a later, observed fixture rather than guessed here.
 */
export function classifyPostAuthState({
  aggregateCount = 0,
  botCount = 0,
  loginFormCount = 0,
  otpCount = 0,
  accountSelectionCount = 0,
  timedOut = false,
  pageReady = false,
} = {}) {
  if (timedOut) return 'AUTH_TIMEOUT';
  if (botCount > 0) return 'BOT_BLOCKED';
  if (otpCount > 0) return 'OTP_REQUIRED';
  if (accountSelectionCount > 0) return 'ACCOUNT_SELECTION_REQUIRED';
  if (loginFormCount > 0) return 'AUTH_FAILED';
  if (pageReady && aggregateCount > 0) return 'AUTHENTICATED';
  return 'UNEXPECTED_STATE';
}

/**
 * Accept only the aggregate-shaped result that may cross the browser boundary.
 * Extra top-level fields are discarded; sensitive nested field names fail closed.
 */
export function normalizeAggregateSnapshot(value) {
  if (!isPlainObject(value) || value.status !== 'READY') {
    throw new Error('invalid_aggregate_status');
  }

  assertNoSensitiveFields(value);
  if (!isPlainObject(value.counts) || !isPlainObject(value.summaries)) {
    throw new Error('invalid_aggregate_shape');
  }

  return {
    status: 'READY',
    granularity: requireGranularity(value.granularity),
    asOf: requireIsoDateTime(value.asOf, 'as_of'),
    sourceDate: requireDate(value.sourceDate, 'source_date'),
    counts: {
      daily: requireCount(value.counts.daily, 'daily_count'),
      monthly: requireCount(value.counts.monthly, 'monthly_count'),
      categories: requireCount(value.counts.categories, 'category_count'),
      assets: requireCount(value.counts.assets, 'asset_count'),
    },
    summaries: value.summaries,
  };
}

/**
 * Cross the post-auth browser boundary only with an authenticated aggregate.
 * The page adapter must provide this already-structured value; raw page text,
 * HTML, cookies, and storage state are intentionally not accepted here.
 */
export function extractAggregateSnapshot({ state, snapshot } = {}) {
  if (state !== 'AUTHENTICATED') {
    throw new Error(`post_auth_state:${state ?? 'MISSING'}`);
  }
  return normalizeAggregateSnapshot(snapshot);
}

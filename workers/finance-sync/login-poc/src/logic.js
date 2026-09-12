const LOGIN_ORIGIN = 'https://id.moneyforward.com';

export const LOGIN_URL = `${LOGIN_ORIGIN}/sign_in`;

const OTP_SELECTORS = [
  'input[autocomplete="one-time-code"]',
  'input[name*="otp"]',
  'input[id*="otp"]',
  'input[name*="verification"]',
  'input[id*="verification"]',
];

const BOT_SELECTORS = [
  'iframe[src*="challenge"]',
  'iframe[src*="captcha"]',
  '[id*="challenge"]',
  '[class*="challenge"]',
  '[id*="captcha"]',
  '[class*="captcha"]',
];

const ERROR_SELECTORS = [
  '[role="alert"]',
  '.alert',
  '.error',
  '[class*="error"]',
];

export function getSafeLocation(rawUrl) {
  try {
    const url = new URL(rawUrl);
    return { origin: url.origin, path: url.pathname };
  } catch {
    return { origin: null, path: null };
  }
}

export function constantTimeEquals(left, right) {
  if (typeof left !== 'string' || typeof right !== 'string') return false;
  const leftBytes = new TextEncoder().encode(left);
  const rightBytes = new TextEncoder().encode(right);
  let difference = leftBytes.length ^ rightBytes.length;
  const maxLength = Math.max(leftBytes.length, rightBytes.length);
  for (let index = 0; index < maxLength; index += 1) {
    difference |= (leftBytes[index] ?? 0) ^ (rightBytes[index] ?? 0);
  }
  return difference === 0;
}

export function isAuthorizedPocRequest(request, expectedToken) {
  const authorization = request.headers.get('authorization') ?? '';
  const match = /^Bearer\s+(.+)$/i.exec(authorization);
  const suppliedToken = match?.[1] ?? request.headers.get('x-sync-poc-token');
  return constantTimeEquals(suppliedToken, expectedToken);
}

export function hasRequiredPocSecrets(env) {
  return [env.MF_LOGIN_EMAIL, env.MF_LOGIN_PASSWORD, env.SYNC_POC_TOKEN]
    .every((value) => typeof value === 'string' && value.length > 0);
}

function pathLooksLikeBotChallenge(path) {
  return /challenge|captcha|blocked|access-denied/i.test(path);
}

function pathLooksLikeOtp(path) {
  return /otp|two[-_]?factor|verification|verify/i.test(path);
}

function pathLooksLikeSignIn(path) {
  return /sign[_-]?in|login/i.test(path);
}

/**
 * Classify only the login state. This intentionally returns no page text,
 * cookies, screenshots, or transaction data.
 */
export function classifyLoginState({ location, otpCount = 0, botCount = 0, errorCount = 0 }) {
  const origin = location?.origin ?? null;
  const path = location?.path ?? '';
  if (pathLooksLikeBotChallenge(path) || botCount > 0) return 'BOT_BLOCKED';
  if (pathLooksLikeOtp(path) || otpCount > 0) return 'OTP_REQUIRED';
  if (origin === LOGIN_ORIGIN && pathLooksLikeSignIn(path)) {
    return errorCount > 0 ? 'AUTH_FAILED' : 'AUTH_FAILED';
  }
  if (origin && origin !== LOGIN_ORIGIN) return 'AUTHENTICATED';
  return 'UNEXPECTED_STATE';
}

export const selectors = Object.freeze({
  email: 'input[name="mfid_user[email]"]',
  password: 'input[name="mfid_user[password]"]',
  submit: 'button#submitto, button[type="submit"]',
  otp: OTP_SELECTORS.join(', '),
  bot: BOT_SELECTORS.join(', '),
  error: ERROR_SELECTORS.join(', '),
});

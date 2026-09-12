import { launch } from '@cloudflare/playwright';

import {
  LOGIN_URL,
  classifyLoginState,
  getSafeLocation,
  hasRequiredPocSecrets,
  isAuthorizedPocRequest,
  selectors,
} from './logic.js';

const LOGIN_TIMEOUT_MS = 30_000;
const POST_LOGIN_WAIT_MS = 2_000;

function json(body, status = 200) {
  return Response.json(body, {
    status,
    headers: { 'Cache-Control': 'no-store' },
  });
}

async function countMatching(page, selector) {
  try {
    return await page.locator(selector).count();
  } catch {
    return 0;
  }
}

async function runLoginPoc(env) {
  let browser;
  try {
    browser = await launch(env.BROWSER, { keep_alive: 60_000 });
    const page = await browser.newPage();
    await page.goto(LOGIN_URL, {
      waitUntil: 'domcontentloaded',
      timeout: LOGIN_TIMEOUT_MS,
    });

    await page.locator(selectors.email).fill(env.MF_LOGIN_EMAIL);
    await page.locator(selectors.password).fill(env.MF_LOGIN_PASSWORD);
    await page.locator(selectors.submit).click();
    await page.waitForTimeout(POST_LOGIN_WAIT_MS);

    const location = getSafeLocation(page.url());
    const [otpCount, botCount, errorCount] = await Promise.all([
      countMatching(page, selectors.otp),
      countMatching(page, selectors.bot),
      countMatching(page, selectors.error),
    ]);
    const status = classifyLoginState({ location, otpCount, botCount, errorCount });

    // Return only a coarse classification and URL origin/path. Do not return
    // page text, cookies, screenshot data, account identifiers, or amounts.
    return {
      status,
      location,
      indicators: {
        otp: otpCount > 0,
        bot: botCount > 0,
        authError: errorCount > 0,
      },
    };
  } catch {
    return {
      status: 'BROWSER_ERROR',
      location: { origin: null, path: null },
      indicators: { otp: false, bot: false, authError: false },
    };
  } finally {
    if (browser) {
      try {
        await browser.close();
      } catch {
        // Best effort close. No session state is persisted by this PoC.
      }
    }
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/health' && request.method === 'GET') {
      return json({ status: 'ok', mode: 'login-poc' });
    }

    if (url.pathname !== '/poc/login' || request.method !== 'POST') {
      return new Response('Not found', { status: 404 });
    }
    if (env.POC_ENABLED !== 'true') {
      return new Response('Not found', { status: 404 });
    }
    if (!hasRequiredPocSecrets(env)) {
      return json({ error: 'poc_secrets_missing' }, 503);
    }
    if (!isAuthorizedPocRequest(request, env.SYNC_POC_TOKEN)) {
      return json({ error: 'unauthorized' }, 401);
    }

    const result = await runLoginPoc(env);
    return json(result, result.status === 'BROWSER_ERROR' ? 502 : 200);
  },
};

export { runLoginPoc };

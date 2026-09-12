import { OAuthProvider } from '@cloudflare/workers-oauth-provider';
import { WorkerEntrypoint } from 'cloudflare:workers';

import { createFinanceMcpHandler } from './mcp.js';
import { handleDefaultRequest } from './oauth.js';
import {
  financeToolSchemas,
} from './contracts.js';
import {
  getAssetSummary,
  getCategoryBreakdown,
  getDataFreshness,
  getMonthlySummary,
  compareMonths,
} from './queries.js';

class FinanceMcpApi extends WorkerEntrypoint {
  async getDataFreshness(input = {}) {
    const args = financeToolSchemas.get_data_freshness.parse(input);
    return getDataFreshness(this.env.FINANCE_DB, args);
  }

  async getMonthlySummary(input = {}) {
    const args = financeToolSchemas.get_monthly_summary.parse(input);
    return getMonthlySummary(this.env.FINANCE_DB, args);
  }

  async getCategoryBreakdown(input) {
    const args = financeToolSchemas.get_category_breakdown.parse(input);
    return getCategoryBreakdown(this.env.FINANCE_DB, args);
  }

  async compareMonths(input) {
    const args = financeToolSchemas.compare_months.parse(input);
    return compareMonths(this.env.FINANCE_DB, args);
  }

  async getAssetSummary(input = {}) {
    const args = financeToolSchemas.get_asset_summary.parse(input);
    return getAssetSummary(this.env.FINANCE_DB, args);
  }

  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname !== '/mcp') {
      return new Response('Not found', { status: 404 });
    }
    if (request.method !== 'POST') {
      return new Response('Method Not Allowed', { status: 405, headers: { Allow: 'POST' } });
    }

    // OAuthProvider has already validated the bearer token before this handler.
    // Only a fixed marker is passed to MCP; the real token is never logged or
    // exposed to tool callbacks.
    const props = this.ctx?.props || {};
    const authInfo = {
      token: 'oauth-validated',
      clientId: 'github-oauth',
      scopes: ['mcp:read'],
      extra: { githubLogin: props.githubLogin || null },
    };
    const allowedOrigins = String(this.env.MCP_ALLOWED_ORIGINS || '')
      .split(',')
      .map((origin) => origin.trim())
      .filter(Boolean);
    const handler = createFinanceMcpHandler(this.env.FINANCE_DB, {
      now: new Date(),
      allowedOrigins,
    });
    return handler.fetch(request, { authInfo });
  }
}

const provider = new OAuthProvider({
  apiRoute: '/mcp',
  apiHandler: FinanceMcpApi,
  defaultHandler: {
    async fetch(request, env) {
      return handleDefaultRequest(request, env);
    },
  },
  authorizeEndpoint: '/authorize',
  tokenEndpoint: '/oauth/token',
  clientRegistrationEndpoint: '/oauth/register',
  scopesSupported: ['mcp:read'],
});

export default {
  fetch(request, env, ctx) {
    return provider.fetch(request, env, ctx);
  },
};

export { FinanceMcpApi };

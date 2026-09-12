import { McpServer, createMcpHandler } from '@modelcontextprotocol/server';

import {
  FinanceQueryError,
  getAssetSummary,
  getCategoryBreakdown,
  getDataFreshness,
  getMonthlySummary,
  compareMonths,
} from './queries.js';
import { financeToolSchemas } from './contracts.js';

const READ_ONLY_ANNOTATIONS = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
};

function safeError(error) {
  if (error instanceof FinanceQueryError) {
    return {
      code: error.code,
      message: error.message,
      ...(error.details && Object.keys(error.details).length > 0 ? { details: error.details } : {}),
    };
  }
  return { code: 'internal_error', message: 'finance query failed' };
}

function resultContent(value) {
  return {
    content: [{ type: 'text', text: JSON.stringify(value) }],
    structuredContent: value,
  };
}

function errorContent(error) {
  return {
    isError: true,
    content: [{ type: 'text', text: JSON.stringify({ error: safeError(error) }) }],
  };
}

async function execute(query) {
  try {
    return resultContent(await query());
  } catch (error) {
    // 金融データや認証情報をログへ出さず、クライアントへは定義済みエラーだけ返す。
    return errorContent(error);
  }
}

/**
 * Create one request-scoped MCP server.
 *
 * The caller must pass the authInfo produced by the OAuth Provider. Keeping the
 * database and clock as arguments makes this function easy to exercise against
 * a local D1 fixture without involving the Worker runtime.
 */
export function createFinanceServer(db, { now = new Date(), authInfo } = {}) {
  if (!authInfo) throw new Error('authenticated MCP context is required');

  const server = new McpServer({
    name: 'fukuchan-finance-mcp',
    version: '0.1.0',
  });

  server.registerTool(
    'get_data_freshness',
    {
      title: 'Get finance data freshness',
      description: 'Return the latest successful finance snapshot status and freshness.',
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async () => execute(() => getDataFreshness(db, { now }))
  );

  server.registerTool(
    'get_monthly_summary',
    {
      title: 'Get monthly finance summary',
      description: 'Return income, expense, balance, and count for one month.',
      inputSchema: financeToolSchemas.get_monthly_summary,
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async (input) => execute(() => getMonthlySummary(db, input, { now }))
  );

  server.registerTool(
    'get_category_breakdown',
    {
      title: 'Get category breakdown',
      description: 'Return a bounded category breakdown for one month.',
      inputSchema: financeToolSchemas.get_category_breakdown,
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async (input) => execute(() => getCategoryBreakdown(db, input, { now }))
  );

  server.registerTool(
    'compare_months',
    {
      title: 'Compare two months',
      description: 'Compare two months, including same-period-to-date comparison when requested.',
      inputSchema: financeToolSchemas.compare_months,
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async (input) => execute(() => compareMonths(db, input, { now }))
  );

  server.registerTool(
    'get_asset_summary',
    {
      title: 'Get asset summary',
      description: 'Return aggregate assets, liabilities, and net assets by type.',
      inputSchema: financeToolSchemas.get_asset_summary,
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async (input) => execute(() => getAssetSummary(db, input, { now }))
  );

  return server;
}

/** Create a stateless Streamable HTTP handler for POST /mcp. */
export function createFinanceMcpHandler(
  db,
  { now = new Date(), allowedOrigins = [], ...handlerOptions } = {}
) {
  const handler = createMcpHandler(
    (ctx) => createFinanceServer(db, { now, authInfo: ctx.authInfo }),
    {
      // Keep stateless compatibility for clients still using the 2025
      // initialize handshake; both paths use Streamable HTTP and never retain
      // session state in this Worker.
      legacy: 'stateless',
      responseMode: 'json',
      ...handlerOptions,
    }
  );

  const configuredOrigins = new Set(allowedOrigins);
  return {
    ...handler,
    async fetch(request, options) {
      const origin = request.headers.get('Origin');
      if (origin) {
        let validOrigin = false;
        try {
          validOrigin = origin === new URL(request.url).origin || configuredOrigins.has(origin);
        } catch {
          validOrigin = false;
        }
        if (!validOrigin) {
          return new Response('Forbidden', { status: 403 });
        }
      }
      return handler.fetch(request, options);
    },
  };
}

export { financeToolSchemas };

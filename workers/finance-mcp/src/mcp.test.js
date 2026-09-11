import { describe, expect, it } from 'vitest';
import { createFinanceMcpHandler } from './mcp.js';

class MockD1 {
  prepare(sql) {
    const normalized = sql.replace(/\s+/g, ' ').trim();
    return {
      bind: (...params) => ({
        first: async () => {
          if (normalized.includes('FROM sync_runs')) {
            return {
              sync_id: 'demo-sync',
              completed_at: '2026-09-11T06:30:00+09:00',
              source_version: 'fixture',
              source_max_date: '2026-09-11',
              daily_count: 11,
              monthly_count: 2,
              category_count: 4,
              asset_count: 2,
              status: 'active',
            };
          }
          if (normalized.includes('FROM monthly_summaries')) {
            return params[1] === '2026-09'
              ? { month: '2026-09', income_yen: 100000, expense_yen: 22000, balance_yen: 78000, transaction_count: 5 }
              : null;
          }
          return null;
        },
        all: async () => ({ results: [] }),
      }),
    };
  }
}

function request(body, headers = {}) {
  return new Request('https://mcp.example.com/mcp', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      ...headers,
    },
    body: JSON.stringify(body),
  });
}

async function rpcResponse(response) {
  const text = await response.text();
  const line = text.split('\n').find((item) => item.startsWith('data: '));
  return line ? JSON.parse(line.slice(6)) : JSON.parse(text);
}

const AUTH = { authInfo: { token: 'validated', clientId: 'test-client', scopes: ['mcp:read'] } };

describe('finance MCP handler', () => {
  it('未認証リクエストではツール一覧を返さない', async () => {
    const handler = createFinanceMcpHandler(new MockD1());
    const response = await handler.fetch(request({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }));
    expect(response.status).toBe(500);
    expect(await response.text()).not.toContain('get_monthly_summary');
  });

  it('tools/listはP0の5ツールだけを公開する', async () => {
    const handler = createFinanceMcpHandler(new MockD1());
    const payload = await rpcResponse(await handler.fetch(
      request({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }),
      AUTH
    ));
    expect(payload.result.tools.map((tool) => tool.name)).toEqual([
      'get_data_freshness',
      'get_monthly_summary',
      'get_category_breakdown',
      'compare_months',
      'get_asset_summary',
    ]);
    expect(payload.result.tools.every((tool) => tool.annotations.readOnlyHint === true)).toBe(true);
  });

  it('2026-07-28 modern envelopeのserver/discoverを処理する', async () => {
    const handler = createFinanceMcpHandler(new MockD1());
    const meta = {
      'io.modelcontextprotocol/protocolVersion': '2026-07-28',
      'io.modelcontextprotocol/clientCapabilities': {},
      'io.modelcontextprotocol/clientInfo': { name: 'test-client', version: '1.0.0' },
    };
    const response = await handler.fetch(
      request(
        { jsonrpc: '2.0', id: 6, method: 'server/discover', params: { _meta: meta } },
        { 'MCP-Protocol-Version': '2026-07-28', 'Mcp-Method': 'server/discover' }
      ),
      AUTH
    );
    const payload = await rpcResponse(response);
    expect(payload.result.supportedVersions).toContain('2026-07-28');
  });

  it('tools/callはquery結果をJSONとstructuredContentで返す', async () => {
    const handler = createFinanceMcpHandler(new MockD1(), { now: new Date('2026-09-11T12:00:00+09:00') });
    const payload = await rpcResponse(await handler.fetch(
      request({
        jsonrpc: '2.0',
        id: 3,
        method: 'tools/call',
        params: { name: 'get_monthly_summary', arguments: { month: '2026-09' } },
      }),
      AUTH
    ));
    expect(payload.result.isError).toBeUndefined();
    expect(payload.result.structuredContent.data.expense_yen).toBe(22000);
    expect(JSON.parse(payload.result.content[0].text).meta.currency).toBe('JPY');
  });

  it('入力スキーマ違反はqueryを実行せずJSON-RPCエラーにする', async () => {
    const handler = createFinanceMcpHandler(new MockD1());
    const payload = await rpcResponse(await handler.fetch(
      request({
        jsonrpc: '2.0',
        id: 4,
        method: 'tools/call',
        params: { name: 'get_category_breakdown', arguments: { month: '2026-13', limit: 21 } },
      }),
      AUTH
    ));
    expect(payload.result.isError).toBe(true);
    expect(payload.result.content[0].text).toMatch(/validation|month|limit/i);
  });

  it('Origin不正はMCP SDKのOrigin検証で拒否する', async () => {
    const handler = createFinanceMcpHandler(new MockD1());
    const response = await handler.fetch(
      request({ jsonrpc: '2.0', id: 5, method: 'tools/list', params: {} }, { Origin: 'https://evil.example' }),
      AUTH
    );
    expect(response.status).toBe(403);
  });
});

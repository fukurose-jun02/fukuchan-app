import { describe, expect, it } from 'vitest';

import {
  callGeminiWithFinance,
  executeFinanceToolCall,
  loadAllKnowledge,
  resolveFinanceMode,
} from './index.js';
import {
  FINANCE_TOOL_DECLARATIONS,
  parseFinanceToolCall,
} from '../workers/finance-mcp/src/contracts.js';

function geminiResponse(parts) {
  return new Response(JSON.stringify({
    candidates: [{ content: { role: 'model', parts } }],
  }), { status: 200, headers: { 'Content-Type': 'application/json' } });
}

describe('finance tool contract', () => {
  it('Gemini向けにP0の5ツールだけを宣言する', () => {
    expect(FINANCE_TOOL_DECLARATIONS.map((tool) => tool.name)).toEqual([
      'get_data_freshness',
      'get_monthly_summary',
      'get_category_breakdown',
      'compare_months',
      'get_asset_summary',
    ]);
  });

  it('モデルが生成した引数をallowlistとスキーマで検証する', () => {
    expect(parseFinanceToolCall('get_monthly_summary', { month: '2026-09' })).toMatchObject({
      ok: true,
      method: 'getMonthlySummary',
      args: { month: '2026-09' },
    });
    expect(parseFinanceToolCall('delete_all_data', {})).toMatchObject({
      ok: false,
      error: { code: 'unknown_tool' },
    });
    expect(parseFinanceToolCall('get_category_breakdown', { month: '2026-13' })).toMatchObject({
      ok: false,
      error: { code: 'invalid_arguments' },
    });
  });

  it('未知ツールや不正引数ではService Bindingを呼ばない', async () => {
    let calls = 0;
    const service = { getMonthlySummary: async () => { calls += 1; return {}; } };
    const part = await executeFinanceToolCall(service, {
      name: 'delete_all_data',
      id: 'call-1',
      args: {},
    });
    expect(calls).toBe(0);
    expect(part.functionResponse).toMatchObject({
      id: 'call-1',
      name: 'delete_all_data',
      response: { error: { code: 'unknown_tool' } },
    });
  });
});

describe('Gemini finance function-calling loop', () => {
  it('functionCallをRPCへ渡し、functionResponse後の最終回答を返す', async () => {
    const requests = [];
    const service = {
      compareMonths: async (args) => ({
        data: { category: { category: args.category, delta_yen: 9000 } },
        meta: { asOf: '2026-09-11T06:30:00+09:00', freshness: 'fresh' },
      }),
    };
    const fetchImpl = async (_url, options) => {
      const payload = JSON.parse(options.body);
      requests.push(payload);
      if (requests.length === 1) {
        return geminiResponse([{
          functionCall: {
            id: 'call-compare',
            name: 'compare_months',
            args: {
              base_month: '2026-09',
              compare_month: '2026-08',
              category: '食費',
              direction: 'expense',
            },
          },
        }]);
      }
      return geminiResponse([{ text: '今月の食費は先月より9,000円多いよ。' }]);
    };

    const reply = await callGeminiWithFinance(
      { GEMINI_API_KEY: 'test-key' },
      'finance rules',
      [{ role: 'user', parts: [{ text: '今月の食費は？' }] }],
      { service, fetchImpl }
    );

    expect(reply).toContain('9,000円');
    expect(reply).toContain('2026-09-11T06:30:00+09:00');
    expect(reply).toContain('fresh');
    expect(requests).toHaveLength(2);
    expect(requests[0].tools[0].functionDeclarations).toHaveLength(5);
    expect(requests[1].system_instruction.parts[0].text).toContain('唯一の根拠');
    expect(requests[1].contents[1].role).toBe('model');
    expect(requests[1].contents[1].parts[0].functionCall.name).toBe('compare_months');
    expect(requests[1].contents[2].role).toBe('user');
    expect(requests[1].contents[2].parts[0].functionResponse).toMatchObject({
      id: 'call-compare',
      name: 'compare_months',
      response: { result: { data: { category: { delta_yen: 9000 } } } },
    });
  });
});

describe('finance mode and knowledge selection', () => {
  it('flagとService Bindingが揃った場合だけ有効になる', () => {
    expect(resolveFinanceMode({ FINANCE_TOOL_ENABLED: 'false', FINANCE_SERVICE: {} })).toBe('disabled');
    expect(resolveFinanceMode({ FINANCE_TOOL_ENABLED: 'true' })).toBe('misconfigured');
    expect(resolveFinanceMode({ FINANCE_TOOL_ENABLED: 'true', FINANCE_SERVICE: {} })).toBe('enabled');
  });

  it('finance modeでは旧finance.csvをGemini用ナレッジに含めない', async () => {
    const requested = [];
    const fetchImpl = async (url) => {
      requested.push(url);
      return new Response(`content:${url}`, { status: 200 });
    };
    const [, knowledge] = await loadAllKnowledge(
      { GITHUB_REPO: 'example/repo', GITHUB_TOKEN: 'test-token' },
      { includeFinance: false, fetchImpl }
    );
    expect(requested.some((url) => url.endsWith('/finance.csv'))).toBe(false);
    expect(knowledge).not.toContain('家計情報');
    expect(knowledge).toContain('家族情報');
  });
});

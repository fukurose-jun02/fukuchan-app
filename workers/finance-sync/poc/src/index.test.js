import { describe, expect, it } from 'vitest';

import { buildScheduledResult } from './index.js';

describe('finance-sync Cron fixture', () => {
  it('builds a safe scheduled result without writing data', () => {
    expect(buildScheduledResult({ cron: '0 * * * *' })).toEqual({
      status: 'scheduled',
      cron: '0 * * * *',
      source: 'fixture',
      dataWritten: false,
    });
  });

  it('does not trust non-string cron values', () => {
    expect(buildScheduledResult({ cron: { secret: 'must-not-leak' } })).toEqual({
      status: 'scheduled',
      cron: null,
      source: 'fixture',
      dataWritten: false,
    });
  });
});

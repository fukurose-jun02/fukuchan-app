// This worker is a local-only PoC for validating Cron Trigger dispatch.
// It deliberately does not access Money Forward, Browser Run, or D1.

export function buildScheduledResult(event = {}) {
  return {
    status: 'scheduled',
    cron: typeof event.cron === 'string' ? event.cron : null,
    source: 'fixture',
    dataWritten: false,
  };
}

export default {
  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === '/health') {
      return Response.json({ status: 'ok', mode: 'cron-fixture' });
    }
    return new Response('Not found', { status: 404 });
  },

  async scheduled(event) {
    const result = buildScheduledResult(event);
    // Keep the log free of request bodies, credentials, and finance data.
    console.log(JSON.stringify({ event: 'finance_sync_poc', ...result }));
    return result;
  },
};

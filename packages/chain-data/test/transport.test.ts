import test from 'node:test';
import assert from 'node:assert/strict';

test('caller cancellation aborts an active fetch without retry', async () => {
  const { Transport } = await import('../src/http.js');
  const { parseConfig } = await import('../src/config.js');
  const ctl = new AbortController(); let attempts = 0;
  const transport = new Transport(parseConfig({ REQUEST_INTERVAL_MS: '0' }), async () => {}, {
    fetch: (async (_url, init) => { attempts++; ctl.abort(new Error('user cancelled')); return new Promise((_, reject) => init?.signal?.addEventListener('abort', () => reject(new Error('private url')))); }) as typeof fetch,
    scope: { signal: ctl.signal },
  });
  await assert.rejects(transport.request('x', new URL('https://example.com'), {}, x => x), /cancel/i);
  assert.equal(attempts, 1);
});

test('cancelling retry sleep prevents later attempts', async () => {
  const { Transport } = await import('../src/http.js');
  const { parseConfig } = await import('../src/config.js');
  const ctl = new AbortController(); let attempts = 0;
  const transport = new Transport(parseConfig({ REQUEST_INTERVAL_MS: '0' }), async () => { ctl.abort(new Error('cancelled')); }, {
    fetch: (async () => { attempts++; return new Response('rate limit', { status: 429 }); }) as typeof fetch,
    scope: { signal: ctl.signal },
  });
  await assert.rejects(transport.request('x', new URL('https://example.com'), {}, x => x), /cancel/i);
  assert.equal(attempts, 1);
});

test('shared scheduler serializes independent transport instances', async () => {
  const { Transport, RequestScheduler } = await import('../src/http.js');
  const { parseConfig } = await import('../src/config.js');
  const scheduler = new RequestScheduler(); const starts: number[] = []; let active = 0;
  const cfg = parseConfig({ REQUEST_INTERVAL_MS: '10' });
  const fetcher = (async () => { assert.equal(active++, 0); starts.push(performance.now()); await new Promise(r => setTimeout(r, 5)); active--; return Response.json({ ok: true }); }) as typeof fetch;
  await Promise.all([1, 2].map(() => new Transport(cfg, async () => {}, { fetch: fetcher, scheduler }).request('x', new URL('https://example.com'), {}, x => x)));
  assert.ok(starts[1]! - starts[0]! >= 8);
});

test('partial pagination retains records and independent transfer directions', async () => {
  const { Checks } = await import('../src/checks.js'); const { parseConfig } = await import('../src/config.js');
  const a = '0x' + '1'.repeat(40); const hash = '0x' + 'a'.repeat(64);
  const cfg = parseConfig({ TEST_ADDRESS: a, END_BLOCK: '10', TX_PAGE_SIZE: '1', TRANSFER_PAGE_SIZE: '1' });
  const api = {
    txPage: async (page: number) => { if (page === 2) throw new Error('HTTP 503'); return [{ hash, blockNumber: '10', timeStamp: '1', from: a, to: a, value: '1', isError: '0' }]; },
    transferPage: async (direction: string) => { if (direction === 'incoming') throw new Error('HTTP 503'); return { transfers: [] }; },
  };
  const checks = new Checks(cfg, api as any, { preservePartial: true });
  const tx = await checks.transactions(); assert.equal(tx.count, 1); assert.equal(tx.complete, false); assert.equal(tx.stopReason, 'error');
  const transfers = await checks.transfers(); assert.equal(transfers.incoming.complete, false); assert.equal(transfers.outgoing.complete, true);
});

test('already aborted scopes also consume rejected work without an unhandled rejection', async () => {
  const { raceSignal } = await import('../src/control.js');
  const controller = new AbortController(); controller.abort(new Error('cancelled'));
  await assert.rejects(raceSignal(Promise.reject(new Error('late transport failure')), controller.signal), /cancel/i);
  await new Promise(resolve => setImmediate(resolve));
});

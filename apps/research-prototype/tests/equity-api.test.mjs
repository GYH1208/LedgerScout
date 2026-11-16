import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createEquityApi, parseSymbols, isEquityRunning, marketReturnPair, refreshProgress } from '../src/equity-api.js';

test('partial refresh shows completed, remaining, and actual supplier failure reasons',()=>{
  const text=refreshProgress({kind:'stocks',status:'partial',completed:['AAPL'],remaining:['MSFT'],errors:[{symbol:'MSFT',code:'PERMISSION_DENIED'}]});
  assert.ok(text.includes('AAPL'));assert.ok(text.includes('MSFT'));assert.ok(text.includes('权限'));
});

test('market display reads trading-day return keys from the data contract',()=>{
  assert.deepEqual(marketReturnPair({returns:{'21d':12.5},relativeToSpy:{'21d':3.1}},'21'),{value:12.5,relative:3.1});
  assert.deepEqual(marketReturnPair({returns:{'1d':null},relativeToSpy:{}},'1'),{value:null,relative:null});
});

test('symbol input is explicit, normalized, unique and bounded', () => {
  assert.deepEqual(parseSymbols('aapl, MSFT\nBRK.B aapl'), ['AAPL', 'MSFT', 'BRK.B']);
  assert.deepEqual(parseSymbols(''), []);
  assert.throws(() => parseSymbols('AAPL/MSFT'), /股票代码/);
  assert.throws(() => parseSymbols('A B C D E F', 5), /5/);
});

test('cached reads stay GET and mutations carry the web client header', async (t) => {
  const calls = [];
  const server = createServer(async (req, res) => {
    let body = ''; for await (const chunk of req) body += chunk;
    calls.push({ path: req.url, method: req.method, client: req.headers['x-ledgerscout-client'], body: body && JSON.parse(body) });
    res.setHeader('content-type', 'application/json');
    if (req.url === '/api/equity/screen') { res.statusCode = 422; res.end(JSON.stringify({ error: '缺少可比较期间' })); }
    else res.end(JSON.stringify({ ok: true }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const api = createEquityApi((path, options) => fetch(`http://127.0.0.1:${server.address().port}${path}`, options));
  await api.state();
  await api.refresh({ kind: 'stocks', symbols: ['AAPL'] });
  await api.evidence('job/a', 'query?#', 20);
  assert.deepEqual(calls[0], { path: '/api/equity/state', method: 'GET', client: undefined, body: '' });
  assert.deepEqual(calls[1], { path: '/api/equity/refresh', method: 'POST', client: 'web', body: { kind: 'stocks', symbols: ['AAPL'] } });
  assert.equal(calls[2].path, '/api/equity/evidence/job%2Fa/query%3F%23?offset=20');
  await assert.rejects(api.screen({ filters: [] }), /缺少可比较期间/);
});

test('unavailable or malformed services fail without fallback data', async () => {
  const api = createEquityApi(async () => new Response('<html>preview</html>'));
  await assert.rejects(api.state(), /服务/);
  await assert.rejects(createEquityApi(async () => new Response('{}', { status: 503 })).state(), /503/);
});

test('polling is limited to ongoing work', () => {
  assert.equal(isEquityRunning({ busy: false, activeJob: { status: 'completed' } }), false);
  assert.equal(isEquityRunning({ busy: true }), true);
  assert.equal(isEquityRunning({ activeJob: { status: 'loading' } }), true);
  assert.equal(isEquityRunning(null), false);
});

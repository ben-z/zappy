'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { createDashboardServer, runDashboardCli } = require('../scripts/dashboard-server.cjs');
const PRIVATE = 'SYNTHETIC-PRIVATE-ERROR-DETAIL';
async function invoke(args, options = {}) {
  let stdout = '', stderr = '';
  const result = await runDashboardCli(args, { ...options, stdout: { write: s => { stdout += s; } }, stderr: { write: s => { stderr += s; } } });
  assert.ok(!(stdout + stderr).includes(PRIVATE));
  return { ...result, stdout, stderr };
}
const rejectedServer = code => () => ({ async start() { const error = new Error(PRIVATE); error.code = code; throw error; } });

test('existing dashboard is recognized safely and duplicate launch exits successfully', async t => {
  const dashboard = createDashboardServer({ port: 0, mode: 'live', client: { listVehicles() { throw Error('No API call expected'); } } });
  const { port } = await dashboard.start();
  t.after(() => dashboard.close());
  const result = await invoke(['--port', String(port)]);
  assert.equal(result.code, 0);
  assert.equal(result.dashboard, undefined);
  assert.match(result.stdout, /already running at http:\/\/localhost:/);
  assert.match(result.stdout, /No second server was started/);
  assert.match(result.stdout, /updated code/);
  assert.equal(result.stderr, '');
  const response = await fetch('http://127.0.0.1:' + port + '/api/health');
  assert.deepEqual(await response.json(), { service: 'zappy-dashboard', mode: 'live' });
});

test('port with another Zappy mode produces an explicit alternative command', async t => {
  const dashboard = createDashboardServer({ port: 0, mode: 'demo' });
  const { port } = await dashboard.start();
  t.after(() => dashboard.close());
  const result = await invoke(['--port', String(port)]);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /demo dashboard, not live/);
  assert.match(result.stderr, /Nothing was stopped/);
  assert.match(result.stderr, /npm run dashboard -- --port 8768/);
});

test('unrelated service is not mistaken for Zappy and its response is never logged', async t => {
  const other = http.createServer((_req, res) => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ private: PRIVATE })); });
  await new Promise(resolve => other.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => other.close(resolve)));
  const result = await invoke(['--port', String(other.address().port)]);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /already in use by another or unrecognized service/);
  assert.match(result.stderr, /Nothing was stopped/);
});

test('failed probe gives a safe conflict message and preserves demo mode in workaround', async () => {
  const result = await invoke(['--demo', '--port', '8768'], { createServer: rejectedServer('EADDRINUSE'), fetch: async () => { throw Error(PRIVATE); } });
  assert.equal(result.code, 1);
  assert.match(result.stderr, /--demo --port 8769/);
});

test('permission errors and unknown failures are actionable without raw messages', async () => {
  for (const code of ['EACCES', 'EPERM', 'UNRECOGNIZED']) {
    const result = await invoke([], { createServer: rejectedServer(code) });
    assert.equal(result.code, 1);
    assert.match(result.stderr, /127\.0\.0\.1:8766/);
    assert.match(result.stderr, /--port 8768/);
    if (code !== 'UNRECOGNIZED') assert.match(result.stderr, /Permission denied/);
  }
});

test('successful start returns ownership and a clear local URL', async () => {
  let options;
  const dashboard = { async start() {} };
  const result = await invoke(['--port', '8877'], { createServer: value => { options = value; return dashboard; } });
  assert.equal(result.code, 0);
  assert.equal(result.dashboard, dashboard);
  assert.deepEqual(options, { mode: 'live', port: 8877 });
  assert.match(result.stdout, /http:\/\/localhost:8877\//);
  assert.match(result.stdout, /Ctrl-C/);
});

test('help and invalid arguments never start a server or make requests', async () => {
  const options = { createServer() { throw Error('must not start'); }, fetch() { throw Error('must not fetch'); } };
  const help = await invoke(['--help'], options);
  assert.equal(help.code, 0);
  assert.match(help.stdout, /Usage/);
  for (const args of [['--port', '0'], ['--port', '65536'], ['--port', 'bad'], ['--demo', '--demo'], ['--port', '8766', '--port', '8767'], ['--secret', PRIVATE]]) {
    const result = await invoke(args, options);
    assert.equal(result.code, 1);
    assert.match(result.stderr, /Usage/);
  }
});

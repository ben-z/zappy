'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const net = require('node:net');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { createDashboardServer } = require('../scripts/dashboard-server.cjs');
const stamp = Date.parse('2026-01-01T12:00:00Z');
async function fixture(t, options = {}) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'zappy-dashboard-')));
  await fs.mkdir(path.join(root, 'web'));
  for (const [name, content] of [['index.html', '<h1>synthetic</h1>'], ['app.js', 'console.log("synthetic")'], ['styles.css', 'body{color:red}']]) await fs.writeFile(path.join(root, 'web', name), content);
  const dashboard = createDashboardServer({ root, port: 0, now: () => stamp, ...options });
  const address = await dashboard.start();
  t.after(async () => { await dashboard.close(); await fs.rm(root, { recursive: true, force: true }); });
  const get = async (route, headers = {}) => request(address.port, route, { headers });
  const bootstrap = (await get('/api/bootstrap')).json;
  const post = (route, body = {}, headers = {}) => request(address.port, route, { method: 'POST', headers: { Origin: address.url, 'X-Zappy-CSRF': bootstrap.csrf, 'Content-Type': 'application/json', ...headers }, body: typeof body === 'string' ? body : JSON.stringify(body) });
  return { ...address, dashboard, root, get, post, bootstrap };
}
function request(port, route, { method = 'GET', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: route, method, headers }, res => {
      let text = '';
      res.on('data', data => { text += data; });
      res.on('end', () => { let json; try { json = JSON.parse(text); } catch {} resolve({ status: res.statusCode, headers: res.headers, text, json }); });
    });
    req.on('error', reject);
    req.end(body);
  });
}
function security(response) {
  assert.equal(response.headers['cache-control'], 'no-store');
  assert.equal(response.headers['referrer-policy'], 'no-referrer');
  assert.equal(response.headers['x-content-type-options'], 'nosniff');
  assert.equal(response.headers['x-frame-options'], 'DENY');
  assert.match(response.headers['content-security-policy'], /default-src 'self'/);
  assert.match(response.headers['content-security-policy'], /frame-ancestors 'none'/);
  assert.doesNotMatch(response.headers['content-security-policy'], /unsafe-inline/);
  assert.equal(response.headers['access-control-allow-origin'], undefined);
}
test('import is side effect free and CLI rejects invalid flags', () => {
  const modulePath = path.resolve(__dirname, '../scripts/dashboard-server.cjs');
  const result = spawnSync(process.execPath, ['-e', `require(${JSON.stringify(modulePath)})`], { timeout: 3000, encoding: 'utf8' });
  assert.equal(result.status, 0); assert.equal(result.stdout, ''); assert.equal(result.stderr, '');
  const bad = spawnSync(process.execPath, [modulePath, '--demo', '--port', 'evil'], { timeout: 3000, encoding: 'utf8' });
  assert.equal(bad.status, 1); assert.match(bad.stderr, /Usage/);
});
test('first load and garage never call API; token is per-server and static allowlist is exact', async t => {
  let reads = 0;
  const f = await fixture(t, { client: { listVehicles() { reads++; throw Error('forbidden'); } } });
  assert.deepEqual(f.bootstrap.garage, { updated_at: null, vehicles: [], request_count: 0, warning: null });
  assert.match(f.bootstrap.csrf, /^[a-f0-9]{64}$/);
  assert.deepEqual((await f.get('/api/garage')).json, f.bootstrap.garage);
  for (const route of ['/', '/app.js', '/styles.css']) { const response = await f.get(route); assert.equal(response.status, 200); security(response); }
  for (const route of ['/.local/oauth-tokens.json', '/scripts/zappy.cjs', '/web/index.html', '/../package.json', '/%2e%2e/.local/oauth-tokens.json', '/%252e%252e/x', '/app.js/../x', '//app.js', '/app.js?file=.local', '/styles.css%00', '/api/comparison', '/api/plan']) {
    const response = await f.get(route); assert.equal(response.status, 404, route); security(response);
  }
  const other = await fixture(t, { mode: 'demo' }); assert.notEqual(other.bootstrap.csrf, f.bootstrap.csrf);
  assert.equal(reads, 0);
});
test('rejects DNS rebinding, wrong bound port, cross-site, Origin and CSRF before any side effects', async t => {
  let calls = 0;
  const f = await fixture(t, { client: { async listVehicles() { calls++; return []; } }, cooldownMs: 0 });
  for (const host of ['evil.test:' + f.port, '127.0.0.1', 'localhost', 'localhost:8766', '127.0.0.1:' + (f.port + 1), '127.0.0.1.evil.test:' + f.port, '[::1]:' + f.port]) {
    const response = await f.get('/api/bootstrap', { Host: host }); assert.equal(response.status, 403); security(response);
  }
  assert.equal((await f.get('/api/bootstrap', { Host: 'localhost:' + f.port })).status, 200);
  for (const headers of [{ Origin: '' }, { Origin: 'null' }, { Origin: 'https://127.0.0.1:' + f.port }, { Origin: 'http://localhost:' + f.port }, { 'X-Zappy-CSRF': '' }, { 'X-Zappy-CSRF': 'a'.repeat(64) }, { 'Sec-Fetch-Site': 'cross-site' }]) {
    const response = await f.post('/api/refresh', {}, headers); assert.equal(response.status, 403); security(response);
  }
  for (const method of ['GET', 'PUT', 'DELETE', 'OPTIONS', 'HEAD']) assert.equal((await request(f.port, '/api/refresh', { method })).status, 405);
  assert.equal(calls, 0);
  assert.equal((await f.post('/api/refresh')).status, 200); assert.equal(calls, 1);
});
test('strict bounded JSON bodies and ordinal capture input', async t => {
  let calls = 0;
  const f = await fixture(t, { client: { async listVehicles() { calls++; return []; } } });
  for (const body of ['null', '[]', '{', '{"unexpected":1}', '"x"']) assert.equal((await f.post('/api/refresh', body)).status, 400);
  assert.equal((await f.post('/api/refresh', {}, { 'Content-Type': 'text/plain' })).status, 415);
  assert.equal((await f.post('/api/refresh', ' '.repeat(4097), { 'Content-Length': '4097' })).status, 413);
  for (const body of [{}, { vehicle: 0 }, { vehicle: 21 }, { vehicle: 1.2 }, { vehicle: '1' }, { vehicle: 1, secret: true }]) assert.equal((await f.post('/api/capture', body)).status, 400);
  assert.equal(calls, 0);
});
test('refresh uses one list, only online charge reads, strict normalized fields, and cap 20', async t => {
  let lists = 0; const data = [];
  const f = await fixture(t, { client: {
    async listVehicles() { lists++; return Array.from({ length: 24 }, (_, i) => ({ state: i === 1 ? 'asleep' : i === 2 ? 'offline' : 'online', vin: 'PRIVATE-VIN', display_name: 'PRIVATE-NAME', id_s: String(i) })); },
    async getVehicleData(vehicle) { assert.equal(vehicle.state, 'online'); data.push(vehicle.id_s); return { vin: 'PRIVATE', charge_state: { battery_level: 72, usable_battery_level: -3, charge_limit_soc: 80, charging_state: 'Charging', charger_power: 7.2, battery_range: 100, time_to_full_charge: 1.2 }, location: 'PRIVATE' }; }
  } });
  const response = await f.post('/api/refresh'); security(response); assert.equal(response.status, 200);
  const g = response.json;
  assert.equal(lists, 1); assert.equal(data.length, 18); assert.equal(g.request_count, 19); assert.equal(g.vehicles.length, 20); assert.match(g.warning, /20/);
  assert.equal(g.vehicles[0].estimated_range_km, 160.9344); assert.equal(g.vehicles[0].usable_battery_percent, null);
  assert.equal(g.vehicles[1].state, 'asleep'); assert.equal(g.vehicles[1].battery_percent, null); assert.equal(g.vehicles[2].state, null);
  assert.equal(g.updated_at, new Date(stamp).toISOString()); assert.equal(g.vehicles[0].fetched_at, g.updated_at);
  assert.doesNotMatch(response.text, /PRIVATE|vin|display_name|id_s|location/);
  await f.get('/api/garage'); assert.equal(lists, 1); assert.equal(data.length, 18);
});
test('provider messages never escape and high-level failed requests still count', async t => {
  const f = await fixture(t, { client: { async listVehicles() { return [{ state: 'online' }]; }, async getVehicleData() { throw Error('SECRET VIN TOKEN'); } } });
  const response = await f.post('/api/refresh'); assert.equal(response.status, 200); assert.equal(response.json.vehicles[0].error, 'unavailable'); assert.equal(response.json.request_count, 2); assert.doesNotMatch(response.text, /SECRET|TOKEN|VIN/);
  for (const [code, expected] of [['AUTH_CONFIG', 'AUTH_REQUIRED'], ['NETWORK_ERROR', 'UNAVAILABLE']]) {
    const x = await fixture(t, { client: { async listVehicles() { throw Object.assign(Error('SECRET'), { code }); } } });
    const error = await x.post('/api/refresh'); assert.equal(error.json.error, expected); assert.doesNotMatch(error.text, /SECRET/); security(error); assert.equal((await x.get('/api/garage')).json.request_count, 1);
  }
});
test('concurrent refreshes dedupe, capture cannot overlap, cooldown is mockable', async t => {
  let time = stamp; let release; let enter; let lists = 0;
  const entered = new Promise(resolve => { enter = resolve; });
  const blocked = new Promise(resolve => { release = resolve; });
  const f = await fixture(t, { now: () => time, client: { async listVehicles() { lists++; enter(); await blocked; return []; } } });
  const first = f.post('/api/refresh'); await entered;
  const second = f.post('/api/refresh');
  assert.equal((await f.post('/api/capture', { vehicle: 1 })).json.error, 'BUSY');
  release(); const results = await Promise.all([first, second]); assert.equal(results[0].status, 200); assert.deepEqual(results[0].json, results[1].json); assert.equal(lists, 1);
  assert.equal((await f.post('/api/refresh')).json.error, 'COOLDOWN'); time += 10000;
  assert.equal((await f.post('/api/refresh')).status, 200); assert.equal(lists, 2);
});
test('demo refresh/capture remains synthetic without any client or private filesystem use', async t => {
  const f = await fixture(t, { mode: 'demo', cooldownMs: 0, client: new Proxy({}, { get() { throw Error('No Fleet access'); } }), run() { throw Error('No private disk access'); } });
  assert.equal(f.bootstrap.mode, 'demo'); assert.equal(f.bootstrap.garage.vehicles.length, 2);
  const [a, b] = f.bootstrap.garage.vehicles; assert.equal(a.battery_percent, 72); assert.equal(a.charger_power_kw, 7.2); assert.equal(a.estimated_range_km, 312.4); assert.equal(b.battery_percent, 48); assert.equal(b.charging_state, 'Disconnected');
  assert.equal((await f.post('/api/refresh')).json.request_count, 0);
  const first = await f.post('/api/capture', { vehicle: 1 }); assert.equal(first.status, 200); assert.equal(first.json.comparison, null);
  const second = await f.post('/api/capture', { vehicle: 1 }); assert.equal(second.json.comparison.battery_percentage_point_delta, 0);
  assert.equal((await f.post('/api/capture', { vehicle: 3 })).status, 404);
  await assert.rejects(fs.stat(path.join(f.root, '.local')), { code: 'ENOENT' });
});
test('capture uses counted narrow client and re-normalizes CLI JSON without provider fields', async t => {
  const commands = [];
  const f = await fixture(t, { client: { async listVehicles() { return [{ state: 'online' }]; }, async getVehicleData() { return {}; } }, run: async (args, options) => {
    commands.push(args);
    if (args[0] === 'snapshot') { const vehicles = await options.client.listVehicles(); await options.client.getVehicleData(vehicles[0]); options.stdout.write(JSON.stringify({ alias: 'PRIVATE', state: 'online', battery_percent: 50, vin: 'PRIVATE', charging_state: 'evil', estimated_range_km: 200 })); }
    else options.stdout.write(JSON.stringify({ alias: 'PRIVATE', battery_percentage_point_delta: 2, caveat: 'PRIVATE', raw: 'PRIVATE' }));
    return 0;
  } });
  const response = await f.post('/api/capture', { vehicle: 1 }); assert.equal(response.status, 200); assert.equal(response.json.snapshot.alias, 'vehicle-1'); assert.equal(response.json.snapshot.charging_state, null); assert.equal(response.json.comparison.battery_percentage_point_delta, 2); assert.doesNotMatch(response.text, /PRIVATE|"vin"|"raw"/);
  assert.deepEqual(commands, [['snapshot', '--vehicle', '1', '--json'], ['compare', '--vehicle', '1', '--json']]); assert.equal((await f.get('/api/garage')).json.request_count, 2);
});
test('static symlinks cannot expose files outside allowlist', async t => {
  const f = await fixture(t, { mode: 'demo' });
  await fs.writeFile(path.join(f.root, 'private-synthetic.txt'), 'PRIVATE');
  await fs.unlink(path.join(f.root, 'web/app.js')); await fs.symlink(path.join(f.root, 'private-synthetic.txt'), path.join(f.root, 'web/app.js'));
  assert.equal((await f.get('/app.js')).status, 404);
  await fs.rename(path.join(f.root, 'web'), path.join(f.root, 'other-web')); await fs.symlink(path.join(f.root, 'other-web'), path.join(f.root, 'web'));
  assert.equal((await f.get('/')).status, 404);
});
test('chunked bodies are bounded and duplicate/forged headers are rejected', async t => {
  let calls = 0;
  const f = await fixture(t, { client: { async listVehicles() { calls++; return []; } } });
  const oversized = await f.post('/api/refresh', ' '.repeat(4097), { 'Transfer-Encoding': 'chunked' });
  assert.equal(oversized.status, 413); security(oversized);
  const duplicate = await new Promise((resolve, reject) => {
    const socket = net.connect(f.port, '127.0.0.1');
    let response = '';
    socket.on('connect', () => socket.write('GET /api/bootstrap HTTP/1.1\r\nHost: localhost:' + f.port + '\r\nHost: evil.test:' + f.port + '\r\nConnection: close\r\n\r\n'));
    socket.on('data', chunk => { response += chunk; });
    socket.on('error', reject); socket.on('end', () => resolve(response));
  });
  assert.ok(duplicate.startsWith('HTTP/1.1 403'));
  const token = await f.post('/api/refresh', {}, { 'X-Zappy-CSRF': ['x'.repeat(64), f.bootstrap.csrf] });
  assert.equal(token.status, 403);
  const localhost = await f.post('/api/refresh', {}, { Host: 'localhost:' + f.port, Origin: 'http://localhost:' + f.port });
  assert.equal(localhost.status, 200); assert.equal(calls, 1);
});
test('capture auth errors stay generic and non-online reads are blocked by narrow wrapper', async t => {
  const f = await fixture(t, { client: { async listVehicles() { throw Object.assign(Error('private-access-token'), { code: 'AUTH_CONFIG' }); } }, run: async (_args, { client }) => {
    try { await client.listVehicles(); } catch {} return 1;
  } });
  const response = await f.post('/api/capture', { vehicle: 1 });
  assert.equal(response.status, 401); assert.equal(response.json.error, 'AUTH_REQUIRED'); assert.doesNotMatch(response.text, /private-access-token/);
  assert.equal((await f.get('/api/garage')).json.request_count, 1);
  let dataReads = 0;
  const x = await fixture(t, { client: { async getVehicleData() { dataReads++; } }, run: async (_args, { client }) => { await client.getVehicleData({ state: 'asleep' }); return 0; } });
  assert.equal((await x.post('/api/capture', { vehicle: 1 })).status, 409); assert.equal(dataReads, 0);
});
test('failed refresh retains prior safe cache and failure cooldown prevents request storms', async t => {
  let time = stamp; let lists = 0;
  const f = await fixture(t, { now: () => time, client: { async listVehicles() { lists++; if (lists > 1) throw Error('private-error'); return [{ state: 'asleep' }]; } } });
  assert.equal((await f.post('/api/refresh')).status, 200);
  const prior = (await f.get('/api/garage')).json;
  time += 10000;
  assert.equal((await f.post('/api/refresh')).status, 502);
  const after = (await f.get('/api/garage')).json;
  assert.deepEqual(after.vehicles, prior.vehicles); assert.equal(after.updated_at, prior.updated_at); assert.equal(after.request_count, 2);
  assert.equal((await f.post('/api/refresh')).status, 429); assert.equal(lists, 2);
});

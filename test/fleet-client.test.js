'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { createFleetClient, FleetError } = require('../scripts/fleet-client.cjs');

const NOW = 1900000000000;
const API = 'https://fleet-api.prd.na.vn.cloud.tesla.com';
const AUTH = 'https://fleet-auth.prd.vn.cloud.tesla.com/oauth2/v3/token';
const response = (body, status = 200) => ({ status, async json() { return body; } });
const rotated = () => ({ access_token: 'new-access-private', refresh_token: 'new-refresh-private', expires_in: 3600 });

async function fixture(t, extra = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'zappy-fleet-test-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const local = path.join(root, '.local');
  await fs.mkdir(local, { mode: 0o700 });
  const tokenFile = path.join(local, 'oauth-tokens.json');
  const tokens = { access_token: 'old-access-private', refresh_token: 'old-refresh-private', expires_at: NOW / 1000 + 3600, retained: 'metadata', ...extra };
  await fs.writeFile(tokenFile, JSON.stringify(tokens), { mode: 0o600 });
  await fs.writeFile(path.join(local, 'tesla-credentials.json'), JSON.stringify({ client_id: 'dummy-client', client_secret: 'never-send-this' }), { mode: 0o600 });
  return { root, local, tokenFile, tokens, client: fetch => createFleetClient({ root, fetch, now: () => NOW }) };
}

async function safeReject(promise, code, status) {
  await assert.rejects(promise, error => {
    assert.ok(error instanceof FleetError);
    assert.equal(error.code, code);
    if (status) assert.equal(error.status, status);
    const publicText = `${error.stack} ${JSON.stringify(error)}`;
    assert.doesNotMatch(publicText, /private|5YJ3E1EA7KF000001|evil\.example|provider-sensitive/);
    assert.equal(error.cause, undefined);
    return true;
  });
}

test('raw response values, fixed GET endpoints, no extra scope or commands', async t => {
  const f = await fixture(t);
  const calls = [];
  const vehicles = [{ id_s: '12345', state: 'online' }];
  const data = { charge_state: { battery_level: 45 } };
  const client = f.client(async (url, init) => {
    calls.push([url, init]);
    return response({ response: calls.length === 1 ? vehicles : data });
  });
  assert.deepEqual(await client.listVehicles(), vehicles);
  assert.deepEqual(await client.getVehicleData(vehicles[0]), data);
  assert.equal(calls[0][0], API + '/api/1/vehicles');
  assert.equal(calls[1][0], API + '/api/1/vehicles/12345/vehicle_data?endpoints=charge_state');
  for (const [, init] of calls) {
    assert.equal(init.method, 'GET');
    assert.equal(init.redirect, 'error');
    assert.ok(init.signal instanceof AbortSignal);
  }
  assert.deepEqual(Object.keys(client).sort(), ['getVehicleData', 'listVehicles']);
});

test('sleeping and unknown states never read authorization or call fetch', async () => {
  const client = createFleetClient({ root: '/unused-dummy-root', fetch: () => assert.fail('network') });
  for (const state of ['asleep', 'offline', 'Online', undefined]) {
    await safeReject(client.getVehicleData({ id_s: '123', state }), 'VEHICLE_ASLEEP');
  }
});

test('identifier allowlist rejects traversal, URLs, numeric coercion and invalid VINs', async t => {
  const f = await fixture(t);
  let calls = 0;
  const client = f.client(async url => {
    calls++;
    assert.equal(url, API + '/api/1/vehicles/5YJ3E1EA7KF000001/vehicle_data?endpoints=charge_state');
    return response({ response: { charge_state: {} } });
  });
  for (const id_s of ['../wake_up', '123?endpoints=location_data', 'https://evil.example', '1/command', '123\n', 123, 'I'.repeat(17), 'A'.repeat(18)]) {
    await safeReject(client.getVehicleData({ id_s, state: 'online' }), 'INVALID_VEHICLE');
  }
  await client.getVehicleData({ vin: '5YJ3E1EA7KF000001', state: 'online', endpoints: 'location_data' });
  assert.equal(calls, 1);
});

test('refreshes at sixty seconds, saves rotated token atomically with mode 600', async t => {
  const f = await fixture(t, { expires_at: NOW / 1000 + 60 });
  let exchanges = 0;
  const client = f.client(async (url, init) => {
    if (url === AUTH) {
      exchanges++;
      assert.equal(init.method, 'POST');
      assert.equal(init.redirect, 'error');
      const form = new URLSearchParams(init.body);
      assert.deepEqual([...form.keys()].sort(), ['audience', 'client_id', 'grant_type', 'refresh_token']);
      assert.equal(form.get('audience'), API);
      assert.equal(form.get('grant_type'), 'refresh_token');
      assert.equal(form.get('refresh_token'), f.tokens.refresh_token);
      assert.equal((await fs.stat(path.join(f.local, '.fleet-refresh.lock'))).mode & 0o777, 0o700);
      return response(rotated());
    }
    assert.equal(init.headers.Authorization, 'Bearer new-access-private');
    return response({ response: [] });
  });
  await client.listVehicles();
  await client.listVehicles();
  assert.equal(exchanges, 1);
  const saved = JSON.parse(await fs.readFile(f.tokenFile, 'utf8'));
  assert.equal(saved.refresh_token, rotated().refresh_token);
  assert.equal(saved.retained, 'metadata');
  assert.equal(Date.parse(saved.expires_at), NOW + 3600000);
  assert.equal((await fs.stat(f.tokenFile)).mode & 0o777, 0o600);
  assert.deepEqual((await fs.readdir(f.local)).sort(), ['oauth-tokens.json', 'tesla-credentials.json']);
});

test('missing refresh replacement, malformed tokens and failed exchanges preserve old record', async t => {
  for (const reply of [response({ access_token: 'new-access-private', expires_in: 3600 }), response({ ...rotated(), expires_in: -1 }), response({ error: 'provider-sensitive' }, 400), response({ error: 'provider-sensitive' })]) {
    const f = await fixture(t, { expires_at: 1 });
    const before = await fs.readFile(f.tokenFile, 'utf8');
    await assert.rejects(f.client(async () => reply).listVehicles(), FleetError);
    assert.equal(await fs.readFile(f.tokenFile, 'utf8'), before);
    assert.equal((await fs.readdir(f.local)).length, reply.status === 400 ? 2 : 3);
  }
});

test('concurrent calls and separate clients use one refresh exchange', async t => {
  const f = await fixture(t, { expires_at: 1 });
  let exchanges = 0;
  const fetch = async url => {
    if (url === AUTH) {
      exchanges++;
      await new Promise(resolve => setTimeout(resolve, 20));
      return response(rotated());
    }
    return response({ response: [] });
  };
  const a = f.client(fetch), b = f.client(fetch);
  await Promise.all(Array.from({ length: 20 }, (_, i) => (i % 2 ? a : b).listVehicles()));
  assert.equal(exchanges, 1);
});

test('401 forced refresh is coordinated and each request retries only once', async t => {
  const f = await fixture(t);
  let exchanges = 0, gets = 0;
  const client = f.client(async (url, init) => {
    if (url === AUTH) { exchanges++; return response(rotated()); }
    gets++;
    if (init.headers.Authorization.includes('old-access')) return response(null, 401);
    return response({ response: [] });
  });
  await Promise.all([client.listVehicles(), client.listVehicles()]);
  assert.equal(exchanges, 1);
  assert.equal(gets, 4);
  const g = await fixture(t);
  let attempts = 0, refreshes = 0;
  await safeReject(g.client(async url => {
    if (url === AUTH) { refreshes++; return response(rotated()); }
    attempts++; return response(null, 401);
  }).listVehicles(), 'UNAUTHORIZED', 401);
  assert.equal(attempts, 2);
  assert.equal(refreshes, 1);
});

test('network, invalid JSON, HTTP failures and HTTP200 error payloads are sanitized', async t => {
  const f = await fixture(t);
  await safeReject(f.client(async () => { throw new Error('provider-sensitive old-access-private https://evil.example/5YJ3E1EA7KF000001'); }).listVehicles(), 'NETWORK_ERROR');
  await safeReject(f.client(async () => ({ status: 200, json: async () => { throw new Error('provider-sensitive'); } })).listVehicles(), 'INVALID_RESPONSE', 200);
  await safeReject(f.client(async () => response('provider-sensitive', 500)).listVehicles(), 'API_ERROR', 500);
  for (const body of [{ error: 'provider-sensitive' }, { response: null }, { response: [], error: 'provider-sensitive' }, { response: {} }]) {
    await safeReject(f.client(async () => response(body)).listVehicles(), 'API_RESPONSE_ERROR', 200);
  }
  await safeReject(f.client(async () => response({ response: { error: 'provider-sensitive' } })).getVehicleData({ id_s: '123', state: 'online' }), 'API_RESPONSE_ERROR', 200);
});

test('fetch timeout bounds hung fetch and hung response body', async t => {
  const f = await fixture(t);
  for (const fetch of [async () => new Promise(() => {}), async () => ({ status: 200, json: () => new Promise(() => {}) })]) {
    await safeReject(createFleetClient({ root: f.root, fetch, now: () => NOW, timeoutMs: 20 }).listVehicles(), 'REQUEST_TIMEOUT');
  }
});

test('existing lock is never stolen, times out safely and preserves tokens', async t => {
  const f = await fixture(t, { expires_at: 1 });
  const lock = path.join(f.local, '.fleet-refresh.lock');
  await fs.mkdir(lock, { mode: 0o700 });
  await fs.utimes(lock, new Date(0), new Date(0));
  await safeReject(createFleetClient({ root: f.root, now: () => NOW, lockWaitMs: 30, lockPollMs: 5, fetch: () => assert.fail('network') }).listVehicles(), 'TOKEN_REFRESH_LOCKED');
  assert.ok((await fs.stat(lock)).isDirectory());
  assert.deepEqual(JSON.parse(await fs.readFile(f.tokenFile, 'utf8')), f.tokens);
});

test('lock acquisition rereads a token replaced by another process', async t => {
  const f = await fixture(t, { expires_at: 1 });
  const lock = path.join(f.local, '.fleet-refresh.lock');
  await fs.mkdir(lock, { mode: 0o700 });
  const pending = createFleetClient({ root: f.root, now: () => NOW, lockWaitMs: 500, lockPollMs: 5, fetch: async url => {
    assert.notEqual(url, AUTH);
    return response({ response: [] });
  } }).listVehicles();
  await new Promise(resolve => setTimeout(resolve, 20));
  await fs.writeFile(f.tokenFile, JSON.stringify({ ...rotated(), expires_at: NOW / 1000 + 3600 }));
  await fs.rmdir(lock);
  await pending;
});

test('cross-process clients perform a single exchange under mkdir lock', async t => {
  const f = await fixture(t, { expires_at: 1 });
  const moduleFile = require.resolve('../scripts/fleet-client.cjs');
  const script = `
    const fs = require('node:fs/promises');
    const { createFleetClient } = require(process.argv[1]);
    const root = process.argv[2];
    const client = createFleetClient({ root, now: () => ${NOW}, lockPollMs: 5,
      fetch: async (url) => {
        if (url === ${JSON.stringify(AUTH)}) {
          await fs.appendFile(root + '/exchanges', 'exchange\\n');
          await new Promise(r => setTimeout(r, 80));
          return { status: 200, json: async () => (${JSON.stringify(rotated())}) };
        }
        return { status: 200, json: async () => ({response: []}) };
      }
    });
    client.listVehicles().catch(() => { process.exitCode = 1; });
  `;
  function child() {
    return new Promise((resolve, reject) => {
      const p = spawn(process.execPath, ['-e', script, moduleFile, f.root], { stdio: ['ignore', 'pipe', 'pipe'] });
      let output = '';
      p.stdout.on('data', chunk => { output += chunk; });
      p.stderr.on('data', chunk => { output += chunk; });
      p.on('error', reject);
      p.on('exit', code => { try { assert.equal(code, 0); assert.equal(output, ''); resolve(); } catch (e) { reject(e); } });
    });
  }
  await Promise.all([child(), child(), child()]);
  assert.equal(await fs.readFile(path.join(f.root, 'exchanges'), 'utf8'), 'exchange\n');
});

test('delayed old-token 401 reuses the already rotated token', async t => {
  const f = await fixture(t);
  let release;
  const delayed = new Promise(resolve => { release = resolve; });
  let oldRequests = 0, exchanges = 0;
  const client = f.client(async (url, init) => {
    if (url === AUTH) { exchanges++; return response(rotated()); }
    if (init.headers.Authorization.includes('old-access')) {
      oldRequests++;
      if (oldRequests === 1) await delayed;
      return response(null, 401);
    }
    return response({ response: [] });
  });
  const first = client.listVehicles();
  // Both initial requests must use the old token, but only one 401 arrives first.
  while (oldRequests < 1) await new Promise(resolve => setTimeout(resolve, 1));
  await client.listVehicles();
  release();
  await first;
  assert.equal(exchanges, 1);
});

test('missing client ID and provider failures do not alter tokens or expose details', async t => {
  const f = await fixture(t, { expires_at: 1 });
  const before = await fs.readFile(f.tokenFile, 'utf8');
  await fs.writeFile(path.join(f.local, 'tesla-credentials.json'), '{}');
  await safeReject(f.client(async () => assert.fail('network')).listVehicles(), 'AUTH_CONFIG');
  assert.equal(await fs.readFile(f.tokenFile, 'utf8'), before);
  await fs.writeFile(path.join(f.local, 'tesla-credentials.json'), '{"client_id":"dummy"}');
  await safeReject(f.client(async () => response({ error: 'provider-sensitive 5YJ3E1EA7KF000001' }, 403)).listVehicles(), 'TOKEN_REFRESH_FAILED', 403);
  await safeReject(f.client(async () => response({ access_token: 'new-access-private', expires_in: 3600 })).listVehicles(), 'TOKEN_REFRESH_POISONED', 200);
  assert.equal(await fs.readFile(f.tokenFile, 'utf8'), before);
});

test('arbitrary thrown values and forged FleetErrors are sanitized', async t => {
  const f = await fixture(t);
  for (const thrown of [undefined, null, new FleetError('LEAK', 'provider-sensitive old-refresh-private')]) {
    await safeReject(f.client(async () => { throw thrown; }).listVehicles(), 'NETWORK_ERROR');
  }
});

test('failed atomic save leaves the original record intact', async t => {
  const f = await fixture(t, { expires_at: 1 });
  const before = await fs.readFile(f.tokenFile, 'utf8');
  const client = f.client(async () => {
    // Simulate a filesystem failure after the successful exchange: a directory
    // cannot be atomically replaced with the token file on the same filesystem.
    await fs.rename(f.tokenFile, path.join(f.local, 'old-record'));
    await fs.mkdir(f.tokenFile);
    return response(rotated());
  });
  await safeReject(client.listVehicles(), 'TOKEN_REFRESH_POISONED');
  assert.equal(await fs.readFile(path.join(f.local, 'old-record'), 'utf8'), before);
  assert.deepEqual((await fs.readdir(f.local)).sort(), ['.fleet-refresh.lock', 'oauth-tokens.json', 'old-record', 'tesla-credentials.json']);
});

test('uncertain exchanges poison the lock and never resubmit the old refresh token', async t => {
  for (const scenario of ['failed-save', 'malformed-success', 'missing-rotation', 'timeout', 'network-error', 'server-error', 'invalid-json', 'body-timeout', 'http-timeout']) {
    await t.test(scenario, async t => {
      const f = await fixture(t, { expires_at: 1 });
      const before = await fs.readFile(f.tokenFile, 'utf8');
      let exchanges = 0;
      const fetch = async url => {
        assert.equal(url, AUTH);
        exchanges++;
        if (scenario === 'failed-save') {
          await fs.rename(f.tokenFile, path.join(f.local, 'old-record'));
          await fs.mkdir(f.tokenFile);
          return response(rotated());
        }
        if (scenario === 'malformed-success') return response({ ...rotated(), expires_in: -1 });
        if (scenario === 'missing-rotation') return response({ access_token: 'new-access-private', expires_in: 3600 });
        if (scenario === 'timeout') return new Promise(() => {});
        if (scenario === 'network-error') throw new Error('provider-sensitive');
        if (scenario === 'server-error') return response({ error: 'provider-sensitive' }, 503);
        if (scenario === 'http-timeout') return response(null, 408);
        if (scenario === 'invalid-json') return { status: 200, json: async () => { throw new Error('provider-sensitive'); } };
        return { status: 200, json: () => new Promise(() => {}) };
      };
      const a = createFleetClient({ root: f.root, fetch, now: () => NOW, timeoutMs: 25 });
      const b = createFleetClient({ root: f.root, fetch, now: () => NOW, timeoutMs: 25 });
      // Two independent clients share an in-flight exchange and see its poison.
      const outcomes = await Promise.allSettled([a.listVehicles(), b.listVehicles()]);
      for (const outcome of outcomes) {
        assert.equal(outcome.status, 'rejected');
        assert.equal(outcome.reason.code, 'TOKEN_REFRESH_POISONED');
        assert.match(outcome.reason.message, /npm run login/);
      }
      if (scenario === 'failed-save') {
        await fs.rmdir(f.tokenFile);
        await fs.rename(path.join(f.local, 'old-record'), f.tokenFile);
      }
      assert.equal(await fs.readFile(f.tokenFile, 'utf8'), before);
      for (const client of [a, b]) await safeReject(client.listVehicles(), 'TOKEN_REFRESH_POISONED');
      assert.equal(exchanges, 1);
      const lock = path.join(f.local, '.fleet-refresh.lock');
      assert.equal((await fs.stat(lock)).mode & 0o777, 0o700);
      assert.deepEqual((await fs.readdir(lock)).sort(), ['exchange-started', 'poisoned']);
      for (const name of ['exchange-started', 'poisoned']) assert.equal((await fs.stat(path.join(lock, name))).mode & 0o777, 0o600);
    });
  }
});

test('definitive refresh 4xx rejection releases lock for a later retry', async t => {
  for (const status of [400, 401, 403, 429]) {
    const f = await fixture(t, { expires_at: 1 });
    let exchanges = 0;
    const fetch = async url => {
      if (url === AUTH) { exchanges++; return exchanges === 1 ? response(null, status) : response(rotated()); }
      return response({ response: [] });
    };
    await safeReject(f.client(fetch).listVehicles(), 'TOKEN_REFRESH_FAILED', status);
    await assert.rejects(fs.stat(path.join(f.local, '.fleet-refresh.lock')), { code: 'ENOENT' });
    await f.client(fetch).listVehicles();
    assert.equal(exchanges, 2);
    await assert.rejects(fs.stat(path.join(f.local, '.fleet-refresh.lock')), { code: 'ENOENT' });
  }
});

test('poison permits fresh-token API reads but blocks forced refresh and survives lock deletion in-process', async t => {
  const f = await fixture(t, { expires_at: 1 });
  let exchanges = 0;
  const fetch = async url => {
    if (url === AUTH) { exchanges++; return response({}); }
    return response({ response: [] });
  };
  await safeReject(f.client(fetch).listVehicles(), 'TOKEN_REFRESH_POISONED');
  await fs.writeFile(f.tokenFile, JSON.stringify({ ...f.tokens, expires_at: NOW / 1000 + 3600 }));
  assert.deepEqual(await f.client(fetch).listVehicles(), []);
  await safeReject(f.client(async url => {
    assert.notEqual(url, AUTH);
    return response(null, 401);
  }).listVehicles(), 'TOKEN_REFRESH_POISONED');
  // Manual deletion alone cannot authorize this process to exchange again.
  await fs.rm(path.join(f.local, '.fleet-refresh.lock'), { recursive: true });
  await fs.writeFile(f.tokenFile, JSON.stringify(f.tokens));
  await safeReject(f.client(fetch).listVehicles(), 'TOKEN_REFRESH_POISONED');
  assert.equal(exchanges, 1);
});

test('waiting independent processes cannot exchange after another process poisons the lock', async t => {
  const f = await fixture(t, { expires_at: 1 });
  const moduleFile = require.resolve('../scripts/fleet-client.cjs');
  const script = `
    const fs = require('node:fs/promises');
    const { createFleetClient } = require(process.argv[1]);
    const root = process.argv[2];
    const client = createFleetClient({ root, now: () => ${NOW}, lockPollMs: 5, lockWaitMs: 1000,
      fetch: async (url) => {
        if (url !== ${JSON.stringify(AUTH)}) throw new Error('unexpected API request');
        await fs.appendFile(root + '/exchanges', 'exchange\\n');
        await new Promise(r => setTimeout(r, 60));
        return { status: 200, json: async () => ({access_token: 'dummy', expires_in: 3600}) };
      }
    });
    client.listVehicles().then(() => { process.exitCode = 1; }, error => {
      if (error.code !== 'TOKEN_REFRESH_POISONED') process.exitCode = 2;
    });
  `;
  function child() {
    return new Promise((resolve, reject) => {
      const p = spawn(process.execPath, ['-e', script, moduleFile, f.root], { stdio: ['ignore', 'pipe', 'pipe'] });
      let output = '';
      p.stdout.on('data', chunk => { output += chunk; });
      p.stderr.on('data', chunk => { output += chunk; });
      p.on('error', reject);
      p.on('exit', code => { try { assert.equal(code, 0); assert.equal(output, ''); resolve(); } catch (error) { reject(error); } });
    });
  }
  await Promise.all([child(), child(), child()]);
  // Also simulate a fresh process started after the poisoned owner exited.
  await child();
  assert.equal(await fs.readFile(path.join(f.root, 'exchanges'), 'utf8'), 'exchange\n');
  assert.ok((await fs.stat(path.join(f.local, '.fleet-refresh.lock'))).isDirectory());
});

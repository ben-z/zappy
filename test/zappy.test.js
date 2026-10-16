'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { run } = require('../scripts/zappy.cjs');
const SECRET = 'SYNTHETIC-PRIVATE-INJECTION\nforged: true';
const vehicle = (id = 'synthetic-id-a', state = 'online') => ({ id, vin: `synthetic-vin-${id}`, state, display_name: SECRET, latitude: 42, option_codes: SECRET });
const data = (battery = 50) => ({ charge_state: { battery_level: battery, usable_battery_level: 49,
  charge_limit_soc: 80, charging_state: 'Charging', charger_power: 7, battery_range: 150, time_to_full_charge: 2,
  unknown: { private: SECRET } }, drive_state: { latitude: 42, longitude: 43 }, vin: SECRET, id: SECRET });
async function invoke(argv, options = {}) {
  let stdout = '', stderr = '';
  const code = await run(argv, { ...options, stdout: { write: text => { stdout += text; } }, stderr: { write: text => { stderr += text; } } });
  return { code, stdout, stderr, parsed: code === 0 && argv.includes('--json') ? JSON.parse(stdout) : null };
}
async function temporary(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'zappy-synthetic-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}
function fixture(vehicles = [vehicle()], payload = data()) {
  const calls = [];
  return { calls, async listVehicles() { calls.push('list'); return vehicles; }, async getVehicleData(v) { calls.push(['data', v]); return payload; } };
}
function assertPrivateFree(result) {
  const combined = result.stdout + result.stderr;
  for (const forbidden of [SECRET, 'synthetic-vin', 'synthetic-id', 'latitude', 'longitude', 'display_name', 'option_codes', 'fingerprint']) assert.ok(!combined.includes(forbidden), forbidden);
}

test('import and offline commands do not load Fleet core, use network, or touch disk', async t => {
  const script = path.resolve(__dirname, '../scripts/zappy.cjs');
  const child = spawnSync(process.execPath, ['-e', `const Module = require('node:module'); const orig = Module._load; Module._load = function(name, ...rest) { if (name.includes('fleet-client')) throw Error('core loaded'); return orig.call(this, name, ...rest); }; require(${JSON.stringify(script)});`], { encoding: 'utf8' });
  assert.equal(child.status, 0); assert.equal(child.stdout, ''); assert.equal(child.stderr, '');
  const root = await temporary(t);
  const client = { listVehicles() { throw new Error('NETWORK MUST NOT RUN'); } };
  for (const args of [['demo', '--json'], ['plan', '--current', '20', '--target', '80', '--capacity-kwh', '75', '--power-kw', '10', '--json']]) {
    const result = await invoke(args, { root, client });
    assert.equal(result.code, 0); assertPrivateFree(result);
    assert.deepEqual(await fs.readdir(root), []);
  }
  const demo = await invoke(['demo', '--json'], { root, client });
  assert.equal(demo.parsed.synthetic, true);
  assert.equal(demo.parsed.status.battery_percent, 50);
  assert.equal(demo.parsed.delta.battery_percentage_point_delta, 10);
  assert.ok(demo.parsed.plan.estimated_hours > 0);
});

test('vehicles makes exactly one list request and emits only ordinal aliases and safe states', async () => {
  const client = fixture([vehicle(), vehicle('synthetic-b', 'asleep'), vehicle('synthetic-c', SECRET)]);
  const result = await invoke(['vehicles', '--json'], { client });
  assert.equal(result.code, 0);
  assert.deepEqual(result.parsed, [{ alias: 'vehicle-1', state: 'online' }, { alias: 'vehicle-2', state: 'asleep' }, { alias: 'vehicle-3', state: null }]);
  assert.deepEqual(client.calls, ['list']); assertPrivateFree(result);
  assert.match(result.stderr, /not persistent vehicle identities/);
});

test('status reads data only for online vehicles, whitelists payloads, and never stores', async t => {
  const root = await temporary(t);
  for (const state of ['online', 'asleep', 'offline', SECRET]) {
    const client = fixture([vehicle('synthetic-a', state)]);
    const result = await invoke(['status', '--vehicle', '1', '--json'], { client, root });
    assert.equal(result.code, 0); assertPrivateFree(result);
    assert.equal(client.calls.length, state === 'online' ? 2 : 1);
    assert.equal(result.parsed.battery_percent, state === 'online' ? 50 : null);
    assert.deepEqual(await fs.readdir(root), []);
  }
});

test('malicious numeric and nested values are never serialized', async () => {
  const payload = { charge_state: { battery_level: SECRET, usable_battery_level: {}, charge_limit_soc: '80',
    charging_state: { injected: SECRET }, charger_power: Infinity, battery_range: [SECRET], time_to_full_charge: SECRET } };
  const result = await invoke(['status', '--vehicle', '1', '--json'], { client: fixture([vehicle()], payload) });
  assert.equal(result.code, 0); assertPrivateFree(result);
  for (const [key, value] of Object.entries(result.parsed)) if (!['alias', 'state'].includes(key)) assert.equal(value, null);
});

test('unknown flags, raw selectors, duplicates, missing and malformed values fail before any calls', async () => {
  for (const argv of [['status'], ['status', '--vehicle', '0'], ['status', '--vehicle', '../1'], ['status', '--vehicle', 'synthetic-id'],
    ['status', '--vehicle', '1.1'], ['status', '--vehicle', '1', '--vehicle', '2'], ['vehicles', '--id', 'synthetic-id'],
    ['vehicles', 'anything'], ['vehicles', '--json', '--json'], ['status', '--vehicle'], ['demo', '--wake'],
    ['plan', '--current', '20'], ['bogus'], ['status', '--vin', 'synthetic-vin'], ['demo', '--json=true']]) {
    const client = fixture(); const result = await invoke(argv, { client });
    assert.equal(result.code, 1, argv.join(' ')); assert.equal(result.stdout, ''); assert.deepEqual(client.calls, []);
    assertPrivateFree(result); assert.ok(!result.stderr.includes('Error:'));
  }
});

test('plan validates numeric flags and calculates deterministic estimate offline', async () => {
  const base = ['plan', '--current', '20', '--target', '80', '--capacity-kwh', '75', '--power-kw', '10'];
  const result = await invoke([...base, '--price-per-kwh', '.25', '--json']);
  assert.equal(result.parsed.estimated_hours, 5); assert.equal(result.parsed.estimated_cost, 12.5);
  for (const extra of [['--efficiency', '0'], ['--efficiency', '1.1'], ['--price-per-kwh', '-1'], ['--price-per-kwh', 'Infinity'], ['--efficiency', SECRET]]) {
    const invalid = await invoke([...base, ...extra]); assert.equal(invalid.code, 1); assertPrivateFree(invalid);
  }
});

test('private snapshots use HMAC, owner-only permissions, atomic files and offline comparisons', async t => {
  const root = await temporary(t);
  const client = fixture();
  const first = await invoke(['snapshot', '--vehicle', '1', '--json'], { root, client, now: () => Date.parse('2026-01-01T00:00:00Z') });
  assert.equal(first.code, 0); assertPrivateFree(first);
  const local = path.join(root, '.local'); const directory = path.join(local, 'snapshots');
  const currentFile = path.join(directory, 'vehicle-1.json'); const previousFile = path.join(directory, 'vehicle-1.previous.json');
  const firstContents = await fs.readFile(currentFile, 'utf8'); const firstRecord = JSON.parse(firstContents);
  const key = await fs.readFile(path.join(local, 'privacy-key'), 'utf8');
  assert.equal(firstRecord.fingerprint, crypto.createHmac('sha256', Buffer.from(key, 'hex')).update(JSON.stringify(['vin', 'synthetic-vin-synthetic-id-a'])).digest('hex'));
  assert.ok(!firstContents.includes('synthetic-vin')); assert.ok(!firstContents.includes(SECRET));
  const second = await invoke(['snapshot', '--vehicle', '1', '--json'], { root, client: fixture([vehicle()], data(60)), now: () => Date.parse('2026-01-01T02:00:00Z') });
  assert.equal(second.code, 0); assertPrivateFree(second);
  assert.deepEqual(JSON.parse(await fs.readFile(previousFile, 'utf8')), firstRecord);
  assert.deepEqual((await fs.readdir(directory)).sort(), ['vehicle-1.json', 'vehicle-1.previous.json']);
  for (const dir of [local, directory]) assert.equal((await fs.stat(dir)).mode & 0o777, 0o700);
  for (const file of [currentFile, previousFile, path.join(local, 'privacy-key')]) assert.equal((await fs.stat(file)).mode & 0o777, 0o600);
  const compare = await invoke(['compare', '--vehicle', '1', '--json'], { root, client: { listVehicles() { throw Error('OFFLINE'); } } });
  assert.equal(compare.code, 0); assertPrivateFree(compare);
  assert.equal(compare.parsed.elapsed_hours, 2); assert.equal(compare.parsed.battery_percentage_point_delta, 10);
  assert.match(compare.parsed.caveat, /driving, weather, and charging/);
});

test('alias reordering refuses comparison instead of mixing identities', async t => {
  const root = await temporary(t);
  assert.equal((await invoke(['snapshot', '--vehicle', '1'], { root, client: fixture([vehicle('synthetic-a'), vehicle('synthetic-b')]), now: () => 0 })).code, 0);
  assert.equal((await invoke(['snapshot', '--vehicle', '1'], { root, client: fixture([vehicle('synthetic-b'), vehicle('synthetic-a')]), now: () => 3600000 })).code, 0);
  const result = await invoke(['compare', '--vehicle', '1', '--json'], { root });
  assert.equal(result.code, 1); assert.match(result.stderr, /identity changed/); assertPrivateFree(result);
});

test('symlink and hardlink paths cannot redirect private writes or reads', async t => {
  for (const target of ['local', 'directory', 'key', 'current', 'previous', 'hard-key']) {
    const root = await temporary(t); const outside = await temporary(t);
    const sentinel = path.join(outside, 'sentinel'); await fs.writeFile(sentinel, 'synthetic-protected', { mode: 0o644 });
    const local = path.join(root, '.local'); const directory = path.join(local, 'snapshots');
    if (target === 'local') await fs.symlink(outside, local);
    else {
      await fs.mkdir(local, { mode: 0o700 });
      if (target === 'directory') await fs.symlink(outside, directory);
      else {
        await fs.mkdir(directory, { mode: 0o700 });
        if (target === 'key') await fs.symlink(sentinel, path.join(local, 'privacy-key'));
        if (target === 'hard-key') await fs.link(sentinel, path.join(local, 'privacy-key'));
        if (target === 'current') await fs.symlink(sentinel, path.join(directory, 'vehicle-1.json'));
        if (target === 'previous') {
          assert.equal((await invoke(['snapshot', '--vehicle', '1'], { root, client: fixture() })).code, 0);
          await fs.symlink(sentinel, path.join(directory, 'vehicle-1.previous.json'));
        }
      }
    }
    const result = await invoke(['snapshot', '--vehicle', '1'], { root, client: fixture() });
    assert.equal(result.code, 1, target); assertPrivateFree(result);
    assert.equal(await fs.readFile(sentinel, 'utf8'), 'synthetic-protected');
    assert.equal((await fs.stat(sentinel)).mode & 0o777, 0o644);
    assert.deepEqual(await fs.readdir(outside), ['sentinel']);
    const comparison = await invoke(['compare', '--vehicle', '1'], { root });
    assert.equal(comparison.code, 1); assertPrivateFree(comparison);
  }
});

test('absent, corrupted or malicious private snapshots fail safely without leaking content', async t => {
  const root = await temporary(t);
  assert.equal((await invoke(['compare', '--vehicle', '1'], { root })).code, 1);
  await invoke(['snapshot', '--vehicle', '1'], { root, client: fixture() });
  const file = path.join(root, '.local/snapshots/vehicle-1.json');
  await fs.writeFile(file, SECRET);
  const result = await invoke(['compare', '--vehicle', '1'], { root });
  assert.equal(result.code, 1); assertPrivateFree(result);
});

test('provider errors never leak messages, payloads, codes, or stack traces', async () => {
  for (const method of ['listVehicles', 'getVehicleData']) {
    const client = fixture(); client[method] = async () => { throw Object.assign(new Error(SECRET), { status: 401, code: SECRET, payload: { vin: SECRET } }); };
    const result = await invoke(['status', '--vehicle', '1', '--json'], { client });
    assert.equal(result.code, 1); assert.equal(result.stdout, '');
    assert.equal(result.stderr, 'Unable to complete request.\n'); assertPrivateFree(result);
  }
});


test('human demo output is structured and rounded while JSON retains precision', async () => {
  const human = await invoke(['demo']);
  assert.equal(human.code, 0);
  assert.match(human.stdout, /status:\n  alias: vehicle-1/);
  assert.match(human.stdout, /estimated range km: 241\.4\n/);
  assert.ok(!human.stdout.includes('000000000003'));
  assertPrivateFree(human);
  const machine = await invoke(['demo', '--json']);
  assert.equal(machine.parsed.status.estimated_range_km, 150 * 1.609344);
});


test('known authorization failures provide fixed recovery guidance without private details', async () => {
  const client = { async listVehicles() { const e = new Error(SECRET); e.name = 'FleetError'; e.code = 'TOKEN_REFRESH_POISONED'; throw e; } };
  const result = await invoke(['vehicles'], { client });
  assert.equal(result.code, 1);
  assert.match(result.stderr, /SECURITY\.md/);
  assertPrivateFree(result);
});

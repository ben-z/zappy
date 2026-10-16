#!/usr/bin/env node
'use strict';

const fs = require('node:fs/promises');
const { constants } = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { normalizeCharge, planCharging, compareSnapshots, state, number } = require('./insights.cjs');

const ALIAS_NOTE = 'Aliases are ordinal list positions, not persistent vehicle identities.';
const HELP = `Usage: zappy demo|vehicles [--json]
       zappy status|snapshot|compare --vehicle N [--json]
       zappy plan --current PCT --target PCT --capacity-kwh N --power-kw N [--efficiency .9] [--price-per-kwh N] [--json]
${ALIAS_NOTE}
Only vehicles, status, and snapshot use the network. No polling, wake, or vehicle commands.
`;
class SafeError extends Error {}
const fail = message => { throw new SafeError(message); };
function parse(argv) {
  const [command, ...args] = argv;
  if (command === undefined || command === '--help' || command === 'help') {
    if (args.length) fail('Invalid arguments. Use --help.');
    return { command: 'help', flags: {} };
  }
  const allowed = {
    demo: [], vehicles: [], status: ['vehicle'], snapshot: ['vehicle'], compare: ['vehicle'],
    plan: ['current', 'target', 'capacity-kwh', 'power-kw', 'efficiency', 'price-per-kwh']
  };
  if (!Object.hasOwn(allowed, command)) fail('Unknown command. Use --help.');
  const flags = Object.create(null);
  for (let i = 0; i < args.length; i++) {
    const key = args[i].startsWith('--') ? args[i].slice(2) : '';
    if ((!allowed[command].includes(key) && key !== 'json') || Object.hasOwn(flags, key)) fail('Invalid arguments. Use --help.');
    if (key === 'json') flags.json = true;
    else {
      const value = args[++i];
      if (value === undefined || value.startsWith('--')) fail('Missing flag value. Use --help.');
      flags[key] = value;
    }
  }
  if (['status', 'snapshot', 'compare'].includes(command) &&
      (!/^[1-9]\d*$/.test(flags.vehicle || '') || Number(flags.vehicle) > 100000)) fail('Provide --vehicle with a positive ordinal number.');
  if (command === 'plan') {
    for (const key of ['current', 'target', 'capacity-kwh', 'power-kw']) {
      if (!Object.hasOwn(flags, key)) fail('Missing charging plan parameter.');
    }
    for (const key of allowed.plan) {
      if (Object.hasOwn(flags, key)) {
        if (!/^(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(flags[key]) || !Number.isFinite(Number(flags[key]))) fail('Invalid numeric parameter.');
        flags[key] = Number(flags[key]);
      }
    }
  }
  return { command, flags };
}
function chargingPlan(flags) {
  try {
    return planCharging({ current: flags.current, target: flags.target, capacityKwh: flags['capacity-kwh'],
      powerKw: flags['power-kw'], efficiency: flags.efficiency, pricePerKwh: flags['price-per-kwh'] });
  } catch { fail('Invalid charging plan parameters.'); }
}
function dateNow(now) {
  const value = new Date(now());
  if (!Number.isFinite(value.getTime())) fail('Unable to determine snapshot time.');
  return value.toISOString();
}
// Private files are never followed through symlinks, and are always owner-only.
async function secureDir(dir, create) {
  if (create) await fs.mkdir(dir, { mode: 0o700 }).catch(error => { if (error.code !== 'EEXIST') throw error; });
  const handle = await fs.open(dir, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_DIRECTORY);
  try {
    const stat = await handle.stat();
    if (!stat.isDirectory()) throw new Error();
    if (create) await handle.chmod(0o700);
    else if ((stat.mode & 0o777) !== 0o700) throw new Error();
  } finally { await handle.close(); }
}
async function privatePaths(root, create = true) {
  const local = path.join(root, '.local');
  await secureDir(local, create);
  const dir = path.join(local, 'snapshots');
  await secureDir(dir, create);
  return { local, dir };
}
async function readPrivate(file, optional = false) {
  let handle;
  try {
    handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const stat = await handle.stat();
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > 65536 || (stat.mode & 0o777) !== 0o600) throw new Error();
    return await handle.readFile('utf8');
  } catch (error) {
    if (optional && error.code === 'ENOENT') return null;
    throw error;
  } finally { if (handle) await handle.close(); }
}
async function atomicPrivate(file, contents) {
  // Refuse an existing symlink or hard link rather than replacing it silently.
  try {
    const stat = await fs.lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) throw new Error();
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const temporary = path.join(path.dirname(file), `.tmp-${crypto.randomBytes(16).toString('hex')}`);
  let handle;
  try {
    handle = await fs.open(temporary, 'wx', 0o600);
    await handle.writeFile(contents, 'utf8');
    await handle.sync();
    await handle.close(); handle = null;
    await fs.rename(temporary, file);
  } finally {
    if (handle) await handle.close();
    await fs.unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; });
  }
}
async function privacyKey(local) {
  const file = path.join(local, 'privacy-key');
  let text = await readPrivate(file, true);
  if (text === null) {
    const generated = crypto.randomBytes(32).toString('hex');
    let handle;
    try {
      handle = await fs.open(file, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      await handle.writeFile(generated, 'utf8'); await handle.sync();
    } catch (error) { if (error.code !== 'EEXIST') throw error; }
    finally { if (handle) await handle.close(); }
    text = await readPrivate(file);
  }
  if (!/^[a-f0-9]{64}$/.test(text)) throw new Error();
  return Buffer.from(text, 'hex');
}
function identity(vehicle) {
  for (const field of ['vin', 'id_s', 'id']) {
    const value = vehicle?.[field];
    if ((typeof value === 'string' && value.length > 0 && value.length <= 512) ||
        (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0)) return JSON.stringify([field, value]);
  }
  fail('Cannot securely identify this vehicle for a private snapshot.');
}
function decodeRecord(text, alias) {
  const value = JSON.parse(text);
  if (!value || value.version !== 1 || !/^[a-f0-9]{64}$/.test(value.fingerprint) ||
      typeof value.captured_at !== 'string' || !Number.isFinite(Date.parse(value.captured_at)) ||
      !value.snapshot || value.snapshot.alias !== alias) throw new Error();
  const s = value.snapshot;
  const clean = normalizeCharge(alias, s.state, { charge_state: {
    battery_level: s.battery_percent, usable_battery_level: s.usable_battery_percent,
    charge_limit_soc: s.charge_limit_percent, charging_state: s.charging_state,
    charger_power: s.charger_power_kw, time_to_full_charge: s.time_to_full_charge_hours
  } });
  clean.estimated_range_km = number(s.estimated_range_km, 0, 2000 * 1.609344);
  return { version: 1, fingerprint: value.fingerprint, captured_at: value.captured_at, snapshot: clean };
}
async function saveSnapshot(root, alias, vehicle, snapshot, now) {
  try {
    const ident = identity(vehicle);
    const { local, dir } = await privatePaths(root);
    const key = await privacyKey(local);
    const file = path.join(dir, `${alias}.json`);
    const previous = await readPrivate(file, true);
    if (previous !== null) await atomicPrivate(path.join(dir, `${alias}.previous.json`), JSON.stringify(decodeRecord(previous, alias)) + '\n');
    const record = { version: 1, captured_at: dateNow(now),
      fingerprint: crypto.createHmac('sha256', key).update(ident).digest('hex'), snapshot };
    await atomicPrivate(file, JSON.stringify(record) + '\n');
  } catch (error) {
    if (error instanceof SafeError) throw error;
    fail('Unable to save private snapshot safely.');
  }
}
async function loadComparison(root, alias) {
  try {
    const { dir } = await privatePaths(root, false);
    const current = decodeRecord(await readPrivate(path.join(dir, `${alias}.json`)), alias);
    const previous = decodeRecord(await readPrivate(path.join(dir, `${alias}.previous.json`)), alias);
    if (current.fingerprint !== previous.fingerprint) fail('Cannot compare: vehicle identity changed at this ordinal alias.');
    return compareSnapshots(previous, current);
  } catch (error) {
    if (error instanceof SafeError) throw error;
    fail('Two valid private snapshots for this vehicle are required to compare.');
  }
}
function demo() {
  const snapshot = normalizeCharge('vehicle-1', 'online', { charge_state: {
    battery_level: 50, usable_battery_level: 49, charge_limit_soc: 80,
    charging_state: 'Charging', charger_power: 7, battery_range: 150, time_to_full_charge: 3
  } });
  const previous = { fingerprint: 'synthetic', captured_at: '2026-01-01T00:00:00Z', snapshot: { ...snapshot, battery_percent: 40, estimated_range_km: 200, charger_power_kw: 0 } };
  const current = { fingerprint: 'synthetic', captured_at: '2026-01-01T01:00:00Z', snapshot };
  return { synthetic: true, status: snapshot,
    plan: planCharging({ current: 50, target: 80, capacityKwh: 75, powerKw: 7 }),
    delta: compareSnapshots(previous, current) };
}
function render(value, json) {
  if (json) return JSON.stringify(value, null, 2) + '\n';
  if (Array.isArray(value)) return value.map(v => `${v.alias}: ${v.state ?? 'unknown'}`).join('\n') + '\n';
  // All values reaching here were constructed from a strict output whitelist.
  // Round only the human view; machine JSON preserves numeric precision.
  function lines(object, indent = '') {
    return Object.entries(object).flatMap(([key, item]) => {
      const label = key.replaceAll('_', ' ');
      if (item !== null && typeof item === 'object') return [`${indent}${label}:`, ...lines(item, indent + '  ')];
      const displayed = item === null ? 'unknown' : typeof item === 'number' ? Number(item.toFixed(2)) : item;
      return [`${indent}${label}: ${displayed}`];
    });
  }
  return lines(value).join('\n') + '\n';
}
async function run(argv, { client, root = path.resolve(__dirname, '..'), stdout = process.stdout, stderr = process.stderr, now = Date.now } = {}) {
  try {
    const { command, flags } = parse(argv);
    if (command === 'help') { stdout.write(HELP); return 0; }
    let result;
    if (command === 'demo') result = demo();
    else if (command === 'plan') result = chargingPlan(flags);
    else if (command === 'compare') result = await loadComparison(root, `vehicle-${flags.vehicle}`);
    else {
      // The core is loaded only for actual Fleet reads, never on import or offline commands.
      const fleet = client || require('./fleet-client.cjs').createFleetClient({ root, fetch: globalThis.fetch, now });
      const vehicles = await fleet.listVehicles();
      if (!Array.isArray(vehicles) || vehicles.length > 100000) fail('Unable to read vehicle list.');
      if (command === 'vehicles') result = vehicles.map((vehicle, index) => ({ alias: `vehicle-${index + 1}`, state: state(vehicle?.state) }));
      else {
        const vehicle = vehicles[Number(flags.vehicle) - 1];
        if (!vehicle || typeof vehicle !== 'object' || Array.isArray(vehicle)) fail('Vehicle ordinal not found.');
        const alias = `vehicle-${flags.vehicle}`;
        const data = vehicle.state === 'online' ? await fleet.getVehicleData(vehicle) : null;
        result = normalizeCharge(alias, vehicle.state, data);
        if (command === 'snapshot') await saveSnapshot(root, alias, vehicle, result, now);
      }
    }
    stdout.write(render(result, flags.json));
    if (['vehicles', 'status', 'snapshot', 'compare', 'demo'].includes(command)) stderr.write(ALIAS_NOTE + '\n');
    return 0;
  } catch (error) {
    stderr.write((error instanceof SafeError ? error.message : 'Unable to complete request.') + '\n');
    return 1;
  }
}
module.exports = { run };
if (require.main === module) run(process.argv.slice(2)).then(code => { process.exitCode = code; });

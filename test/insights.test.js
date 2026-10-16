'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeCharge, planCharging, compareSnapshots } = require('../scripts/insights.cjs');
const alias = 'vehicle-1';
const normalize = charge => normalizeCharge(alias, 'online', { charge_state: charge });

test('normalizes only explicitly whitelisted fields and converts Tesla miles to km', () => {
  const actual = normalize({ battery_level: 50, usable_battery_level: 49, charge_limit_soc: 80,
    charging_state: 'Charging', charger_power: 7, battery_range: 100, time_to_full_charge: 2,
    latitude: 99, nested: { arbitrary: 'SYNTHETIC-SECRET' }, display_name: 'SYNTHETIC-SECRET' });
  assert.deepEqual(actual, { alias, state: 'online', battery_percent: 50, usable_battery_percent: 49,
    charge_limit_percent: 80, charging_state: 'Charging', charger_power_kw: 7,
    estimated_range_km: 160.9344, time_to_full_charge_hours: 2 });
});

test('malformed numeric values, out-of-bounds values, and arbitrary enum strings become null', () => {
  for (const bad of ['80', 'SYNTHETIC-SECRET\nforged: true', {}, [], true, NaN, Infinity, -1, 1001, null, undefined]) {
    const actual = normalize({ battery_level: bad, usable_battery_level: bad, charge_limit_soc: bad,
      charging_state: 'SYNTHETIC-SECRET', charger_power: bad, battery_range: bad, time_to_full_charge: bad });
    assert.equal(actual.battery_percent, null);
    assert.equal(actual.usable_battery_percent, null);
    assert.equal(actual.charge_limit_percent, null);
    assert.equal(actual.charging_state, null);
    assert.equal(actual.time_to_full_charge_hours, null);
    if (bad !== 1001) { assert.equal(actual.charger_power_kw, null); assert.equal(actual.estimated_range_km, null); }
    assert.ok(!JSON.stringify(actual).includes('SYNTHETIC-SECRET'));
  }
  assert.equal(normalize({ battery_range: 2001 }).estimated_range_km, null);
  assert.equal(normalize({ charging_state: 'Charging', time_to_full_charge: 169 }).time_to_full_charge_hours, null);
});

test('empty objects, arrays, and noncharging states are conservative', () => {
  for (const data of [undefined, null, [], 'unsafe', { charge_state: [] }]) {
    const actual = normalizeCharge(alias, 'SYNTHETIC-SECRET', data);
    assert.equal(actual.state, null);
    assert.equal(actual.battery_percent, null);
  }
  for (const charging_state of ['Stopped', 'Complete', 'Disconnected', 'NoPower', 'Starting']) {
    const actual = normalize({ charging_state, time_to_full_charge: 2 });
    assert.equal(actual.charging_state, charging_state);
    assert.equal(actual.time_to_full_charge_hours, null);
  }
});

test('charging math, cost, zero delta and defaults', () => {
  const plan = planCharging({ current: 20, target: 80, capacityKwh: 75, powerKw: 10, efficiency: 0.9, pricePerKwh: 0.25 });
  assert.equal(plan.battery_energy_kwh, 45);
  assert.equal(plan.grid_energy_kwh, 50);
  assert.equal(plan.estimated_hours, 5);
  assert.equal(plan.estimated_cost, 12.5);
  assert.match(plan.assumptions, /constant net charging rate/);
  assert.match(plan.assumptions, /taper, cold, auxiliary loads, and degradation/);
  const zero = planCharging({ current: 80, target: 80, capacityKwh: 75, powerKw: 7 });
  assert.equal(zero.estimated_hours, 0);
  assert.equal(zero.estimated_cost, null);
  assert.equal(zero.efficiency, 0.9);
});

test('invalid plans and numerical overflow are rejected', () => {
  const valid = { current: 20, target: 80, capacityKwh: 75, powerKw: 7, efficiency: 0.9, pricePerKwh: 0 };
  for (const changes of [{ current: -1 }, { current: '20' }, { current: NaN }, { target: 101 }, { target: 10 },
    { capacityKwh: 0 }, { powerKw: 0 }, { efficiency: 0 }, { efficiency: 1.1 }, { pricePerKwh: -1 },
    { powerKw: Infinity }, { efficiency: Number.MIN_VALUE }, { powerKw: Number.MIN_VALUE }]) {
    assert.throws(() => planCharging({ ...valid, ...changes }), RangeError);
  }
});

test('comparison reports change, not inferred drain or efficiency, and enforces identity', () => {
  const before = { fingerprint: 'synthetic-hmac', captured_at: '2026-01-01T00:00:00Z', snapshot: normalize({ battery_level: 80, battery_range: 200, charger_power: 7 }) };
  const after = { fingerprint: 'synthetic-hmac', captured_at: '2026-01-01T02:00:00Z', snapshot: normalize({ battery_level: 75, battery_range: 190, charger_power: 0 }) };
  const comparison = compareSnapshots(before, after);
  assert.equal(comparison.elapsed_hours, 2);
  assert.equal(comparison.battery_percentage_point_delta, -5);
  assert.ok(Math.abs(comparison.estimated_range_change_km + 16.09344) < 1e-8);
  assert.equal(comparison.charger_power_change_kw, -7);
  assert.match(comparison.caveat, /Cannot infer drain or efficiency/);
  assert.ok(!JSON.stringify(comparison).includes('synthetic-hmac'));
  assert.throws(() => compareSnapshots(before, { ...after, fingerprint: 'other' }));
  assert.throws(() => compareSnapshots(after, before));
  assert.throws(() => compareSnapshots(before, { ...after, captured_at: 'invalid' }));
  assert.equal(compareSnapshots(before, { ...after, snapshot: normalize({}) }).battery_percentage_point_delta, null);
});

'use strict';

const MILES_TO_KM = 1.609344;
const CHARGING_STATES = new Set(['Charging', 'Complete', 'Disconnected', 'Stopped', 'NoPower', 'Starting']);
const CAVEAT = 'Cannot infer drain or efficiency without knowing driving, weather, and charging.';
const ASSUMPTIONS = 'Estimate assumes constant net charging rate and stated capacity; taper, cold, auxiliary loads, and degradation are not modeled.';

function number(value, min, max) {
  return typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max ? value : null;
}
function object(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}
function state(value) {
  return value === 'online' || value === 'asleep' ? value : null;
}
function normalizeCharge(alias, vehicleState, data) {
  const charge = object(object(data).charge_state);
  const miles = number(charge.battery_range, 0, 2000);
  const charging = CHARGING_STATES.has(charge.charging_state) ? charge.charging_state : null;
  return {
    alias,
    state: state(vehicleState),
    battery_percent: number(charge.battery_level, 0, 100),
    usable_battery_percent: number(charge.usable_battery_level, 0, 100),
    charge_limit_percent: number(charge.charge_limit_soc, 0, 100),
    charging_state: charging,
    charger_power_kw: number(charge.charger_power, 0, 1000),
    estimated_range_km: miles === null ? null : miles * MILES_TO_KM,
    time_to_full_charge_hours: charging === 'Charging' ? number(charge.time_to_full_charge, 0, 168) : null
  };
}
function planCharging({ current, target, capacityKwh, powerKw, efficiency = 0.9, pricePerKwh }) {
  if (number(current, 0, 100) === null || number(target, current, 100) === null ||
      number(capacityKwh, Number.MIN_VALUE, Number.MAX_VALUE) === null ||
      number(powerKw, Number.MIN_VALUE, Number.MAX_VALUE) === null ||
      number(efficiency, Number.MIN_VALUE, 1) === null ||
      (pricePerKwh !== undefined && number(pricePerKwh, 0, Number.MAX_VALUE) === null)) {
    throw new RangeError('Invalid charging plan parameters.');
  }
  const batteryEnergy = capacityKwh * ((target - current) / 100);
  const gridEnergy = batteryEnergy / efficiency;
  const hours = gridEnergy / powerKw;
  const cost = pricePerKwh === undefined ? null : gridEnergy * pricePerKwh;
  if (![batteryEnergy, gridEnergy, hours, ...(cost === null ? [] : [cost])].every(Number.isFinite)) {
    throw new RangeError('Charging plan exceeds supported numeric range.');
  }
  return {
    current_percent: current, target_percent: target, capacity_kwh: capacityKwh,
    power_kw: powerKw, efficiency, battery_energy_kwh: batteryEnergy,
    grid_energy_kwh: gridEnergy, estimated_hours: hours,
    estimated_cost: cost, assumptions: ASSUMPTIONS
  };
}
function compareSnapshots(previous, current) {
  if (!previous || !current || typeof previous.fingerprint !== 'string' ||
      previous.fingerprint !== current.fingerprint) throw new Error('Snapshot identity mismatch.');
  const elapsed = (Date.parse(current.captured_at) - Date.parse(previous.captured_at)) / 3600000;
  if (!Number.isFinite(elapsed) || elapsed < 0) throw new Error('Invalid snapshot interval.');
  const before = previous.snapshot;
  const after = current.snapshot;
  const delta = key => typeof before[key] === 'number' && typeof after[key] === 'number' ? after[key] - before[key] : null;
  return {
    alias: after.alias, elapsed_hours: elapsed,
    battery_percentage_point_delta: delta('battery_percent'),
    estimated_range_change_km: delta('estimated_range_km'),
    previous_charger_power_kw: before.charger_power_kw,
    charger_power_kw: after.charger_power_kw,
    charger_power_change_kw: delta('charger_power_kw'),
    charging_state: after.charging_state, caveat: CAVEAT
  };
}
module.exports = { normalizeCharge, planCharging, compareSnapshots, state, number, CAVEAT, ASSUMPTIONS };

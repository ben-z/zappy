'use strict';

(() => {
  const $ = (id) => document.getElementById(id);
  const missing = 'Not reported';
  const state = { csrf: null, mode: null, garage: null, entries: [], busy: false, comparisons: new Map() };
  const chargingLabels = { Charging: 'Charging', Complete: 'Complete', Disconnected: 'Disconnected', Stopped: 'Stopped', NoPower: 'No power', Starting: 'Starting' };
  const number = (value) => typeof value === 'number' && Number.isFinite(value) ? value : null;
  const bounded = (value, min, max) => { const n = number(value); return n !== null && n >= min && n <= max ? n : null; };
  const format = (value, digits = 1) => new Intl.NumberFormat(undefined, { maximumFractionDigits: digits }).format(value);
  const dateText = (value) => {
    if (typeof value !== 'string') return null;
    const date = new Date(value);
    return Number.isFinite(date.getTime()) ? date.toLocaleString(undefined, { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit', second: '2-digit', timeZoneName: 'short' }) : null;
  };
  const duration = (hours) => {
    if (hours === null || hours < 0) return missing;
    if (hours === 0) return '0 min';
    if (hours < 1 / 60) return 'Less than 1 min';
    const minutes = Math.round(hours * 60);
    const h = Math.floor(minutes / 60);
    const m = minutes % 60;
    return h ? `${format(h, 0)} hr${m ? ` ${m} min` : ''}` : `${m} min`;
  };
  const vehicleAt = (ordinal) => state.entries.find((entry) => entry.ordinal === ordinal)?.vehicle ?? null;
  const chargingLabel = (value) => Object.hasOwn(chargingLabels, value) ? chargingLabels[value] : null;
  const safeVehicle = (vehicle) => vehicle && typeof vehicle === 'object' && !Array.isArray(vehicle) ? vehicle : null;

  const navLinks = Array.from(document.querySelectorAll('.navigation .nav-link'));
  function updateNavigation() {
    const hash = window.location.hash || '#overview';
    const detailIds = { '#charging-lab': 'planner-tools', '#snapshots': 'snapshot-tools', '#privacy': 'privacy-tools' };
    if (detailIds[hash]) $(detailIds[hash]).setAttribute('open', '');
    navLinks.forEach((link) => {
      const active = link.getAttribute('href') === hash;
      link.classList.toggle('is-active', active);
      if (active) link.setAttribute('aria-current', 'location');
      else link.removeAttribute('aria-current');
    });
  }
  window.addEventListener('hashchange', updateNavigation);
  navLinks.forEach((link) => link.addEventListener('click', () => {
    const section = $(link.getAttribute('href').slice(1));
    const details = section?.querySelector('details');
    if (details) details.setAttribute('open', '');
  }));
  updateNavigation();

  function renderVehicleSelects() {
    ['planner-vehicle', 'snapshot-vehicle'].forEach((id) => {
      const select = $(id);
      const previous = Number(select.value);
      const options = document.createDocumentFragment();
      if (!state.entries.length) {
        const option = document.createElement('option');
        option.value = '';
        option.textContent = 'No vehicles available';
        options.append(option);
      } else {
        state.entries.forEach(({ ordinal }) => {
          const option = document.createElement('option');
          option.value = String(ordinal);
          option.textContent = `Vehicle ${ordinal}`;
          options.append(option);
        });
      }
      select.replaceChildren(options);
      if (state.entries.some(({ ordinal }) => ordinal === previous)) select.value = String(previous);
      select.disabled = !state.entries.length;
    });
    $('use-battery').disabled = !state.entries.length;
    if (!state.entries.length) $('prefill-status').textContent = 'No vehicles are available. The planner still works with your own assumptions.';
    else if ($('prefill-status').textContent.startsWith('No vehicles are available.')) $('prefill-status').textContent = 'Current battery stays an assumption until you explicitly use a reading.';
    renderComparison(Number($('snapshot-vehicle').value));
  }

  function notice(label, message, error = false) {
    const container = $('garage-status');
    container.hidden = false;
    container.classList.toggle('is-error', error);
    container.querySelector('.notice-label').textContent = label;
    container.querySelector('p').textContent = message;
  }

  function renderVehicles() {
    const fragment = document.createDocumentFragment();
    state.entries.forEach(({ ordinal, vehicle }) => {
      const clone = $('vehicle-template').content.cloneNode(true);
      const card = clone.querySelector('.vehicle-card');
      card.querySelector('.vehicle-name').textContent = `Vehicle ${ordinal}`;
      card.querySelector('.battery-progress').setAttribute('aria-label', `Vehicle ${ordinal} battery charge`);
      const unavailable = !vehicle || vehicle.error === 'unavailable';
      const battery = unavailable ? null : bounded(vehicle.battery_percent, 0, 100);
      const limit = unavailable ? null : bounded(vehicle.charge_limit_percent, 0, 100);
      const vehicleState = vehicle?.state === 'online' ? 'Online' : vehicle?.state === 'asleep' ? 'Asleep' : missing;
      const stateBadge = card.querySelector('.vehicle-state');
      stateBadge.textContent = vehicleState === missing ? 'State not reported' : `Last reported: ${vehicleState.toLowerCase()}`;
      stateBadge.classList.toggle('is-online', vehicleState === 'Online' && !unavailable);
      stateBadge.classList.toggle('is-asleep', vehicleState === 'Asleep');
      const batteryLabel = card.querySelector('.battery-number');
      batteryLabel.textContent = battery === null ? missing : format(battery);
      batteryLabel.classList.toggle('is-unavailable', battery === null);
      card.querySelector('.battery-unit').hidden = battery === null;
      const progress = card.querySelector('.battery-progress');
      progress.value = battery ?? 0;
      progress.setAttribute('aria-valuetext', battery === null ? missing : `${format(battery)} percent`);
      const marker = card.querySelector('.limit-marker line');
      marker.setAttribute('visibility', limit === null ? 'hidden' : 'visible');
      marker.setAttribute('x1', String(limit ?? 0));
      marker.setAttribute('x2', String(limit ?? 0));
      card.querySelector('.charge-limit').textContent = limit === null ? 'Charge limit not reported' : `Charge limit ${format(limit)}%`;
      const charging = unavailable ? null : chargingLabel(vehicle.charging_state);
      const chargingElement = card.querySelector('.charging-state');
      chargingElement.textContent = charging ?? missing;
      chargingElement.classList.toggle('is-charging', vehicle?.charging_state === 'Charging' && !unavailable);
      const range = unavailable ? null : bounded(vehicle.estimated_range_km, 0, 10000);
      const power = unavailable ? null : bounded(vehicle.charger_power_kw, 0, 10000);
      const time = unavailable ? null : bounded(vehicle.time_to_full_charge_hours, 0, 10000);
      const metrics = [['.vehicle-range', range === null ? missing : `${format(range)} km`], ['.vehicle-power', power === null ? missing : `${format(power)} kW`], ['.vehicle-time', charging === 'Disconnected' || charging === 'Stopped' || charging === 'Complete' || charging === 'No power' ? 'Not charging' : duration(time)]];
      metrics.forEach(([selector, text]) => { const element = card.querySelector(selector); element.textContent = text; element.classList.toggle('is-unavailable', text === missing); });
      const timestamp = dateText(vehicle?.fetched_at);
      card.querySelector('.vehicle-updated').textContent = unavailable && vehicle ? `Reading unavailable${timestamp ? ` · fetched ${timestamp}` : ''}` : timestamp ? `Fetched ${timestamp}` : 'No reading yet';
      fragment.append(clone);
    });
    $('vehicles').replaceChildren(fragment);
    $('vehicle-count').textContent = String(state.entries.length);
    const vehicles = state.entries.map((entry) => entry.vehicle);
    const count = vehicles.length;
    const available = vehicles.filter((vehicle) => vehicle.error !== 'unavailable');
    const knownStates = vehicles.filter((vehicle) => vehicle.state === 'online' || vehicle.state === 'asleep');
    const knownCharging = available.filter((vehicle) => chargingLabel(vehicle.charging_state));
    const online = knownStates.filter((vehicle) => vehicle.state === 'online').length;
    const charging = knownCharging.filter((vehicle) => vehicle.charging_state === 'Charging').length;
    $('online-count').textContent = count ? (knownStates.length ? `${online} of ${count}${knownStates.length < count ? ' confirmed' : ''}` : missing) : '0 of 0';
    $('charging-count').textContent = count ? (knownCharging.length ? `${charging} of ${count}${knownCharging.length < count ? ' confirmed' : ''}` : missing) : '0 of 0';
    const updated = dateText(state.garage?.updated_at);
    $('last-sync').textContent = updated ?? 'Not yet';
    if (updated) $('last-sync').setAttribute('datetime', state.garage.updated_at);
    else $('last-sync').removeAttribute('datetime');
  }

  function showGarage(garage) {
    if (!garage || typeof garage !== 'object' || !Array.isArray(garage.vehicles)) throw new Error('invalid');
    const ordinals = new Set();
    const entries = garage.vehicles.slice(0, 20).map((item) => {
      const vehicle = safeVehicle(item);
      const match = typeof vehicle?.alias === 'string' ? /^vehicle-([1-9][0-9]*)$/.exec(vehicle.alias) : null;
      const ordinal = match ? Number(match[1]) : null;
      if (!Number.isSafeInteger(ordinal) || ordinal > 20 || ordinals.has(ordinal)) throw new Error('invalid');
      ordinals.add(ordinal);
      return { ordinal, vehicle };
    });
    state.garage = garage;
    state.entries = entries;
    for (const ordinal of state.comparisons.keys()) {
      if (!ordinals.has(ordinal)) state.comparisons.delete(ordinal);
    }
    renderVehicles();
    renderVehicleSelects();
    if (garage.vehicles.length > 20) notice('GARAGE DISPLAY LIMIT', `Showing the first 20 of ${garage.vehicles.length} vehicles. Counts and controls apply to these 20 vehicles only.`);
    else if (!garage.vehicles.length) notice('READY WHEN YOU ARE', 'No cached vehicles. Click Refresh garage to request readings. Opening this page only loads the local cache.');
    else if (garage.warning || garage.vehicles.some((vehicle) => !vehicle || vehicle.error === 'unavailable')) notice('PARTIAL GARAGE', 'Some readings are unavailable. Sleeping or unreachable vehicles are never woken. You can try a manual refresh later.');
    else $('garage-status').hidden = true;
  }

  function setBusy(value, operation) {
    state.busy = value;
    $('refresh-button').disabled = value || !state.csrf;
    $('capture-button').disabled = value || !state.csrf || !vehicleAt(Number($('snapshot-vehicle').value));
    $('refresh-button').querySelector('span').textContent = value && operation === 'refresh' ? 'Refreshing garage…' : 'Refresh garage';
    $('capture-button').querySelector('span').textContent = value && operation === 'capture' ? 'Capturing…' : 'Capture snapshot';
    $('refresh-button').setAttribute('aria-busy', String(value && operation === 'refresh'));
    $('capture-button').setAttribute('aria-busy', String(value && operation === 'capture'));
  }

  function requestError(status) {
    if (status === 429) return 'The local server is cooling down. Please wait a little before trying again; nothing will retry automatically.';
    if (status === 401) return 'Login is required. Complete the local Tesla login setup, then reload this page. Credentials are never entered here.';
    if (status === 503) return 'The local connection is not ready. Check your local Tesla login setup and dashboard configuration, then try again.';
    if (status === 403) return 'This local session could not be verified. Reload the page to start a fresh private session.';
    if (status) return `The local server could not complete this request (HTTP ${status}). Try again manually later.`;
    return 'Cannot reach the local dashboard. Start it with npm run dashboard, then reload this page.';
  }

  async function request(endpoint, body) {
    let response;
    try {
      response = await fetch(endpoint, { method: body === undefined ? 'GET' : 'POST', credentials: 'omit', cache: 'no-store', redirect: 'error', headers: body === undefined ? { Accept: 'application/json' } : { Accept: 'application/json', 'Content-Type': 'application/json', 'X-Zappy-CSRF': state.csrf }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    } catch { throw new Error(requestError()); }
    if (!response.ok) throw new Error(requestError(response.status));
    try { return await response.json(); } catch { throw new Error('The local server returned an unreadable response. Reload the page or try again manually.'); }
  }

  $('refresh-button').addEventListener('click', async () => {
    if (state.busy || !state.csrf) return;
    setBusy(true, 'refresh');
    notice('MANUAL SYNC', 'Requesting garage readings. Sleeping vehicles will not be woken.');
    try { showGarage(await request('/api/refresh', {})); }
    catch (error) { notice('SYNC NOT COMPLETED', error.message === 'invalid' ? 'The local server returned an unexpected garage response. Existing readings have not been replaced.' : error.message, true); }
    finally { setBusy(false); }
  });

  const plannerIds = ['current-percent', 'target-percent', 'capacity', 'power', 'efficiency', 'price'];
  function readInput(id) { const input = $(id); return input.value.trim() === '' ? null : Number.isFinite(input.valueAsNumber) ? input.valueAsNumber : null; }
  function calculate() {
    plannerIds.forEach((id) => $(id).removeAttribute('aria-invalid'));
    const [current, target, capacity, power, efficiency, price] = plannerIds.map(readInput);
    const errors = [];
    const check = (condition, id, message) => { if (!condition) { errors.push(message); $(id).setAttribute('aria-invalid', 'true'); } };
    for (const [id, value, min, max, message] of [
      ['current-percent', current, 0, 100, 'Current charge must be between 0 and 100%.'],
      ['target-percent', target, 0, 100, 'Target charge must be between 0 and 100%.'],
      ['capacity', capacity, 0.1, 1000, 'Usable capacity must be 0.1 to 1,000 kWh.'],
      ['power', power, 0.01, 1000, 'Grid input power must be 0.01 to 1,000 kW.'],
      ['efficiency', efficiency, 1, 100, 'Efficiency must be 1 to 100%.']
    ]) {
      // An unfinished field is not an error. Validate only entered values.
      if ($(id).value.trim() !== '') check(value !== null && value >= min && value <= max, id, message);
    }
    if (current !== null && target !== null) check(target >= current, 'target-percent', 'Target charge must be at least current charge.');
    check($('price').value.trim() === '' || (price !== null && price >= 0 && price <= 1000), 'price', 'Price must be blank or between 0 and 1,000 per kWh.');
    $('planner-error').hidden = errors.length === 0;
    $('planner-error').textContent = errors.join(' ');
    if (errors.length || [current, target, capacity, power, efficiency].some(value => value === null)) {
      $('result-time').textContent = errors.length ? 'Check inputs' : 'Enter charging assumptions';
      $('result-battery').textContent = 'Not calculated';
      $('result-grid').textContent = 'Not calculated';
      $('result-cost').textContent = price === null ? 'Add a price for cost' : 'Not calculated';
      $('result-description').textContent = errors.length ? 'Correct the highlighted inputs.' : 'Complete the required inputs to calculate an estimate.';
      return;
    }
    const battery = capacity * (target - current) / 100;
    const grid = battery / (efficiency / 100);
    const hours = grid / power;
    $('result-time').textContent = duration(hours);
    $('result-battery').textContent = `${format(battery, 2)} kWh`;
    $('result-grid').textContent = `${format(grid, 2)} kWh`;
    $('result-cost').textContent = price === null ? 'Add a price for cost' : `${format(grid * price, 2)} price units`;
    $('result-description').textContent = current === target ? 'Already at the assumed target. No added charging energy.' : `${format(current)}% → ${format(target)}% · ${format(target - current)} percentage points, using your assumptions.`;
  }
  $('planner-form').addEventListener('submit', (event) => event.preventDefault());
  plannerIds.forEach((id) => $(id).addEventListener('input', () => {
    if (id === 'current-percent') $('prefill-status').textContent = 'Current charge was edited manually and is an assumption.';
    calculate();
  }));
  $('use-battery').addEventListener('click', () => {
    const index = Number($('planner-vehicle').value);
    const vehicle = safeVehicle(vehicleAt(index));
    if (!vehicle) return;
    const battery = vehicle?.error === 'unavailable' ? null : bounded(vehicle?.battery_percent, 0, 100);
    if (battery === null) { $('prefill-status').textContent = `Vehicle ${index} battery is not reported. Your assumptions have not changed.`; return; }
    $('current-percent').value = String(battery);
    const timestamp = dateText(vehicle.fetched_at);
    $('prefill-status').textContent = `${state.mode === 'demo' ? 'Synthetic demo battery' : 'Cached battery'} from Vehicle ${index}${timestamp ? `, fetched ${timestamp}` : ', fetched time not reported'}. Capacity, power and efficiency remain assumptions.`;
    calculate();
  });

  function signed(value, unit) { return value === null ? missing : `${value > 0 ? '+' : ''}${format(value, 2)} ${unit}`; }
  function renderComparison(index) {
    const entry = state.comparisons.get(index);
    const comparison = entry?.comparison;
    $('comparison').hidden = !comparison;
    $('snapshot-status').classList.remove('is-error');
    $('snapshot-status').textContent = entry ? `${state.mode === 'demo' ? 'Synthetic demo snapshot. ' : ''}Captured locally · ${entry.completedAt}. ${comparison ? 'Comparing the latest two captures for this vehicle.' : 'Capture again later to compare.'}` : state.entries.length ? 'No snapshots captured in this session. Capture again later to compare.' : 'No vehicles are available. Refresh the garage before capturing a snapshot.';
    if (!comparison) return;
    $('comparison-vehicle').textContent = `Vehicle ${index}`;
    $('compare-elapsed').textContent = duration(bounded(comparison.elapsed_hours, 0, Number.MAX_SAFE_INTEGER / 60));
    $('compare-battery').textContent = signed(bounded(comparison.battery_percentage_point_delta, -100, 100), 'pp');
    $('compare-range').textContent = signed(bounded(comparison.estimated_range_change_km, -10000, 10000), 'km');
    const previous = bounded(comparison.previous_charger_power_kw, 0, 10000);
    const current = bounded(comparison.charger_power_kw, 0, 10000);
    $('compare-power').textContent = `Reported charger power: ${previous === null ? missing : `${format(previous)} kW`} → ${current === null ? missing : `${format(current)} kW`}. Change: ${signed(bounded(comparison.charger_power_change_kw, -10000, 10000), 'kW')}.`;
    $('compare-state').textContent = `Latest charging state: ${chargingLabel(comparison.charging_state) ?? missing}.`;
    $('compare-caveat').textContent = 'Changes between snapshots are not a measurement of battery drain or battery health.';
  }
  $('snapshot-vehicle').addEventListener('change', () => renderComparison(Number($('snapshot-vehicle').value)));
  $('capture-button').addEventListener('click', async () => {
    if (state.busy || !state.csrf) return;
    const index = Number($('snapshot-vehicle').value);
    if (!vehicleAt(index)) return;
    setBusy(true, 'capture');
    $('snapshot-vehicle').disabled = true;
    $('snapshot-status').classList.remove('is-error');
    $('snapshot-status').textContent = `Capturing Vehicle ${index}. This is a manual vehicle read.`;
    try {
      const result = await request('/api/capture', { vehicle: index });
      if (!result || typeof result !== 'object' || !result.snapshot || typeof result.snapshot !== 'object' || Array.isArray(result.snapshot) || (result.comparison !== null && (typeof result.comparison !== 'object' || Array.isArray(result.comparison)))) throw new Error('The local server returned an unexpected capture response. No new comparison is shown.');
      state.comparisons.set(index, { comparison: result.comparison, completedAt: dateText(new Date().toISOString()) });
      renderComparison(index);
    } catch (error) {
      $('snapshot-status').classList.add('is-error');
      $('snapshot-status').textContent = `${error.message} Any comparison below is from your previous successful capture.`;
    } finally { $('snapshot-vehicle').disabled = !state.entries.length; setBusy(false); }
  });

  renderVehicles();
  renderVehicleSelects();
  calculate();
  setBusy(true, 'bootstrap');
  (async () => {
    try {
      const bootstrap = await request('/api/bootstrap');
      if (!bootstrap || !['live', 'demo'].includes(bootstrap.mode) || typeof bootstrap.csrf !== 'string' || !bootstrap.csrf) throw new Error('The local dashboard session could not be initialized. Reload the page to try again.');
      state.csrf = bootstrap.csrf;
      state.mode = bootstrap.mode;
      $('mode-banner').hidden = state.mode !== 'demo';
      showGarage(bootstrap.garage);
    } catch (error) {
      state.csrf = null;
      notice('LOCAL CONNECTION NEEDED', error.message === 'invalid' ? 'The local server returned an unexpected garage response. Reload the page to try again.' : error.message, true);
    } finally { setBusy(false); }
  })();
})();

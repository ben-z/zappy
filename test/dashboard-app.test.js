/* Offline app regressions. No browser, dependencies, live credentials or network.
 * Dynamic imports keep this test runnable in both CommonJS and ESM projects.
 * The small DOM supports only the static markup and APIs used by app.js. It is
 * intentionally not a layout engine; desktop/mobile rendering is tested separately.
 */
(async () => {
  const { test } = await import('node:test');
  const { default: assert } = await import('node:assert/strict');
  const { readFile } = await import('node:fs/promises');
  const { default: vm } = await import('node:vm');
  const { pathToFileURL } = await import('node:url');
  const testURL = pathToFileURL(process.argv[1]);
  const [source, markup] = await Promise.all([
    readFile(new URL('../web/app.js', testURL), 'utf8'),
    readFile(new URL('../web/index.html', testURL), 'utf8'),
  ]);
  const FIXED_ISO = '2026-10-15T18:23:45.000Z';
  const clockMilliseconds = Date.parse(FIXED_ISO);
  const locale = 'en-US';
  const localeOptions = { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit', second: '2-digit', timeZoneName: 'short' };
  class TestDate extends Date {
    constructor(...args) { super(...(args.length ? args : [clockMilliseconds])); }
    static now() { return clockMilliseconds; }
    toLocaleString(_locale, options) { return super.toLocaleString(locale, options); }
  }
  const testIntl = { NumberFormat: class extends Intl.NumberFormat { constructor(_locale, options) { super(locale, options); } } };

  class Node {
    constructor(tagName = '#fragment', attributes = {}) {
      this.tagName = tagName;
      this.attributes = { ...attributes };
      this.children = [];
      this.parentNode = null;
      this.listeners = new Map();
      this._text = '';
      this._value = undefined;
      if (tagName === 'template') this.content = new Node();
    }
    get id() { return this.attributes.id || ''; }
    set id(value) { this.attributes.id = String(value); }
    get hidden() { return Object.hasOwn(this.attributes, 'hidden'); }
    set hidden(value) { if (value) this.attributes.hidden = ''; else delete this.attributes.hidden; }
    get disabled() { return Object.hasOwn(this.attributes, 'disabled'); }
    set disabled(value) { if (value) this.attributes.disabled = ''; else delete this.attributes.disabled; }
    get classList() {
      const node = this;
      const read = () => new Set((node.attributes.class || '').split(/\s+/).filter(Boolean));
      const write = (set) => { node.attributes.class = [...set].join(' '); };
      return {
        contains(name) { return read().has(name); },
        add(name) { const set = read(); set.add(name); write(set); },
        remove(name) { const set = read(); set.delete(name); write(set); },
        toggle(name, force) { const set = read(); const on = force ?? !set.has(name); if (on) set.add(name); else set.delete(name); write(set); return on; },
      };
    }
    get textContent() { return this._text + this.children.map((child) => child.textContent).join(''); }
    set textContent(value) { this._text = String(value); this.replaceChildren(); }
    get innerHTML() { throw new Error('innerHTML is forbidden in dashboard rendering'); }
    set innerHTML(_value) { throw new Error('innerHTML is forbidden in dashboard rendering'); }
    get options() { return this.children.filter((child) => child.tagName === 'option'); }
    get value() {
      if (this.tagName === 'select') {
        if (this._value !== undefined && this.options.some((option) => option.value === this._value)) return this._value;
        return this.options[0]?.value ?? '';
      }
      return this._value ?? this.attributes.value ?? '';
    }
    set value(value) { this._value = String(value); }
    get valueAsNumber() { return this.value.trim() === '' ? NaN : Number(this.value); }
    setAttribute(name, value) { this.attributes[name] = String(value); }
    getAttribute(name) { return this.attributes[name] ?? null; }
    removeAttribute(name) { delete this.attributes[name]; }
    append(...nodes) {
      for (const node of nodes) {
        if (node.tagName === '#fragment') { this.append(...node.children.slice()); continue; }
        if (node.parentNode) node.parentNode.children.splice(node.parentNode.children.indexOf(node), 1);
        node.parentNode = this;
        this.children.push(node);
      }
    }
    replaceChildren(...nodes) {
      for (const node of this.children) node.parentNode = null;
      this.children = [];
      if (this.tagName === 'select') this._value = undefined;
      this.append(...nodes);
    }
    cloneNode(deep = false) {
      const clone = new Node(this.tagName, this.attributes);
      clone._text = this._text;
      clone._value = this._value;
      if (deep) clone.append(...this.children.map((child) => child.cloneNode(true)));
      return clone;
    }
    matches(selector) {
      if (selector.startsWith('.')) return this.classList.contains(selector.slice(1));
      if (selector.startsWith('#')) return this.id === selector.slice(1);
      return this.tagName === selector.toLowerCase();
    }
    querySelectorAll(selector) {
      const parts = selector.trim().split(/\s+/);
      const result = [];
      const walk = (node) => {
        for (const child of node.children) {
          if (child.matches(parts[parts.length - 1])) {
            let ancestor = child.parentNode;
            let index = parts.length - 2;
            while (index >= 0 && ancestor) { if (ancestor.matches(parts[index])) index -= 1; ancestor = ancestor.parentNode; }
            if (index < 0) result.push(child);
          }
          walk(child);
        }
      };
      walk(this);
      return result;
    }
    querySelector(selector) { return this.querySelectorAll(selector)[0] ?? null; }
    addEventListener(name, listener) {
      if (!this.listeners.has(name)) this.listeners.set(name, []);
      this.listeners.get(name).push(listener);
    }
    async dispatch(name) {
      for (const listener of this.listeners.get(name) ?? []) await listener({ type: name, target: this, preventDefault() {} });
    }
    async click() { if (!this.disabled) await this.dispatch('click'); }
  }

  function parseDocument(html) {
    const root = new Node('#document');
    const stack = [root];
    const voidTags = new Set(['meta', 'link', 'input', 'br', 'hr', 'img']);
    let nodeCount = 0;
    for (const token of html.match(/<[^>]*>|[^<]+/g) ?? []) {
      if (++nodeCount > 4000) throw new Error('Fixture DOM is unexpectedly large');
      if (token.startsWith('<!')) continue;
      if (token.startsWith('</')) { stack.pop(); continue; }
      if (token.startsWith('<')) {
        const tag = /^<([\w-]+)/.exec(token)?.[1]?.toLowerCase();
        assert.ok(tag, 'Only bounded static HTML markup is supported');
        const attributes = {};
        const attrText = token.slice(tag.length + 1, token.endsWith('/>') ? -2 : -1);
        for (const match of attrText.matchAll(/([\w:-]+)(?:="([^"]*)")?/g)) attributes[match[1]] = match[2] ?? '';
        const node = new Node(tag, attributes);
        stack[stack.length - 1].append(node);
        if (!voidTags.has(tag) && !token.endsWith('/>')) stack.push(tag === 'template' ? node.content : node);
      } else {
        const text = new Node('#text');
        text._text = token;
        stack[stack.length - 1].append(text);
      }
    }
    return {
      root,
      getElementById: (id) => root.querySelector(`#${id}`),
      querySelectorAll: (selector) => root.querySelectorAll(selector),
      createElement: (tag) => new Node(tag),
      createDocumentFragment: () => new Node(),
    };
  }
  function visibleText(node) {
    if (node.hidden || ['template', 'script', 'style', 'head'].includes(node.tagName)) return '';
    return node._text + node.children.map(visibleText).join('');
  }
  function vehicle(ordinal, overrides = {}) {
    return { alias: `vehicle-${ordinal}`, state: 'online', battery_percent: 60 + ordinal, usable_battery_percent: 60 + ordinal, charge_limit_percent: 80, charging_state: ordinal === 1 ? 'Charging' : 'Stopped', charger_power_kw: 11, estimated_range_km: 300, time_to_full_charge_hours: 1.5, fetched_at: '2026-10-14T10:00:00Z', error: null, ...overrides };
  }
  function garage(count = 0, overrides = {}) {
    return { updated_at: count ? '2026-10-14T10:00:00Z' : null, vehicles: Array.from({ length: count }, (_, index) => vehicle(index + 1)), request_count: count, warning: null, ...overrides };
  }
  const comparison = { alias: 'vehicle-1', elapsed_hours: 2, battery_percentage_point_delta: -1, estimated_range_change_km: -4, previous_charger_power_kw: 11, charger_power_kw: 0, charger_power_change_kw: -11, charging_state: 'Stopped', caveat: 'Two captures only.' };

  async function boot(initial = garage(), { mode = 'live', hash = '' } = {}) {
    const document = parseDocument(markup);
    const calls = [];
    const queued = [];
    const globalListeners = new Map();
    const storageAccess = [];
    const bodyReads = [];
    const window = {
      location: { hash },
      addEventListener(name, listener) { if (!globalListeners.has(name)) globalListeners.set(name, []); globalListeners.get(name).push(listener); },
    };
    const forbidden = (name) => () => { throw new Error(`${name} is forbidden by the offline harness`); };
    const sandbox = {
      document, window, Date: TestDate, Intl: testIntl,
      setTimeout: forbidden('timers'), setInterval: forbidden('polling'),
      WebSocket: forbidden('WebSocket'), XMLHttpRequest: forbidden('XMLHttpRequest'),
      console: new Proxy({}, { get: () => forbidden('console dumps') }),
      fetch: async (url, options) => {
        assert.ok(['/api/bootstrap', '/api/refresh', '/api/capture'].includes(url), 'Only local dashboard endpoints are permitted');
        calls.push({ url, options: structuredClone(options) });
        let item;
        if (calls.length === 1) { assert.equal(url, '/api/bootstrap'); item = { body: { mode, csrf: 'offline-stub-csrf', garage: initial } }; }
        else { item = queued.shift(); assert.ok(item, `Unexpected automatic/unprepared request: ${url}`); }
        if (item.reject) throw new Error(item.reject);
        const status = item.status ?? 200;
        return {
          ok: status >= 200 && status < 300, status,
          async json() { bodyReads.push(status); if (item.invalidJSON) throw new Error('SYNTHETIC_PRIVATE_SERVER_DETAIL'); return structuredClone(item.body); },
          async text() { bodyReads.push(status); throw new Error('Raw server body must never be read'); },
        };
      },
    };
    for (const name of ['localStorage', 'sessionStorage', 'indexedDB']) {
      const getter = () => { storageAccess.push(name); throw new Error(`${name} must not be accessed`); };
      Object.defineProperty(sandbox, name, { get: getter });
      Object.defineProperty(window, name, { get: getter });
    }
    Object.defineProperty(document, 'cookie', { get: forbidden('cookie reads'), set: forbidden('cookie writes') });
    vm.runInNewContext(source, sandbox, { filename: 'web/app.js', timeout: 1000 });
    await new Promise((resolve) => setImmediate(resolve));
    const get = (id) => { const element = document.getElementById(id); assert.ok(element, `Missing actual markup element: ${id}`); return element; };
    return {
      get, document, calls, storageAccess, bodyReads,
      cards: () => get('vehicles').querySelectorAll('.vehicle-card'),
      enqueue(body, status = 200) { queued.push({ body, status }); },
      reject(message = 'SYNTHETIC_PRIVATE_NETWORK_DETAIL') { queued.push({ reject: message }); },
      invalidJSON() { queued.push({ invalidJSON: true }); },
      async input(id, value) { get(id).value = String(value); await get(id).dispatch('input'); },
      async hash(next) { window.location.hash = next; for (const listener of globalListeners.get('hashchange') ?? []) await listener(); },
      visibleText: () => visibleText(document.root),
    };
  }

  for (const count of [0, 1, 3]) {
    test(`${count} cached vehicles: exact cards, anonymous labels, count, options and controls`, async () => {
      const app = await boot(garage(count));
      assert.equal(app.cards().length, count);
      assert.equal(app.get('vehicle-count').textContent, String(count));
      assert.deepEqual(app.cards().map((card) => card.querySelector('.vehicle-name').textContent), Array.from({ length: count }, (_, index) => `Vehicle ${index + 1}`));
      for (const id of ['planner-vehicle', 'snapshot-vehicle']) {
        const select = app.get(id);
        assert.equal(select.disabled, count === 0);
        assert.deepEqual(select.options.map((option) => option.value), count ? Array.from({ length: count }, (_, index) => String(index + 1)) : ['']);
        assert.deepEqual(select.options.map((option) => option.textContent), count ? Array.from({ length: count }, (_, index) => `Vehicle ${index + 1}`) : ['No vehicles available']);
      }
      assert.equal(app.get('use-battery').disabled, count === 0);
      assert.equal(app.get('capture-button').disabled, count === 0);
      assert.equal(app.get('online-count').textContent, `${count} of ${count}`);
      assert.equal(app.get('charging-count').textContent, `${count ? 1 : 0} of ${count}`);
      if (!count) { await app.get('capture-button').click(); await app.get('use-battery').click(); assert.equal(app.calls.length, 1); }
    });
  }

  test('refresh replaces cards without duplicates and preserves each selected ordinal', async () => {
    const app = await boot(garage(3));
    app.get('planner-vehicle').value = '3';
    app.get('snapshot-vehicle').value = '2';
    const firstCards = app.cards();
    const next = garage(3);
    next.vehicles.reverse();
    app.enqueue(next);
    await app.get('refresh-button').click();
    assert.equal(app.get('planner-vehicle').value, '3');
    assert.equal(app.get('snapshot-vehicle').value, '2');
    assert.equal(app.cards().length, 3);
    assert.ok(firstCards.every((card) => !app.cards().includes(card)));
    const gradientIDs = app.cards().map((card) => card.querySelector('linearGradient').id);
    assert.equal(new Set(gradientIDs).size, 3);
    assert.deepEqual(app.cards().map((card) => card.querySelector('.vehicle-name').textContent), ['Vehicle 3', 'Vehicle 2', 'Vehicle 1']);
    app.enqueue(garage(1));
    await app.get('refresh-button').click();
    assert.equal(app.cards().length, 1);
    assert.equal(app.get('planner-vehicle').value, '1');
    assert.equal(app.get('snapshot-vehicle').value, '1');
    app.enqueue(garage());
    await app.get('refresh-button').click();
    assert.equal(app.cards().length, 0);
    assert.equal(app.get('capture-button').disabled, true);
    assert.equal(app.get('use-battery').disabled, true);
  });

  test('supports all twenty vehicle cards and options, not only the first two', async () => {
    const app = await boot(garage(20));
    assert.equal(app.cards().length, 20);
    assert.equal(app.get('vehicle-count').textContent, '20');
    assert.equal(app.get('planner-vehicle').options.length, 20);
    assert.equal(app.get('snapshot-vehicle').options[19].textContent, 'Vehicle 20');
    assert.equal(app.get('online-count').textContent, '20 of 20');
    assert.equal(new Set(app.cards().map((card) => card.querySelector('linearGradient').id)).size, 20);
  });

  test('sidebar active class and aria-current track initial hash and subsequent hash changes', async () => {
    const app = await boot(garage(), { hash: '#charging-lab' });
    const links = app.document.querySelectorAll('.navigation .nav-link');
    function check(hash) {
      assert.equal(links.filter((link) => link.classList.contains('is-active')).length, 1);
      for (const link of links) {
        const active = link.getAttribute('href') === hash;
        assert.equal(link.classList.contains('is-active'), active);
        assert.equal(link.getAttribute('aria-current'), active ? 'location' : null);
      }
    }
    check('#charging-lab');
    for (const hash of ['#snapshots', '#privacy', '#overview']) { await app.hash(hash); check(hash); }
    assert.equal(app.calls.length, 1);
  });

  test('bootstrap is a single cache-only GET; planner, hash and prefill do not trigger reads', async () => {
    const app = await boot(garage(1));
    assert.equal(app.calls.length, 1);
    assert.equal(app.calls[0].url, '/api/bootstrap');
    assert.equal(app.calls[0].options.method, 'GET');
    assert.equal(app.calls[0].options.body, undefined);
    assert.equal(app.calls[0].options.credentials, 'omit');
    assert.equal(app.calls[0].options.cache, 'no-store');
    await app.input('price', '0.30');
    await app.hash('#charging-lab');
    await app.get('use-battery').click();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(app.calls.length, 1);
    app.enqueue(garage(1));
    await app.get('refresh-button').click();
    const manual = app.calls[1];
    assert.equal(manual.url, '/api/refresh');
    assert.equal(manual.options.method, 'POST');
    assert.equal(manual.options.headers['Content-Type'], 'application/json');
    assert.equal(manual.options.headers['X-Zappy-CSRF'], 'offline-stub-csrf');
    assert.equal(manual.options.body, '{}');
  });

  test('planner default assumptions yield 30 / 33.33 kWh, 4 hr 38 min and 8.33 price units', async () => {
    const app = await boot();
    for (const [id, value] of Object.entries({ 'current-percent': '40', 'target-percent': '80', capacity: '75', power: '7.2', efficiency: '90', price: '0.25' })) assert.equal(app.get(id).value, value);
    assert.equal(app.get('result-battery').textContent, '30 kWh');
    assert.equal(app.get('result-grid').textContent, '33.33 kWh');
    assert.equal(app.get('result-time').textContent, '4 hr 38 min');
    assert.equal(app.get('result-cost').textContent, '8.33 price units');
    assert.equal(app.get('planner-error').hidden, true);
    await app.input('target-percent', 20);
    assert.equal(app.get('planner-error').hidden, false);
    assert.equal(app.get('target-percent').getAttribute('aria-invalid'), 'true');
    assert.match(app.get('planner-error').textContent, /at least current charge/);
    for (const id of ['result-time', 'result-battery', 'result-grid', 'result-cost']) assert.equal(app.get(id).textContent, 'Not available');
    await app.input('target-percent', 40);
    assert.equal(app.get('result-time').textContent, '0 min');
    assert.equal(app.get('result-battery').textContent, '0 kWh');
    await app.input('price', '');
    assert.equal(app.get('result-cost').textContent, 'No price entered');
  });

  test('cached battery only prefills on explicit button; independent capacity and grid power never change', async () => {
    const data = garage(3);
    data.vehicles[2].battery_percent = 52;
    data.vehicles[2].charger_power_kw = 250;
    const app = await boot(data);
    app.get('planner-vehicle').value = '3';
    await app.get('planner-vehicle').dispatch('change');
    assert.equal(app.get('current-percent').value, '40');
    await app.get('use-battery').click();
    assert.equal(app.get('current-percent').value, '52');
    assert.equal(app.get('capacity').value, '75');
    assert.equal(app.get('power').value, '7.2');
    assert.equal(app.get('efficiency').value, '90');
    assert.match(app.get('prefill-status').textContent, /Cached battery from Vehicle 3/);
    assert.match(app.get('prefill-status').textContent, /remain assumptions/);
    assert.equal(app.calls.length, 1);
    data.vehicles[2].battery_percent = 55;
    app.enqueue(data);
    await app.get('refresh-button').click();
    assert.equal(app.get('current-percent').value, '52');
  });

  test('capture labels local completion date; compares only actual responses and retains comparison on error', async () => {
    const app = await boot(garage(3));
    app.get('snapshot-vehicle').value = '3';
    app.enqueue({ snapshot: { alias: 'vehicle-3', battery_percent: 61 }, comparison: null, note: 'First capture' });
    await app.get('capture-button').click();
    const first = app.calls[1];
    assert.equal(first.url, '/api/capture');
    assert.equal(first.options.method, 'POST');
    assert.equal(first.options.headers['X-Zappy-CSRF'], 'offline-stub-csrf');
    assert.equal(first.options.body, '{"vehicle":3}');
    const status = app.get('snapshot-status').textContent;
    assert.match(status, /^Captured locally · /);
    assert.ok(status.includes(new TestDate().toLocaleString(undefined, localeOptions)));
    assert.doesNotMatch(status, /Server reading timestamp/);
    assert.match(status, /Capture again later to compare/);
    assert.equal(app.get('comparison').hidden, true);
    app.enqueue({ snapshot: { alias: 'vehicle-3', battery_percent: 60 }, comparison: { ...comparison, alias: 'vehicle-3' }, note: 'Second capture' });
    await app.get('capture-button').click();
    assert.equal(app.get('comparison').hidden, false);
    assert.equal(app.get('comparison-vehicle').textContent, 'Vehicle 3');
    assert.equal(app.get('compare-elapsed').textContent, '2 hr');
    assert.equal(app.get('compare-battery').textContent, '-1 pp');
    assert.equal(app.get('compare-range').textContent, '-4 km');
    assert.match(app.get('compare-caveat').textContent, /not a measurement of battery drain or battery health/);
    app.enqueue({ message: 'SYNTHETIC_PRIVATE_ERROR_DETAIL' }, 429);
    await app.get('capture-button').click();
    assert.match(app.get('snapshot-status').textContent, /cooling down/);
    assert.match(app.get('snapshot-status').textContent, /previous successful capture/);
    assert.equal(app.get('comparison').hidden, false);
    assert.equal(app.get('compare-battery').textContent, '-1 pp');
    assert.equal(app.get('capture-button').disabled, false);
    assert.ok(!app.bodyReads.includes(429));
  });

  test('server reading timestamps, when present, are labeled separately from local capture time', async () => {
    const app = await boot(garage(1));
    app.enqueue({ snapshot: { fetched_at: '2026-01-02T03:04:05Z' }, comparison: null, note: '' });
    await app.get('capture-button').click();
    const status = app.get('snapshot-status').textContent;
    assert.match(status, /^Captured locally · /);
    assert.match(status, /Server reading timestamp · /);
    assert.ok(status.includes(new TestDate('2026-01-02T03:04:05Z').toLocaleString(undefined, localeOptions)));
    assert.ok(status.includes(new TestDate().toLocaleString(undefined, localeOptions)));
  });

  test('HTTP, connection and malformed JSON errors use static safe hints, never raw response details', async () => {
    const privateMarker = 'SYNTHETIC_PRIVATE_OWNER_VIN_ADDRESS';
    const app = await boot(garage(1, { warning: privateMarker }));
    assert.doesNotMatch(app.visibleText(), new RegExp(privateMarker));
    for (const [status, pattern] of [[401, /Login is required/], [503, /not ready/], [403, /could not be verified/], [429, /cooling down/], [500, /HTTP 500/]]) {
      app.enqueue({ error: privateMarker, html: '<script>unsafe()</script>' }, status);
      await app.get('refresh-button').click();
      assert.match(app.get('garage-status').querySelector('p').textContent, pattern);
      assert.doesNotMatch(app.visibleText(), new RegExp(privateMarker));
      assert.ok(!app.bodyReads.includes(status));
    }
    app.reject(privateMarker);
    await app.get('refresh-button').click();
    assert.match(app.get('garage-status').querySelector('p').textContent, /npm run dashboard/);
    assert.doesNotMatch(app.visibleText(), new RegExp(privateMarker));
    app.invalidJSON();
    await app.get('refresh-button').click();
    assert.match(app.get('garage-status').querySelector('p').textContent, /unreadable response/);
    assert.doesNotMatch(app.visibleText(), /SYNTHETIC_PRIVATE_SERVER_DETAIL/);
    assert.equal(app.cards().length, 1);
  });

  test('unknown/asleep values stay unavailable; extra backend identity fields never render', async () => {
    const app = await boot(garage(1, { vehicles: [vehicle(1, { state: 'asleep', battery_percent: null, charge_limit_percent: null, charging_state: null, charger_power_kw: null, estimated_range_km: null, time_to_full_charge_hours: null, vin: 'SYNTHETIC_PRIVATE_VIN', display_name: 'SYNTHETIC_PRIVATE_NAME', location: 'SYNTHETIC_PRIVATE_ADDRESS' })] }));
    const card = app.cards()[0];
    for (const selector of ['.battery-number', '.vehicle-range', '.vehicle-power', '.vehicle-time']) assert.equal(card.querySelector(selector).textContent, 'Not available');
    assert.equal(card.querySelector('.vehicle-state').textContent, 'Asleep');
    assert.doesNotMatch(app.visibleText(), /SYNTHETIC_PRIVATE_/);
    await app.get('use-battery').click();
    assert.equal(app.get('current-percent').value, '40');
  });

  test('demo stays explicitly synthetic and app never accesses browser storage or unsafe HTML APIs', async () => {
    const app = await boot(garage(2), { mode: 'demo' });
    assert.equal(app.get('mode-banner').hidden, false);
    assert.match(app.get('mode-banner').textContent, /SYNTHETIC DEMO/);
    await app.get('use-battery').click();
    app.enqueue({ snapshot: {}, comparison: null, note: '' });
    await app.get('capture-button').click();
    assert.match(app.get('snapshot-status').textContent, /Synthetic demo snapshot/);
    assert.deepEqual(app.storageAccess, []);
    assert.doesNotMatch(source, /\b(?:localStorage|sessionStorage|indexedDB)\b|\.innerHTML\b|\.outerHTML\b|insertAdjacentHTML/);
  });
})().catch((error) => { process.stderr.write(`${error.stack}\n`); process.exitCode = 1; });

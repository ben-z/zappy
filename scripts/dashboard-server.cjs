#!/usr/bin/env node
'use strict';
const http = require('node:http');
const fs = require('node:fs/promises');
const { constants } = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { normalizeCharge, sanitizeSnapshot, compareSnapshots, number, CAVEAT } = require('./insights.cjs');
const CSP = "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'";
const HEADERS = { 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer', 'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY', 'Content-Security-Policy': CSP };
const NOTE = 'Aliases are ordinal positions, not persistent identities. Comparisons require two snapshots of the same vehicle. Request counts are high-level reads, not authoritative billing.';
const AUTH_CODES = new Set(['AUTH_CONFIG', 'UNAUTHORIZED', 'TOKEN_REFRESH_FAILED', 'TOKEN_REFRESH_POISONED', 'TOKEN_REFRESH_LOCKED']);
const FILES = new Map([['/', ['index.html', 'text/html; charset=utf-8']], ['/app.js', ['app.js', 'text/javascript; charset=utf-8']], ['/styles.css', ['styles.css', 'text/css; charset=utf-8']]]);
const object = v => v !== null && typeof v === 'object' && !Array.isArray(v);
class HttpError extends Error { constructor(status, code) { super(code); this.status = status; this.code = code; } }
const failure = (status, code) => { throw new HttpError(status, code); };
function cleanComparison(value, ordinal) {
  if (!object(value)) return null;
  const clean = { alias: 'vehicle-' + ordinal };
  for (const key of ['elapsed_hours', 'battery_percentage_point_delta', 'estimated_range_change_km', 'previous_charger_power_kw', 'charger_power_kw', 'charger_power_change_kw']) {
    clean[key] = number(value[key], key === 'elapsed_hours' ? 0 : -Number.MAX_VALUE, Number.MAX_VALUE);
  }
  clean.charging_state = normalizeCharge('', null, { charge_state: { charging_state: value.charging_state } }).charging_state;
  clean.caveat = CAVEAT;
  return clean;
}
function createDashboardServer(options = {}) {
  const root = path.resolve(options.root || path.join(__dirname, '..'));
  const mode = options.mode ?? 'live';
  const requestedPort = options.port ?? 8766;
  const now = options.now || Date.now;
  const cooldownMs = options.cooldownMs ?? 10000;
  if (!['live', 'demo'].includes(mode) || !Number.isInteger(requestedPort) || requestedPort < 0 || requestedPort > 65535 || typeof cooldownMs !== 'number' || !Number.isFinite(cooldownMs) || cooldownMs < 0) throw new TypeError('Invalid dashboard options.');
  const csrf = crypto.randomBytes(32).toString('hex');
  let fleet = options.client;
  let requestCount = 0;
  let boundPort;
  let starting;
  let pending;
  let pendingKey;
  let lastFinished = -Infinity;
  const demoPrevious = new Map();
  const timestamp = () => new Date(now()).toISOString();
  let garage = { updated_at: null, vehicles: [], request_count: 0, warning: null };
  const copy = value => JSON.parse(JSON.stringify(value));
  function syntheticGarage() {
    const stamp = timestamp();
    return { updated_at: stamp, vehicles: [
      { ...normalizeCharge('vehicle-1', 'online', { charge_state: { battery_level: 72, usable_battery_level: 72, charge_limit_soc: 80, charging_state: 'Charging', charger_power: 7.2, time_to_full_charge: 1.2 } }), estimated_range_km: 312.4, fetched_at: stamp, error: null },
      { ...normalizeCharge('vehicle-2', 'online', { charge_state: { battery_level: 48, usable_battery_level: 48, charge_limit_soc: 80, charging_state: 'Disconnected', charger_power: 0 } }), estimated_range_km: 208.6, fetched_at: stamp, error: null }
    ], request_count: 0, warning: null };
  }
  if (mode === 'demo') garage = syntheticGarage();
  function countedClient() {
    // No client construction, credential read, or outbound request before a manual live action.
    if (!fleet) fleet = require('./fleet-client.cjs').createFleetClient({ root, now });
    return {
      async listVehicles() {
        requestCount++; garage.request_count = requestCount;
        return fleet.listVehicles();
      },
      async getVehicleData(vehicle) {
        if (vehicle?.state !== 'online') failure(409, 'UNAVAILABLE');
        requestCount++; garage.request_count = requestCount;
        return fleet.getVehicleData(vehicle);
      }
    };
  }
  function safeError(error) {
    if (error instanceof HttpError) return error;
    if (AUTH_CODES.has(error?.code)) return new HttpError(401, 'AUTH_REQUIRED');
    return new HttpError(502, 'UNAVAILABLE');
  }
  async function refresh() {
    if (mode === 'demo') { garage = syntheticGarage(); return copy(garage); }
    const client = countedClient();
    const vehicles = await client.listVehicles();
    if (!Array.isArray(vehicles)) failure(502, 'UNAVAILABLE');
    const normalized = [];
    for (const [index, raw] of vehicles.slice(0, 20).entries()) {
      const vehicle = object(raw) ? raw : {};
      let data = null;
      let error = null;
      let fetchedAt = null;
      if (vehicle.state === 'online') {
        try { data = await client.getVehicleData(vehicle); fetchedAt = timestamp(); }
        catch (cause) { if (AUTH_CODES.has(cause?.code)) throw cause; error = 'unavailable'; }
      }
      normalized.push({ ...normalizeCharge('vehicle-' + (index + 1), vehicle.state, data), fetched_at: fetchedAt, error });
    }
    garage = { updated_at: timestamp(), vehicles: normalized, request_count: requestCount, warning: vehicles.length > 20 ? 'Only the first 20 vehicles are shown.' : null };
    return copy(garage);
  }
  async function capture(ordinal) {
    if (mode === 'demo') {
      const vehicle = garage.vehicles[ordinal - 1];
      if (!vehicle) failure(404, 'VEHICLE_NOT_FOUND');
      const snapshot = sanitizeSnapshot('vehicle-' + ordinal, vehicle);
      const record = { fingerprint: 'synthetic-' + ordinal, captured_at: timestamp(), snapshot };
      const previous = demoPrevious.get(ordinal);
      demoPrevious.set(ordinal, record);
      return { snapshot, comparison: previous ? cleanComparison(compareSnapshots(previous, record), ordinal) : null, note: NOTE };
    }
    const captureSnapshot = options.captureSnapshot || require('./zappy.cjs').captureSnapshot;
    const loadComparison = options.loadComparison || require('./zappy.cjs').loadComparison;
    const snapshot = await captureSnapshot({ root, client: countedClient(), ordinal, now });
    if (!object(snapshot)) failure(502, 'UNAVAILABLE');
    let comparison = null;
    // A first snapshot, invalid private history, or changed identity is not comparable.
    try { comparison = await loadComparison({ root, ordinal }); } catch {}
    return { snapshot: sanitizeSnapshot('vehicle-' + ordinal, snapshot), comparison: cleanComparison(comparison, ordinal), note: NOTE };
  }

  function manual(key, action) {
    if (pending) { if (pendingKey === key) return pending; failure(409, 'BUSY'); }
    if (Number(now()) - lastFinished < cooldownMs) failure(429, 'COOLDOWN');
    pendingKey = key;
    pending = Promise.resolve().then(action).finally(() => { lastFinished = Number(now()); pending = null; pendingKey = null; });
    return pending;
  }
  function send(res, status, value, type = 'application/json; charset=utf-8') {
    res.writeHead(status, { ...HEADERS, 'Content-Type': type });
    res.end(Buffer.isBuffer(value) ? value : JSON.stringify(value));
  }
  function oneHeader(req, name) {
    let count = 0;
    for (let i = 0; i < req.rawHeaders.length; i += 2) if (req.rawHeaders[i].toLowerCase() === name) count++;
    return count === 1 ? req.headers[name] : undefined;
  }
  async function jsonBody(req) {
    if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(oneHeader(req, 'content-type') || '') || req.headers['content-encoding']) failure(415, 'CONTENT_TYPE');
    if (req.headers['content-length'] && Number(req.headers['content-length']) > 4096) failure(413, 'BODY_TOO_LARGE');
    const chunks = [];
    await new Promise((resolve, reject) => {
      let length = 0;
      let rejected = false;
      req.on('data', chunk => {
        length += chunk.length;
        if (length > 4096) {
          if (!rejected) { rejected = true; chunks.length = 0; reject(new HttpError(413, 'BODY_TOO_LARGE')); }
        } else if (!rejected) chunks.push(chunk);
      });
      req.once('end', resolve);
      req.once('error', () => reject(new HttpError(400, 'INVALID_BODY')));
      req.once('aborted', () => reject(new HttpError(400, 'INVALID_BODY')));
    });
    let result;
    try { result = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { failure(400, 'INVALID_BODY'); }
    if (!object(result)) failure(400, 'INVALID_BODY');
    return result;
  }
  async function staticFile(route) {
    const [name, type] = FILES.get(route);
    const web = path.join(root, 'web');
    if ((await fs.lstat(web)).isSymbolicLink() || await fs.realpath(web) !== web) failure(404, 'NOT_FOUND');
    const handle = await fs.open(path.join(web, name), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.nlink !== 1 || stat.size > 2 * 1024 * 1024) failure(404, 'NOT_FOUND');
      return [await handle.readFile(), type];
    } finally { await handle.close(); }
  }
  const server = http.createServer(async (req, res) => {
    try {
      const host = oneHeader(req, 'host');
      if (!boundPort || !['127.0.0.1:' + boundPort, 'localhost:' + boundPort].includes(host)) failure(403, 'INVALID_HOST');
      if (req.headers['sec-fetch-site'] === 'cross-site') failure(403, 'CROSS_SITE');
      const route = req.url;
      if (FILES.has(route)) {
        if (req.method !== 'GET') failure(405, 'METHOD_NOT_ALLOWED');
        let file;
        try { file = await staticFile(route); } catch { failure(404, 'NOT_FOUND'); }
        send(res, 200, file[0], file[1]); return;
      }
      if (route === '/api/health' || route === '/api/bootstrap' || route === '/api/garage') {
        if (req.method !== 'GET') failure(405, 'METHOD_NOT_ALLOWED');
        const value = route === '/api/health' ? { service: 'zappy-dashboard', mode }
          : route === '/api/bootstrap' ? { mode, csrf, garage: copy(garage) } : copy(garage);
        send(res, 200, value); return;
      }
      if (route !== '/api/refresh' && route !== '/api/capture') failure(404, 'NOT_FOUND');
      if (req.method !== 'POST') failure(405, 'METHOD_NOT_ALLOWED');
      if (oneHeader(req, 'origin') !== 'http://' + host) failure(403, 'INVALID_ORIGIN');
      const token = oneHeader(req, 'x-zappy-csrf');
      if (typeof token !== 'string' || Buffer.byteLength(token) !== Buffer.byteLength(csrf) || !crypto.timingSafeEqual(Buffer.from(token), Buffer.from(csrf))) failure(403, 'INVALID_CSRF');
      const body = await jsonBody(req);
      if (route === '/api/refresh') {
        if (Object.keys(body).length !== 0) failure(400, 'INVALID_BODY');
        send(res, 200, await manual('refresh', refresh));
      } else {
        if (Object.keys(body).length !== 1 || !Number.isInteger(body.vehicle) || body.vehicle < 1 || body.vehicle > 20) failure(400, 'INVALID_BODY');
        send(res, 200, await manual('capture:' + body.vehicle, () => capture(body.vehicle)));
      }
    } catch (cause) {
      const error = safeError(cause);
      if (res.destroyed || res.headersSent) return;
      const body = { error: error.code };
      if (error.code === 'AUTH_REQUIRED') body.guidance = 'Run npm run login. For locked or uncertain authorization, follow SECURITY.md recovery steps first.';
      send(res, error.status, body);
    }
  });
  server.requestTimeout = 15000;
  server.headersTimeout = 10000;
  server.on('clientError', (_error, socket) => {
    if (!socket.writable) return;
    const headers = Object.entries(HEADERS).map(([key, value]) => key + ': ' + value).join('\r\n');
    const body = '{"error":"BAD_REQUEST"}';
    socket.end('HTTP/1.1 400 Bad Request\r\n' + headers + '\r\nContent-Type: application/json\r\nConnection: close\r\nContent-Length: ' + Buffer.byteLength(body) + '\r\n\r\n' + body);
  });
  return {
    start() {
      if (starting) return starting;
      starting = new Promise((resolve, reject) => {
        const onError = error => { starting = null; reject(error); };
        server.once('error', onError);
        server.listen(requestedPort, '127.0.0.1', () => {
          server.removeListener('error', onError); boundPort = server.address().port;
          resolve({ url: 'http://127.0.0.1:' + boundPort, port: boundPort });
        });
      });
      return starting;
    },
    async close() {
      if (!starting) return;
      await starting.catch(() => {});
      await new Promise((resolve, reject) => {
        server.close(error => error && error.code !== 'ERR_SERVER_NOT_RUNNING' ? reject(error) : resolve());
        server.closeIdleConnections();
      });
      boundPort = undefined; starting = null;
    }
  };
}
async function runDashboardCli(args = process.argv.slice(2), options = {}) {
  const stdout = options.stdout || process.stdout;
  const stderr = options.stderr || process.stderr;
  const usage = 'Usage: npm run dashboard -- [--demo] [--port N]\n';
  if (args.length === 1 && args[0] === '--help') { stdout.write(usage); return { code: 0 }; }
  let mode = 'live'; let port = 8766; let valid = true; let seenPort = false; let seenDemo = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--demo' && !seenDemo) { mode = 'demo'; seenDemo = true; }
    else if (args[i] === '--port' && !seenPort && /^\d+$/.test(args[i + 1] || '')) { port = Number(args[++i]); seenPort = true; }
    else valid = false;
  }
  if (!valid || !Number.isInteger(port) || port < 1 || port > 65535) {
    stderr.write(usage); return { code: 1 };
  }
  const url = 'http://localhost:' + port + '/';
  const alternativePort = port === 8768 ? 8769 : 8768;
  const alternative = 'npm run dashboard --' + (mode === 'demo' ? ' --demo' : '') + ' --port ' + alternativePort;
  const dashboard = (options.createServer || createDashboardServer)({ mode, port });
  try {
    await dashboard.start();
    stdout.write('Zappy dashboard: ' + url + '\nPress Ctrl-C to stop.\n');
    return { code: 0, dashboard };
  } catch (error) {
    if (error?.code === 'EADDRINUSE') {
      let existing;
      try {
        const response = await (options.fetch || globalThis.fetch)('http://127.0.0.1:' + port + '/api/health', {
          redirect: 'error', signal: AbortSignal.timeout(1000)
        });
        if (response.ok) existing = await response.json();
      } catch { /* An occupied port is not assumed to belong to Zappy. */ }
      if (existing?.service === 'zappy-dashboard' && existing.mode === mode) {
        stdout.write('Zappy is already running at ' + url + '\nNo second server was started. Stop the existing instance to load updated code.\n');
        return { code: 0 };
      }
      if (existing?.service === 'zappy-dashboard' && ['live', 'demo'].includes(existing.mode)) {
        stderr.write('Port ' + port + ' is running a Zappy ' + existing.mode + ' dashboard, not ' + mode + '.\n');
      } else stderr.write('Port ' + port + ' is already in use by another or unrecognized service.\n');
      stderr.write('Nothing was stopped. Choose a different port:\n  ' + alternative + '\n');
    } else if (error?.code === 'EACCES' || error?.code === 'EPERM') {
      stderr.write('Permission denied listening on 127.0.0.1:' + port + '. Try an unprivileged port:\n  ' + alternative + '\n');
    } else {
      stderr.write('Could not start Zappy on 127.0.0.1:' + port + '. Check local networking or try:\n  ' + alternative + '\n');
    }
    return { code: 1 };
  }
}
module.exports = { createDashboardServer, runDashboardCli };
if (require.main === module) runDashboardCli().then(({ code, dashboard }) => {
  process.exitCode = code;
  if (dashboard) for (const signal of ['SIGINT', 'SIGTERM']) {
    process.once(signal, () => dashboard.close().catch(() => {}).finally(() => { process.exitCode = 0; }));
  }
}).catch(() => { process.stderr.write('Dashboard startup failed. Run npm run dashboard -- --help for usage.\n'); process.exitCode = 1; });

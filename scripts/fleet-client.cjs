'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');

const API = 'https://fleet-api.prd.na.vn.cloud.tesla.com';
const AUTH = 'https://fleet-auth.prd.vn.cloud.tesla.com/oauth2/v3/token';
// Existing OAuth helpers use the same atomic storage contract. Standalone tests
// and installations without the helper retain the equivalent local fallback.
let oauth;
try {
  const helper = require('./oauth-lib.cjs');
  if (typeof helper.buildTokenRecord === 'function' && typeof helper.writeTokensAtomic === 'function') oauth = helper;
} catch (error) {
  // An incompatible optional helper is not used; the safe fallback remains available.
  oauth = undefined;
}
const inFlight = new Map();
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

class FleetError extends Error {
  constructor(code, message, status) {
    super(message);
    this.name = 'FleetError';
    this.code = code;
    if (Number.isInteger(status) && status >= 100 && status <= 599) this.status = status;
  }
}
const fail = (code, message, status) => new FleetError(code, message, status);
const secretString = value => typeof value === 'string' && value.length > 0 && !/[\r\n]/.test(value);
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);

function createFleetClient(options = {}) {
  const root = path.resolve(options.root || path.join(__dirname, '..'));
  const fetcher = options.fetch || globalThis.fetch;
  const now = options.now || Date.now;
  const timeoutMs = positive(options.timeoutMs, 15000);
  const lockWaitMs = positive(options.lockWaitMs, 10000);
  const lockPollMs = positive(options.lockPollMs, 50);
  const local = path.join(root, '.local');
  const tokenFile = path.join(local, 'oauth-tokens.json');
  const credentialFile = path.join(local, 'tesla-credentials.json');
  const lockDir = path.join(local, '.fleet-refresh.lock');

  async function readJSON(file) {
    try {
      const value = JSON.parse(await fs.readFile(file, 'utf8'));
      if (!record(value)) throw new Error();
      return value;
    } catch {
      throw fail('AUTH_CONFIG', 'Local Tesla authorization files are missing or invalid. Reauthorize before retrying.');
    }
  }

  function expiration(tokens) {
    const raw = tokens.expires_at ?? tokens.expiresAt;
    if (typeof raw === 'number' && Number.isFinite(raw)) return raw < 1e12 ? raw * 1000 : raw;
    if (typeof raw === 'string') {
      const parsed = /^\d+(?:\.\d+)?$/.test(raw) ? Number(raw) : Date.parse(raw);
      return /^\d+(?:\.\d+)?$/.test(raw) && parsed < 1e12 ? parsed * 1000 : parsed;
    }
    return NaN;
  }

  function fresh(tokens) {
    return secretString(tokens.access_token) && expiration(tokens) > now() + 60000;
  }

  async function request(url, init) {
    const controller = new AbortController();
    let timer;
    let trustedError;
    try {
      return await Promise.race([
        (async () => {
          const response = await fetcher(url, { ...init, redirect: 'error', signal: controller.signal });
          const status = response.status;
          if (!Number.isInteger(status) || status < 100 || status > 599) throw new Error();
          // Never propagate provider bodies, including non-JSON error pages.
          if (status < 200 || status >= 300) return { status, body: null };
          let body;
          try { body = await response.json(); } catch {
            trustedError = fail('INVALID_RESPONSE', 'Tesla returned an invalid response.', status);
            throw trustedError;
          }
          return { status, body };
        })(),
        new Promise((_, reject) => {
          timer = setTimeout(() => {
            controller.abort();
            trustedError = fail('REQUEST_TIMEOUT', 'Tesla request timed out. Please retry.');
            reject(trustedError);
          }, timeoutMs);
        })
      ]);
    } catch (error) {
      if (trustedError && error === trustedError) throw trustedError;
      throw fail('NETWORK_ERROR', 'Tesla request failed. Please retry.');
    } finally { clearTimeout(timer); }
  }

  async function writeAtomic(value) {
    let temporary;
    let handle;
    try {
      if (oauth) {
        await oauth.writeTokensAtomic(tokenFile, value);
        return;
      }
      temporary = path.join(local, `.oauth-tokens.${crypto.randomBytes(16).toString('hex')}.tmp`);
      handle = await fs.open(temporary, 'wx', 0o600);
      await handle.writeFile(JSON.stringify(value, null, 2) + '\n', 'utf8');
      await handle.sync();
      await handle.close();
      handle = null;
      await fs.rename(temporary, tokenFile);
      temporary = null;
    } catch {
      throw fail('TOKEN_SAVE_FAILED', 'Unable to save refreshed authorization. Reauthorize before retrying.');
    } finally {
      if (handle) await handle.close().catch(() => {});
      if (temporary) await fs.unlink(temporary).catch(() => {});
    }
  }

  async function withLock(work) {
    let owned = false;
    const deadline = Date.now() + lockWaitMs;
    try {
      await fs.mkdir(local, { recursive: true, mode: 0o700 });
      while (!owned) {
        try {
          await fs.mkdir(lockDir, { mode: 0o700 });
          owned = true;
          await fs.chmod(lockDir, 0o700);
        } catch (error) {
          if (owned || error.code !== 'EEXIST') throw fail('TOKEN_LOCK_FAILED', 'Unable to secure authorization refresh. Please check local file permissions.');
          if (Date.now() >= deadline) throw fail('TOKEN_REFRESH_LOCKED', 'Authorization refresh is locked. Verify no other client is refreshing before removing the stale refresh lock.');
          await wait(Math.min(lockPollMs, Math.max(1, deadline - Date.now())));
        }
      }
      return await work();
    } catch (error) {
      if (error instanceof FleetError) throw error;
      throw fail('TOKEN_LOCK_FAILED', 'Unable to secure authorization refresh. Please check local file permissions.');
    } finally {
      if (owned) await fs.rmdir(lockDir).catch(() => {});
    }
  }

  async function refresh(rejectedAccess) {
    // Share refresh work across all clients in this process, not only one instance.
    const existing = inFlight.get(tokenFile);
    if (existing) {
      await existing;
      const latest = await readJSON(tokenFile);
      if (rejectedAccess === undefined ? fresh(latest) : secretString(latest.access_token) && latest.access_token !== rejectedAccess) return latest;
    }
    const pending = withLock(async () => {
      const current = await readJSON(tokenFile);
      // Another process may already have replaced the rejected/expiring token.
      if (rejectedAccess === undefined ? fresh(current) : secretString(current.access_token) && current.access_token !== rejectedAccess) return current;
      const credentials = await readJSON(credentialFile);
      if (!secretString(credentials.client_id) || !secretString(current.refresh_token)) {
        throw fail('AUTH_CONFIG', 'Tesla authorization is incomplete. Reauthorize before retrying.');
      }
      // Public-client refresh: intentionally do not send client_secret.
      const form = new URLSearchParams({ grant_type: 'refresh_token', client_id: credentials.client_id, refresh_token: current.refresh_token, audience: API });
      const { status, body } = await request(AUTH, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: form.toString() });
      if (status < 200 || status >= 300 || !record(body) || body.error || body.errors) {
        throw fail('TOKEN_REFRESH_FAILED', 'Tesla authorization refresh failed. Reauthorize before retrying.', status);
      }
      if (!secretString(body.access_token) || !secretString(body.refresh_token) || typeof body.expires_in !== 'number' || !Number.isFinite(body.expires_in) || body.expires_in <= 60) {
        throw fail('INVALID_TOKEN_RESPONSE', 'Tesla returned incomplete authorization. Reauthorize before retrying.', status);
      }
      let updated;
      try {
        const timestamp = now();
        const built = oauth ? oauth.buildTokenRecord(body, timestamp) : {
          access_token: body.access_token,
          refresh_token: body.refresh_token,
          token_type: 'Bearer',
          expires_in: body.expires_in,
          issued_at: new Date(timestamp).toISOString(),
          expires_at: new Date(timestamp + body.expires_in * 1000).toISOString()
        };
        updated = { ...current, ...built };
        // The provider's replacement is mandatory, even if a helper omits it.
        updated.access_token = body.access_token;
        updated.refresh_token = body.refresh_token;
        if (!fresh(updated)) throw new Error();
        if (typeof body.scope === 'string') updated.scope = body.scope;
      } catch {
        throw fail('INVALID_TOKEN_RESPONSE', 'Tesla returned incomplete authorization. Reauthorize before retrying.', status);
      }
      await writeAtomic(updated);
      return updated;
    });
    inFlight.set(tokenFile, pending);
    try { return await pending; }
    finally { if (inFlight.get(tokenFile) === pending) inFlight.delete(tokenFile); }
  }

  async function api(relativePath, expected) {
    let tokens = await readJSON(tokenFile);
    if (!fresh(tokens)) tokens = await refresh();
    for (let attempt = 0; attempt < 2; attempt++) {
      const result = await request(API + relativePath, { method: 'GET', headers: { Authorization: `Bearer ${tokens.access_token}`, Accept: 'application/json' } });
      if (result.status === 401 && attempt === 0) {
        tokens = await refresh(tokens.access_token);
        continue;
      }
      if (result.status < 200 || result.status >= 300) throw fail(result.status === 401 ? 'UNAUTHORIZED' : 'API_ERROR', 'Tesla vehicle request failed.', result.status);
      const body = result.body;
      if (!record(body) || body.error || body.errors || !expected(body.response) || (record(body.response) && (body.response.error || body.response.errors))) {
        throw fail('API_RESPONSE_ERROR', 'Tesla did not return valid vehicle data.', result.status);
      }
      return body.response;
    }
  }

  return {
    listVehicles() { return api('/api/1/vehicles', Array.isArray); },
    async getVehicleData(vehicle) {
      if (!record(vehicle)) throw fail('INVALID_VEHICLE', 'A valid vehicle is required.');
      if (vehicle.state !== 'online') throw fail('VEHICLE_ASLEEP', 'Vehicle is offline or asleep. No wake request was sent.');
      const identifier = vehicle.id_s || vehicle.vin;
      if (typeof identifier !== 'string' || !/^(?:[0-9]{1,30}|[A-HJ-NPR-Z0-9]{17})$/.test(identifier)) {
        throw fail('INVALID_VEHICLE', 'A valid vehicle identifier is required.');
      }
      return api(`/api/1/vehicles/${encodeURIComponent(identifier)}/vehicle_data?endpoints=charge_state`, record);
    }
  };
}

function positive(value, fallback) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback;
}

module.exports = { createFleetClient, FleetError };

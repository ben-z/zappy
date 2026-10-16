'use strict';
// Localhost OAuth (authorization code + PKCE) helper for Tesla Fleet API.
// Node standard library only. Nothing here runs on require().
// This module performs NO vehicle API requests, wakes, or commands. The only
// outbound request is the token exchange.
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');

const AUTHORIZE_URL = 'https://auth.tesla.com/oauth2/v3/authorize';
const TOKEN_URL = 'https://fleet-auth.prd.vn.cloud.tesla.com/oauth2/v3/token';
const AUDIENCE = 'https://fleet-api.prd.na.vn.cloud.tesla.com';
const SCOPE = 'openid offline_access vehicle_device_data';
const CALLBACK_PATH = '/oauth-signin-redirect';
const DEFAULT_PORT = 8765;
const BIND_HOST = '127.0.0.1';
const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;
const ROOT = path.resolve(__dirname, '..');
const DEFAULT_CREDENTIALS_PATH = path.join(ROOT, '.local', 'tesla-credentials.json');
const DEFAULT_TOKEN_PATH = path.join(ROOT, '.local', 'oauth-tokens.json');

const b64url = (buf) => buf.toString('base64url');

function generateSecrets() {
  const verifier = b64url(crypto.randomBytes(64)); // 86 chars
  return {
    state: b64url(crypto.randomBytes(32)),
    nonce: b64url(crypto.randomBytes(32)),
    verifier,
    challenge: b64url(crypto.createHash('sha256').update(verifier, 'ascii').digest()),
  };
}

function loadCredentials(file = DEFAULT_CREDENTIALS_PATH) {
  const c = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!c || typeof c.client_id !== 'string' || !c.client_id || typeof c.client_secret !== 'string' || !c.client_secret) {
    throw new Error('credentials file must contain client_id and client_secret');
  }
  return { client_id: c.client_id, client_secret: c.client_secret };
}

function safeEqual(a, b) {
  const x = Buffer.from(String(a), 'utf8');
  const y = Buffer.from(String(b), 'utf8');
  if (x.length !== y.length) return false;
  return crypto.timingSafeEqual(x, y);
}

function isLoopbackHost(header) {
  if (typeof header !== 'string') return false;
  const m = /^(localhost|127\.0\.0\.1|\[::1\])(?::(\d{1,5}))?$/i.exec(header);
  return !!m;
}

function page(title, message) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="referrer" content="no-referrer"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title></head><body><h1>${title}</h1><p>${message}</p></body></html>\n`;
}
const PAGES = {
  ok: page('Sign-in complete', 'Tokens were saved locally. You can close this tab.'),
  fail: page('Sign-in failed', 'The sign-in could not be completed. Return to the terminal and try again.'),
  bad: page('Invalid request', 'This request was not accepted.'),
  notfound: page('Not found', 'Nothing here.'),
};

const SECURITY_HEADERS = {
  'Content-Type': 'text/html; charset=utf-8',
  'Cache-Control': 'no-store',
  Pragma: 'no-cache',
  'Referrer-Policy': 'no-referrer',
  'Content-Security-Policy': "default-src 'none'",
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  Connection: 'close',
};

function send(res, status, body, extra = {}) {
  res.writeHead(status, { ...SECURITY_HEADERS, ...extra });
  res.end(body);
}

function writeTokensAtomic(file, tokens) {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.chmodSync(dir, 0o700);
  const tmp = path.join(dir, `.oauth-tokens.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`);
  let fd;
  try {
    fd = fs.openSync(tmp, 'wx', 0o600);
    fs.writeSync(fd, JSON.stringify(tokens, null, 2) + '\n');
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    fs.chmodSync(tmp, 0o600);
    fs.renameSync(tmp, file);
  } catch (err) {
    if (fd !== undefined) try { fs.closeSync(fd); } catch {}
    try { fs.unlinkSync(tmp); } catch {}
    throw err;
  }
}

// Build the stored token record. id_token is intentionally dropped.
function buildTokenRecord(resp, nowMs) {
  if (!resp || typeof resp.access_token !== 'string' || !resp.access_token) throw new Error('token response missing access_token');
  const expiresIn = Number(resp.expires_in);
  if (!Number.isFinite(expiresIn) || expiresIn <= 0) throw new Error('token response missing expires_in');
  const rec = {
    access_token: resp.access_token,
    issued_at: new Date(nowMs).toISOString(),
    expires_at: new Date(nowMs + expiresIn * 1000).toISOString(),
    scope: typeof resp.scope === 'string' && resp.scope ? resp.scope : SCOPE,
  };
  if (typeof resp.refresh_token === 'string' && resp.refresh_token) rec.refresh_token = resp.refresh_token;
  return rec;
}

/**
 * Create (not start) a login session.
 * opts: credentials {client_id, client_secret}, fetch, tokenPath, port, timeoutMs, now, log
 * Returns { start(): Promise<{port,startUrl}>, done: Promise<{ok:true}>, close() }
 * `done` rejects with a generic Error (no secret detail) on failure/timeout/provider error.
 */
function createSession(opts = {}) {
  const creds = opts.credentials;
  if (!creds || !creds.client_id || !creds.client_secret) throw new Error('credentials required');
  const doFetch = opts.fetch || globalThis.fetch;
  const tokenPath = opts.tokenPath || DEFAULT_TOKEN_PATH;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const now = opts.now || Date.now;
  const log = opts.log || (() => {});
  const requestedPort = opts.port ?? DEFAULT_PORT;
  const secrets = generateSecrets();

  let redirectUri = `http://localhost:${requestedPort}${CALLBACK_PATH}`;
  let inFlight = false;
  let finished = false;
  let timer = null;
  let resolveDone, rejectDone;
  const done = new Promise((res, rej) => { resolveDone = res; rejectDone = rej; });
  done.catch(() => {}); // avoid unhandled rejection if caller only awaits start()

  const server = http.createServer((req, res) => {
    handle(req, res).catch(() => {
      if (!res.headersSent) send(res, 500, PAGES.fail);
      else res.end();
      finish(new Error('internal error'));
    });
  });

  function closeServer() {
    return new Promise((resolve) => {
      if (!server.listening) return resolve();
      server.close(() => resolve());
      server.closeAllConnections?.();
    });
  }

  function finish(err) {
    if (finished) return;
    finished = true;
    clearTimeout(timer);
    // Let the in-progress response flush before connections are torn down.
    setImmediate(() => {
      closeServer().then(() => (err ? rejectDone(err) : resolveDone({ ok: true })));
    });
  }

  function authorizeLocation() {
    const q = new URLSearchParams({
      client_id: creds.client_id,
      redirect_uri: redirectUri,
      response_type: 'code',
      scope: SCOPE,
      state: secrets.state,
      nonce: secrets.nonce,
      code_challenge: secrets.challenge,
      code_challenge_method: 'S256',
      locale: 'en-US',
    });
    return `${AUTHORIZE_URL}?${q.toString()}`;
  }

  async function exchange(code) {
    const body = new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: creds.client_id,
      client_secret: creds.client_secret,
      code,
      code_verifier: secrets.verifier,
      redirect_uri: redirectUri,
      audience: AUDIENCE,
    });
    const r = await doFetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: body.toString(),
      signal: AbortSignal.timeout(30000),
    });
    if (!r.ok) throw new Error(`token exchange failed (HTTP ${r.status})`);
    return buildTokenRecord(await r.json(), now());
  }

  async function handle(req, res) {
    if (finished) return send(res, 503, PAGES.bad);
    if (!isLoopbackHost(req.headers.host)) return send(res, 403, PAGES.bad);
    if (req.method !== 'GET') return send(res, 405, PAGES.bad, { Allow: 'GET' });
    let url;
    try { url = new URL(req.url, 'http://localhost'); } catch { return send(res, 400, PAGES.bad); }

    if (url.pathname === '/') return send(res, 302, '', { Location: authorizeLocation() });
    if (url.pathname !== CALLBACK_PATH) return send(res, 404, PAGES.notfound);

    if (inFlight) return send(res, 409, PAGES.bad);
    const p = url.searchParams;
    const codes = p.getAll('code');
    const states = p.getAll('state');
    const errors = p.getAll('error');
    if (codes.length > 1 || states.length > 1 || errors.length > 1) return send(res, 400, PAGES.bad);
    if (states.length !== 1 || !safeEqual(states[0], secrets.state)) return send(res, 400, PAGES.bad);
    if ((codes.length === 1) === (errors.length === 1)) return send(res, 400, PAGES.bad); // missing or ambiguous
    if (errors.length === 1) {
      inFlight = true;
      log('Authorization was denied or failed at the provider.');
      send(res, 400, PAGES.fail);
      return finish(new Error('authorization failed at provider'));
    }
    if (!codes[0]) return send(res, 400, PAGES.bad);

    inFlight = true; // single use: validated, now exchanging
    log('Callback accepted; exchanging code for tokens.');
    try {
      const rec = await exchange(codes[0]);
      writeTokensAtomic(tokenPath, rec);
    } catch (e) {
      log('Token exchange or save failed.');
      send(res, 502, PAGES.fail);
      return finish(new Error('token exchange or save failed'));
    }
    log('Tokens saved.');
    send(res, 200, PAGES.ok);
    finish();
  }

  function start() {
    return new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(requestedPort, BIND_HOST, () => {
        const port = server.address().port;
        if (requestedPort === 0) redirectUri = `http://localhost:${port}${CALLBACK_PATH}`;
        timer = setTimeout(() => {
          log('Timed out waiting for sign-in.');
          finish(new Error('timed out'));
        }, timeoutMs);
        timer.unref?.();
        resolve({ port, startUrl: `http://localhost:${port}/`, redirectUri });
      });
    });
  }

  return { start, done, close: () => { finish(new Error('closed')); return closeServer(); } };
}

module.exports = {
  AUTHORIZE_URL, TOKEN_URL, AUDIENCE, SCOPE, CALLBACK_PATH, DEFAULT_PORT, BIND_HOST,
  DEFAULT_TIMEOUT_MS, DEFAULT_CREDENTIALS_PATH, DEFAULT_TOKEN_PATH,
  generateSecrets, loadCredentials, safeEqual, isLoopbackHost, writeTokensAtomic,
  buildTokenRecord, createSession,
};

'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');
const lib = require('../scripts/oauth-lib.cjs');
const cli = require('../scripts/oauth-login.cjs');

const CREDS = { client_id: 'dummy-client-id-0000', client_secret: 'dummy-client-secret-0000' };
const FAKE_TOKENS = {
  access_token: 'dummy.access.token.AAAA',
  refresh_token: 'dummy_refresh_token_BBBB',
  id_token: 'dummy.id.token.CCCC',
  expires_in: 28800,
  state: 'ignored',
  token_type: 'Bearer',
  scope: 'openid offline_access vehicle_device_data',
};

function tmpDir() { return fs.mkdtempSync(path.join(os.tmpdir(), 'oauth-test-')); }

function req(port, { method = 'GET', pathAndQuery = '/', host } = {}) {
  return new Promise((resolve, reject) => {
    const r = http.request({ host: '127.0.0.1', port, method, path: pathAndQuery, headers: { Host: host ?? `localhost:${port}` }, agent: false }, (res) => {
      let body = '';
      res.on('data', (d) => (body += d));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
    });
    r.on('error', reject);
    r.end();
  });
}

async function setup(over = {}) {
  const dir = tmpDir();
  const tokenPath = path.join(dir, 'sub', '.local', 'oauth-tokens.json');
  const calls = [];
  const logs = [];
  const fakeFetch = over.fetch || (async (url, init) => {
    calls.push({ url, init });
    return { ok: true, status: 200, json: async () => FAKE_TOKENS };
  });
  const session = lib.createSession({ credentials: CREDS, fetch: fakeFetch, tokenPath, port: 0, log: (m) => logs.push(m), timeoutMs: over.timeoutMs, now: () => 1_700_000_000_000 });
  const info = await session.start();
  const loc = await req(info.port, { pathAndQuery: '/' });
  const auth = new URL(loc.headers.location);
  return { dir, tokenPath, calls, logs, session, info, port: info.port, auth, loc, state: auth.searchParams.get('state') };
}

const cb = (state, extra = '') => `${lib.CALLBACK_PATH}?code=dummycode123&state=${encodeURIComponent(state)}${extra}`;
const listening = async (port) => new Promise((r) => { const s = require('node:net').connect(port, '127.0.0.1'); s.on('connect', () => { s.destroy(); r(true); }); s.on('error', () => r(false)); });

test('importing modules does not start anything', () => {
  assert.equal(typeof lib.createSession, 'function');
  assert.equal(typeof cli.main, 'function');
});

test('constants are fixed', () => {
  assert.equal(lib.SCOPE, 'openid offline_access vehicle_device_data');
  assert.equal(lib.DEFAULT_PORT, 8765);
  assert.equal(lib.BIND_HOST, '127.0.0.1');
  assert.equal(lib.DEFAULT_TIMEOUT_MS, 600000);
  assert.equal(lib.CALLBACK_PATH, '/oauth-signin-redirect');
});

test('generateSecrets: 86-char verifier, S256 challenge, random', () => {
  const a = lib.generateSecrets(), b = lib.generateSecrets();
  assert.equal(a.verifier.length, 86);
  assert.match(a.verifier, /^[A-Za-z0-9_-]{86}$/);
  assert.equal(a.challenge, crypto.createHash('sha256').update(a.verifier).digest('base64url'));
  assert.notEqual(a.state, b.state);
  assert.notEqual(a.nonce, b.nonce);
  assert.notEqual(a.verifier, b.verifier);
  assert.ok(a.state.length >= 43 && a.nonce.length >= 43);
});

test('start route redirects to Tesla authorize with all params, binds loopback', async () => {
  const t = await setup();
  try {
    assert.equal(t.loc.status, 302);
    assert.equal(t.auth.origin + t.auth.pathname, 'https://auth.tesla.com/oauth2/v3/authorize');
    const q = t.auth.searchParams;
    assert.equal(q.get('client_id'), CREDS.client_id);
    assert.equal(q.get('redirect_uri'), `http://localhost:${t.port}/oauth-signin-redirect`);
    assert.equal(q.get('response_type'), 'code');
    assert.equal(q.get('scope'), 'openid offline_access vehicle_device_data');
    assert.equal(q.get('code_challenge_method'), 'S256');
    assert.equal(q.get('locale'), 'en-US');
    assert.ok(q.get('state') && q.get('nonce') && q.get('code_challenge'));
    assert.equal(q.get('code_challenge').length, 43);
    assert.equal(t.loc.headers['cache-control'], 'no-store');
    assert.equal(t.loc.headers['referrer-policy'], 'no-referrer');
    assert.equal(t.info.startUrl, `http://localhost:${t.port}/`);
  } finally { await t.session.close(); }
});

test('success: token exchange request, secure atomic write, headers, closes listener', async () => {
  const t = await setup();
  const res = await req(t.port, { pathAndQuery: cb(t.state) });
  assert.equal(res.status, 200);
  assert.equal(res.headers['cache-control'], 'no-store');
  assert.equal(res.headers['referrer-policy'], 'no-referrer');
  assert.equal(res.headers['content-security-policy'], "default-src 'none'");
  assert.match(res.headers['content-type'], /^text\/html/);
  assert.match(res.body, /name="referrer" content="no-referrer"/);
  assert.ok(!res.body.includes('dummycode123') && !res.body.includes(t.state));
  await t.session.done;

  assert.equal(t.calls.length, 1);
  const { url, init } = t.calls[0];
  assert.equal(url, 'https://fleet-auth.prd.vn.cloud.tesla.com/oauth2/v3/token');
  assert.equal(init.method, 'POST');
  const b = new URLSearchParams(init.body);
  assert.equal(b.get('grant_type'), 'authorization_code');
  assert.equal(b.get('client_id'), CREDS.client_id);
  assert.equal(b.get('client_secret'), CREDS.client_secret);
  assert.equal(b.get('code'), 'dummycode123');
  assert.equal(b.get('redirect_uri'), t.auth.searchParams.get('redirect_uri'));
  assert.equal(b.get('audience'), 'https://fleet-api.prd.na.vn.cloud.tesla.com');
  const verifier = b.get('code_verifier');
  assert.equal(verifier.length, 86);
  assert.equal(crypto.createHash('sha256').update(verifier).digest('base64url'), t.auth.searchParams.get('code_challenge'));

  const saved = JSON.parse(fs.readFileSync(t.tokenPath, 'utf8'));
  assert.deepEqual(Object.keys(saved).sort(), ['access_token', 'expires_at', 'issued_at', 'refresh_token', 'scope']);
  assert.equal(saved.access_token, FAKE_TOKENS.access_token);
  assert.equal(saved.refresh_token, FAKE_TOKENS.refresh_token);
  assert.equal(saved.issued_at, new Date(1_700_000_000_000).toISOString());
  assert.equal(saved.expires_at, new Date(1_700_000_000_000 + 28800_000).toISOString());
  assert.equal(saved.scope, FAKE_TOKENS.scope);
  assert.ok(!JSON.stringify(saved).includes('id.token'));
  if (process.platform !== 'win32') {
    assert.equal(fs.statSync(t.tokenPath).mode & 0o777, 0o600);
    assert.equal(fs.statSync(path.dirname(t.tokenPath)).mode & 0o777, 0o700);
  }
  assert.deepEqual(fs.readdirSync(path.dirname(t.tokenPath)), ['oauth-tokens.json']); // no temp leftovers
  assert.equal(await listening(t.port), false);
});

test('missing refresh_token is omitted', async () => {
  const t = await setup({ fetch: async () => ({ ok: true, status: 200, json: async () => ({ access_token: 'a', expires_in: 10 }) }) });
  await req(t.port, { pathAndQuery: cb(t.state) });
  await t.session.done;
  const saved = JSON.parse(fs.readFileSync(t.tokenPath, 'utf8'));
  assert.ok(!('refresh_token' in saved));
  assert.equal(saved.scope, lib.SCOPE);
});

test('rejects non-loopback Host, non-GET, unknown path; stays open', async () => {
  const t = await setup();
  try {
    for (const host of ['evil.example.com', 'localhost.evil.com', '192.168.1.5:8765']) {
      assert.equal((await req(t.port, { pathAndQuery: cb(t.state), host })).status, 403, host);
    }
    assert.equal((await req(t.port, { method: 'POST', pathAndQuery: cb(t.state) })).status, 405);
    assert.equal((await req(t.port, { method: 'PUT', pathAndQuery: '/' })).status, 405);
    assert.equal((await req(t.port, { pathAndQuery: '/other' })).status, 404);
    assert.equal(t.calls.length, 0);
    assert.equal((await req(t.port, { pathAndQuery: '/', host: `127.0.0.1:${t.port}` })).status, 302);
  } finally { await t.session.close(); }
});

test('rejects duplicate, mismatched, missing, and ambiguous params without exchanging', async () => {
  const t = await setup();
  try {
    const wrong = t.state.slice(0, -1) + (t.state.endsWith('A') ? 'B' : 'A');
    const cases = [
      `${lib.CALLBACK_PATH}?code=a&code=b&state=${t.state}`,
      `${lib.CALLBACK_PATH}?code=a&state=${t.state}&state=${t.state}`,
      `${lib.CALLBACK_PATH}?error=x&error=y&state=${t.state}`,
      `${lib.CALLBACK_PATH}?code=a&state=${wrong}`,
      `${lib.CALLBACK_PATH}?code=a&state=short`,
      `${lib.CALLBACK_PATH}?code=a&state=${t.state}extra`,
      `${lib.CALLBACK_PATH}?code=a`,
      `${lib.CALLBACK_PATH}?state=${t.state}`,
      `${lib.CALLBACK_PATH}?code=a&error=access_denied&state=${t.state}`,
      `${lib.CALLBACK_PATH}?code=&state=${t.state}`,
      lib.CALLBACK_PATH,
    ];
    for (const c of cases) {
      const r = await req(t.port, { pathAndQuery: c });
      assert.equal(r.status, 400, c);
      assert.ok(!r.body.includes(t.state));
    }
    assert.equal(t.calls.length, 0);
    assert.equal(await listening(t.port), true); // invalid requests do not end the session
  } finally { await t.session.close(); }
});

test('replay: second callback while/after in flight is rejected, one exchange only', async () => {
  let release;
  const gate = new Promise((r) => (release = r));
  const t = await setup({ fetch: async function (u, i) { t0.push(i); await gate; return { ok: true, status: 200, json: async () => FAKE_TOKENS }; } });
  const first = req(t.port, { pathAndQuery: cb(t.state) });
  while (t0.length === 0) await new Promise((r) => setTimeout(r, 5));
  const second = await req(t.port, { pathAndQuery: cb(t.state) });
  assert.equal(second.status, 409);
  release();
  assert.equal((await first).status, 200);
  await t.session.done;
  assert.equal(t0.length, 1);
  t0.length = 0;
  assert.equal(await listening(t.port), false); // replay after completion impossible
});
const t0 = [];

test('valid provider error (matching state) ends session, no exchange, no echo', async () => {
  const t = await setup();
  const r = await req(t.port, { pathAndQuery: `${lib.CALLBACK_PATH}?error=access_denied&error_description=secret-ish&state=${t.state}` });
  assert.equal(r.status, 400);
  assert.ok(!r.body.includes('access_denied') && !r.body.includes('secret-ish'));
  assert.equal(r.headers['content-security-policy'], "default-src 'none'");
  await assert.rejects(t.session.done, /provider/);
  assert.equal(t.calls.length, 0);
  assert.equal(fs.existsSync(t.tokenPath), false);
  assert.equal(await listening(t.port), false);
});

test('error callback with wrong state is ignored', async () => {
  const t = await setup();
  try {
    const r = await req(t.port, { pathAndQuery: `${lib.CALLBACK_PATH}?error=access_denied&state=nope` });
    assert.equal(r.status, 400);
    assert.equal(await listening(t.port), true);
  } finally { await t.session.close(); }
});

test('token exchange failure: generic error, nothing written, closed, no secrets in message', async () => {
  const t = await setup({ fetch: async () => ({ ok: false, status: 400, json: async () => ({ error: 'invalid_grant', detail: CREDS.client_secret }) }) });
  const r = await req(t.port, { pathAndQuery: cb(t.state) });
  assert.equal(r.status, 502);
  const err = await t.session.done.then(() => null, (e) => e);
  assert.ok(err);
  assert.ok(!err.message.includes(CREDS.client_secret));
  assert.equal(fs.existsSync(t.tokenPath), false);
  assert.equal(await listening(t.port), false);
});

test('malformed token response is rejected without writing', async () => {
  const t = await setup({ fetch: async () => ({ ok: true, status: 200, json: async () => ({ expires_in: 5 }) }) });
  const r = await req(t.port, { pathAndQuery: cb(t.state) });
  assert.equal(r.status, 502);
  await assert.rejects(t.session.done);
  assert.equal(fs.existsSync(t.tokenPath), false);
});

test('timeout closes the listener and rejects', async () => {
  const t = await setup({ timeoutMs: 60 });
  await assert.rejects(t.session.done, /timed out/);
  assert.equal(await listening(t.port), false);
});

test('existing token file is replaced atomically with 0600; loose dir tightened', () => {
  const dir = tmpDir();
  const d = path.join(dir, '.local');
  fs.mkdirSync(d, { mode: 0o755 });
  const f = path.join(d, 'oauth-tokens.json');
  fs.writeFileSync(f, '{"old":true}', { mode: 0o644 });
  lib.writeTokensAtomic(f, { access_token: 'x' });
  assert.deepEqual(JSON.parse(fs.readFileSync(f, 'utf8')), { access_token: 'x' });
  assert.equal(fs.statSync(f).mode & 0o777, 0o600);
  assert.equal(fs.statSync(d).mode & 0o777, 0o700);
});

test('no secrets in log output across a full flow', async () => {
  const t = await setup();
  await req(t.port, { pathAndQuery: cb(t.state) });
  await t.session.done;
  const all = t.logs.join('\n');
  for (const s of [CREDS.client_id, CREDS.client_secret, 'dummycode123', t.state, t.auth.searchParams.get('nonce'), t.auth.searchParams.get('code_challenge'), FAKE_TOKENS.access_token, FAKE_TOKENS.refresh_token, 'auth.tesla.com', 'oauth-signin-redirect']) {
    assert.ok(!all.includes(s), `log leaked ${s.slice(0, 6)}`);
  }
});

test('library never calls anything but the token endpoint', async () => {
  const t = await setup();
  await req(t.port, { pathAndQuery: cb(t.state) });
  await t.session.done;
  assert.deepEqual(t.calls.map((c) => c.url), [lib.TOKEN_URL]);
  const src = fs.readFileSync(path.join(__dirname, '../scripts/oauth-lib.cjs'), 'utf8');
  assert.ok(!/fleet-api\.prd\.na[^'"`]*\/api\//.test(src));
  assert.ok(!/vehicle_cmds|vehicle_charging_cmds|wake_up/.test(src.replace(/\/\/.*$/gm, '')));
});

test('loadCredentials validates fields (temp file, dummy values)', () => {
  const dir = tmpDir();
  const f = path.join(dir, 'c.json');
  fs.writeFileSync(f, JSON.stringify(CREDS));
  assert.deepEqual(lib.loadCredentials(f), CREDS);
  fs.writeFileSync(f, JSON.stringify({ client_id: 'x' }));
  assert.throws(() => lib.loadCredentials(f), /client_id and client_secret/);
});

test('CLI reports missing credentials safely, does not bind', async () => {
  const logs = [];
  const code = await cli.main([], { log: (m) => logs.push(m), credentialsPath: path.join(tmpDir(), 'nope.json') });
  assert.equal(code, 1);
  assert.match(logs.join('\n'), /Could not load/);
  assert.equal(await cli.main(['--timeout-seconds', 'abc'], { log: () => {} }), 2);
});

test('isLoopbackHost / safeEqual', () => {
  for (const h of ['localhost', 'localhost:8765', '127.0.0.1:8765', '[::1]:8765', 'LOCALHOST:1']) assert.ok(lib.isLoopbackHost(h), h);
  for (const h of ['', undefined, 'a.com', 'localhost.a.com', '0.0.0.0:8765', 'localhost:99999999']) assert.ok(!lib.isLoopbackHost(h), String(h));
  assert.ok(lib.safeEqual('abc', 'abc'));
  assert.ok(!lib.safeEqual('abc', 'abd'));
  assert.ok(!lib.safeEqual('abc', 'abcd'));
});

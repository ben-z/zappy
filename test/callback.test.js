'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { computeRedirect, run } = require('../callback.js');
const root = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');

test('signin forwards code+state to exact private path', () => {
  const r = computeRedirect('signin', '?code=abc&state=xyz');
  assert.strictEqual(r.action, 'forward');
  assert.strictEqual(r.url, 'https://zappy.benzhang.dev/oauth-signin-redirect?code=abc&state=xyz');
});
test('signin forwards error params, drops unknown ones', () => {
  const r = computeRedirect('signin', '?error=access_denied&error_description=No+way&error_uri=https%3A%2F%2Fx.y&state=s&evil=1&redirect=http://evil');
  assert.strictEqual(r.action, 'forward');
  const u = new URL(r.url);
  assert.strictEqual(u.origin + u.pathname, 'https://zappy.benzhang.dev/oauth-signin-redirect');
  assert.deepStrictEqual([...u.searchParams.keys()].sort(), ['error', 'error_description', 'error_uri', 'state']);
  assert.strictEqual(u.searchParams.get('error_description'), 'No way');
});
test('signin preserves special characters through encoding', () => {
  const r = computeRedirect('signin', '?code=a%2Bb%26c%3D&state=s%20t');
  const u = new URL(r.url);
  assert.strictEqual(u.searchParams.get('code'), 'a+b&c=');
  assert.strictEqual(u.searchParams.get('state'), 's t');
});
test('signin does not forward without expected params', () => {
  for (const s of ['', '?', '?foo=bar', '?code=abc', '?state=xyz', '?error_description=x']) {
    const r = computeRedirect('signin', s);
    assert.strictEqual(r.action, 'none', s);
    assert.strictEqual(r.url, undefined);
  }
});
test('duplicate sensitive params rejected', () => {
  for (const s of ['?code=a&code=b&state=s', '?code=a&state=s&state=t', '?error=a&error=b']) {
    assert.strictEqual(computeRedirect('signin', s).action, 'reject', s);
  }
  assert.strictEqual(computeRedirect('signout', '?state=a&state=b').action, 'reject');
});
test('duplicate non-whitelisted params are ignored', () => {
  assert.strictEqual(computeRedirect('signin', '?code=a&state=s&x=1&x=2').action, 'forward');
});
test('signout forwards only state,error', () => {
  const r = computeRedirect('signout', '?state=s&error=e&code=c&error_description=d');
  assert.strictEqual(r.action, 'forward');
  const u = new URL(r.url);
  assert.strictEqual(u.origin + u.pathname, 'https://zappy.benzhang.dev/oauth-signout-redirect');
  assert.deepStrictEqual([...u.searchParams.keys()].sort(), ['error', 'state']);
});
test('parameterless signout returns to the fixed private route', () => {
  for (const search of ['', '?code=c', '?next=https://evil.example']) {
    assert.deepStrictEqual(computeRedirect('signout', search), {
      action: 'forward', url: 'https://zappy.benzhang.dev/oauth-signout-redirect'
    });
  }
});
test('unknown flow rejected', () => {
  assert.strictEqual(computeRedirect('__proto__', '?code=a&state=b').action, 'reject');
  assert.strictEqual(computeRedirect(null, '').action, 'reject');
});
test('destination cannot be influenced by input', () => {
  const r = computeRedirect('signin', '?code=a&state=//evil.com&error_uri=https://evil.com');
  assert.ok(r.url.startsWith('https://zappy.benzhang.dev/oauth-signin-redirect?'));
});

function fakeWin(search, flow) {
  const calls = [];
  const status = { textContent: '' };
  return {
    calls, status,
    win: {
      location: { search, hash: '', pathname: '/oauth-signin-redirect/', replace: (u) => calls.push(['replace', u]) },
      history: { replaceState: (a, b, u) => calls.push(['replaceState', u]) },
    },
    doc: { body: { getAttribute: () => flow }, getElementById: () => status },
  };
}
test('run clears history before location.replace and never displays params', () => {
  const f = fakeWin('?code=SECRET&state=S2', 'signin');
  run(f.win, f.doc);
  assert.deepStrictEqual(f.calls.map((c) => c[0]), ['replaceState', 'replace']);
  assert.strictEqual(f.calls[0][1], '/oauth-signin-redirect/');
  assert.ok(!f.status.textContent.includes('SECRET'));
});
test('run with no params shows safe status and does not redirect', () => {
  const f = fakeWin('', 'signin');
  run(f.win, f.doc);
  assert.ok(!f.calls.some((c) => c[0] === 'replace'));
  assert.ok(f.status.textContent.length > 0);
});
test('run with duplicate params clears query, no redirect, no echo', () => {
  const f = fakeWin('?code=SECRET&code=B&state=x', 'signin');
  run(f.win, f.doc);
  assert.deepStrictEqual(f.calls.map((c) => c[0]), ['replaceState']);
  assert.ok(!f.status.textContent.includes('SECRET'));
});

test('static files and hardening', () => {
  assert.strictEqual(read('CNAME').trim(), 'zappy-auth.benzhang.dev');
  assert.ok(fs.existsSync(path.join(root, '.nojekyll')));
  const gi = read('.gitignore');
  for (const p of ['.local', '*.private.pem', '.env']) assert.ok(gi.includes(p), p);
  for (const f of ['index.html', 'oauth-signin-redirect/index.html', 'oauth-signout-redirect/index.html']) {
    const h = read(f);
    assert.match(h, /<meta name="referrer" content="no-referrer">/);
    assert.match(h, /Content-Security-Policy[^>]*script-src 'self'/);
    assert.doesNotMatch(h, /https?:\/\//, f + ' has external URL');
    assert.doesNotMatch(h, /<script(?![^>]*\bsrc=)[^>]*>/, f + ' has inline script');
    assert.doesNotMatch(h, /\son\w+=/i);
  }
  assert.doesNotMatch(read('index.html'), /<script/);
  assert.doesNotMatch(read('index.html'), /location\.|http-equiv="refresh"/i);
  assert.match(read('oauth-signin-redirect/index.html'), /data-flow="signin"/);
  assert.match(read('oauth-signout-redirect/index.html'), /data-flow="signout"/);
  const js = read('callback.js');
  assert.match(js, /location\.replace/);
  assert.doesNotMatch(js, /console\./);
  assert.doesNotMatch(js, /location\.(href|assign)\s*=/);
});


test('Tesla public key is a valid P-256 EC public key', () => {
  const crypto = require('node:crypto');
  const pem = read('.well-known/appspecific/com.tesla.3p.public-key.pem');
  const key = crypto.createPublicKey(pem);
  assert.strictEqual(key.asymmetricKeyType, 'ec');
  assert.strictEqual(key.asymmetricKeyDetails.namedCurve, 'prime256v1');
  assert.match(pem, /^-----BEGIN PUBLIC KEY-----/);
});

test('publishable tree contains no private key material', () => {
  function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (['.git', '.local', 'node_modules'].includes(entry.name)) continue;
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(file);
      else if (entry.isFile()) {
        const text = fs.readFileSync(file, 'utf8');
        assert.doesNotMatch(text, /-----BEGIN\s+(?:RSA\s+|EC\s+|ENCRYPTED\s+)?PRIVATE KEY-----/, file);
      }
    }
  }
  walk(root);
});

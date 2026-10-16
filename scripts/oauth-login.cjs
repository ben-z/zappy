#!/usr/bin/env node
'use strict';
// Usage: node scripts/oauth-login.cjs [--timeout-seconds N]
// Starts a loopback listener on 127.0.0.1:8765, prints the local start link, and
// saves tokens to .local/oauth-tokens.json after the browser flow completes.
// Read-only scope only. Makes no vehicle API requests. Never prints secrets.
const lib = require('./oauth-lib.cjs');

async function main(argv = process.argv.slice(2), io = {}) {
  const out = io.log || ((m) => console.log(m));
  let timeoutMs = lib.DEFAULT_TIMEOUT_MS;
  const i = argv.indexOf('--timeout-seconds');
  if (i !== -1) {
    const n = Number(argv[i + 1]);
    if (!Number.isFinite(n) || n <= 0) { out('Invalid --timeout-seconds.'); return 2; }
    timeoutMs = n * 1000;
  }
  let credentials;
  try { credentials = lib.loadCredentials(io.credentialsPath); }
  catch { out('Could not load .local/tesla-credentials.json (need client_id and client_secret).'); return 1; }
  const session = lib.createSession({ credentials, timeoutMs, log: out, tokenPath: io.tokenPath });
  try {
    await session.start();
  } catch {
    out(`Could not listen on ${lib.BIND_HOST}:${lib.DEFAULT_PORT} (port in use?).`);
    return 1;
  }
  out(`Open this link in your browser: http://localhost:${lib.DEFAULT_PORT}/`);
  out(`Waiting up to ${Math.round(timeoutMs / 1000)}s for sign-in...`);
  try { await session.done; out('Done.'); return 0; }
  catch (e) { out(`Login did not complete: ${e.message}`); return 1; }
}

module.exports = { main };
if (require.main === module) main().then((c) => { process.exitCode = c; });

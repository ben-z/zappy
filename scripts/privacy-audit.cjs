'use strict';
// Audit files git would publish, not ignored runtime data. Never print matched values.
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const DEFAULT_ROOT = path.resolve(__dirname, '..');
const PRIVATE_FIELDS = new Set(['client_id', 'client_secret', 'access_token', 'refresh_token', 'id_token', 'vin', 'display_name', 'vehicle_name', 'email', 'account_id', 'user_id', 'vehicle_id', 'id', 'id_s']);
function privateValues(root) {
  const values = new Set();
  function visit(value, key) {
    if (PRIVATE_FIELDS.has(key)) {
      if (typeof value === 'string' && value.length >= 3) values.add(value);
      else if (typeof value === 'number' && Number.isFinite(value)) values.add(String(value));
    }
    if (Array.isArray(value)) value.forEach(v => visit(v, ''));
    else if (value && typeof value === 'object') for (const [k, v] of Object.entries(value)) visit(v, k);
  }
  function walk(dir) {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) continue;
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(file);
      else if (entry.isFile() && entry.name.endsWith('.json')) {
        try { visit(JSON.parse(fs.readFileSync(file, 'utf8')), ''); } catch { /* An opaque file is not parsed. */ }
      }
    }
  }
  walk(path.join(root, '.local'));
  return values;
}
function audit(options = {}) {
  const root = options.root || DEFAULT_ROOT;
  const files = options.files || execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).split('\0').filter(Boolean);
  const knownPrivate = privateValues(root);
  const findings = [];
  for (const relative of new Set(files)) {
    const full = path.resolve(root, relative);
    if (!full.startsWith(path.resolve(root) + path.sep)) { findings.push({ file: relative, rule: 'outside-repository' }); continue; }
    if (/(^|\/)(\.local|exports|node_modules)(\/|$)|(^|\/)\.env(?:\.|$)|\.(?:log|key)$|\.private\.pem$/.test(relative)) findings.push({ file: relative, rule: 'private-runtime-file' });
    if (!fs.existsSync(full)) continue;
    if (fs.lstatSync(full).isSymbolicLink()) { findings.push({ file: relative, rule: 'symlink-not-audited' }); continue; }
    if (!fs.statSync(full).isFile()) continue;
    const text = fs.readFileSync(full, 'utf8');
    if (/-----BEGIN\s+(?:(?:RSA|EC|ENCRYPTED|OPENSSH)\s+)?PRIVATE KEY-----/.test(text)) findings.push({ file: relative, rule: 'private-key' });
    if (/ta-secret\.[A-Za-z0-9^!$%&*+_~=-]{12,}/.test(text)) findings.push({ file: relative, rule: 'tesla-client-secret' });
    if (/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{12,}\b/.test(text)) findings.push({ file: relative, rule: 'jwt-token' });
    // Test fixtures may contain deliberately fake VIN-shaped strings. Exact local
    // vehicle identifiers are still checked in every file, including tests.
    if (!relative.startsWith('test/') && /\b(?:5YJ|7SA|LRW|XP7|SFZ|5SA)[A-HJ-NPR-Z0-9]{14}\b/.test(text)) findings.push({ file: relative, rule: 'vehicle-identifier' });
    if ([...knownPrivate].some(value => text.includes(value))) findings.push({ file: relative, rule: 'matches-private-local-data' });
  }
  return { files_checked: new Set(files).size, local_private_data_checked: knownPrivate.size > 0, findings };
}
function main() {
  try {
    const result = audit();
    for (const f of result.findings) console.error(`${f.file}: ${f.rule}`);
    if (result.findings.length) { console.error('Privacy audit failed. Matched values are not printed.'); return 1; }
    console.log(`Privacy audit passed: ${result.files_checked} publishable files checked.`);
    console.log(result.local_private_data_checked ? 'Also checked for exact private values found in local runtime JSON.' : 'No local private JSON found; only static format/path checks ran.');
    console.log('This is a guardrail, not a proof of anonymity. Review the staged diff before publishing.');
    return 0;
  } catch { console.error('Privacy audit could not complete. No file contents were printed.'); return 1; }
}
module.exports = { audit, privateValues, main };
if (require.main === module) process.exitCode = main();

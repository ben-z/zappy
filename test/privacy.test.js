'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { audit } = require('../scripts/privacy-audit.cjs');
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'zappy-privacy-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, '.local'));
  return root;
}
test('checks exact local secrets and PII without returning any matched values', t => {
  const root = fixture(t);
  const secret = ['unique', 'private', 'refresh', 'sentinel'].join('-');
  const vehicle = ['private', 'vehicle', 'sentinel'].join('-');
  fs.writeFileSync(path.join(root, '.local', 'runtime.json'), JSON.stringify({ refresh_token: secret, response: [{ display_name: vehicle }] }));
  fs.writeFileSync(path.join(root, 'leak.txt'), secret + '\n' + vehicle);
  const report = audit({ root, files: ['leak.txt'] });
  assert.deepEqual(report.findings, [{ file: 'leak.txt', rule: 'matches-private-local-data' }]);
  assert.equal(report.local_private_data_checked, true);
  assert.ok(!JSON.stringify(report).includes(secret));
  assert.ok(!JSON.stringify(report).includes(vehicle));
});
test('public samples pass without local credentials', t => {
  const root = fixture(t);
  fs.writeFileSync(path.join(root, 'sample.json'), JSON.stringify({ alias: 'vehicle-1', battery_percent: 42 }));
  assert.deepEqual(audit({ root, files: ['sample.json'] }).findings, []);
});
test('rejects private runtime paths even without known private values', t => {
  const root = fixture(t);
  fs.writeFileSync(path.join(root, '.local', 'runtime.json'), '{}');
  assert.equal(audit({ root, files: ['.local/runtime.json'] }).findings[0].rule, 'private-runtime-file');
});
test('detects key, Tesla-secret, and JWT-shaped strings without exposing values', t => {
  const root = fixture(t);
  const body = ['-----BEGIN ' + 'PRIVATE KEY-----', 'ta-' + 'secret.' + 'x'.repeat(20), 'eyJ' + 'x'.repeat(20) + '.' + 'y'.repeat(20) + '.' + 'z'.repeat(20)].join('\n');
  fs.writeFileSync(path.join(root, 'leak.txt'), body);
  assert.deepEqual(audit({ root, files: ['leak.txt'] }).findings.map(f => f.rule).sort(), ['jwt-token', 'private-key', 'tesla-client-secret']);
});
test('git file enumeration includes tracked ignored files but excludes untracked ignored data', t => {
  const root = fixture(t);
  execFileSync('git', ['init', '-q'], { cwd: root });
  fs.writeFileSync(path.join(root, '.gitignore'), '.local/\n');
  fs.writeFileSync(path.join(root, '.local', 'ignored.json'), '{}');
  fs.writeFileSync(path.join(root, 'safe.txt'), 'synthetic');
  let report = audit({ root });
  assert.equal(report.files_checked, 2);
  execFileSync('git', ['add', '-f', '.local/ignored.json'], { cwd: root });
  report = audit({ root });
  assert.ok(report.findings.some(f => f.rule === 'private-runtime-file'));
});
test('does not follow publishable symlinks into private data', t => {
  const root = fixture(t);
  fs.writeFileSync(path.join(root, '.local', 'private.txt'), 'private');
  fs.symlinkSync(path.join(root, '.local', 'private.txt'), path.join(root, 'public.txt'));
  assert.equal(audit({ root, files: ['public.txt'] }).findings[0].rule, 'symlink-not-audited');
});

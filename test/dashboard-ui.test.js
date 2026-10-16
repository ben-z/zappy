'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');

test('dashboard assets are self-contained and compatible with the local CSP', () => {
  const html = read('web/index.html');
  const css = read('web/styles.css');
  assert.match(html, /href=["']\/styles\.css["']/);
  assert.match(html, /src=["']\/app\.js["']/);
  assert.doesNotMatch(html, /<script(?![^>]*\bsrc=)[^>]*>/i);
  assert.doesNotMatch(html, /\son[a-z]+\s*=/i);
  assert.doesNotMatch(html, /\sstyle\s*=/i);
  assert.doesNotMatch(html, /(?:src|href)=["']https?:\/\//i);
  assert.doesNotMatch(css, /@import\b|url\(\s*["']?https?:/i);
});

test('frontend has no browser persistence, unsafe HTML insertion, or scheduled polling', () => {
  const app = read('web/app.js');
  assert.doesNotMatch(app, /\b(?:localStorage|sessionStorage|indexedDB)\s*[.\[]/);
  assert.doesNotMatch(app, /\.innerHTML\s*=|\.outerHTML\s*=|\.insertAdjacentHTML\s*\(|document\.write\s*\(/);
  assert.doesNotMatch(app, /\bsetInterval\s*\(|\beval\s*\(/);
  assert.doesNotMatch(app, /console\.(?:log|debug|info|error)\s*\(/);
  for (const endpoint of ['/api/bootstrap', '/api/refresh', '/api/capture']) assert.ok(app.includes(endpoint));
});

test('dashboard keeps data first and optional tools collapsed', () => {
  const html = read('web/index.html');
  const app = read('web/app.js');
  const css = read('web/styles.css');
  assert.match(html, /<h1 id="page-title">Your garage<\/h1>/);
  assert.match(html, /Local · cached readings · manual updates/);
  assert.doesNotMatch(html, /car-illustration|battery-arc|car-stage|at a glance|Time to limit|Only when you ask/);
  assert.match(html, /Reported power/);
  assert.match(html, /Reported time remaining/);
  assert.match(html, /Use cached battery/);
  for (const id of ['planner-tools', 'snapshot-tools', 'privacy-tools']) {
    assert.match(html, new RegExp(`<details id="${id}"[^>]*>`));
    assert.doesNotMatch(html, new RegExp(`<details id="${id}"[^>]*\\bopen\\b`));
  }
  for (const id of ['current-percent', 'capacity', 'power', 'price']) {
    const input = html.match(new RegExp(`<input id="${id}"[^>]*>`))[0];
    assert.doesNotMatch(input, /\bvalue=/);
  }
  assert.match(html, /Enter charging assumptions/);
  assert.doesNotMatch(app, /readingAt|snapshot\.captured_at|snapshot\.fetched_at/);
  assert.ok(css.split('\n').length > 200, 'Styles stay formatted rather than minified patches');
  assert.doesNotMatch(css, /car-stage|car-body|battery-arc|arc-fill|hero/);
});

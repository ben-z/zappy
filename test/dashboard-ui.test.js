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

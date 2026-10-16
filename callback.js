'use strict';
(function (root) {
  var PRIVATE_ORIGIN = 'https://zappy.benzhang.dev';
  var FLOWS = {
    signin: {
      destination: PRIVATE_ORIGIN + '/oauth-signin-redirect',
      allowed: ['code', 'state', 'error', 'error_description', 'error_uri'],
      // Forward only a plausible callback: code+state, or error.
      expected: function (p) { return (p.has('code') && p.has('state')) || p.has('error'); }
    },
    signout: {
      destination: PRIVATE_ORIGIN + '/oauth-signout-redirect',
      allowed: ['state', 'error'],
      expected: function (p) { return p.has('state') || p.has('error'); }
    }
  };

  // Pure: returns {action: 'forward'|'none'|'reject', url?, reason?}. Never echoes values.
  function computeRedirect(flow, search) {
    var cfg = Object.prototype.hasOwnProperty.call(FLOWS, flow) ? FLOWS[flow] : null;
    if (!cfg) return { action: 'reject', reason: 'unknown-flow' };
    var params;
    try { params = new URLSearchParams(typeof search === 'string' ? search : ''); }
    catch (e) { return { action: 'reject', reason: 'malformed' }; }
    var seen = {};
    var out = new URLSearchParams();
    var keys = [];
    params.forEach(function (v, k) { keys.push([k, v]); });
    for (var i = 0; i < keys.length; i++) {
      var k = keys[i][0];
      if (cfg.allowed.indexOf(k) === -1) continue; // drop everything else
      if (seen[k]) return { action: 'reject', reason: 'duplicate-param' };
      seen[k] = true;
      out.append(k, keys[i][1]);
    }
    if (!cfg.expected(out)) return { action: 'none', reason: 'no-expected-params' };
    return { action: 'forward', url: cfg.destination + '?' + out.toString() };
  }

  var MESSAGES = {
    'no-expected-params': 'No sign-in or sign-out response was found on this page. Start from the Zappy app.',
    'duplicate-param': 'The request was rejected because it was malformed. Please try again from the Zappy app.',
    'malformed': 'The request was rejected because it was malformed. Please try again from the Zappy app.',
    'unknown-flow': 'This page is not configured correctly.'
  };

  function run(win, doc) {
    var flow = doc.body && doc.body.getAttribute('data-flow');
    var status = doc.getElementById('status');
    var result = computeRedirect(flow, win.location.search);
    if (result.action === 'forward') {
      if (status) status.textContent = 'Redirecting to Zappy\u2026';
      // Remove query/hash from public history before leaving.
      win.history.replaceState(null, '', win.location.pathname);
      win.location.replace(result.url);
      return result;
    }
    if (win.location.search || win.location.hash) {
      win.history.replaceState(null, '', win.location.pathname);
    }
    if (status) status.textContent = MESSAGES[result.reason] || MESSAGES['malformed'];
    return result;
  }

  var api = { computeRedirect: computeRedirect, run: run, PRIVATE_ORIGIN: PRIVATE_ORIGIN };
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root && root.document) { root.ZappyCallback = api; run(root, root.document); }
})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : this));

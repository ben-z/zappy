'use strict';
// Official Tesla onboarding only. Never authorizes a vehicle or sends a command.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const root = path.resolve(__dirname, '..');
const domain = 'zappy-auth.benzhang.dev';
const audience = 'https://fleet-api.prd.na.vn.cloud.tesla.com';
const credentials = JSON.parse(fs.readFileSync(path.join(root, '.local/tesla-credentials.json'), 'utf8'));
const secrets = [credentials.client_secret, credentials.client_id];
const verifyOnly = process.argv.includes('--verify-only');
function sanitize(value) {
  if (typeof value === 'string') return secrets.reduce((s, secret) => secret ? s.split(secret).join('[redacted]') : s, value);
  if (Array.isArray(value)) return value.map(sanitize);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, val]) => [key, /secret|token|authorization/i.test(key) ? '[redacted]' : sanitize(val)]));
  return value;
}
async function jsonResponse(response) {
  const text = await response.text();
  try { return JSON.parse(text); } catch { return { message: text }; }
}
async function main() {
  const tokenResponse = await fetch('https://fleet-auth.prd.vn.cloud.tesla.com/oauth2/v3/token', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'client_credentials', client_id: credentials.client_id, client_secret: credentials.client_secret, audience, scope: 'openid vehicle_device_data vehicle_cmds vehicle_charging_cmds' }),
    signal: AbortSignal.timeout(30000)
  });
  const tokenData = await jsonResponse(tokenResponse);
  console.log('Partner authentication HTTP', tokenResponse.status);
  if (!tokenResponse.ok || !tokenData.access_token) throw new Error(JSON.stringify(sanitize(tokenData)));
  secrets.push(tokenData.access_token);
  const headers = { 'Content-Type': 'application/json', Authorization: 'Bearer ' + tokenData.access_token };
  let registrationStatus = 200;
  if (!verifyOnly) {
    const registration = await fetch(audience + '/api/1/partner_accounts', {
      method: 'POST', headers, body: JSON.stringify({ domain }), signal: AbortSignal.timeout(30000)
    });
    const registrationData = await jsonResponse(registration);
    registrationStatus = registration.status;
    console.log('Partner registration HTTP', registration.status);
    console.log('Partner registration result', JSON.stringify(sanitize(registrationData)));
    if (!registration.ok) throw new Error('Partner registration was not accepted.');
    fs.writeFileSync(path.join(root, '.local/partner-registration.json'), JSON.stringify({ registered_at: new Date().toISOString(), domain, audience, registration_status: registration.status, public_key_matches: null }, null, 2) + '\n', { mode: 0o600 });
  }
  const verification = await fetch(audience + '/api/1/partner_accounts/public_key?domain=' + encodeURIComponent(domain), {
    headers, signal: AbortSignal.timeout(30000)
  });
  const verificationData = await jsonResponse(verification);
  console.log('Registered-key verification HTTP', verification.status);
  if (!verification.ok) throw new Error(JSON.stringify(sanitize(verificationData)));
  const response = verificationData.response ?? verificationData;
  const returnedKey = typeof response === 'string' ? response : response.public_key;
  if (typeof returnedKey !== 'string') throw new Error('Verification response did not contain a public key.');
  const localKey = crypto.createPublicKey(fs.readFileSync(path.join(root, '.well-known/appspecific/com.tesla.3p.public-key.pem'))).export({ type: 'spki', format: 'der' });
  let matches;
  if (/^04[0-9a-f]{128}$/i.test(returnedKey)) {
    const jwk = crypto.createPublicKey({ key: localKey, type: 'spki', format: 'der' }).export({ format: 'jwk' });
    const rawPoint = '04' + Buffer.from(jwk.x, 'base64url').toString('hex') + Buffer.from(jwk.y, 'base64url').toString('hex');
    matches = rawPoint.toLowerCase() === returnedKey.toLowerCase();
  } else {
    const remoteKey = crypto.createPublicKey(returnedKey).export({ type: 'spki', format: 'der' });
    matches = localKey.equals(remoteKey);
  }
  if (!matches) throw new Error('Registered public key does not match the deployed key.');
  console.log('Registered public key matches the deployed P-256 key.');
  const report = { verified_at: new Date().toISOString(), domain, audience, registration_status: registrationStatus, public_key_matches: true };
  fs.writeFileSync(path.join(root, '.local/partner-registration.json'), JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
}
main().catch(error => { console.error('Onboarding error:', sanitize(error.message)); process.exitCode = 1; });

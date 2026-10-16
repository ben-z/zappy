# zappy

Static GitHub Pages site on `https://zappy-auth.benzhang.dev` that relays OAuth
browser redirects to the private Zappy app at the fixed origin
`https://zappy.benzhang.dev`. It exists so the OAuth provider can be given a
public redirect URI while the app itself stays private.

No build step, no dependencies, no published secrets. Plain HTML, one JS file, one CSS file.

## Setup status (2026-10-15)

- GitHub repository `ben-z/zappy` is public and deploys `main` from `/ (root)`.
- Custom domain `zappy-auth.benzhang.dev` is verified on GitHub account `ben-z`.
- Cloudflare has the DNS-only CNAME to `ben-z.github.io` and the GitHub ownership TXT.
- GitHub's HTTPS certificate is active and HTTPS is enforced.
- Tesla developer application **Zappy** was approved and is **Active**.
- Enabled app capabilities: Vehicle Information, Vehicle Location, Vehicle Commands,
  Vehicle Charging Management, Energy Product Information, Energy Product Commands.
  Profile Information was left unchecked.
- Optional billing details were skipped. Future Fleet API usage can have charges;
  this setup does not configure a billing payment method or start polling.
- North America partner registration succeeded and the registered public key was verified.
- No private app exists yet. The callback destinations are reserved for that future app.
  No owner OAuth login, vehicle pairing, vehicle commands, or energy controls were performed.

## Routes

| Public (GitHub Pages) | Forwards to (private, no trailing slash) | Forwarded params |
|---|---|---|
| `https://zappy-auth.benzhang.dev/oauth-signin-redirect/` | `https://zappy.benzhang.dev/oauth-signin-redirect` | `code`, `state`, `error`, `error_description`, `error_uri` |
| `https://zappy-auth.benzhang.dev/oauth-signout-redirect/` | `https://zappy.benzhang.dev/oauth-signout-redirect` | `state`, `error` |
| `https://zappy-auth.benzhang.dev/` | (informational page, never redirects) | none |

All other query parameters are dropped.

### Trailing slash: IMPORTANT

GitHub Pages serves `oauth-signin-redirect/index.html`, so the canonical public URL
has a **trailing slash**. Register that form to avoid an extra redirect at the callback.
The private app routes are the opposite: **no** trailing slash.

The public URI with the trailing slash must be used **identically** in both:

1. the authorize request `redirect_uri`, and
2. the token exchange `redirect_uri`.

```
redirect_uri = https://zappy-auth.benzhang.dev/oauth-signin-redirect/
logout       = https://zappy-auth.benzhang.dev/oauth-signout-redirect/
```

Providers compare these strings exactly; a mismatch (slash vs. no slash) between
authorize and token exchange fails with `invalid_grant` / `redirect_uri_mismatch`.
Register the slash form in the provider's allowed redirect / post-logout list.
The private app must NOT use its own `/oauth-signin-redirect` URL as `redirect_uri`
for token exchange; it must send the public slash URI it used for authorize.

## Behavior

- Signin forwards only when `code` and `state` are both present, or `error` is present.
- Signout returns to the fixed private route even without parameters, since providers
  may send a parameterless post-logout callback. Only `state` and `error` are forwarded.
- Signin without expected parameters stays and shows a generic status message (no redirect).
- If a whitelisted parameter appears more than once, the request is rejected: no redirect.
- Before leaving, the query string is removed from the public page's history entry
  (`history.replaceState`), then `location.replace()` is used so the public URL is not
  left in back-history.
- Parameter values are never displayed or logged.

## Setup

1. Repository: `https://github.com/ben-z/zappy`; local clone: `~/Projects/zappy`.
2. Settings > Pages: deploy from branch `main`, folder `/ (root)`.
3. Custom domain: `zappy-auth.benzhang.dev` (matches the committed `CNAME`). Enable "Enforce HTTPS".
4. Cloudflare DNS: `CNAME zappy-auth -> ben-z.github.io`, **DNS only**.
   Leave `*.benzhang.dev` pointing to the private Tailscale ingress.
5. `.nojekyll` is committed so Pages serves files as-is.
6. Register the two public URIs (with trailing slashes) with the OAuth provider.

## Integration checklist (private app)

- Authorize: `redirect_uri=https://zappy-auth.benzhang.dev/oauth-signin-redirect/`.
- Token exchange: send the exact same `redirect_uri`.
- Verify `state` (and PKCE verifier) in the private app; this relay does not validate them.
- Handle `GET /oauth-signin-redirect` and `GET /oauth-signout-redirect` (no trailing slash) on `https://zappy.benzhang.dev`.
- The private app must treat forwarded values as untrusted input. The relay is a convenience, not a trust boundary.
- Use PKCE with a public client, or keep any client secret on the private server only.

## Security

- Destination origin and paths are constants in `callback.js`; input cannot alter them.
- `<meta name="referrer" content="no-referrer">` on every page.
- CSP meta: `default-src 'none'; script-src 'self'; style-src 'self'`; no inline scripts, no third-party resources.
- `location.replace` is used, never `href=` / `assign`.
- No client secrets or private keys belong in this repo. `.gitignore` excludes `.local/`,
  `*.pem` except explicitly allowed public keys, `.env*`, and `*.key`.
- Limitations: meta CSP cannot set `frame-ancestors`, and GitHub Pages cannot set custom headers. Query values pass through the browser URL bar and provider logs by nature of OAuth redirects. Use PKCE and one-time `state`.

## Tesla Fleet API public key and partner registration

Tesla requires a PEM-encoded P-256 (`prime256v1` / `secp256r1`) public key at:

```
https://zappy-auth.benzhang.dev/.well-known/appspecific/com.tesla.3p.public-key.pem
```

The public key is committed. The matching private key was generated on the setup
Mac at `~/Projects/zappy/.local/fleet.private.pem` with owner-only permissions.
It is git-ignored and is NOT recoverable by cloning this public repo. Back it up in
a secret manager and securely deploy it to the private app or Tesla Vehicle Command
Proxy before using vehicle commands. Never upload the private key to Pages.

The app's client credentials are stored only on the setup Mac at
`~/Projects/zappy/.local/tesla-credentials.json`, with owner-only permissions.
The `.local` directory itself is owner-only and excluded from git. Back these up
securely; do not copy them into Pages or a future browser frontend.

North America onboarding is complete for `domain: zappy-auth.benzhang.dev` and
`audience: https://fleet-api.prd.na.vn.cloud.tesla.com`. A verification report is
stored in `.local/partner-registration.json` (not committed).

The non-secret helper `scripts/register-partner.cjs` can repeat onboarding or verify
an existing registration. It reads local credentials, keeps the token in memory,
redacts credentials from output, and never authorizes a vehicle or sends commands:

```
node scripts/register-partner.cjs --verify-only
# For a fresh registration only:
node scripts/register-partner.cjs
```

Registration is required separately in any other region where the app will operate.
The helper currently targets North America only. The registration domain must share
the root domain of the allowed origin. Official references:

- https://developer.tesla.com/docs/fleet-api/authentication/partner-tokens
- https://developer.tesla.com/docs/fleet-api/endpoints/partner-endpoints

For vehicle commands, the owner must also pair the registered public key with the
vehicle through Tesla's mobile-app flow. Publishing the key alone does not register
the partner, pair a vehicle, or grant access to any vehicle.

Keep the existing key stable. Do not regenerate/replace it after registration or
pairing without planning the registration and vehicle re-pairing steps.

## Tests

```
node --test
```

Covers the pure `computeRedirect(flow, search)` helper (whitelisting, duplicates,
missing params, encoding, fixed destination), the `run()` flow with fake window objects
(history cleared before `replace`, no echoing of values), and static hardening checks
(CNAME, `.nojekyll`, CSP, referrer meta, no external URLs or inline scripts).

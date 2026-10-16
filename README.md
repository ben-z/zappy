# zappy

Static GitHub Pages site on `https://zappy-auth.benzhang.dev` that relays OAuth
browser redirects to the private Zappy app at the fixed origin
`https://zappy.benzhang.dev`. It exists so the OAuth provider can be given a
public redirect URI while the app itself stays private.

No build step, no dependencies, no secrets. Plain HTML, one JS file, one CSS file.

## Routes

| Public (GitHub Pages) | Forwards to (private, no trailing slash) | Forwarded params |
|---|---|---|
| `https://zappy-auth.benzhang.dev/oauth-signin-redirect/` | `https://zappy.benzhang.dev/oauth-signin-redirect` | `code`, `state`, `error`, `error_description`, `error_uri` |
| `https://zappy-auth.benzhang.dev/oauth-signout-redirect/` | `https://zappy.benzhang.dev/oauth-signout-redirect` | `state`, `error` |
| `https://zappy-auth.benzhang.dev/` | (informational page, never redirects) | none |

All other query parameters are dropped.

### Trailing slash: IMPORTANT

GitHub Pages serves `oauth-signin-redirect/index.html`, so the canonical public URL
has a **trailing slash**. Without it, Pages answers with a 301 redirect that can
drop or alter behavior. The private app routes are the opposite: **no** trailing slash.

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
- Signout forwards only when `state` or `error` is present.
- Otherwise the page stays and shows a generic status message (no redirect).
- If a whitelisted parameter appears more than once, the request is rejected: no redirect.
- Before leaving, the query string is removed from the public page's history entry
  (`history.replaceState`), then `location.replace()` is used so the public URL is not
  left in back-history.
- Parameter values are never displayed or logged.

## Setup

1. Create a GitHub repo and push `main` (not done by this project).
2. Settings > Pages: deploy from branch `main`, folder `/ (root)`.
3. Custom domain: `zappy-auth.benzhang.dev` (matches the committed `CNAME`). Enable "Enforce HTTPS".
4. DNS: `CNAME zappy-auth -> <github-user>.github.io`.
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
- No client secrets or private keys belong in this repo. `.gitignore` excludes `.local/`, `*.pem` (except `*.public.pem`), `.env*`, `*.key`.
- Limitations: meta CSP cannot set `frame-ancestors`, and GitHub Pages cannot set custom headers. Query values pass through the browser URL bar and provider logs by nature of OAuth redirects. Use PKCE and one-time `state`.

## Future: public key requirements

Not present yet; no placeholder key is committed. If the provider later needs a
public key or JWKS (e.g. `private_key_jwt` client auth, signed requests):

- Generate the key pair outside this repo (keep the private half in `.local/` or a secret manager; never commit it).
- Commit only the public half, e.g. `.well-known/jwks.json` or `keys/<kid>.public.pem`. Pages must serve it; `.nojekyll` already allows dot-directories.
- Include a stable `kid`, algorithm (e.g. RS256/ES256), and `use: sig`.
- Support rotation by publishing old and new keys together until old tokens expire.
- Add a test asserting no `PRIVATE KEY` material appears in the tree.

## Tests

```
node --test
```

Covers the pure `computeRedirect(flow, search)` helper (whitelisting, duplicates,
missing params, encoding, fixed destination), the `run()` flow with fake window objects
(history cleared before `replace`, no echoing of values), and static hardening checks
(CNAME, `.nojekyll`, CSP, referrer meta, no external URLs or inline scripts).

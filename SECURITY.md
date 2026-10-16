# Security and privacy

## Boundaries

The public repository and GitHub Pages host contain code, documentation, synthetic
examples, the configured public domain, and Tesla's intentionally public signing
key. They must never contain private account or vehicle data. The published domain
and GitHub owner are intentional public deployment configuration, not anonymized
placeholders. A domain may identify its owner; using this repo is not anonymous.

The normal toolkit and owner-login flow are read-only. They request only Vehicle
Information plus offline access. The separate partner-onboarding helper uses app
credentials for partner registration, not vehicle control. The app registration may
allow other capabilities, but the toolkit does not request or exercise them. The Fleet client has a fixed host and a narrow endpoint allowlist; it has no
arbitrary-URL, command, wake, location, polling, or telemetry-configuration interface.

## Local sensitive data

`.local/` is excluded from git and contains credentials, tokens, the private signing
key, historical setup/test responses, current/previous normalized snapshots, and a
random private fingerprint key. All of it is sensitive, including records without
VINs. Git-ignore is not encryption. File permissions protect against other local
users, not malware running as the same user, backups, or an unlocked account.

New writes use owner-only directory/file permissions. Do not sync this directory to
public storage, paste its files into chat, or attach it to an issue. The private key
and credentials cannot be recovered by cloning the public repo. Back them up only
to a suitable secret manager or encrypted private backup.

Normal CLI output omits vehicle names, VINs, numeric IDs, location, access/refresh
tokens, client credentials, and private identity fingerprints. It also ignores
unknown upstream fields instead of dumping API response objects. Charge levels,
states, and timing can still be private. Treat real output as private even with
ordinal vehicle labels. Use `demo` output for public examples.

## Token lifecycle

Access tokens are used only in Authorization headers to the fixed Fleet API host.
Refresh tokens are sent only to Tesla's fixed token endpoint. Refresh responses are
saved atomically, including the new refresh token. Do not keep using the old one.
Concurrent clients coordinate rotation with a local lock. Run one interactive
login at a time, and avoid login during active API operations: the OAuth login
helper is a separate flow, not a refresh worker.

If a process dies during token renewal, or Tesla may have rotated a token that
could not be saved, the refresh lock deliberately blocks another exchange of the
old token. Do not blindly delete it or retry the old refresh token. Confirm that no
Zappy process is still using the lock, reauthorize with `npm run login`, and only
then remove only its `exchange-started` and `poisoned` marker files if present,
remove the empty `.local/.fleet-refresh.lock` directory, and restart clients.
A fresh login writes a new token pair; merely deleting the lock does not repair a
lost refresh token. In-process poison intentionally lasts until that process exits.

## Before publishing

```sh
npm run check
git diff --cached --stat
git diff --cached
```

`privacy` checks the working-tree files git would publish, including tracked files
that happen to match `.gitignore`. It rejects common token/private-key formats and
private runtime paths. When local runtime JSON is present, it also looks for exact
known private account, token, and vehicle identifiers in publishable files,
including numeric IDs converted to strings. Findings
print filenames and categories, never matched values. Synthetic VIN-shaped fixtures
are allowed under `test/`, but exact known local VINs are checked there too.

CI uses no credentials and only synthetic tests. Consequently its privacy scan
cannot know a developer's local PII. The audit is not a formal guarantee: arbitrary
PII, screenshots, binary files, transforms, staging/worktree differences, and git
history need human review. Do not publish a staged version different from what you
audited. Do not put private data in filenames. No production response should be used
as a test fixture, even after casually deleting its VIN field.

## Incident response

If a secret is published, delete it from the working tree **and rotate/revoke it**.
Deleting a file or rewriting history does not make a previously exposed secret safe.
Review the commit history and Pages output, and revoke app access from Tesla account
security if needed. Replacing a registered signing key may require partner
registration updates and vehicle re-pairing; do not rotate it casually.

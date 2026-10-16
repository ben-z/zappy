# Zappy dashboard

A private local web dashboard for the read-only toolkit. The public repository
contains the UI and synthetic examples, not your telemetry. GitHub Pages remains
the public OAuth-key/callback host; it does not serve the live dashboard backend.

## Start

Requires Node.js 22+ and the existing local Tesla authorization files.

```sh
npm run dashboard
# Open http://localhost:8766/
```

No live vehicle reads happen just because you open or reload the page. Click
**Refresh garage** to fetch a vehicle list and charging information for online
vehicles. The latest response is cached in the server process until the next manual
refresh; it is not a continuously updating stream. Restarting the server clears
that cache. Stop the server with Ctrl-C.

### Startup messages

Running `npm run dashboard` again recognizes an existing Zappy instance on the same
port, prints its URL, and exits successfully instead of hiding the cause behind a
generic failure. It does not start or stop another server. If you changed backend
code, stop the old instance before starting the updated one.

If a different service or a different Zappy mode occupies the port, the command
says so and suggests an explicit alternative, for example:

```sh
npm run dashboard -- --port 8768
```

Permission and networking failures also show the bind address and a useful next
step, without exposing raw errors or provider responses. The `/api/health` route
only identifies the local dashboard and mode; it does not read Tesla or return
credentials, CSRF tokens, or vehicle data.

If authorization expires, the existing Fleet client attempts safe token renewal.
If owner consent is missing or revoked, run `npm run login` in another terminal.
Stop active refresh operations before reauthorizing; see [token recovery](../SECURITY.md).

For a completely offline, shareable preview:

```sh
npm run dashboard:demo
# Open http://localhost:8767/
```

Demo mode has an explicit synthetic-data label, requires no credentials, and does
not call Tesla. Demo snapshot comparisons are in memory only. Do not use live-mode
screenshots as public examples even though the UI hides direct identifiers.

## What it does

- **Garage overview:** compact ordinal vehicle cards with battery state, charge
  limit, reported power, range estimate, and charging status. All values are cached
  and labelled with their fetch time, not advertised as a continuously live feed. Asleep/offline cars do not receive
  a live-data call and have unavailable charge fields rather than invented values.
- **Charging estimate:** an optional, collapsed offline calculator. Current charge,
  capacity, input power, and optional price start blank. No estimate is shown until
  sufficient assumptions are entered. Using a selected cached battery percentage
  does not infer capacity, input power, or tariff. Model details are expandable.
- **Snapshots:** an optional collapsed tool to capture the selected vehicle's normalized private snapshot and
  compare it with the previous snapshot for that ordinal. Real records remain in
  `.local/snapshots/`; keyed private fingerprints prevent cross-vehicle comparisons
  when list order changes. The UI does not show the fingerprint or any VIN.
- **Privacy:** no external fonts, images, scripts, analytics, browser persistence,
  geolocation, polling, car wakes, or vehicle commands. Unknown upstream fields and
  raw error payloads are not sent to the browser.

The normal UI uses no vehicle names, VINs, numeric API IDs, or location. Ordinals
are list positions, not persistent identities. Battery level, power, and timing can
still be sensitive: a private dashboard is not anonymized data suitable for publication.

## Live request budget

- Opening the UI and fetching its bootstrap/cache: **zero Tesla requests**.
- Refresh garage: **one list request**, then **at most one charge-state read per
  online vehicle**, capped at 20 vehicles. Token refresh and the client's bounded
  401 retry may add requests.
- Capture snapshot: **one list request** and **at most one charge-state read for
  the selected online vehicle**. The comparison is offline.
- Charging lab: **zero requests**, all math runs in the browser.

Live reads may incur Fleet API charges and can affect sleep behavior. A short
server-side cooldown and in-flight request protection reduce accidental repeated
clicks; they are not an authoritative billing limit or authentication system.

## Local security model

The server binds only to `127.0.0.1`, checks the Host against its actual port,
serves only explicitly allowlisted UI assets, and rejects cross-origin mutations.
Manual read/capture actions require a random per-process anti-CSRF token plus the
same-origin request header. Responses use no-store, no-referrer, no-sniff, and a
restrictive Content Security Policy. There is no arbitrary file/URL proxy route.

This is not a multi-user web application. Other software running as your user can
still access local files and may be able to interact with the loopback service.
Do not bind it to `0.0.0.0`, port-forward it, put it behind a public tunnel, or publish
its responses. A remotely accessible dashboard needs real authentication, TLS,
per-user authorization, and a separate review.

## Model limitations

The charging planner assumes constant usable capacity, sustained input power,
efficiency, and price. It omits taper, conditioning, cold weather, auxiliary loads,
load sharing, degradation, tariff-boundary changes, and session fees. Time estimates
are not a guarantee that a car will reach a target before departure. Snapshot changes
do not establish battery health, efficiency, or idle drain without additional context.

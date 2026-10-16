# Useful things to do with Zappy

All numbers in these examples are synthetic. No account, vehicle name, VIN,
location, identifier, token, or captured response is included. The public site
is a static OAuth callback host, not a dashboard for personal telemetry.

## 1. A quick charging check

```sh
npm run zappy -- vehicles
npm run zappy -- status --vehicle 1
```

Use this to answer: how much battery remains, is the car actually charging,
what charge limit is set, and what power does the car report?

The CLI uses ordinal labels such as `vehicle-1`, not your vehicle names or VINs.
An ordinal is only an index in the current list, not a permanent vehicle ID.
Recheck the list before selecting a vehicle if your account has changed.

Network budget: `vehicles` makes one list request. `status` makes one list
request plus at most one live `charge_state` request, only if the car is online.
A 401 can cause one token refresh and one retry. No wake requests are sent.
Even read-only requests can cost money or affect a vehicle's sleep behavior.
There is no background polling, cron, or monitoring installed by this project.

## 2. Estimate whether a charging window is enough

```sh
npm run zappy -- plan --current 40 --target 80 \
  --capacity-kwh 75 --power-kw 7.2 --efficiency 0.9 --price-per-kwh 0.25
```

This example adds 30 kWh to the battery, draws approximately 33.33 kWh
from the grid, takes approximately 4.63 hours, and costs approximately 8.33
in the currency of your supplied per-kWh price. It is completely offline.

The model is deliberately simple:

```
battery energy = usable capacity * (target percent - current percent) / 100
grid energy    = battery energy / charging efficiency
time           = grid energy / input power
cost           = grid energy * price per kWh
```

Use your own estimate of **usable** battery capacity and sustained input power.
Zappy does not infer capacity from a VIN, trim, or API range estimate. The API's
reported charger power is not automatically treated as wall input power.

Where this model is wrong: it assumes constant capacity, efficiency, power,
and price. Charge taper, battery conditioning, cabin heating, cold weather,
load-sharing, battery degradation, time-of-use tariff boundaries, and demand or
session fees are not modeled. This is not a prediction of your vehicle's exact
finish time and it cannot guarantee readiness at a departure time.

## 3. Compare two moments without publishing a driving diary

```sh
npm run zappy -- snapshot --vehicle 1
# Later, manually take another snapshot when you actually need it:
npm run zappy -- snapshot --vehicle 1
npm run zappy -- compare --vehicle 1
```

Only allowlisted charging fields are persisted under `.local/snapshots/`.
Snapshots have owner-only permissions and retain only current and previous
records per ordinal. The comparison itself is offline. A local keyed fingerprint
prevents silently comparing two different vehicles after the list order changes;
that fingerprint is never printed or exported as normal command output.

Differences can reveal a changed charge limit, a charging session that finished,
or a battery percentage change. They **cannot establish vampire drain or battery
health**: driving, charging, temperature, rounding, and elapsed time are confounders.

The outputs still contain sensitive operational information such as charge level
and timing. Removing direct identifiers does not make telemetry anonymous.
Do not commit outputs or upload them to a public dashboard.

## 4. Prototype a private dashboard without touching a real car

```sh
npm run demo
npm run zappy -- demo --json
```

Demo mode is synthetic, offline, and does not read credentials or token files.
Use it for screenshots, examples, UI prototypes, and tests. Do not substitute
real output into a public README, issue, action log, Pages file, or screenshot.

## Safe next experiments (not implemented or enabled)

- **Private readiness reminders:** notify locally when a user-specified target
  is missed, without automatically starting charging or waking a sleeping car.
- **Solar-aware suggestions:** combine private home-energy readings with a tariff
  model, initially suggesting charging windows rather than issuing commands.
  This requires additional owner consent and energy API support.
- **Streaming instead of polling:** a private Fleet Telemetry receiver can provide
  efficient event-driven history. It requires server infrastructure, TLS, vehicle
  setup, and explicit field selection. Leave location and VINs out of public logs.
- **Budget visibility:** inspect Tesla's Billing & Usage page. Do not mistake a
  local request counter for an authoritative invoice or hard spending limit.

No climate, unlock, remote-start, charging-control, vehicle-pairing, telemetry
configuration, or location collection is performed by the new toolkit commands.
Those are separate projects requiring explicit consent and safety review.

## Official references

- [Vehicle endpoints and live-data polling warning](https://developer.tesla.com/docs/fleet-api/endpoints/vehicle-endpoints)
- [Token exchange and refresh-token rotation](https://developer.tesla.com/docs/fleet-api/authentication/third-party-tokens)
- [Billing, discounts, and limits](https://developer.tesla.com/docs/fleet-api/billing-and-limits)
- [Fleet Telemetry overview](https://developer.tesla.com/docs/fleet-api/fleet-telemetry)

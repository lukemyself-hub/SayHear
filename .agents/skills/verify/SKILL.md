---
name: verify
description: Drive the real SayHear Internal Portal in an isolated local Next.js and PostgreSQL instance, capture browser and persistence evidence, and report unverified user paths. Use after Portal changes or when proving conversation, Journal, or Inspector behavior.
---

# Verify SayHear

Read [the feature map](features/README.md), then the feature being checked.
Run commands from the repository root. This is the Internal Core Web driver;
database CLIs and HTTP inspection endpoints are secondary surfaces. Voice, hosted
Workflow delivery, production promotion, and model quality need separate evidence.

## Launch

Requirements: Node 24.18.0, pnpm 11.9.0, installed workspace dependencies,
PostgreSQL server tools (`initdb`, `pg_ctl`, `createdb`, `psql`), `lsof` on macOS
for orphan-process ownership checks, and an existing Playwright installation with Chromium. No new repository dependency is needed.

```sh
node scripts/check-runtime.mjs
# Only if dependencies are absent:
CI=true pnpm install --frozen-lockfile
VERIFY_RUN="verify-$(date +%Y%m%d-%H%M%S)"
node scripts/verify-control.mjs launch "$VERIFY_RUN"
```

The helper uses the repository's `next dev` entrypoint on loopback with a random
port. It copies current source and installed dependencies into a fresh temporary
directory, preserving pnpm links. Next telemetry is disabled and debug flush is
synchronous, preventing a detached exit process from recreating scratch state.
It excludes `.env*`, `.next`, `.vercel`, and
release run artifacts, and allowlists child environment variables. Editing the
checkout does not update the copy: relaunch after edits. Never double-drive one
run ID. Separate IDs have separate source copies, ports, data, and browser contexts.

From an empty PostgreSQL cluster it creates separate `business` and `marker`
databases, runs both migration sets, provisions one synthetic Owner, and creates a
database session through the existing auth adapter. A synthetic backup-policy row
opens writes for this disposable fixture only; it asserts no external backup.
There are initially no conversation, Journal, Reflection, or Candidate records.

The runtime uses `SAYHEAR_DEPLOYMENT=test`, a fixed clock at
`2026-07-27T16:00:00Z`, the existing deterministic Provider adapter, and closed
Episode/Reflection switches. It introduces no app endpoint or production bypass.
GitHub credentials are inert synthetic values. This session fixture skips OAuth;
it does not establish authentication acceptance.

Ready means launch exits 0 after migrations, anonymous API denial, authenticated
access with writes allowed, and the real `/internal` composer rendered. A Next
`Ready` log alone is insufficient. Failure cleans up the owned instance and keeps
logs. On a sandboxed macOS host, PostgreSQL shared memory, browser launch, `ps`,
and process teardown may require the host's approved execution path. Do not alter
product guards to make sandbox restrictions disappear.

Set `SAYHEAR_VERIFY_PG_BIN` to the server-tool directory if it is not on PATH;
the helper also detects Homebrew PostgreSQL 18/17/16.

## Doctor

```sh
node scripts/verify-control.mjs doctor "$VERIFY_RUN"
```

This read-only check verifies the recorded Next PID/start time, unchanged Git
HEAD, anonymous 401, authenticated 200 with writes allowed, composer presence,
and migration counts in both databases. It saves `doctor.json`. The recorded
`sourceStatus` describes the checkout at launch; uncommitted edits are included in
the copied source. Run doctor before driving and whenever behavior looks wrong.
It cannot prove live OAuth, production pins, or hosted health.

## Drive

```sh
# Set these only if the default installed browser/runtime cannot be found:
# SAYHEAR_VERIFY_PLAYWRIGHT = absolute path to playwright-core/index.mjs
# SAYHEAR_CHROME = absolute path to a Chromium executable
node scripts/verify-control.mjs drive "$VERIFY_RUN" text
```

The browser helper uses a fresh Playwright context, 1440×900 viewport,
America/Los_Angeles timezone, and real route navigation, labels, and buttons.
`SAYHEAR_VERIFY_PLAYWRIGHT` defaults to the existing OpenClaw runtime at
`/opt/homebrew/lib/node_modules/openclaw/node_modules/playwright-core/index.mjs`.
Use an already installed equivalent on other hosts. `SAYHEAR_CHROME` overrides
Playwright's browser lookup; the local proof used cached Chromium headless shell.

| Command suffix | Executed journey | Coverage limit |
| --- | --- | --- |
| `access` | Root redirect to GitHub sign-in; anonymous access API denial | Does not complete OAuth |
| `text` | Send via button, clear composer, receive reply, reload, verify canonical rows, open date URL, return to current chat | Requires a fresh empty conversation; no past-date navigation fixture |
| `journal` | Navigate to Journal and observe the real empty state | No published Journal; delivery/copy/export remain unverified |
| `context` | Navigate through 检查工具 to Context Inspector | Entry only; no sensitive read acceptance |
| `reflection` | Open Reflection Inspector and its separate Evidence verification control | Entry only; no generated Reflection |

Each suffix runs the doctor first. A failed drive cleans up the instance.
The `text` journey does not send through test endpoints or internal setters;
fixture setup is limited to infrastructure, authentication, and backup policy.
The real composer calls the existing response endpoint and consumes its NDJSON.
Browser requests outside this instance are blocked and recorded. Unexpected
requests make the proof fail. Auth.js's sign-in page requests its public GitHub
icon from `https://authjs.dev/img/providers/github.svg`; the access journey permits
that recorded attempt while still blocking it. No OAuth navigation is performed.
This observes browser traffic only; it is not a server-egress audit.

For mapped behaviors outside the canned journeys, use the Playwright setup in
`scripts/verify-browser.mjs` and the feature file's real handles. Add a bounded
journey to the driver when needed; do not substitute a convenient entry point for
one listed in the map. A missing seed precondition is an explicit failed/unmet
journey, not a pass inferred from another path.

## Evidence

Evidence survives at `artifacts/verify/<run-id>/` (gitignored). Record which
journey and entry point ran, its action and result, and remaining paths. The
helper produces action logs, request/response bodies, ARIA snapshots, screenshots,
Playwright trace ZIPs, result JSON, doctor JSON, and instance/server logs. The text
journey also writes canonical stored rows read independently through `psql`.

Require the real user action and resulting state, not just a final screen. For a
mutation, reload and independently verify persistence/side effects. Synthetic
fixtures and the existing Provider port are the only stand-ins here. Do not inject
message/Journal/Reflection rows to turn a generation journey green. Do not collect
private Owner conversations in screenshots or formal acceptance artifacts.

`instance.json` and traces contain disposable session material; do not publish
them indiscriminately. Screenshots and response captures contain synthetic text.
The existing `scripts/portal-visual-acceptance.mjs` is supplementary layout evidence
from mirrored DOM, not evidence that the actual app route works.

This local stack substitutes a fresh cluster, synthetic Owner/session/backup
evidence, fixed clock, deterministic Provider, and local Next dev for the real
target. OAuth provisioning/callbacks, actual backup/PITR configuration, live
Provider transport/quality, G1 activation/pins, production build, and hosted
Workflow dispatch remain unverified until exercised on the appropriate isolated
target. The default dev server also logs existing Edge Instrumentation errors for
Node built-ins imported via `runtime-config`; preserve `next.log` and do not claim
clean instrumentation or production-build acceptance from passing UI journeys.
Run the Node runtime check directly: on this host `pnpm check:runtime` attempted
an automatic dependency reinstall and stopped for lack of a TTY.
Keep [ADR-0138](../../../docs/adr/0138-1a3b-formal-acceptance-uses-synthetic-data.md),
[ADR-0144](../../../docs/adr/0144-g1-hosted-acceptance-isolated-from-production.md),
and [ADR-0148](../../../docs/adr/0148-deployment-identity-config-authorization-and-acceptance-are-separate.md)
in force; this driver is not a release gate waiver.

## Cleanup

```sh
node scripts/verify-control.mjs cleanup "$VERIFY_RUN"
```

Cleanup terminates only the recorded Next process group after checking its start
time. If the leader has exited, cleanup checks every remaining member's working
directory against the owned scratch directory before stopping that group. It
waits for that entire group to exit, stops the PostgreSQL cluster whose data
path matches `postmaster.pid`, and
removes its scratch directory. It never kills by process name or touches the
checkout's `.next`, existing instances, or external databases. Repeating cleanup
is safe. `cleanup.json` and all proof remain under `artifacts/verify/<run-id>/`.
After success or failure, confirm `scratchRemoved: true` and that the evidence
files still exist. If a run is interrupted, use its saved run ID for cleanup.

## Helpers

- `node scripts/verify-control.mjs launch|doctor|drive|cleanup <run-id>` owns lifecycle.
- `scripts/verify-fixture.mjs` is invoked by launch through `node --import tsx`;
  it validates the loopback targets before migration/seeding. Do not run it
  against an existing profile.
- `scripts/verify-browser.mjs` is invoked by `drive`; its third argument selects
  `access`, `text`, `journal`, `context`, or `reflection`.

All helpers are executable. Keep the map and driver aligned with route changes;
use `/maintain-verification-skill` for a source-and-live audit.

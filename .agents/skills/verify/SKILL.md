---
name: verify
description: Drive the real SayHear Internal Portal in an isolated local Next.js and PostgreSQL instance, capture browser and persistence evidence, and report unverified user paths. Use after Portal changes or when proving conversation, Journal delivery, Inspector, real GitHub OAuth, or live Provider behavior.
---

# Verify SayHear

Read [the feature map](features/README.md), then the feature being checked.
Run commands from the repository root. This is the Internal Core Web driver;
database CLIs and HTTP inspection endpoints are secondary surfaces. Voice, hosted
Workflow delivery, Episode and Reflection generation, production promotion, and
model quality need separate evidence; [Hosted target](#hosted-target) lists what
that takes.

## Launch

Requirements: Node 24.18.0, pnpm 11.9.0, installed workspace dependencies,
PostgreSQL server tools (`initdb`, `pg_ctl`, `createdb`, `psql`), `lsof` on macOS
for orphan-process ownership checks, and an existing Playwright installation with Chromium. No new repository dependency is needed.

```sh
node scripts/check-runtime.mjs
# Only if dependencies are absent:
CI=true pnpm install --frozen-lockfile
VERIFY_RUN="verify-$(date +%Y%m%d-%H%M%S)"
node scripts/verify-control.mjs launch "$VERIFY_RUN"            # profile: local
node scripts/verify-control.mjs launch "$VERIFY_RUN" <profile>  # see Profiles
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

Every profile uses `SAYHEAR_DEPLOYMENT=test` and closed Episode/Reflection
switches. It introduces no app endpoint or production bypass.

### Profiles

A profile names what stands in for the real target. `local` is the baseline; the
other rows show which stand-ins each profile replaces with the real thing. `doctor.json` and every
result JSON record the profile, so a proof states which stand-ins it ran on.

| Profile | Clock | Provider | GitHub OAuth | Session | Owner mapping |
| --- | --- | --- | --- | --- | --- |
| `local` | fixed `2026-07-27T16:00:00Z` | deterministic adapter | inert synthetic client | database-session fixture | synthetic subject |
| `live` | real, 60 s inactivity window | deterministic adapter | inert | fixture | synthetic |
| `provider` | real, 60 s inactivity window | OpenCode Go, default model | inert | fixture | synthetic |
| `timeline` | test-only file clock, 60 s inactivity window | deterministic adapter | inert | fixture | synthetic |
| `fault` | test-only file clock, 60 s inactivity window | deterministic adapter with a file-driven chunk ceiling | inert | fixture | synthetic |
| `oauth` | real | deterministic adapter | real client from the `.env` profile | none; sign in | the configured Owner subject |
| `oauth-stranger` | real | deterministic adapter | real client | none | synthetic, so the GitHub account signing in is not the Owner |

`timeline` and `fault` are test-only seams, both refused outside
`SAYHEAR_DEPLOYMENT=test`. The driver rewrites a clock file between requests and
`loadRuntimeConfiguration` re-reads it per request, so one instance can produce
two logical dates without editing session rows. `fault` additionally names a
fault file: a missing or empty file means no fault, a non-negative integer is the
chunk ceiling where the deterministic stream fails. The driver toggles it between
the interrupted send and the retry. These replace `SAYHEAR_TEST_NOW` and
`SAYHEAR_TEST_PROVIDER_FAIL_AFTER_CHUNKS` for a run; the static variables stay
the launch fallback.

Real credentials come from an env profile file you name; nothing is defaulted.
Launch reads the single variables it needs and passes them to the child
processes only. They never reach `instance.json` or the evidence directory.

```sh
# oauth, oauth-stranger: reads NEXTAUTH_URL, GITHUB_CLIENT_ID, GITHUB_CLIENT_SECRET,
# and for oauth SAYHEAR_INTERNAL_OWNER_SUBJECT.
export SAYHEAR_VERIFY_OAUTH_ENV=/absolute/path/to/.env
# provider: reads OPENCODE_GO_API_KEY. Every reply and Journal is a paid call.
export SAYHEAR_VERIFY_PROVIDER_ENV=/absolute/path/to/.env.neon
```

The two files are the separate profiles of
[local-environment.md](../../../docs/agents/local-environment.md). The OAuth
profiles serve on that file's `NEXTAUTH_URL` origin, because the GitHub OAuth app
registers one callback. Launch refuses when that port is taken. A `provider`
run spends real Provider budget: read the current budget ruling before launch and
record the stored token counts afterwards. A fixture session skips OAuth and
does not establish authentication acceptance.

Ready means launch exits 0 after migrations, anonymous API denial, authenticated
access with writes allowed, and the real `/internal` composer rendered. A Next
`Ready` log alone is insufficient. Failure cleans up the owned instance and keeps
logs. On a sandboxed macOS host, PostgreSQL shared memory, browser launch, `ps`,
and process teardown may require the host's approved execution path. Do not alter
product guards to make sandbox restrictions disappear.

Set `SAYHEAR_VERIFY_PG_BIN` to the server-tool directory if it is not on PATH;
the helper also detects Homebrew PostgreSQL 18/17/16. With no locale in the
environment the helper sets `LC_ALL=C`, which the macOS postmaster needs to start.

## Doctor

```sh
node scripts/verify-control.mjs doctor "$VERIFY_RUN"
```

This read-only check verifies the recorded Next PID/start time, unchanged Git
HEAD, anonymous 401, and migration counts in both databases. With a fixture
session it also requires authenticated 200 with writes allowed and the composer.
In the OAuth profiles it requires the sign-in POST to redirect to GitHub's
authorize endpoint with this instance's callback; it sends nothing to GitHub. It
saves `doctor.json`. The recorded
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
Playwright's browser lookup. Set it when that Playwright version expects a
browser build the cache lacks, for example to the cached
`chromium-*/chrome-mac-arm64/Google Chrome for Testing.app` binary.

| Command suffix | Profiles | Executed journey | Coverage limit |
| --- | --- | --- | --- |
| `access` | any | Root redirect to GitHub sign-in; anonymous access API denial | Does not complete OAuth |
| `text` | `local`, `live`, `provider` | Send via button, clear composer, receive reply, reload, verify canonical rows and the stored model run attempt, open date URL, return to current chat | Fresh empty conversation. On `provider` it proves one live reply's transport, rendering and persistence, not quality |
| `keyboard` | `local`, `live`, `timeline`, `fault` | Shift+Enter inserts one newline with no request; a browser-level IME composition blocks Enter; one Enter sends exactly one request and commits the multiline text | The IME is emulated through CDP `Input.imeSetComposition`; a real OS IME stays human-pending |
| `history` | `local`, `live`, `timeline`, `fault` | 28 composer exchanges exceed the 50-message window; the bounded window is exact, 回到最新 restores follow, 加载更早消息 prepends the rest without duplicates or a moved reading position | Fresh instance, deterministic Provider |
| `interruption` | `fault` | A one-chunk fault interrupts a real reply; read-only history only guides to the current chat; `Retry response` recovers once; the exact retry request replays idempotently | Deterministic fault and controlled clock, not a real Provider or network interruption |
| `cross-date` | `timeline`, `fault` | Two controlled-clock dates each publish their own Journal; date entry, URL, 复制, 导出 and 查看当天聊天 verified per date | Driver-run scans and local Workflow runtime; a real midnight crossing stays unverified; all three 2026-10-13 attempts lost the #340 deadlock at a Journal publication |
| `journal` | fixture session | Navigate to Journal and observe the real empty state | Empty launch only |
| `delivery` | `live`, `provider` | Send substantive text, stay idle past the inactivity window, run the scheduled scan, read the published Journal, reload, date entries, 复制, 导出, 查看当天聊天 | Fresh instance. Shortened window, driver-run scan and local Workflow runtime stand in for the hosted schedule |
| `context` | fixture session | Navigate through 检查工具 to Context Inspector | Entry only |
| `context-trace` | fixture session, after `text` or `delivery` | Follow 查看 context, repeat by typed lookup, compare the Provider shown with the stored attempt, then require the exact-content endpoint to deny and audit | Denial only; an allowed read needs `oauth` |
| `reflection` | fixture session | Open Reflection Inspector and its separate Evidence verification control | Entry only; no generated Reflection |
| `signout` | fixture session, last | Sign out through Auth.js's page; require 401, no session row, and sign-in on return | Ends the run's only session |
| `oauth-manual` | `oauth`, `oauth-stranger` | The same Owner and stranger checks with no driven browser: a person acts in their own browser and the driver confirms each step from the database and `next.log` | No screenshots or network capture; proves server-side outcomes only |
| `oauth` | `oauth`, `oauth-stranger` | Real GitHub sign-in in a visible window. Owner: composer, one Owner session, denied read, Evidence verification roundtrip, allowed read, two audit rows, sign-out. Stranger: refusal, no session, mapping unchanged | A person completes GitHub's pages. No Reflection excerpt expansion |

Each suffix runs the doctor first and refuses a profile that lacks the stand-ins
it needs. A failed drive cleans up the instance. `delivery` keeps polling when a
scan returns a non-200 status and reports the count as `failedScans`.

Google's sign-in refuses any automated browser ("This browser or app may not be
secure"), so an account that reaches GitHub through Google cannot complete
`oauth`. Use `oauth-manual` for it: the journey prints each step to stderr with
the exact URL, waits up to ten minutes per step, and passes only on the stored
session, grant and audit rows and the logged callback. Relay its prompts to the
person; the sensitive-read URL is known only after their first message.

The `oauth` journey opens a headed browser and waits at each GitHub page: up to
ten minutes for sign-in, and for the Owner up to four minutes for the account
confirmation of the Evidence verification, whose intent expires after five. It
proceeds only after the real `/api/auth/callback/github` response. The driver
acts only on SayHear's own pages. The stranger refusal must carry Auth.js's
`OAuthCreateAccount` error. The manual `oauth-stranger-1` run on 2026-10-13
confirmed that error, zero sessions and one Owner mapping. Owner login, Evidence
verification, allowed reading and sign-out passed separately in `oauth-owner-1`.
Both runs prove server-side results from the database and log; the headed
journey's post-login code and Reflection excerpt expansion remain unverified.
The GitHub session
persists in `~/.sayhear-verify/github-browser-profile`
(`SAYHEAR_VERIFY_BROWSER_PROFILE` overrides it), outside the repository, so a
later run needs no password. This journey records no Playwright trace, since a
trace would capture GitHub's sign-in form; it keeps Auth.js response statuses
without bodies and external hostnames without URLs. Next dev writes the callback's
one-time `code` and `state` to `next.log`; cleanup redacts them, so clean up
before sharing that log.
The `text` journey does not send through test endpoints or internal setters;
fixture setup is limited to infrastructure, authentication, and backup policy.
The real composer calls the existing response endpoint and consumes its NDJSON.
Browser requests outside this instance are blocked and recorded. Unexpected
requests make the proof fail. Auth.js's sign-in page requests its public GitHub
icon from `https://authjs.dev/img/providers/github.svg`; the access journey permits
that recorded attempt while still blocking it. No OAuth navigation is performed.
This observes browser traffic only; it is not a server-egress audit. The `oauth`
journey reaches GitHub, so it allows external requests and records their hostnames.

For mapped behaviors outside the canned journeys, use the Playwright setup in
`scripts/verify-browser.mjs` and the feature file's real handles. Add a bounded
journey to the driver when needed; do not substitute a convenient entry point for
one listed in the map. A missing seed precondition is an explicit failed/unmet
journey, not a pass inferred from another path.

## Evidence

Evidence survives at `artifacts/verify/<run-id>/` (gitignored). Record which
journey and entry point ran, its action and result, and remaining paths. The
helper produces action logs, request/response bodies, ARIA snapshots, screenshots,
Playwright trace ZIPs, result JSON, doctor JSON, and instance/server logs. The
`text`, `delivery`, `context-trace`, `oauth`, `keyboard`, `history`,
`interruption` and `cross-date` journeys also write `*-stored.json` with rows
read independently through `psql`: canonical messages, content-free model run
attempts (Provider, model, tokens, timings), Journal outcomes, outbox events,
scan results, sensitive-access audits, observed key/composition events, retry
turns, and per-date Journal statements.

Require the real user action and resulting state, not just a final screen. For a
mutation, reload and independently verify persistence/side effects. Synthetic
fixtures and the existing Provider port are the only stand-ins here. Do not inject
message/Journal/Reflection rows to turn a generation journey green. Do not collect
private Owner conversations in screenshots or formal acceptance artifacts.

`instance.json` and traces contain disposable session material, including the
instance's scanner secret; do not publish them indiscriminately. Screenshots and response captures contain synthetic text.
The existing `scripts/portal-visual-acceptance.mjs` is supplementary layout evidence
from mirrored DOM, not evidence that the actual app route works.

Every profile substitutes a fresh cluster, synthetic backup evidence, and local
Next dev with its local Workflow runtime for the real target; the profile table
names the rest. Actual backup/PITR configuration, Provider quality, G1
activation/pins, Episode and Reflection generation, production build, and hosted
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

## Hosted target

The isolated acceptance environment of
[ADR-0144](../../../docs/adr/0144-g1-hosted-acceptance-isolated-from-production.md)
is the Vercel project `sayhear-g1-acceptance`, reached through the alias
`sayhear-g1-canary-lukemyself.vercel.app`. It has its own GitHub OAuth app,
business database, Purge Marker database and Provider key. This driver does not
attach to it: the alias sits behind Vercel Authentication, its deployments are
CLI uploads without Git metadata, and its G1 switches and release manifest are
unreadable secrets. Hosted Journal, Episode and Daily/Weekly Reflection journeys
need, in order: the deployed commit read from
`/api/internal/inspection/release-identity` as the signed-in Owner, a decision on
deploying the commit under test there, a person's Vercel and GitHub sign-in, and
the active G1 manifest and pins of that environment. Until then report those
journeys unverified. Driving the same pages in a local profile does not prove
them.

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
- `scripts/verify-browser.mjs` is invoked by `drive`; its `JOURNEYS` table maps
  each suffix to the stand-ins it requires.

All helpers are executable. Keep the map and driver aligned with route changes;
use `/maintain-verification-skill` for a source-and-live audit.

# G1 Pro preflight candidate — non-release diagnostic only

Status: **diagnostic candidate — not release evidence and not activation evidence.**
Created: 2026-10-01.
Scope owner: Luke (adjudication and any production publication).

This directory prepares an isolated evaluation candidate. It does **not** change
any live route, production pin, migration, or model-routing policy. Under
ADR-0058, replay/eval output only recommends; a human must explicitly review and
publish a new versioned Model Routing Policy before any real traffic uses it.
The Pro publication confirmation is still pending, so no real-traffic switch is
authorized here.

## What changed

`pins.json` is a byte-for-byte copy of the current
`eval/continuation-acceptance-1a3b/g1-activation-pins.json`, with exactly one
class of change: the four active G1 model roles request `deepseek-v4-pro` and pin
their snapshot to `deepseek-v4-pro` instead of
`deepseek-v4-flash` / `deepseek-flash`.

Exact changed JSON paths (8 values; verified by deep diff, no other path differs):

| JSON path | Before | After |
| --- | --- | --- |
| `$.roles.episode.build.model` | `deepseek-v4-flash` | `deepseek-v4-pro` |
| `$.roles.episode.build.snapshot` | `deepseek-flash` | `deepseek-v4-pro` |
| `$.roles.reflection.daily.model` | `deepseek-v4-flash` | `deepseek-v4-pro` |
| `$.roles.reflection.daily.snapshot` | `deepseek-flash` | `deepseek-v4-pro` |
| `$.roles.reflection.weekly.model` | `deepseek-v4-flash` | `deepseek-v4-pro` |
| `$.roles.reflection.weekly.snapshot` | `deepseek-flash` | `deepseek-v4-pro` |
| `$.roles.narrative.validate.model` | `deepseek-v4-flash` | `deepseek-v4-pro` |
| `$.roles.narrative.validate.snapshot` | `deepseek-flash` | `deepseek-v4-pro` |

The four roles are exactly the capture role set (`G1_CAPTURE_ROLES` in
`run-validator-capture.ts`).

## What is deliberately preserved (byte-equivalent as data)

- `version` stays `1a3b-f3-pins:v3`; no version or migration edit.
- All `promptVersion`, `schemaVersion`, `policyVersion`, `parameters`,
  `maxTechnicalRetries`, and `fallback` values are unchanged.
- `episode.build` / `reflection.daily` / `reflection.weekly` keep
  `maxOutputTokens: 10000`.
- `narrative.validate` keeps its `maxOutputTokens: 10000` **and** its
  `reasoning: { effort: "low" }` parameter.
- Retired Bio, Open Loop, and Proactive structures are untouched:
  `roles.open_loop.extract`, `roles.bio.write`, `roles.proactive.followup`,
  the `continuation` block (both arms and `allowedDifferenceKeys`), the `bio`
  configurations, and the top-level `validator.configuration` all retain
  `deepseek-v4-flash` / `deepseek-flash`.

## Note on "continuation incumbent"

The `continuation.arms.incumbent` object in this schema (F3Pins in
`protocol.ts`) has an `id` plus Open Loop / Proactive bundle pins only; it has
no `model` or `snapshot` field and never carried one. The incumbent
continuation arm's runtime model/snapshot are derived from the four active role
pins, so the four role changes above are the only model/snapshot change possible
without editing the schema. No field was added, removed, or renamed, and the
`continuation` block is byte-equivalent to the source.

## Before this could ever be published

This candidate is **not** a candidate for release acceptance as-is:

1. **Config version cannot be reused.** Reusing `1a3b-f3-pins:v3` and the
   incumbent role config/rollout/pin versions for a Pro publication would
   collide with the already-accepted v2/v3/v4 incumbent identity. An eventual
   Pro pin needs distinct, versioned per-role configuration, rollout pin, and
   provider-egress policy versions plus a forward migration, like the existing
   v5/v6 pending work described in `docs/plans/g1-activation.md`.
2. **ADR-0140 alias/snapshot decision.** `deepseek-v4-pro` is served as a
   supported model name returning `deepseek-v4-pro`, unlike the mutable
   `deepseek-flash` alias bounded by ADR-0140. An eventual published pin must
   state the explicit alias/snapshot decision and keep runtime fail-closed on a
   returned-snapshot mismatch.
3. **Fresh exact-commit capture.** Any run produced from this candidate is a
   dirty diagnostic preflight. If Pro is approved, all affected Provider,
   validator, precision, F3, hosted, and regression evidence must be re-captured
   on a clean frozen commit with `gitDirty=false` and the final exact pins. This
   directory must not be renamed into evidence for a later commit.

## Probe context (provided by Luke; not re-run here)

A same-key, exact-body paired probe reported:

- `deepseek-flash` and `deepseek-v4-flash`: HTTP 200 with keepalive framing;
  42 bytes captured; request ended in a 45-second timeout.
- `deepseek-v4-pro`: `response.completed` in ~6.222 s, output 20 /
  reasoning 18, returned model `deepseek-v4-pro`.
- Root balances reported 200 / available and the model list supported Pro.

This candidate records the intent only; no Provider call was made while
preparing it.

## Validation performed

- `git diff --no-index` between the source and candidate pins shows only the 8
  model/snapshot line changes above.
- A Node deep diff over both parsed JSON files reports `changedPathCount: 8`
  with exactly the intended paths.
- No test, Provider call, database write, migration, deployment, commit, or push
  was performed.

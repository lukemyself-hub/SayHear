# Conversation Text Champion Baseline (issue #61)

## Status

Captured — evidence artifact for Wayfinder map [#58](https://github.com/lukemyself-hub/SayHear/issues/58).

## TL;DR

- `run/` holds one captured baseline of the configured Conversation Text
  Champion across synthetic English, Chinese, and code-switched multi-turn
  scenarios (`scenarios.json`), produced through the highest authenticated
  Text system seam.
- Everything here is a **non-authoritative eval artifact** (ADR-0020 Initial
  Replay, ADR-0073): synthetic inputs only, disposable isolated schema, no
  product state written.
- `analysis.md` records the observable failure patterns; `run/manifest.json`
  freezes every prompt / Persona / model / locale-pack / Context Compiler /
  policy version the run used.
- Re-run: `tsx scripts/capture-conversation-baseline.ts --out <new-dir>`.

## What the seam covers

The capture drives the production stack end to end:

```
apps/web conversation-response-handler (BFF NDJSON)
  -> ConversationResponseService
  -> Conversation Agent Harness (+ Action Gateway, regenerate_journal catalog)
  -> Context Compiler (context-compiler:v1)
  -> runtime responses-api Provider Egress Port (real Champion)
```

with a disposable isolated PostgreSQL schema for the persistence layer. The
only production pieces absent by design are the outbox dispatcher (Journal /
Evidence / DialogueState / RollingSummary projections never run) and the
Recovery Gate; see `run/manifest.json` limitations.

## Files

| Path | Purpose |
| --- | --- |
| `scenarios.json` | 33 synthetic multi-turn scenarios: 11 situation categories × en / zh / code-switch |
| `run/manifest.json` | Frozen versions, champion config, run metadata, limitations |
| `run/transcripts.json` | Per-turn inputs, assistant outputs, action receipts, mechanical checks, timings |
| `analysis.md` | Observable failure patterns and findings for map #58 decisions |

## Situation categories

`ordinary_sharing`, `hidden_emotion`, `good_news`, `relationship_conflict`,
`uncertainty`, `short_answers`, `refusal`, `topic_change`, `direct_task`,
`high_risk`, `memory_continuity` (cross-day probe with a 26h session gap).

## Re-running

```bash
tsx scripts/capture-conversation-baseline.ts --out eval/conversation-text-baseline/run-2
```

Requires the repository `.env` (`DATABASE_URL`, `SAYHEAR_PROVIDER_ADAPTER`,
the matching Provider API key). Model outputs are sampled, not deterministic;
a re-run with the same frozen inputs and versions is a new sample of the same
baseline, not a diff target. The committed `run/` is the baseline snapshot
referenced by the map.

## Boundaries

- Scenario material is fully fictional; no real private conversation is used
  or reproduced (ADR-0020 Initial Replay ingress rule).
- The harness never writes product state and never reads the business schema
  of `DATABASE_URL`; it creates and drops its own schema.
- High-risk fixtures are synthetic strings in the style of the existing
  minimum evaluation set (`tests/conversation-behavior-evaluation.test.ts`).

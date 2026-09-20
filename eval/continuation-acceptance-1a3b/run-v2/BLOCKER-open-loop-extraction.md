# Blocker: Open Loop targets cannot form with the pinned `open_loop.extract` candidate

Status: **stop condition triggered** (plan §Stop conditions: "A positive case has
no accepted target or no committed segment"; §Extraction and domain setup:
"Abort the case if no expected Loop forms").

Date: 2026-09-17. Candidate under test: `eval/continuation-acceptance-1a3b/pins-v2.json`
role `open_loop.extract` (`deepseek-v4-flash` / `deepseek-flash`, `maxOutputTokens: 700`,
`reasoningEffort: none`, `responseFormat: json_object`, `promptVersion
open-loop-extract:eval:v1`, `maxSemanticRepairs: 0`).

## Observed

Full-pool ON capture over the 28-scene v2 catalog, with the real pinned Provider
and bounded retries (6 per User Event):

- 402 extract attempts, 66 accepted attempts, **0 loops formed in 28/28 scenes**
  (`formedTargetRefs` empty everywhere).
- 336 conditioning failures, **all** `schema_incompatible`
  (`open_loop.extract returned an invalid output schema.`).
- No other failure category; transport, auth, and model-snapshot checks all pass.
- `probe-extract-utterances.ts` over representative utterances shows two modes:
  - utterance carries a time anchor → Provider returns proposals, the validator
    rejects them (`schema_incompatible`);
  - utterance has no time anchor → Provider returns `{"proposals":[],"closures":[]}`.

## Root cause

The frozen Provider schema for `expectedWindow` requires
`{ startAt, endAt, precision, timezone }`
(`isOpenLoopExpectedWindow` in `packages/ai/src/one-a-3b-role-providers.ts`),
but the evaluated instruction only names the `precision` values and never the
field names. The model therefore emits its own vocabulary, for example:

- `{"precision":"range","start":"2026-09-12","end":"2026-09-18"}`
- `{"precision":"date","localDate":"2026-09-18","timeZone":"Asia/Shanghai"}`
- `{"precision":"approximate","earliest":"2026-09-12","latest":"2026-09-26"}`

Every such proposal fails `asOpenLoopExtractOutput` before
`open_loop-admission` ever runs, is classified `invalid_response` /
`schema_incompatible`, and is retried with identical results. Without a time
anchor the model declines to propose at all, so no proposal shape can pass:
the Open Loop lane can never be populated by the pinned configuration.

The raw Provider transcript names the gap itself (saved in
`run-v2/evidence/raw-extract-response.sse`, reasoning channel):

> schema for expectedWindow — we don't know exact fields. We have expectedWindow
> precision must be one of instant, date, range, approximate, unknown. Probably
> expectedWindow is an object with fields like start, end, precision, maybe
> label. Without schema detail, I'll include a reasonable object.

This is a product-path defect, not an eval artifact: the production path
(`runOpenLoopExtractAttempt` → `createRuntimeOneA3bRoleProviders`) uses the same
instruction and the same validator, and `open_loop.extract` has
`maxSemanticRepairs: 0` and no schema alias handling.

## Consequence for issue #207

- Every `positive_open_loop`, loop-form `stateful_suppression`,
  `competing_pool` (loop arm) and `formed_in_current_turn` case is ineligible;
  the sample requirement "≥2 Open Loop segments" cannot be met, so the ON-vs-OFF
  review package cannot be built or published.
- Layer 3 (expression comparison) is also affected: its required
  "treatment-positive segment inputs" for the question expression kind can only
  come from Open Loop targets. A Memory-only expression comparison would not
  evaluate the pinned question expression at all.
- The v2 design caught this because it was the first capture that ran the real
  Provider for extraction (v1 pre-seeded Open Loops).

## Minimal reproduction

```sh
pnpm exec tsx eval/continuation-acceptance-1a3b/probe-extract-utterances.ts
```

## Candidate remedies (decision needed)

1. **Fix the instruction text and version it** (recommended): name the
   `expectedWindow` fields (`startAt`/`endAt` ISO-8601 or `null`, `precision`,
   `timezone` IANA or `null`), state that a window is optional and must be
   omitted rather than invented, then publish it as a new evaluated artifact
   (`open-loop-extract:eval:v2`) and re-run the acceptance evidence for that
   configuration.
2. **Widen the provider validator**: accept the model's observed field aliases
   and normalize them. Smaller prompt change, but adds schema surface and still
   leaves the unanchored-utterance empty behavior unexplained.
3. **Supersede the Open Loop half of the G2 review**: evaluate only Memory,
   suppression, and correct-zero cases. This changes the product scope of
   issue #207 and needs an explicit decision, not an eval-side workaround.

## Evidence gap to close with the fix

The v2 manifest and ledger pin Prompt/Schema/policy *versions* (`pins-v2.json`
labels) but not the *content hash* of the resolved instruction text, which is
hardcoded in `packages/ai/src/one-a-3b-role-providers.ts`. A silent prompt edit
would not change `v2ConfigurationFingerprint`. Any prompt revision should also
add a content fingerprint to the manifest (or register prompts as versioned
artifacts like `prompt-artifacts.ts` does for `conversation.text`).

## Resolution (2026-09-17): three stacked causes, verifier now green

The blocker was recorded when the ON capture formed 0/28 loops. The
final root-cause chain was three independent layers:

1. **Prompt/schema gap (fixed, v2).** The instruction never named the
   `expectedWindow` fields, so the model guessed field names and the
   frozen schema rejected the output (`schema_incompatible`). Fixed by
   naming the four fields and instructing the model to omit the window
   rather than invent one.

2. **Model conservatism (fixed, v3, Luke-approved).** The instruction's
   negative bias ("Never propose ... unfinished topics") made the model
   return `{"proposals":[]}` for loop-worthy utterances. Measured with
   the pinned provider: zh loop utterances 0/5 -> 5/5 after adding one
   positive decision rule, with correct-zero controls unchanged.

3. **Frozen near-term allowlist rejection (fixture-side fix).** Even
   when the model proposed, `planOpenLoopFormation` rejected it with
   `no_real_anchor`: the model set a digit-free `userTimeExpression`
   ("这两周", "next week") *and* a claimed precise window, which SPEC
   6.2 treats as a fabricated date because the phrase is not an exact
   hit on `OPEN_LOOP_NEAR_TERM_LEXICAL_ALLOWLIST_V1`. Fixture phrasings
   now use explicit calendar dates (digits) or allowlisted near-term
   phrases; admission code was not touched.

Also fixed along the way: schedule expiry is `windowEnd + 14 days`
(unanchored: `committedAt + 14 days`), so a `clockAdvanceDays: 14`
reviewed turn landed exactly on the expiry boundary and the lane
filtered the loop. Fixture advances are now 10 days.

Two independent full ON captures (`--concurrency 3`, pins
`open-loop-extract:v3`) formed 10/10 declared loops and passed
`verify-g2-treatment.ts` with 0 failures and 28/28 eligible scenes.
Ledger `formedLoopSchedules` records each formed loop's window,
eligibility instant, and expiry for operator evidence.

---
status: accepted
date: 2026-08-02
---

# DeepSeek joins OpenAI as a Conversation Text Provider in 1A.1

The configured OpenAI account was suspended, so the OpenAI API became completely
unavailable and real-generation acceptance (the bilingual / code-switching
human acceptance behind ADR-0072) could no longer run. DeepSeek's Responses API
is wire-compatible with OpenAI's (`response.output_text.delta`,
`response.completed`, Bearer auth, identical `usage` field names), so a second
Provider can be added at near-zero cost. We add DeepSeek **alongside** OpenAI
rather than replacing it, switch the dev and production default Champion to
`deepseek-v4-flash`, and switch back with a single environment change once the
OpenAI account is restored.

## Decisions

- **Add, not replace.** Rename the OpenAI-specific adapter into one
  provider-agnostic Responses-API protocol client
  (`createResponsesApiConversationTextModel`) that owns the shared SSE parsing,
  timeout, abort, and HTTP-status error categorization. OpenAI and DeepSeek are
  two configurations of that single client (`baseUrl` / `apiKey`); the OpenAI
  bloodline survives as the `provider: "openai"` configuration and
  `SAYHEAR_PROVIDER_ADAPTER=openai`, not as a separate adapter artifact. No
  speculative Provider-divergence extensibility is added — the runtime adapter
  union has one `responses-api` member, not per-Provider literals; if the two
  Responses APIs diverge later, split then.
- **`provider` is widened to `"openai" | "deepseek"`** in `ConversationTextChampion`
  and `GenerationPolicy`. This is backward compatible: persisted
  `provider: "openai"` rows stay valid; no data migration.
- **DeepSeek gets its own `providerPolicyVersion: "deepseek-conversation-text:v1"`**,
  not a reuse of `openai-conversation-text:v1`. The two policies already differ
  subtly (no `[DONE]` sentinel, unsupported parameters silently ignored, only
  `deepseek-v4-flash` available, no image/file input), and the version is frozen
  per `GenerationCommand`, so sharing it would muddle lineage.
- **Default Champion is `deepseek-v4-flash`** in both development and production.
  Internal core has a single Internal Owner and no external users (ADR-0014), so
  changing the production default carries near-zero product risk; a half-switch
  (dev-only) is rejected because "works locally, fails on deploy" is the
  failure mode most likely to bite.

## Relationship to ADR-0019

This is a **narrow exception** to ADR-0019's "1A.1 has one Provider adapter"
clause, not a supersede. ADR-0019's real invariant is preserved: there is still
exactly one configured active Champion at a time, no capability matching, and
**no automatic model or Provider fallback**; switching Providers is an explicit
human configuration change. ADR-0019's roadmap (Role-based Model Registry in
1A.2, Capability Registry / Champion-Challenger / versioned fallback in 1A.4)
still stands. ADR-0019 is annotated as amended by this ADR on the single
adapter-count clause only.

## Considered options

- **Replace OpenAI with DeepSeek** — rejected. The account is suspended, not
  decommissioned; the Provider Egress Port exists precisely so Providers are
  swappable, and replacement would orphan the OpenAI adapter and sever the
  lineage of already-persisted `provider: "openai"` attempts.
- **Dev-only default** — rejected. Leaves a deploy-time trap where the
  production config still points at the unavailable Provider.
- **Selectable-but-not-default** — rejected. Forcing a manual override on every
  local run contradicts the goal of stable acceptance.
- **Reuse `openai-conversation-text:v1`** — rejected. Identical policy today is
  not a reason to share a version string; the version tracks future divergence,
  and divergence has already begun.

## Consequences

- The `provider` literal and `providerPolicyVersion` are now a versioned union
  persisted on every `GenerationCommand`; adding a third Provider later is
  another literal widening plus its own policy version (ADR-0074 lineage).
- Two Provider bloodlines (`openai` + `openai-conversation-text:v1`,
  `deepseek` + `deepseek-conversation-text:v1`) coexist in history. Reporting
  and replay tooling must not assume a single Provider.
- `deepseek-v4-flash` is the only model the DeepSeek Responses API serves, so
  the DeepSeek Champion has no model-selection degree of freedom until DeepSeek
  ships a second model.

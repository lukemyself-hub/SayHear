import { describe, expect, it } from "vitest";

import {
  renderMemorySection,
  type MemorySectionBudgetActual,
  type RetrievalCandidateInspection,
  type RetrievalRunManifest,
} from "@sayhear/application";

import {
  DIALOGUE_STATE_FIELDS,
  humanizeDiagnosticCode,
  injectedMemoryItemCount,
  memorySectionItemsFromSections,
  parseMemorySectionItems,
  retrievalRejectionSummary,
  retrievalSummary,
  safetyPostureLabel,
  sectionVersionLabel,
  type ContextInspectorContext,
  type ContextInspectorPayload,
  type ContextInspectorSection,
} from "../apps/web/app/internal/context-inspector-data";

const context: ContextInspectorContext = {
  dialogueState: {
    content: {
      advice_explicitly_requested: {
        confidence: 0.9,
        sourceRevisionIds: ["revision-1"],
        value: false,
      },
      close_intent: {
        confidence: 0.9,
        sourceRevisionIds: ["revision-1"],
        value: false,
      },
      current_request_requires_focus: {
        confidence: 0.9,
        sourceRevisionIds: ["revision-1"],
        value: true,
      },
      current_topic: {
        confidence: 0.9,
        sourceRevisionIds: ["revision-1"],
        value: "work",
      },
      emotional_intensity: {
        confidence: 0.9,
        sourceRevisionIds: ["revision-1"],
        value: "medium",
      },
      user_willing_to_elaborate: {
        confidence: 0.9,
        sourceRevisionIds: ["revision-1"],
        value: true,
      },
    },
    dialogueRevision: 2,
    policyVersion: "dialogue-state:v2",
    sourceRevision: 2,
    status: "lagging",
  },
  policyVersions: {
    canonicalPersonaVersion: "canonical-persona:v1",
    localePolicyVersion: "locale-pack-en:v1",
    outputFormatVersion: "conversation-output:v1",
    personaBehaviorAnchorsVersion: "persona-behavior-anchors:v1",
    personaContractInvariantVersion: "persona-contract-invariant:v1",
    productPolicyVersion: "product-policy:v1",
    relationshipPolicyVersion: "relationship-boundary:v1",
    safetyPolicyVersion: "minimum-high-risk-response:v1",
    taskInstructionVersion: "task-instruction-decision:v1",
  },
  safetyPosture: {
    posture: {
      content: {
        cleanTurnCount: 0,
        evidence: {
          activatedUserEventRevisionId: "revision-1",
          lastTurnUserEventRevisionId: "revision-1",
        },
        kind: "self_harm",
        releasedBy: null,
        state: "active",
      },
      policyVersion: "safety-posture:v1",
      sourceRevision: 1,
      versionNo: 1,
    },
    state: "active",
  },
};

function section(
  key: ContextInspectorSection["key"],
  reference: string,
): ContextInspectorSection {
  return {
    budgetTokens: null,
    key,
    ordinal: 0,
    reference,
    selectedTokens: 1,
    truncatable: false,
  };
}

describe("Context Inspector data labels", () => {
  it("keeps the six DialogueState v2 fields explicit", () => {
    expect(DIALOGUE_STATE_FIELDS).toEqual([
      "current_topic",
      "emotional_intensity",
      "advice_explicitly_requested",
      "current_request_requires_focus",
      "close_intent",
      "user_willing_to_elaborate",
    ]);
  });

  it("uses pinned policy versions for static sections", () => {
    expect(
      sectionVersionLabel(section("product_policy", "ignored"), context),
    ).toBe("product-policy:v1");
  });

  it("does not expose rendered state content as a section version", () => {
    const renderedDialogueState =
      "DialogueState (current topic: private user content; policy dialogue-state:v2)";
    const renderedSafetyPosture =
      "Safety Posture (policy safety-posture:v1): ACTIVE — support anchor";

    expect(
      sectionVersionLabel(
        section("dialogue_state", renderedDialogueState),
        context,
      ),
    ).toBe("dialogue-state:v2");
    expect(
      sectionVersionLabel(
        section("safety_posture", renderedSafetyPosture),
        context,
      ),
    ).toBe("safety-posture:v1");
    expect(sectionVersionLabel(section("current_user_input", "user text"), context)).toBe(
      "event-revision",
    );
  });
});

describe("Context Inspector memory item parsing (#122)", () => {
  const renderedPortrait = [
    "Person Portrait（用户画像，person_portrait，逐轮重选；条目按记忆引用单独寻址）" +
      " [portrait-selection:v1 | memory-budgets:v1 | recall-framing:v2]" +
      " (section=person_portrait):",
    "- [shh-memory-1] 老家在西安 — kind=objective epistemic=confirmed" +
      " claim=claim-1 version=version-1 evidence=ev-1,ev-2 temporal=current" +
      " valid_from=2026-01-01",
    "  措辞（objective）：这是用户亲口陈述的事实；可以“你之前说过…”的方式来源归属式引用，不得表述为独立核验过的事实。记忆中出现的具体名称（机构、项目、人名、地点）在回复中自然使用该名称，不用泛指代替。",
    "- [shh-memory-2] 重视家庭 — kind=impression epistemic=inferred" +
      " claim=claim-2 version=version-2 evidence=none temporal=ended" +
      " valid_from=2026-01-02 valid_to=2026-06-30",
    "  措辞（impression）：这是你基于多次观察形成的理解，可以自然、朋友式地表达；不得升级成用户亲述或已核验事实，不得固化成永久标签或诊断式身份。记忆中出现的具体名称（机构、项目、人名、地点）在回复中自然使用该名称，不用泛指代替。",
  ].join("\n");

  it("parses every injected item with the exact structured fields the model received", () => {
    const items = parseMemorySectionItems(renderedPortrait);

    expect(items).toEqual([
      {
        claimId: "claim-1",
        claimVersionId: "version-1",
        contextMemoryRef: "shh-memory-1",
        epistemicStatus: "confirmed",
        evidenceIds: ["ev-1", "ev-2"],
        kind: "objective",
        renderedText: "老家在西安",
        temporalStatus: "current",
        validFrom: "2026-01-01",
        validTo: null,
      },
      {
        claimId: "claim-2",
        claimVersionId: "version-2",
        contextMemoryRef: "shh-memory-2",
        epistemicStatus: "inferred",
        evidenceIds: [],
        kind: "impression",
        renderedText: "重视家庭",
        temporalStatus: "ended",
        validFrom: "2026-01-02",
        validTo: "2026-06-30",
      },
    ]);
  });

  it("keeps rendered text that itself contains an em dash intact", () => {
    const items = parseMemorySectionItems(
      [
        "Objective Memory（objective_memory，本轮话题检索命中）" +
          " [portrait-selection:v1 | memory-budgets:v1 | recall-framing:v2]" +
          " (section=objective_memory):",
        "- [shh-memory-1] 喜欢徒步 — 每月一次山里 — kind=objective" +
          " epistemic=confirmed claim=c version=v evidence=none temporal=current",
      ].join("\n"),
    );

    expect(items[0]?.renderedText).toBe("喜欢徒步 — 每月一次山里");
  });

  it("returns no items for a non-memory section reference", () => {
    expect(parseMemorySectionItems("product-policy:v1")).toEqual([]);
    expect(
      parseMemorySectionItems(
        "DialogueState (current topic: private; policy dialogue-state:v2)",
      ),
    ).toEqual([]);
  });

  it("collects injected items per memory section key in compile order", () => {
    const items = memorySectionItemsFromSections([
      section("objective_memory", "product-policy:v1"),
      section("person_portrait", renderedPortrait),
    ]);

    // Every present memory section is listed; a reference without item lines
    // contributes zero items rather than a fabricated injection.
    expect(items.map((entry) => entry.sectionKey)).toEqual([
      "person_portrait",
      "objective_memory",
    ]);
    expect(items[0]?.items).toHaveLength(2);
    expect(items[1]?.items).toEqual([]);
  });

  it("parses the current renderMemorySection output round-trip (format conformance)", () => {
    // If renderMemorySection's line format ever drifts, this fails in CI
    // instead of the panel silently showing zero injected items.
    const items = [
      {
        claimId: "claim-1",
        claimVersionId: "version-1",
        contextMemoryRef: "shh-memory-1",
        renderedText: "老家在西安",
        kind: "objective" as const,
        epistemicStatus: "confirmed" as const,
        temporalStatus: "current" as const,
        validFrom: "2026-01-01",
        validTo: null,
        entityVersionIds: ["entity-version-1"],
        evidenceIds: ["ev-1", "ev-2"],
        recallFramingPolicyVersion: "recall-framing:v2",
        selectionSource: "person_portrait" as const,
        predicateId: "sh.place.hometown",
      },
      {
        claimId: "claim-2",
        claimVersionId: "version-2",
        contextMemoryRef: "shh-memory-2",
        renderedText: "重视家庭 — 每次都提到",
        kind: "impression" as const,
        epistemicStatus: "inferred" as const,
        temporalStatus: "ended" as const,
        validFrom: "2026-01-02",
        validTo: "2026-06-30",
        entityVersionIds: [],
        evidenceIds: [],
        recallFramingPolicyVersion: "recall-framing:v2",
        selectionSource: "query_retrieval" as const,
        predicateId: "sh.value.core_priorities",
      },
    ] as const;

    const rendered = renderMemorySection({
      items,
      key: "person_portrait",
      locale: "zh",
    });
    expect(parseMemorySectionItems(rendered)).toEqual([
      {
        claimId: "claim-1",
        claimVersionId: "version-1",
        contextMemoryRef: "shh-memory-1",
        epistemicStatus: "confirmed",
        evidenceIds: ["ev-1", "ev-2"],
        kind: "objective",
        renderedText: "老家在西安",
        temporalStatus: "current",
        validFrom: "2026-01-01",
        validTo: null,
      },
      {
        claimId: "claim-2",
        claimVersionId: "version-2",
        contextMemoryRef: "shh-memory-2",
        epistemicStatus: "inferred",
        evidenceIds: [],
        kind: "impression",
        renderedText: "重视家庭 — 每次都提到",
        temporalStatus: "ended",
        validFrom: "2026-01-02",
        validTo: "2026-06-30",
      },
    ]);
  });
});

const emptyBudget: MemorySectionBudgetActual = {
  memory_class_total: { actual_items: 0, ceiling_items: 0 },
  person_portrait: {
    actual_impressions: 0,
    actual_items: 0,
    ceiling_impressions: 2,
    ceiling_items: 3,
  },
  query_retrieved: {
    actual_impressions: 0,
    actual_items: 0,
    ceiling_impressions: 2,
    ceiling_items: 3,
  },
};

function manifest(
  degradedReasonCodes: RetrievalRunManifest["degraded_reason_codes"] = [],
  portraitDegradedReasonCodes: RetrievalRunManifest["portrait_degraded_reason_codes"] = [],
): RetrievalRunManifest {
  return {
    candidate_count: 0,
    deadline_exceeded_stage: null,
    deadline_ms: 200,
    degraded_reason_codes: degradedReasonCodes,
    duration_ms: 5,
    fenced_out_count: 0,
    lane_hit_counts: {
      english_fts: 0,
      lexical_term_overlap: 0,
      structured_exact: 0,
    },
    lane_plan: [],
    normalized_query_terms: {
      canonical_keys: [],
      date_tokens: [],
      lexical_terms: [],
      predicate_candidates: [],
      resolved_entities: [],
      time_word_classes: [],
    },
    portrait_degraded_reason_codes: portraitDegradedReasonCodes,
    portrait_selection: { pool_count: 0, selected_claim_version_ids: [] },
    projection_policy_version: "projection:v1",
    qualified_count: 0,
    query_construction_policy_version: "query:v1",
    query_source_refs: [],
    retrieval_policy_version: "retrieval:v1",
    retrieval_run_id: "run-1",
    section_budget_vs_actual: emptyBudget,
    selection_policy_versions: {
      memory_budgets: "memory-budgets:v1",
      portrait_selection: "portrait-selection:v1",
      recall_framing: "recall-framing:v2",
    },
    timings: {},
    zero_signal: true,
  };
}

function payloadWithManifest(
  retrievalManifest: RetrievalRunManifest | null,
): Pick<ContextInspectorPayload, "compiledContext"> {
  return {
    compiledContext: {
      retrievalManifest,
    } as ContextInspectorPayload["compiledContext"],
  };
}

function candidate(
  overrides: Partial<RetrievalCandidateInspection> = {},
): RetrievalCandidateInspection {
  return {
    claimVersionId: "version-1",
    finalRank: null,
    lane: "structured_exact",
    matchedFields: [],
    matchedTerms: [],
    rankComponents: {
      entity_match: 0,
      fts_rank: null,
      last_observed_at: "2026-01-01T00:00:00.000Z",
      lexical_coverage: 0,
      predicate_match: 0,
      stable_id: "claim-1",
      temporal_fit: 0,
      trust_kind: "objective",
    },
    rejectionReasonCodes: [],
    retrievalProjectionId: "projection-1",
    selectedSection: null,
    selectionReasonCodes: [],
    trustFenceResults: [],
    ...overrides,
  };
}

describe("Context Inspector summary helpers (#266)", () => {
  it("labels the three safety-posture states", () => {
    expect(safetyPostureLabel("active")).toBe("Active");
    expect(safetyPostureLabel("released")).toBe("Cleared");
    expect(safetyPostureLabel("default")).toBe("Default");
  });

  it("humanizes known diagnostic codes and passes unknown codes through", () => {
    expect(humanizeDiagnosticCode("retrieval_lane_failed")).toBe(
      "A retrieval lane failed; the round degraded and injected no memory.",
    );
    expect(humanizeDiagnosticCode("selected_person_portrait")).toBe(
      "Selected into the Person Portrait.",
    );
    // Nothing is invented for a code this build does not know.
    expect(humanizeDiagnosticCode("brand_new_code")).toBe("brand_new_code");
  });

  it("classifies the retrieval run as none / completed / degraded", () => {
    expect(retrievalSummary(payloadWithManifest(null)).state).toBe("none");

    const completed = retrievalSummary(payloadWithManifest(manifest()));
    expect(completed.state).toBe("completed");
    expect(completed.degradedReasonCodes).toEqual([]);

    const degraded = retrievalSummary(
      payloadWithManifest(manifest(["retrieval_lane_failed"], ["portrait_load_failed"])),
    );
    expect(degraded.state).toBe("degraded");
    expect(degraded.degradedReasonCodes).toEqual(["retrieval_lane_failed"]);
    expect(degraded.portraitDegradedReasonCodes).toEqual([
      "portrait_load_failed",
    ]);
  });

  it("counts only injected memory items across present memory sections", () => {
    const rendered = [
      "- [shh-memory-1] 老家在西安 — kind=objective epistemic=confirmed claim=c version=v evidence=none temporal=current",
      "- [shh-memory-2] 重视家庭 — kind=impression epistemic=inferred claim=c2 version=v2 evidence=none temporal=ended",
    ].join("\n");
    expect(
      injectedMemoryItemCount([
        section("person_portrait", rendered),
        section("objective_memory", "no item lines here"),
      ]),
    ).toBe(2);
    expect(injectedMemoryItemCount([])).toBe(0);
  });

  it("groups rejection reasons by count and reports uncoded rejections", () => {
    const summary = retrievalRejectionSummary([
      candidate({
        rejectionReasonCodes: ["relevance_cutoff_single_term"],
      }),
      candidate({
        rejectionReasonCodes: [
          "relevance_cutoff_single_term",
          "budget_retrieval_ceiling",
        ],
        retrievalProjectionId: "projection-2",
      }),
      candidate({
        rejectionReasonCodes: [],
        retrievalProjectionId: "projection-3",
      }),
      // Selected candidates never appear in the exclusion summary.
      candidate({
        rejectionReasonCodes: ["relevance_cutoff_single_term"],
        retrievalProjectionId: "projection-4",
        selectedSection: "person_portrait",
      }),
    ]);

    expect(summary.entries).toEqual([
      { code: "relevance_cutoff_single_term", count: 2 },
      { code: "budget_retrieval_ceiling", count: 1 },
    ]);
    expect(summary.uncodedCount).toBe(1);
  });
});

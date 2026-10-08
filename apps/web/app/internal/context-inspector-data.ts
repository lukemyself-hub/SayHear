import type {
  CompiledContextSectionKey,
  ContextPolicyVersions,
  RetrievalCandidateInspection,
  RetrievalRunManifest,
} from "@sayhear/application";

export const DIALOGUE_STATE_FIELDS = [
  "current_topic",
  "emotional_intensity",
  "advice_explicitly_requested",
  "current_request_requires_focus",
  "close_intent",
  "user_willing_to_elaborate",
] as const;

export type DialogueStateField = (typeof DIALOGUE_STATE_FIELDS)[number];

export type ContextInspectorSection = Readonly<{
  budgetTokens: number | null;
  key: CompiledContextSectionKey;
  ordinal: number;
  reference: string;
  selectedTokens: number;
  truncatable: boolean;
}>;

export type ContextInspectorDialogueField = Readonly<{
  confidence: number;
  sourceRevisionIds: readonly string[];
  value: unknown;
}>;

export type ContextInspectorDialogueState = Readonly<{
  content: Readonly<Record<DialogueStateField, ContextInspectorDialogueField>>;
  dialogueRevision: number;
  policyVersion: string;
  sourceRevision: number;
  status: "current" | "lagging";
}>;

export type ContextInspectorSafetyPosture = Readonly<{
  posture: Readonly<{
    content: Readonly<{
      cleanTurnCount: number;
      evidence: Readonly<{
        activatedUserEventRevisionId: string;
        lastTurnUserEventRevisionId: string;
      }>;
      kind: string;
      releasedBy: Readonly<{ userEventRevisionId: string }> | null;
      state: "active" | "released";
    }>;
    policyVersion: string;
    sourceRevision: number;
    versionNo: number;
  }> | null;
  state: "active" | "default" | "released";
}>;

export type ContextInspectorContext = Readonly<{
  dialogueState: ContextInspectorDialogueState | null;
  policyVersions: ContextPolicyVersions;
  safetyPosture: ContextInspectorSafetyPosture;
}>;

export type ContextInspectorPayload = Readonly<{
  attemptStatus: string;
  checkedAt: string;
  commandStatus: string;
  compiledContext: ContextInspectorContext &
    Readonly<{
      compilerVersion: string;
      degradedReason: string | null;
      dialogueRevision: number;
      locale: string;
      retrievalManifest: RetrievalRunManifest | null;
      sectionBudgets: Readonly<{ committedRawEvents: number }>;
      sections: readonly ContextInspectorSection[];
      sourceRevision: number;
      totalTokens: number;
    }>;
  generationCommandId: string;
  model: string;
  provider: string;
  providerPolicyVersion: string;
  retrievalCandidates: readonly RetrievalCandidateInspection[];
}>;

export type ContextInspectorMemoryItem = Readonly<{
  claimId: string;
  claimVersionId: string;
  contextMemoryRef: string;
  epistemicStatus: string;
  evidenceIds: readonly string[];
  kind: string;
  renderedText: string;
  temporalStatus: string;
  validFrom: string | null;
  validTo: string | null;
}>;

export type ContextInspectorMemorySectionItems = Readonly<{
  items: readonly ContextInspectorMemoryItem[];
  sectionKey: CompiledContextSectionKey;
}>;

const MEMORY_ITEM_LINE =
  /^- \[(shh-memory-\d+)\] (.*) — kind=(\S+) epistemic=(\S+) claim=(\S+) version=(\S+) evidence=(\S+) temporal=(\S+)(?: valid_from=(\S+))?(?: valid_to=(\S+))?$/;

/**
 * #122: parses the itemized memory section content — the exact text the model
 * received, persisted verbatim as the section reference — back into its
 * structured `MemoryContextItem` fields. The line format is deterministic per
 * renderMemorySection; anything else (non-memory references, non-item lines)
 * yields no items, so the panel can never fabricate an injection.
 */
export function parseMemorySectionItems(
  reference: string,
): readonly ContextInspectorMemoryItem[] {
  const items: ContextInspectorMemoryItem[] = [];
  for (const line of reference.split("\n")) {
    const match = MEMORY_ITEM_LINE.exec(line.trimEnd());
    if (!match) continue;
    const [
      ,
      contextMemoryRef,
      renderedText,
      kind,
      epistemicStatus,
      claimId,
      claimVersionId,
      evidence,
      temporalStatus,
      validFrom,
      validTo,
    ] = match;
    items.push({
      claimId: claimId!,
      claimVersionId: claimVersionId!,
      contextMemoryRef: contextMemoryRef!,
      epistemicStatus: epistemicStatus!,
      evidenceIds:
        evidence === "none" ? [] : evidence!.split(",").filter(Boolean),
      kind: kind!,
      renderedText: renderedText!,
      temporalStatus: temporalStatus!,
      validFrom: validFrom ?? null,
      validTo: validTo ?? null,
    });
  }
  return items;
}

const MEMORY_SECTION_KEYS_IN_COMPILER_ORDER: readonly CompiledContextSectionKey[] =
  ["person_portrait", "objective_memory", "ai_impression"];

/** Injected items per present memory section, in compiler section order. */
export function memorySectionItemsFromSections(
  sections: readonly ContextInspectorSection[],
): readonly ContextInspectorMemorySectionItems[] {
  return MEMORY_SECTION_KEYS_IN_COMPILER_ORDER.flatMap((sectionKey) => {
    const section = sections.find((candidate) => candidate.key === sectionKey);
    if (!section) return [];
    return [
      {
        items: parseMemorySectionItems(section.reference),
        sectionKey,
      },
    ];
  });
}

export function sectionVersionLabel(
  section: ContextInspectorSection,
  context: ContextInspectorContext,
): string {
  switch (section.key) {
    case "product_policy":
      return context.policyVersions.productPolicyVersion;
    case "safety_policy":
      return context.policyVersions.safetyPolicyVersion;
    case "relationship_boundary":
      return context.policyVersions.relationshipPolicyVersion;
    case "persona_contract_invariant":
      return context.policyVersions.personaContractInvariantVersion;
    case "canonical_persona":
      return context.policyVersions.canonicalPersonaVersion;
    case "persona_behavior_anchors":
      return section.reference;
    case "task_instruction":
      return context.policyVersions.taskInstructionVersion;
    case "output_format":
      return context.policyVersions.outputFormatVersion;
    case "locale_pack":
      return context.policyVersions.localePolicyVersion;
    case "safety_posture":
      return (
        context.safetyPosture.posture?.policyVersion ??
        renderedPolicyVersion(section.reference) ??
        "safety-posture:unavailable"
      );
    case "dialogue_state":
      return (
        context.dialogueState?.policyVersion ??
        renderedPolicyVersion(section.reference) ??
        "dialogue-state:unavailable"
      );
    case "curiosity_stop_signal":
      return (
        renderedPolicyVersion(section.reference) ??
        "curiosity-stop-signal:unavailable"
      );
    case "person_portrait":
    case "objective_memory":
    case "ai_impression":
      // #117: the memory sections pin their strategy versions inside the
      // rendered reference ("[portrait-selection:v1 | memory-budgets:v1 |
      // recall-framing:v2]").
      return (
        section.reference.match(/\[(portrait-selection:[^\]]+)\]/)?.[1] ??
        "memory-selection:unavailable"
      );
    case "recall_experience":
      // #118: the recall experience contract version sits in the rendered
      // content ("[recall-experience-contract:v1]").
      return (
        section.reference.match(/\[(recall-experience-contract:[^\]]+)\]/)
          ?.[1] ?? "recall-experience:unavailable"
      );
    case "trust_action_expression":
      // #119: the P1–P6 trust-action expression contract version sits in the
      // rendered content ("[trust-action-expression-contract:v2]").
      return (
        section.reference.match(
          /\[(trust-action-expression-contract:[^\]]+)\]/,
        )?.[1] ?? "trust-action-expression:unavailable"
      );
    case "rolling_summary":
      return (
        referenceValue(section.reference, ":policy:", ":prompt:") ??
        "rolling-summary:unavailable"
      );
    case "daily_session":
      return (
        referenceValue(section.reference, ":closure:", ":dialogue:") ??
        "daily-session"
      );
    case "action_finalization_receipt":
      return /^receipt:\d+$/.test(section.reference)
        ? section.reference
        : "receipt";
    case "committed_raw_events":
      return "event-revisions";
    case "current_user_input":
      return "event-revision";
    case "recent_conversation_context":
      // #293: the frozen reference pins the selector and policy identities.
      return (
        section.reference.match(/"selectorVersion":"([^"]+)"/)?.[1] ??
        section.reference.match(/"policyVersion":"([^"]+)"/)?.[1] ??
        "recent-context:unavailable"
      );
  }
}

export type ContextInspectorRetrievalState = "none" | "completed" | "degraded";

export type ContextInspectorRetrievalSummary = Readonly<{
  degradedReasonCodes: readonly string[];
  portraitDegradedReasonCodes: readonly string[];
  state: ContextInspectorRetrievalState;
}>;

/**
 * #266: one deterministic, presentation-only reading of the recorded retrieval
 * manifest for the always-visible summary. It never re-derives a selection; it
 * only classifies the persisted degradation codes.
 */
export function retrievalSummary(
  inspection: Pick<ContextInspectorPayload, "compiledContext">,
): ContextInspectorRetrievalSummary {
  const manifest = inspection.compiledContext.retrievalManifest;
  if (manifest === null) {
    return {
      degradedReasonCodes: [],
      portraitDegradedReasonCodes: [],
      state: "none",
    };
  }
  return {
    degradedReasonCodes: manifest.degraded_reason_codes,
    portraitDegradedReasonCodes: manifest.portrait_degraded_reason_codes,
    state:
      manifest.degraded_reason_codes.length > 0 ? "degraded" : "completed",
  };
}

export function safetyPostureLabel(
  state: ContextInspectorSafetyPosture["state"],
): string {
  switch (state) {
    case "released":
      return "Cleared";
    case "active":
      return "Active";
    case "default":
      return "Default";
  }
}

/** #266: count of memory items actually injected across present memory sections. */
export function injectedMemoryItemCount(
  sections: readonly ContextInspectorSection[],
): number {
  return memorySectionItemsFromSections(sections).reduce(
    (total, section) => total + section.items.length,
    0,
  );
}

export type RetrievalRejectionSummaryEntry = Readonly<{
  code: string;
  count: number;
}>;

/**
 * #266: groups the per-candidate rejection reasons recorded on the run ledger
 * for the summary's natural-language exclusion list. Selection reasons and the
 * full per-candidate rows stay untouched in the detail funnel.
 */
export function retrievalRejectionSummary(
  candidates: readonly RetrievalCandidateInspection[],
): Readonly<{
  entries: readonly RetrievalRejectionSummaryEntry[];
  uncodedCount: number;
}> {
  const counts = new Map<string, number>();
  let uncodedCount = 0;
  for (const candidate of candidates) {
    if (candidate.selectedSection !== null) continue;
    if (candidate.rejectionReasonCodes.length === 0) {
      uncodedCount += 1;
      continue;
    }
    for (const code of candidate.rejectionReasonCodes) {
      counts.set(code, (counts.get(code) ?? 0) + 1);
    }
  }
  const entries = [...counts.entries()]
    .map(([code, count]) => ({ code, count }))
    .sort(
      (left, right) =>
        right.count - left.count || left.code.localeCompare(right.code),
    );
  return { entries, uncodedCount };
}

/**
 * #266: presentation labels for the recorded diagnostic / selection / rejection
 * reason codes. Unknown codes fall through unchanged, so the summary never
 * invents a meaning the ledger did not record; the raw codes remain visible in
 * the detail sections.
 */
const DIAGNOSTIC_CODE_LABELS: Readonly<Record<string, string>> = {
  budget_retrieval_ceiling: "Excluded by the retrieval budget ceiling.",
  budget_retrieval_impression_ceiling:
    "Excluded by the impression budget ceiling.",
  memory_retrieval_failed:
    "Memory retrieval failed, so this Context compiled without memory.",
  portrait_load_failed:
    "The Person Portrait could not be loaded and was omitted this turn.",
  relevance_cutoff_broad_term_only:
    "Excluded because only a broad term matched.",
  relevance_cutoff_canonical_key_exact:
    "Selected on an exact canonical-key match.",
  relevance_cutoff_canonical_key_object_elided:
    "Selected on a canonical-key match with the object elided.",
  relevance_cutoff_entity_anchored:
    "Selected because the entity anchored the match.",
  relevance_cutoff_entity_predicate_joint:
    "Selected because the entity and predicate matched together.",
  relevance_cutoff_impression_per_run_limit:
    "Excluded by the per-run impression limit.",
  relevance_cutoff_impression_single_signal:
    "Excluded because the impression had only one signal.",
  relevance_cutoff_impression_two_signals:
    "Selected because the impression had two or more signals.",
  relevance_cutoff_insufficient_signals:
    "Excluded because too few signals matched.",
  relevance_cutoff_lexical_two_terms:
    "Selected because two lexical terms matched.",
  relevance_cutoff_single_term:
    "Excluded because only a single weak term matched.",
  retrieval_candidate_hydration_failed:
    "Selected retrieval candidates could not be loaded.",
  retrieval_deadline_exceeded: "The retrieval round exceeded its deadline.",
  retrieval_lane_failed:
    "A retrieval lane failed; the round degraded and injected no memory.",
  retrieval_policy_unavailable: "The retrieval policy was unavailable.",
  retrieval_query_construction_failed:
    "The retrieval query could not be constructed.",
  retrieval_run_recording_failed: "The retrieval run could not be recorded.",
  section_dedupe_portrait_priority:
    "De-duplicated: the Person Portrait already carried this item.",
  selected_person_portrait: "Selected into the Person Portrait.",
  selected_query_retrieval: "Selected by query retrieval.",
};

export function humanizeDiagnosticCode(code: string): string {
  return DIAGNOSTIC_CODE_LABELS[code] ?? code;
}

function renderedPolicyVersion(reference: string): string | null {
  return reference.match(/policy ([A-Za-z0-9._-]+:[A-Za-z0-9._-]+)/)?.[1] ?? null;
}

function referenceValue(
  reference: string,
  startMarker: string,
  endMarker: string,
): string | null {
  const start = reference.indexOf(startMarker);
  if (start < 0) return null;
  const valueStart = start + startMarker.length;
  const end = reference.indexOf(endMarker, valueStart);
  const value = reference.slice(valueStart, end < 0 ? undefined : end);
  return value.length > 0 ? value : null;
}

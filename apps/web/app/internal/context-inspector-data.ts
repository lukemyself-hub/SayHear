import type {
  CompiledContextSectionKey,
  ContextPolicyVersions,
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
      sectionBudgets: Readonly<{ committedRawEvents: number }>;
      sections: readonly ContextInspectorSection[];
      sourceRevision: number;
      totalTokens: number;
    }>;
  generationCommandId: string;
  model: string;
  provider: string;
  providerPolicyVersion: string;
}>;

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
      // recall-framing:v1]").
      return (
        section.reference.match(/\[(portrait-selection:[^\]]+)\]/)?.[1] ??
        "memory-selection:unavailable"
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
  }
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

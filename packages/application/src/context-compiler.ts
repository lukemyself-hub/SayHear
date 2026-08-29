import { createHmac, timingSafeEqual } from "node:crypto";
import { randomUUID } from "node:crypto";

import {
  RECALL_EXPERIENCE_CONTRACT_VERSION,
  resolvePromptArtifacts,
  resolveRecallExperienceContract,
  resolveSafetyPostureReducedPersona,
  resolveTrustActionExpressionContract,
  SAFETY_POSTURE_REDUCED_PERSONA_VERSION,
  TRUST_ACTION_EXPRESSION_CONTRACT_VERSION,
  type GenerationCommandStage,
  type ResolvedPromptArtifacts,
} from "./prompt-artifacts";
import type {
  CompiledContextId,
  ConversationEventRevisionId,
  DailySessionId,
  GenerationCommandId,
  InteractionTurnId,
  UserId,
} from "@sayhear/domain";
import type { CurrentDialogueState } from "./dialogue-state";
import type { CurrentRollingSummary } from "./rolling-summary";
import {
  activeCuriosityStopSignal,
  hasActiveCuriosityStopSignal,
  renderCuriosityStopSignal,
  type CurrentCuriosityStopSignal,
} from "./curiosity-stop-signal";
import {
  activeSafetyPosture,
  renderSafetyPosture,
  type CurrentSafetyPosture,
} from "./safety-posture";
import type {
  ActionReferenceHandle,
  ActionReferenceTarget,
} from "./conversation-action-catalog";
import { resolveConversationLocale } from "./conversation-behavior";
import type {
  MemoryRetrievalPort,
  RetrievalRunManifest,
} from "./memory-retrieval/types";
import {
  MEMORY_SECTION_KEYS,
  memoryLocaleOf,
  renderMemorySection,
  type MemoryContextItem,
  type MemorySectionKey,
} from "./memory-retrieval/memory-compilation";
import type {
  ConversationActionAdmission,
  ConversationActionExecution,
} from "./conversation-action-gateway";

/**
 * The trust-action detail of a frozen Action Finalization Receipt (issue
 * #119). Populated by the repository loaders only for trust-action receipts:
 * the typed reference to the resolved Claim (ADR-0118), the multi-hit
 * candidate count, and — for source explanations — the verified evidence
 * snapshot or the `unverifiable` verdict (ADR-0008). No prose beyond the
 * bounded user-word quotes the reply must cite.
 */
export type ActionFinalizationTrustActionDetail = Readonly<{
  candidateCount: number | null;
  claimId: string | null;
  claimKind: "objective" | "impression" | null;
  claimVersionId: string | null;
  qualifierId: string | null;
  targetKind: "memory_claim" | "relationship_qualifier" | null;
  evidenceItems: readonly Readonly<{
    occurredOn: string;
    quote: string;
  }>[];
  evidenceVerdict: "verified" | "unverifiable" | null;
}>;

export type ActionFinalizationReceiptSnapshot = Readonly<{
  actionKind: string | null;
  admission: ConversationActionAdmission;
  disposition: string | null;
  execution: ConversationActionExecution;
  sequence: number;
  trustAction?: ActionFinalizationTrustActionDetail | null;
}>;

export type ContextPolicyVersions = Readonly<{
  canonicalPersonaVersion: string;
  localePolicyVersion: string;
  outputFormatVersion: string;
  personaBehaviorAnchorsVersion: string;
  personaContractInvariantVersion: string;
  productPolicyVersion: string;
  relationshipPolicyVersion: string;
  safetyPolicyVersion: string;
  taskInstructionVersion: string;
}>;

export type ContextSourceEvent = Readonly<{
  actor: "user" | "assistant";
  locale: string;
  revisionId: ConversationEventRevisionId;
  sequence: number;
  text: string;
}>;

export type ContextSourceSnapshot = Readonly<{
  actionFinalizationReceipt?: ActionFinalizationReceiptSnapshot;
  actionReferenceTargets?: readonly ActionReferenceTarget[];
  curiosityStopSignal?: CurrentCuriosityStopSignal | null;
  dailySession: Readonly<{
    activityState: "active" | "finalized" | "quiescent";
    closurePolicyVersion: string;
    continuousExchangeNo: number;
    id: DailySessionId;
  }>;
  dialogueRevision: number;
  dialogueState?: CurrentDialogueState | null;
  dialogueStateFailure?: boolean;
  events: readonly ContextSourceEvent[];
  generationStage: GenerationCommandStage;
  /**
   * True when the current Daily Session has committed final / corrected User
   * Event revisions carrying fast-path extraction commands whose runs have
   * not completed (issue #113). The compile never waits; raw Events continue
   * to serve and the manifest records `fast_path_pending`.
   */
  fastPathPending?: boolean;
  inputRevisionId: ConversationEventRevisionId;
  locale: string;
  policyVersions: ContextPolicyVersions;
  rollingSummary?: CurrentRollingSummary | null;
  rollingSummaryFailure?: boolean;
  safetyPosture?: CurrentSafetyPosture | null;
  sourceRevision: number;
}>;

export type CompiledContextDegradedReason =
  | "raw_event_budget_exceeded"
  | "dialogue_state_failed"
  | "dialogue_state_lagging"
  | "rolling_summary_failed"
  | "memory_retrieval_failed"
  | "fast_path_pending"
  /** #119: a materially ambiguous trust-action target closes the reply round's memory. */
  | "trust_action_memory_fenced"
  | null;

export type CompiledContextSectionKey =
  | "product_policy"
  | "safety_policy"
  | "relationship_boundary"
  | "persona_contract_invariant"
  | "canonical_persona"
  | "persona_behavior_anchors"
  | "safety_posture"
  | "task_instruction"
  | "output_format"
  | "locale_pack"
  | "daily_session"
  | "dialogue_state"
  | "curiosity_stop_signal"
  | "person_portrait"
  | "objective_memory"
  | "ai_impression"
  | "recall_experience"
  | "trust_action_expression"
  | "rolling_summary"
  | "committed_raw_events"
  | "current_user_input"
  | "action_finalization_receipt";

export type CompiledContextSection = Readonly<{
  budgetTokens: number | null;
  contentHmac: string;
  key: CompiledContextSectionKey;
  ordinal: number;
  reference: string;
  selectedTokens: number;
  truncatable: boolean;
}>;

export type CompiledContextReferencedEvent = ContextSourceEvent &
  Readonly<{
    estimatedTokens: number;
    section: "committed_raw_events" | "current_user_input";
    selectionOrder: number | null;
  }>;

export type CompiledContext = Readonly<{
  actionReferenceHandles?: readonly ActionReferenceHandle[];
  degradedReason: CompiledContextDegradedReason;
  dialogueRevision: number;
  id: CompiledContextId;
  locale: string;
  /**
   * #116: the Structured-Lexical retrieval run behind this compile. Absent
   * when retrieval is not wired (no port configured). A degraded run still
   * carries its manifest — detailed codes live on the retrieval run row.
   */
  retrieval?: Readonly<{
    degraded: boolean;
    manifest: RetrievalRunManifest;
    retrievalRunId: string | null;
  }>;
  referencedRevisionIds: readonly ConversationEventRevisionId[];
  sourceRevision: number;
  statistics: Readonly<{
    rawEventBudgetTokens: number;
    selectedEventCount: number;
    totalTokens: number;
  }>;
}>;

export type CompiledContextRenderSource = Readonly<{
  actionFinalizationReceipt?: ActionFinalizationReceiptSnapshot;
  actionReferenceHandles?: readonly ActionReferenceHandle[];
  compilerVersion: string;
  integrity: Readonly<{
    algorithm: "hmac-sha256";
    contentHmac: string;
    keyVersion: string;
  }>;
  generationStage: GenerationCommandStage;
  locale: string;
  policyVersions: ContextPolicyVersions;
  rollingSummary?: CurrentRollingSummary | null;
  referencedEvents: readonly CompiledContextReferencedEvent[];
  sections: readonly CompiledContextSection[];
  totalTokens: number;
}>;

export type RenderedCompiledContextPayload = Readonly<{
  actionReferenceHandles?: readonly ActionReferenceHandle[];
  instructions: string;
  messages: readonly Readonly<{
    revisionId: ConversationEventRevisionId;
    role: "user" | "assistant";
    text: string;
  }>[];
}>;

export type ContextCompilerRepository = Readonly<{
  loadContextSource(input: {
    generationCommandId: GenerationCommandId;
    interactionTurnId: InteractionTurnId;
    userId: UserId;
  }): Promise<ContextSourceSnapshot>;
  saveCompiledContext(input: {
    actionReferenceHandles?: readonly (ActionReferenceHandle &
      Readonly<{
        sourceRevision: number;
        targetId: string;
        targetVersionId: string;
        targetClaimId?: string;
        targetQualifierId?: string;
        qualifierAxisId?: string;
        qualifierRoleSide?: "canonical_subject" | "counterpart";
        qualifierTypedValue?: string | readonly string[];
      }>)[];
    compilerVersion: string;
    degradedReason: CompiledContextDegradedReason;
    dialogueRevision: number;
    generationCommandId: GenerationCommandId;
    integrity: Readonly<{
      algorithm: "hmac-sha256";
      contentHmac: string;
      keyVersion: string;
    }>;
    locale: string;
    now: Date;
    policyVersions: ContextPolicyVersions;
    retrievalManifest?: RetrievalRunManifest | null;
    retrievalRunId?: string | null;
    rollingSummary: CurrentRollingSummary | null;
    referencedEvents: readonly CompiledContextReferencedEvent[];
    sectionBudgets: Readonly<{ committedRawEvents: number }>;
    sections: readonly CompiledContextSection[];
    sourceRevision: number;
    totalTokens: number;
    userId: UserId;
  }): Promise<CompiledContext>;
}>;

export type ContextCompiler = Readonly<{
  compile(input: {
    generationCommandId: GenerationCommandId;
    interactionTurnId: InteractionTurnId;
    userId: UserId;
  }): Promise<CompiledContext>;
  renderPermittedPayload(
    source: CompiledContextRenderSource,
  ): RenderedCompiledContextPayload;
}>;

export class CompiledContextIntegrityError extends Error {
  public constructor() {
    super("The frozen CompiledContext manifest failed integrity validation.");
    this.name = "CompiledContextIntegrityError";
  }
}

export function createContextCompiler(dependencies: {
  clock: () => Date;
  compilerVersion: string;
  contentHmacKeyVersion?: string;
  contentHmacSecret: string;
  rawEventTokenBudget: number;
  repository: ContextCompilerRepository;
  /** #116: optional until composition enables the retrieval baseline. */
  memoryRetrieval?: MemoryRetrievalPort;
}): ContextCompiler {
  const integrityKeyVersion =
    dependencies.contentHmacKeyVersion ?? "context-integrity:v1";

  return {
    async compile(input) {
      const source = await dependencies.repository.loadContextSource(input);
      assertSupportedPolicyVersions(source.policyVersions);
      // Identity-layer resolution is fail-closed: an unknown persona, locale,
      // or stage-mismatched task version throws and no Assistant Response
      // ships with an absent or defaulted identity layer (issue #73).
      const promptArtifacts = resolvePromptArtifacts({
        generationStage: source.generationStage,
        locale: source.locale,
        policyVersions: source.policyVersions,
      });
      const currentInput = source.events.find(
        (event) => event.revisionId === source.inputRevisionId,
      );
      if (!currentInput || currentInput.actor !== "user") {
        throw new Error(
          "CompiledContext requires its committed current User input revision.",
        );
      }

      const dialogueState = usableDialogueState(source);
      const dialogueStateFailure =
        source.dialogueStateFailure === true ||
        (source.dialogueState !== undefined &&
          source.dialogueState !== null &&
          dialogueState === null);

      // #116: the Structured-Lexical retrieval run shares this compile. Its
      // one versioned deadline covers query construction, lanes, ranking,
      // and fences; a degraded run closes the round's memory (no partial
      // injection, no reuse of a previous turn's cache) and the conversation
      // continues without memory (ADR-0111).
      const retrievalOutcome = dependencies.memoryRetrieval
        ? await dependencies.memoryRetrieval.run({
            userId: input.userId,
            dailySession: {
              id: source.dailySession.id,
              continuousExchangeNo: source.dailySession.continuousExchangeNo,
            },
            sourceEventRevisionId: source.inputRevisionId,
            currentInputText: currentInput.text,
            // Only a source-valid current topic may feed the query (story 44):
            // a stale / failed / invalidated projection yields null.
            currentTopic: dialogueState?.content.current_topic.value ?? null,
            dialogueRevision: source.dialogueRevision,
            currentInputSequence: currentInput.sequence,
            locale: memoryLocaleOf(source.locale),
          })
        : null;

      const historyNewestFirst = source.events
        .filter((event) => {
          const dialogueCoverage = dialogueState?.coveredThroughSequence ?? 0;
          const summaryCoverage = source.rollingSummary?.coveredThrough ?? 0;
          return event.revisionId !== source.inputRevisionId &&
            event.sequence > Math.max(dialogueCoverage, summaryCoverage);
        })
        .toSorted((left, right) => right.sequence - left.sequence);
      const selectedNewestFirst: CompiledContextReferencedEvent[] = [];
      let remaining = dependencies.rawEventTokenBudget;
      for (const [selectionOrder, event] of historyNewestFirst.entries()) {
        const estimatedTokens = estimateTokens(event.text);
        if (estimatedTokens > remaining) {
          break;
        }
        selectedNewestFirst.push({
          ...event,
          estimatedTokens,
          section: "committed_raw_events",
          selectionOrder,
        });
        remaining -= estimatedTokens;
      }

      const selectedHistory = selectedNewestFirst.toSorted(
        (left, right) => left.sequence - right.sequence,
      );
      const referencedEvents: CompiledContextReferencedEvent[] = [
        ...selectedHistory,
        {
          ...currentInput,
          estimatedTokens: estimateTokens(currentInput.text),
          section: "current_user_input",
          selectionOrder: null,
        },
      ];
      const dailySessionReference =
        `${source.dailySession.id}:activity:${source.dailySession.activityState}` +
        `:closure:${source.dailySession.closurePolicyVersion}` +
        `:dialogue:${source.dialogueRevision}` +
        `:exchange:${source.dailySession.continuousExchangeNo}`;
      const renderableSections = createSections({
        contentHmacSecret: dependencies.contentHmacSecret,
        currentInput: referencedEvents.at(-1)!,
        dailySessionReference,
        history: selectedHistory,
        locale: source.locale,
        policyVersions: source.policyVersions,
        promptArtifacts,
        rawEventTokenBudget: dependencies.rawEventTokenBudget,
        curiosityStopSignal: source.curiosityStopSignal ?? null,
        currentExchangeNo: source.dailySession.continuousExchangeNo,
        dialogueState,
        // #117: a degraded retrieval run carries empty sections (the round's
        // memory fails closed) and empty sections are omitted entirely —
        // never placeholder text, never fabricated. #119: a materially
        // ambiguous trust-action target closes the reply round's memory the
        // same way (SPEC AC 29).
        memorySections:
          retrievalOutcome === null ||
          retrievalOutcome.status === "degraded" ||
          trustActionFencesMemory(source.actionFinalizationReceipt)
            ? undefined
            : retrievalOutcome.memorySections,
        rollingSummary: source.rollingSummary ?? null,
        safetyPosture: source.safetyPosture ?? null,
        actionFinalizationReceipt: source.actionFinalizationReceipt,
      });
      const sections = renderableSections.map(
        ({ content: _content, ...section }) => section,
      );
      const totalTokens = sections.reduce(
        (total, section) => total + section.selectedTokens,
        0,
      );
      const degradedReason = dialogueStateFailure
        ? "dialogue_state_failed"
        : dialogueState?.status === "lagging"
          ? "dialogue_state_lagging"
          : source.rollingSummaryFailure
            ? "rolling_summary_failed"
            : selectedHistory.length < historyNewestFirst.length
              ? "raw_event_budget_exceeded"
              : retrievalOutcome?.status === "degraded"
                ? "memory_retrieval_failed"
                : trustActionFencesMemory(source.actionFinalizationReceipt)
                  ? "trust_action_memory_fenced"
                  : source.fastPathPending === true
                    ? "fast_path_pending"
                    : null;
      const contentHmac = createManifestContentHmac(
        dependencies.contentHmacSecret,
        sections,
      );
      const actionReferenceHandles = (source.actionReferenceTargets ?? []).flatMap(
        (target) =>
          target.actionKinds.map((actionKind) => ({
            actionKinds: [actionKind],
            handle: `shh-handle-${randomUUID()}`,
            targetKind: target.targetKind,
            targetId: target.targetId,
            targetVersionId: target.targetVersionId,
            sourceRevision: target.sourceRevision,
            ...(target.targetClaimId === undefined
              ? {}
              : { targetClaimId: target.targetClaimId }),
            ...(target.targetQualifierId === undefined
              ? {}
              : { targetQualifierId: target.targetQualifierId }),
            ...(target.qualifierAxisId === undefined
              ? {}
              : { qualifierAxisId: target.qualifierAxisId }),
            ...(target.qualifierRoleSide === undefined
              ? {}
              : { qualifierRoleSide: target.qualifierRoleSide }),
            ...(target.qualifierTypedValue === undefined
              ? {}
              : { qualifierTypedValue: target.qualifierTypedValue }),
          })),
      );

      const compiled = await dependencies.repository.saveCompiledContext({
        ...(actionReferenceHandles.length === 0
          ? {}
          : { actionReferenceHandles }),
        compilerVersion: dependencies.compilerVersion,
        degradedReason,
        dialogueRevision: source.dialogueRevision,
        generationCommandId: input.generationCommandId,
        integrity: {
          algorithm: "hmac-sha256",
          contentHmac,
          keyVersion: integrityKeyVersion,
        },
        locale: source.locale,
        now: dependencies.clock(),
        policyVersions: source.policyVersions,
        ...(retrievalOutcome
          ? {
              retrievalManifest: retrievalOutcome.manifest,
              retrievalRunId: retrievalOutcome.retrievalRunId,
            }
          : {}),
        rollingSummary: source.rollingSummary ?? null,
        referencedEvents,
        sectionBudgets: {
          committedRawEvents: dependencies.rawEventTokenBudget,
        },
        sections,
        sourceRevision: source.sourceRevision,
        totalTokens,
        userId: input.userId,
      });
      if (!retrievalOutcome) return compiled;
      return {
        ...compiled,
        retrieval: {
          degraded: retrievalOutcome.status === "degraded",
          manifest: retrievalOutcome.manifest,
          retrievalRunId: retrievalOutcome.retrievalRunId,
        },
      };
    },
    renderPermittedPayload(source) {
      assertSupportedPolicyVersions(source.policyVersions);
      if (
        source.compilerVersion !== dependencies.compilerVersion ||
        source.integrity.algorithm !== "hmac-sha256" ||
        source.integrity.keyVersion !== integrityKeyVersion
      ) {
        throw new CompiledContextIntegrityError();
      }
      // Re-resolution is deterministic by version, so the recomputed section
      // HMACs below prove the frozen manifest resolved the same artifacts.
      const promptArtifacts = resolvePromptArtifacts({
        generationStage: source.generationStage,
        locale: source.locale,
        policyVersions: source.policyVersions,
      });
      const currentInputs = source.referencedEvents.filter(
        (event) => event.section === "current_user_input",
      );
      const history = source.referencedEvents
        .filter((event) => event.section === "committed_raw_events")
        .toSorted((left, right) => left.sequence - right.sequence);
      const currentInput = currentInputs[0];
      const dailySessionReference = source.sections.find(
        (section) => section.key === "daily_session",
      )?.reference;
      const rawEventBudget = source.sections.find(
        (section) => section.key === "committed_raw_events",
      )?.budgetTokens;
      const dialogueStateSection = source.sections.find(
        (section) => section.key === "dialogue_state",
      );
      const stopSignalSection = source.sections.find(
        (section) => section.key === "curiosity_stop_signal",
      );
      const safetyPostureSection = source.sections.find(
        (section) => section.key === "safety_posture",
      );
      // #117: memory sections replay their exact frozen content from the
      // section reference (dialogue-state pattern) — what was inspected is
      // what was injected.
      const memorySectionContents = Object.fromEntries(
        MEMORY_SECTION_KEYS.flatMap((key) => {
          const section = source.sections.find(
            (candidate) => candidate.key === key,
          );
          return section ? [[key, section.reference] as const] : [];
        }),
      ) as Partial<Record<MemorySectionKey, string>>;
      // #118: the recall experience contract rides the same reference-is-
      // content replay as the memory sections it governs.
      const recallExperienceSection = source.sections.find(
        (candidate) => candidate.key === "recall_experience",
      );
      // #119: the P1–P6 trust-action expression contract replays the same way.
      const trustActionExpressionSection = source.sections.find(
        (candidate) => candidate.key === "trust_action_expression",
      );
      if (
        currentInputs.length !== 1 ||
        !currentInput ||
        currentInput.actor !== "user" ||
        !dailySessionReference ||
        rawEventBudget === null ||
        rawEventBudget === undefined ||
        (dialogueStateSection && !dialogueStateSection.reference) ||
        (stopSignalSection && !stopSignalSection.reference) ||
        (safetyPostureSection && !safetyPostureSection.reference) ||
        MEMORY_SECTION_KEYS.some(
          (key) => memorySectionContents[key] === "",
        ) ||
        (recallExperienceSection && !recallExperienceSection.reference) ||
        (trustActionExpressionSection && !trustActionExpressionSection.reference)
      ) {
        throw new CompiledContextIntegrityError();
      }
      const renderableSections = createSections({
        contentHmacSecret: dependencies.contentHmacSecret,
        currentInput,
        dailySessionReference,
        history,
        locale: source.locale,
        policyVersions: source.policyVersions,
        promptArtifacts,
        rawEventTokenBudget: rawEventBudget,
        curiosityStopSignal: null,
        ...(dialogueStateSection?.reference
          ? { dialogueStateContent: dialogueStateSection.reference }
          : {}),
        ...(stopSignalSection?.reference
          ? { stopSignalContent: stopSignalSection.reference }
          : {}),
        ...(safetyPostureSection?.reference
          ? { safetyPostureContent: safetyPostureSection.reference }
          : {}),
        ...(recallExperienceSection?.reference
          ? { recallExperienceContent: recallExperienceSection.reference }
          : {}),
        ...(trustActionExpressionSection?.reference
          ? {
              trustActionExpressionContent:
                trustActionExpressionSection.reference,
            }
          : {}),
        memorySectionContents,
        rollingSummary: source.rollingSummary ?? null,
        actionFinalizationReceipt: source.actionFinalizationReceipt,
      });
      const expectedSections = renderableSections.map(
        ({ content: _content, ...section }) => section,
      );
      const expectedTotalTokens = expectedSections.reduce(
        (total, section) => total + section.selectedTokens,
        0,
      );
      const expectedContentHmac = createManifestContentHmac(
        dependencies.contentHmacSecret,
        expectedSections,
      );
      if (
        expectedTotalTokens !== source.totalTokens ||
        !sectionsMatch(expectedSections, source.sections) ||
        !hmacMatches(expectedContentHmac, source.integrity.contentHmac)
      ) {
        throw new CompiledContextIntegrityError();
      }

      return {
        ...(source.actionReferenceHandles === undefined
          ? {}
          : { actionReferenceHandles: source.actionReferenceHandles }),
        instructions: renderableSections
          .filter(
            (section) =>
              section.key !== "committed_raw_events" &&
              section.key !== "current_user_input",
          )
          .map((section) => section.content)
          .join("\n") +
          renderActionReferenceInstructions(source.actionReferenceHandles),
        messages: [...history, currentInput]
          .toSorted((left, right) => left.sequence - right.sequence)
          .map((event) => ({
            revisionId: event.revisionId,
            role: event.actor,
            text: event.text,
          })),
      };
    },
  };
}

function renderActionReferenceInstructions(
  handles: readonly ActionReferenceHandle[] | undefined,
): string {
  if (!handles || handles.length === 0) return "";
  return [
    "Available Action Reference Handles (opaque and command-scoped):",
    ...handles.flatMap((handle) =>
      handle.actionKinds.map(
        (actionKind) => `- ${actionKind}: ${handle.handle}`,
      ),
    ),
  ].join("\n");
}

/** The trust-action kinds whose receipts ship with the Catalog v2 pin (ADR-0118). */
export const TRUST_ACTION_KINDS: readonly string[] = [
  "memory_correction",
  "explain_memory_source",
  "memory_forget_request",
  "memory_forget_reversal",
  "entity_identity_correction",
];

export function isTrustActionReceipt(
  receipt: ActionFinalizationReceiptSnapshot | undefined,
): receipt is ActionFinalizationReceiptSnapshot &
  Readonly<{ actionKind: string }> {
  return (
    receipt !== undefined &&
    receipt.actionKind !== null &&
    TRUST_ACTION_KINDS.includes(receipt.actionKind)
  );
}

/**
 * A materially ambiguous trust-action target closes the round's memory on
 * the reply context (SPEC AC 29): the user disputed remembered content the
 * system cannot uniquely locate, so the reply continues with zero memory
 * injection — no partial memory, no reuse of the decision stage's view —
 * while the honest clarification reply explains itself from the frozen
 * receipt.
 */
export function trustActionFencesMemory(
  receipt: ActionFinalizationReceiptSnapshot | undefined,
): boolean {
  if (!isTrustActionReceipt(receipt)) return false;
  if (
    receipt.admission === "clarification_required" &&
    (receipt.disposition === "target_ambiguous_multi_hit" ||
      receipt.disposition === "scope_ambiguous")
  ) {
    return true;
  }
  return (
    receipt.admission === "accepted" &&
    (receipt.execution === "succeeded" ||
      receipt.execution === "failed" ||
      receipt.execution === "canceled") &&
    (receipt.actionKind === "memory_correction" ||
      receipt.actionKind === "memory_forget_request" ||
      receipt.actionKind === "memory_forget_reversal" ||
      receipt.actionKind === "entity_identity_correction")
  );
}

const TRUST_ACTION_UNVERIFIABLE_PHRASING: Readonly<{ en: string; zh: string }> = {
  en: "I can't verify where this came from.",
  zh: "我无法核实这条记忆是从哪来的。",
};

export function trustActionUnverifiablePhrasing(locale: string): string {
  return resolveConversationLocale(locale) === "zh"
    ? TRUST_ACTION_UNVERIFIABLE_PHRASING.zh
    : TRUST_ACTION_UNVERIFIABLE_PHRASING.en;
}

function renderActionFinalizationReceipt(
  receipt: ActionFinalizationReceiptSnapshot,
): string {
  if (isTrustActionReceipt(receipt)) {
    return renderTrustActionFinalizationReceipt(receipt);
  }
  const completionRule = receipt.execution === "succeeded"
    ? "The Action completed successfully; it is valid to say the regenerated Journal is complete."
    : "The Action is not complete; do not claim that a new Journal Version was generated or became current.";
  return [
    "Action Finalization Receipt (frozen committed source):",
    `Admission: ${receipt.admission}; execution: ${receipt.execution}; sequence: ${receipt.sequence}; disposition: ${receipt.disposition ?? "none"}.`,
    completionRule,
    "Only this Receipt snapshot may determine the Action status in the final response.",
  ].join("\n");
}

function renderTrustActionFinalizationReceipt(
  receipt: ActionFinalizationReceiptSnapshot & Readonly<{ actionKind: string }>,
): string {
  const detail = receipt.trustAction ?? null;
  const lines = [
    "Action Finalization Receipt (frozen committed source):",
    `Action: ${receipt.actionKind}; admission: ${receipt.admission}; execution: ${receipt.execution}; sequence: ${receipt.sequence}; disposition: ${receipt.disposition ?? "none"}.`,
  ];
  if (receipt.actionKind === "memory_correction") {
    if (receipt.admission === "accepted" && receipt.execution === "succeeded") {
      if (receipt.disposition === "succeeded_noop") {
        lines.push(
          "Outcome rule: this memory already sat corrected — say so honestly and plainly; nothing new changed this turn, and you must not pretend a fresh correction happened.",
        );
      } else {
        lines.push(
          "Outcome rule: the correction committed in this turn — that item is corrected now and stops being recalled. Confirm it plainly per P1; acknowledge the corrected version the user stated, if any; the background re-checks are still in progress, never claimed complete (P3). Do not restate the corrected-away content as current memory, and do not confess internal mechanics.",
        );
      }
    } else if (
      receipt.admission === "clarification_required" &&
      receipt.disposition === "target_ambiguous_multi_hit"
    ) {
      lines.push(
        `Outcome rule: several memories (${detail?.candidateCount ?? "some"}) match what the user described. Say only how many are in question — never list their content, never guess or preselect one — and ask which one the user means (P4). Nothing was changed.`,
      );
    } else if (
      receipt.admission === "clarification_required" &&
      receipt.disposition === "target_not_found"
    ) {
      lines.push(
        "Outcome rule: no matching memory was found. Say plainly that you could not find such a memory and that nothing was changed (P4). Do not invent a near miss, and do not confess internal mechanics.",
      );
    } else {
      lines.push(
        "Outcome rule: the correction did not complete; never claim any memory was corrected (P3/P4).",
      );
    }
  } else if (receipt.actionKind === "explain_memory_source") {
    if (
      receipt.execution === "succeeded" &&
      receipt.disposition === "source_evidence_verified" &&
      detail &&
      detail.evidenceVerdict === "verified" &&
      detail.evidenceItems.length > 0
    ) {
      lines.push(
        `Outcome rule: the source is verified. Explain it from these evidence items only, with their dates and the user's actual words, in the two-kind language (P5): claim kind = ${detail.claimKind ?? "unknown"}. ${detail.evidenceItems
          .map((item) => `[${item.occurredOn}] ${item.quote}`)
          .join(" ")} Never add a date, word, or event that is not listed here.`,
      );
    } else {
      lines.push(
        `Outcome rule: the source cannot be verified. Use exactly this phrasing and add nothing that pretends provenance (P5): "${trustActionUnverifiablePhrasing("en")}" / 「${trustActionUnverifiablePhrasing("zh")}」`,
      );
    }
  } else if (receipt.actionKind === "memory_forget_request") {
    if (receipt.admission === "accepted" && receipt.execution === "succeeded") {
      if (receipt.disposition === "succeeded_noop") {
        lines.push(
          "Outcome rule: this target was already forgotten; say that plainly and do not claim that anything changed or was deleted.",
        );
      } else {
        lines.push(
          "Outcome rule: the Forget Request committed. Stop using the selected whole memory or relationship role in future memory recall, while the original conversation and Journal remain intact; do not call it deletion and do not restate the forgotten content.",
        );
      }
    } else if (
      receipt.admission === "clarification_required" &&
      receipt.disposition === "scope_ambiguous"
    ) {
      lines.push(
        "Outcome rule: the request could mean the whole remembered relationship or only one role within it. Ask the user which scope they mean; nothing changed.",
      );
    } else if (
      receipt.admission === "clarification_required" &&
      receipt.disposition === "target_ambiguous_multi_hit"
    ) {
      lines.push(
        `Outcome rule: several memories (${detail?.candidateCount ?? "some"}) match. Ask which one the user means without listing or guessing; nothing changed.`,
      );
    } else {
      lines.push(
        "Outcome rule: no matching memory was changed. Say so plainly and do not claim the Forget Request succeeded.",
      );
    }
  } else if (receipt.actionKind === "memory_forget_reversal") {
    if (receipt.admission === "accepted" && receipt.execution === "succeeded") {
      lines.push(
        "Outcome rule: the explicit Forget Reversal committed. The current request is new Evidence and permission; never say that old Evidence or an old ClaimVersion was reactivated.",
      );
    } else if (
      receipt.admission === "clarification_required" &&
      receipt.disposition === "target_not_fenced"
    ) {
      lines.push(
        "Outcome rule: no currently forgotten target was found, so nothing was restored. Say that honestly and do not infer permission from ordinary repetition.",
      );
    } else if (
      receipt.admission === "clarification_required" &&
      receipt.disposition === "scope_ambiguous"
    ) {
      lines.push(
        "Outcome rule: the request does not identify one forgotten whole memory or relationship role. Ask one concise clarification; nothing changed.",
      );
    } else {
      lines.push(
        "Outcome rule: no memory was restored. Do not claim that Forget permission changed.",
      );
    }
  } else if (receipt.actionKind === "entity_identity_correction") {
    if (receipt.admission === "accepted" && receipt.execution === "succeeded") {
      if (receipt.disposition === "succeeded_noop") {
        lines.push(
          "Outcome rule: this Entity identity was already in the requested state; say so plainly and do not claim that a new identity correction changed anything.",
        );
      } else {
        lines.push(
          "Outcome rule: the user's Entity identity correction committed. Say that the identity was corrected plainly, without exposing internal IDs or claiming that the targeted Journal revalidation is already complete; affected Claims and Journal statements remain fenced until their background revalidation finishes.",
        );
      }
    } else if (
      receipt.admission === "clarification_required" &&
      receipt.disposition === "target_ambiguous_multi_hit"
    ) {
      lines.push(
        `Outcome rule: several Entity identities (${detail?.candidateCount ?? "some"}) match what the user described. Say only how many are in question, never list or guess among them, and ask which identity the user means. Nothing changed.`,
      );
    } else if (
      receipt.admission === "clarification_required" &&
      receipt.disposition === "target_not_found"
    ) {
      lines.push(
        "Outcome rule: no matching Entity identity was found. Say plainly that you could not find it and that nothing changed; do not invent a near match.",
      );
    } else {
      lines.push(
        "Outcome rule: the Entity identity correction did not complete; never claim that an Entity, Claim, or Journal statement was corrected.",
      );
    }
  }
  lines.push(
    "Only this Receipt snapshot may determine the Action status in the final response.",
  );
  return lines.join("\n");
}

function estimateTokens(text: string): number {
  return Math.max(1, Math.ceil([...text].length / 4));
}

function createSections(input: {
  contentHmacSecret: string;
  currentInput: CompiledContextReferencedEvent;
  currentExchangeNo?: number;
  dailySessionReference: string;
  history: readonly CompiledContextReferencedEvent[];
  locale: string;
  policyVersions: ContextPolicyVersions;
  promptArtifacts: ResolvedPromptArtifacts;
  rawEventTokenBudget: number;
  curiosityStopSignal: CurrentCuriosityStopSignal | null;
  dialogueState?: CurrentDialogueState | null;
  dialogueStateContent?: string;
  /** #117: compiled memory items per section (compile-time path). */
  memorySections?:
    | Readonly<Record<MemorySectionKey, readonly MemoryContextItem[]>>
    | undefined;
  /** #117: exact frozen content replayed from the manifest (egress path). */
  memorySectionContents?: Partial<Record<MemorySectionKey, string>>;
  rollingSummary: CurrentRollingSummary | null;
  safetyPosture?: CurrentSafetyPosture | null;
  safetyPostureContent?: string;
  actionFinalizationReceipt: ActionFinalizationReceiptSnapshot | undefined;
}): readonly (CompiledContextSection & Readonly<{ content: string }>)[] {
  // While the Safety Posture is active, enforcement is compilation: the
  // ordinary behavior anchors are swapped for the versioned reduced variant,
  // and the `safety_posture` section keeps the real-world support anchor on
  // every posture-active turn (ADR-0112). `safetyPostureContent` replays the
  // exact state frozen at compile time for the Provider Egress re-derivation.
  const activePosture = activeSafetyPosture(
    input.safetyPosture?.content ?? null,
  );
  const safetyPostureSectionContent =
    input.safetyPostureContent ??
    (activePosture !== null && input.safetyPosture
      ? renderSafetyPosture({
          content: activePosture,
          locale: input.locale,
          policyVersion: input.safetyPosture.policyVersion,
        })
      : undefined);
  const reducedPersonaActive = safetyPostureSectionContent !== undefined;
  const definitions: readonly Readonly<{
    budgetTokens: number | null;
    content: string;
    key: CompiledContextSectionKey;
    reference: string;
    selectedTokens?: number;
    truncatable: boolean;
  }>[] = [
    {
      budgetTokens: null,
      content:
        "Listen and understand by default. Do not give advice unless the user asks.",
      key: "product_policy",
      reference: input.policyVersions.productPolicyVersion,
      truncatable: false,
    },
    ...(input.rollingSummary === null ? [] : [{
      budgetTokens: null,
      content: renderRollingSummary(input.rollingSummary),
      key: "rolling_summary" as const,
      reference: `${input.rollingSummary.id}:version:${input.rollingSummary.version}:covered-through:${input.rollingSummary.coveredThrough}:sources:${input.rollingSummary.sourceRevisionIds.join(",")}:policy:${input.rollingSummary.policyVersion}:prompt:${input.rollingSummary.promptVersion}:model:${input.rollingSummary.modelConfigVersion}`,
      truncatable: false,
    }]),
    ...(input.actionFinalizationReceipt === undefined
      ? []
      : [{
          budgetTokens: null,
          content: renderActionFinalizationReceipt(input.actionFinalizationReceipt),
          key: "action_finalization_receipt" as const,
          reference: `receipt:${input.actionFinalizationReceipt.sequence}`,
          truncatable: false,
        }]),
    ...renderTrustActionExpressionSection(input),
    {
      budgetTokens: null,
      content:
        "For explicit self-harm, harm-to-others, or imminent danger, pause ordinary listening and encourage immediate real-world support without diagnosing, impersonating a therapist, or promising absolute confidentiality.",
      key: "safety_policy",
      reference: input.policyVersions.safetyPolicyVersion,
      truncatable: false,
    },
    {
      budgetTokens: null,
      content:
        "Distinguish user facts and judgments from your own inference. Do not encourage dependence or exclusivity.",
      key: "relationship_boundary",
      reference: input.policyVersions.relationshipPolicyVersion,
      truncatable: false,
    },
    {
      budgetTokens: null,
      content: input.promptArtifacts.personaContractInvariant,
      key: "persona_contract_invariant",
      reference: input.policyVersions.personaContractInvariantVersion,
      truncatable: false,
    },
    {
      budgetTokens: null,
      content: input.promptArtifacts.canonicalPersona,
      key: "canonical_persona",
      reference: input.policyVersions.canonicalPersonaVersion,
      truncatable: false,
    },
    {
      budgetTokens: null,
      content: reducedPersonaActive
        ? resolveSafetyPostureReducedPersona(
            SAFETY_POSTURE_REDUCED_PERSONA_VERSION,
          )
        : input.promptArtifacts.personaBehaviorAnchors,
      key: "persona_behavior_anchors",
      reference: reducedPersonaActive
        ? SAFETY_POSTURE_REDUCED_PERSONA_VERSION
        : input.policyVersions.personaBehaviorAnchorsVersion,
      truncatable: false,
    },
    ...(safetyPostureSectionContent === undefined
      ? []
      : [
          {
            budgetTokens: null,
            content: safetyPostureSectionContent,
            key: "safety_posture" as const,
            reference: safetyPostureSectionContent,
            truncatable: false,
          },
        ]),
    {
      budgetTokens: null,
      content: input.promptArtifacts.taskInstruction,
      key: "task_instruction",
      reference: input.policyVersions.taskInstructionVersion,
      truncatable: false,
    },
    {
      budgetTokens: null,
      content:
        "Return only the natural-language companion response, without metadata or formatting wrappers.",
      key: "output_format",
      reference: input.policyVersions.outputFormatVersion,
      truncatable: false,
    },
    {
      budgetTokens: null,
      content: input.promptArtifacts.localePack,
      key: "locale_pack",
      reference: input.policyVersions.localePolicyVersion,
      truncatable: false,
    },
    {
      budgetTokens: null,
      content: `daily_session=${input.dailySessionReference}`,
      key: "daily_session",
      reference: input.dailySessionReference,
      truncatable: false,
    },
    ...((input.dialogueState !== null && input.dialogueState !== undefined) ||
    input.dialogueStateContent
      ? [
          {
            budgetTokens: null,
            content:
              input.dialogueStateContent ?? renderDialogueState(input.dialogueState!),
            key: "dialogue_state" as const,
            reference:
              input.dialogueStateContent ?? renderDialogueState(input.dialogueState!),
            truncatable: false,
          },
        ]
      : []),
    ...renderCuriosityStopSignalSection(input),
    ...renderMemorySections(input),
    ...renderRecallExperienceSection(input),
    {
      budgetTokens: input.rawEventTokenBudget,
      content: input.history
        .map(
          (event) =>
            `${event.actor}:${event.revisionId}:${event.text}`,
        )
        .join("\n"),
      key: "committed_raw_events",
      reference: `event-revisions:${input.history
        .map((event) => event.revisionId)
        .join(",")}`,
      selectedTokens: input.history.reduce(
        (total, event) => total + event.estimatedTokens,
        0,
      ),
      truncatable: true,
    },
    {
      budgetTokens: null,
      content: `${input.currentInput.revisionId}:${input.currentInput.text}`,
      key: "current_user_input",
      reference: input.currentInput.revisionId,
      selectedTokens: input.currentInput.estimatedTokens,
      truncatable: false,
    },
  ];

  return definitions.map((section, ordinal) => ({
    budgetTokens: section.budgetTokens,
    content: section.content,
    contentHmac: createContentHmac(
      input.contentHmacSecret,
      `${section.key}\n${section.content}`,
    ),
    key: section.key,
    ordinal,
    reference: section.reference,
    selectedTokens:
      section.selectedTokens ?? estimateTokens(section.content),
    truncatable: section.truncatable,
  }));
}

function usableDialogueState(
  source: ContextSourceSnapshot,
): CurrentDialogueState | null {
  const projection = source.dialogueState;
  if (!projection) return null;
  const highestSequence = Math.max(
    ...source.events.map((event) => event.sequence),
  );
  if (
    projection.dialogueRevision > source.dialogueRevision ||
    projection.sourceRevision > source.sourceRevision ||
    projection.coveredThroughSequence > highestSequence
  ) {
    return null;
  }
  return projection;
}

/**
 * The stop-signal section is present only when the deterministic projection
 * holds an active suppression for the compiled exchange; an empty projection
 * (or one whose blanket form died with a previous Continuous Exchange) is
 * silently omitted. `stopSignalContent` replays the exact state frozen at
 * compile time for the Provider Egress re-derivation.
 */
function renderCuriosityStopSignalSection(input: {
  curiosityStopSignal: CurrentCuriosityStopSignal | null;
  currentExchangeNo?: number;
  stopSignalContent?: string;
}): readonly Readonly<{
  budgetTokens: null;
  content: string;
  key: "curiosity_stop_signal";
  reference: string;
  truncatable: false;
}>[] {
  if (input.stopSignalContent) {
    return [
      {
        budgetTokens: null,
        content: input.stopSignalContent,
        key: "curiosity_stop_signal",
        reference: input.stopSignalContent,
        truncatable: false,
      },
    ];
  }
  const projection = input.curiosityStopSignal;
  if (
    !projection ||
    input.currentExchangeNo === undefined ||
    !hasActiveCuriosityStopSignal(
      projection.content,
      input.currentExchangeNo,
    )
  ) {
    return [];
  }
  const content = renderCuriosityStopSignal({
    active: activeCuriosityStopSignal(
      projection.content,
      input.currentExchangeNo,
    ),
    policyVersion: projection.policyVersion,
  });
  return [
    {
      budgetTokens: null,
      content,
      key: "curiosity_stop_signal",
      reference: content,
      truncatable: false,
    },
  ];
}

/**
 * The three memory sections (#117, ADR-0111): compiled only when the run
 * produced items for them. Empty sections are omitted without placeholder
 * text; `memorySectionContents` replays the exact content frozen at compile
 * time for the Provider Egress re-derivation (what was inspected is what was
 * injected). The section reference carries the full rendered content, so the
 * replay needs no second persisted copy.
 */
function renderMemorySections(input: {
  locale: string;
  memorySections?:
    | Readonly<Record<MemorySectionKey, readonly MemoryContextItem[]>>
    | undefined;
  memorySectionContents?: Partial<Record<MemorySectionKey, string>>;
}): readonly Readonly<{
  budgetTokens: null;
  content: string;
  key: MemorySectionKey;
  reference: string;
  truncatable: false;
}>[] {
  const sections: {
    budgetTokens: null;
    content: string;
    key: MemorySectionKey;
    reference: string;
    truncatable: false;
  }[] = [];
  for (const key of MEMORY_SECTION_KEYS) {
    const replayed = input.memorySectionContents?.[key];
    if (replayed !== undefined) {
      sections.push({
        budgetTokens: null,
        content: replayed,
        key,
        reference: replayed,
        truncatable: false,
      });
      continue;
    }
    const items = input.memorySections?.[key] ?? [];
    if (items.length === 0) continue;
    const content = renderMemorySection({ key, items, locale: input.locale });
    sections.push({
      budgetTokens: null,
      content,
      key,
      reference: content,
      truncatable: false,
    });
  }
  return sections;
}

/**
 * The recall experience contract (issue #118, ADR-0116 / ADR-0117): present
 * exactly when at least one memory section is present, so the opener
 * permission and recall-language rules never speak for a turn memory did not
 * participate in. On a fail-closed round with zero injection the section is
 * absent and the response continues as if memory did not participate — the
 * structural half of the double prohibition. `recallExperienceContent`
 * replays the exact content frozen at compile time for the Provider Egress
 * re-derivation (the section reference carries the full rendered content).
 */
function renderRecallExperienceSection(input: {
  locale: string;
  memorySections?:
    | Readonly<Record<MemorySectionKey, readonly MemoryContextItem[]>>
    | undefined;
  memorySectionContents?: Partial<Record<MemorySectionKey, string>>;
  recallExperienceContent?: string;
}): readonly Readonly<{
  budgetTokens: null;
  content: string;
  key: "recall_experience";
  reference: string;
  truncatable: false;
}>[] {
  if (input.recallExperienceContent !== undefined) {
    return [
      {
        budgetTokens: null,
        content: input.recallExperienceContent,
        key: "recall_experience",
        reference: input.recallExperienceContent,
        truncatable: false,
      },
    ];
  }
  const anyMemorySection = MEMORY_SECTION_KEYS.some(
    (key) => (input.memorySections?.[key]?.length ?? 0) > 0,
  );
  if (!anyMemorySection) {
    return [];
  }
  const content = resolveRecallExperienceContract({
    locale: input.locale,
    version: RECALL_EXPERIENCE_CONTRACT_VERSION,
  });
  return [
    {
      budgetTokens: null,
      content,
      key: "recall_experience",
      reference: content,
      truncatable: false,
    },
  ];
}

/**
 * The P1–P6 trust-action expression contract (issue #119, SPEC story 49):
 * present exactly when the frozen receipt belongs to a trust action, so the
 * confirmation style is compiled, never improvised. `trustActionExpression-
 * Content` replays the exact content frozen at compile time for the Provider
 * Egress re-derivation (the section reference carries the full rendered
 * content — the recall-experience pattern).
 */
function renderTrustActionExpressionSection(input: {
  actionFinalizationReceipt: ActionFinalizationReceiptSnapshot | undefined;
  locale: string;
  trustActionExpressionContent?: string;
}): readonly Readonly<{
  budgetTokens: null;
  content: string;
  key: "trust_action_expression";
  reference: string;
  truncatable: false;
}>[] {
  if (input.trustActionExpressionContent !== undefined) {
    return [
      {
        budgetTokens: null,
        content: input.trustActionExpressionContent,
        key: "trust_action_expression",
        reference: input.trustActionExpressionContent,
        truncatable: false,
      },
    ];
  }
  if (!isTrustActionReceipt(input.actionFinalizationReceipt)) {
    return [];
  }
  const content = resolveTrustActionExpressionContract({
    locale: input.locale,
    version: TRUST_ACTION_EXPRESSION_CONTRACT_VERSION,
  });
  return [
    {
      budgetTokens: null,
      content,
      key: "trust_action_expression",
      reference: content,
      truncatable: false,
    },
  ];
}

function renderDialogueState(state: CurrentDialogueState): string {
  const renderField = <T>(field: { confidence: number; sourceRevisionIds: readonly ConversationEventRevisionId[]; value: T }) =>
    `${String(field.value ?? "none")} (confidence=${field.confidence.toFixed(2)}, sources=${field.sourceRevisionIds.join(",") || "none"})`;
  const advicePermitted = state.content.advice_explicitly_requested.value === true;
  return [
    `DialogueState (non-authoritative; status=${state.status}; dialogue_revision=${state.dialogueRevision}; source_revision=${state.sourceRevision}; covered_through_sequence=${state.coveredThroughSequence}):`,
    `Current topic: ${renderField(state.content.current_topic)}`,
    `Emotional intensity: ${renderField(state.content.emotional_intensity)}`,
    `Advice explicitly requested: ${renderField(state.content.advice_explicitly_requested)}`,
    `Current request requires focus: ${renderField(state.content.current_request_requires_focus)}`,
    `Close intent: ${renderField(state.content.close_intent)}`,
    `User willing to elaborate: ${renderField(state.content.user_willing_to_elaborate)}`,
    advicePermitted
      ? "Advice gate: the user explicitly requested advice in the covered turns; advice serving that request is permitted."
      : "Advice gate: the user has not explicitly requested advice in the covered turns; listen and understand rather than advise.",
    "Do not use DialogueState confidence to close the exchange or authorize a Conversation Action.",
  ].join("\n");
}

function renderRollingSummary(summary: CurrentRollingSummary): string {
  return [
    "Rolling Summary (non-authoritative Context projection):",
    `Stated facts: ${summary.content.statedFacts.join("; ") || "none"}`,
    `Judgments and feelings: ${summary.content.judgmentsAndFeelings.join("; ") || "none"}`,
    `Open topics: ${summary.content.openTopics.join("; ") || "none"}`,
  ].join("\n");
}

function createContentHmac(secret: string, content: string): string {
  return createHmac("sha256", secret).update(content).digest("hex");
}

function createManifestContentHmac(
  secret: string,
  sections: readonly CompiledContextSection[],
): string {
  return createContentHmac(
    secret,
    sections
      .map(
        (section) =>
          [
            section.ordinal,
            section.key,
            section.reference,
            section.budgetTokens ?? "unbounded",
            section.selectedTokens,
            section.truncatable,
            section.contentHmac,
          ].join(":"),
      )
      .join("\n"),
  );
}

function assertSupportedPolicyVersions(
  versions: ContextPolicyVersions,
): void {
  // The exact-match allowlist covers the static policy layers; the identity
  // layers (persona blocks, locale pack, task instruction) are resolved
  // fail-closed from the versioned prompt-artifact registry instead.
  const supported = {
    outputFormatVersion: "conversation-output:v1",
    productPolicyVersion: "product-policy:v1",
    relationshipPolicyVersion: "relationship-boundary:v1",
    safetyPolicyVersion: "minimum-high-risk-response:v1",
  };
  for (const key of Object.keys(supported) as Array<keyof typeof supported>) {
    if (versions[key] !== supported[key]) {
      throw new CompiledContextIntegrityError();
    }
  }
}

function sectionsMatch(
  expected: readonly CompiledContextSection[],
  actual: readonly CompiledContextSection[],
): boolean {
  return (
    expected.length === actual.length &&
    expected.every((section, index) => {
      const candidate = actual[index];
      return (
        candidate !== undefined &&
        section.budgetTokens === candidate.budgetTokens &&
        section.key === candidate.key &&
        section.ordinal === candidate.ordinal &&
        section.reference === candidate.reference &&
        section.selectedTokens === candidate.selectedTokens &&
        section.truncatable === candidate.truncatable &&
        hmacMatches(section.contentHmac, candidate.contentHmac)
      );
    })
  );
}

function hmacMatches(expected: string, actual: string): boolean {
  if (!/^[a-f0-9]{64}$/.test(expected) || !/^[a-f0-9]{64}$/.test(actual)) {
    return false;
  }
  return timingSafeEqual(
    Buffer.from(expected, "hex"),
    Buffer.from(actual, "hex"),
  );
}

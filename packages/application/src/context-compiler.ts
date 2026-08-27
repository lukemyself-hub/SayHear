import { createHmac, timingSafeEqual } from "node:crypto";
import { randomUUID } from "node:crypto";

import {
  resolvePromptArtifacts,
  resolveSafetyPostureReducedPersona,
  SAFETY_POSTURE_REDUCED_PERSONA_VERSION,
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
import type {
  ConversationActionAdmission,
  ConversationActionExecution,
} from "./conversation-action-gateway";

export type ActionFinalizationReceiptSnapshot = Readonly<{
  admission: ConversationActionAdmission;
  disposition: string | null;
  execution: ConversationActionExecution;
  sequence: number;
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
  | "fast_path_pending"
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
              : source.fastPathPending === true
                ? "fast_path_pending"
                : null;
      const contentHmac = createManifestContentHmac(
        dependencies.contentHmacSecret,
        sections,
      );
      const actionReferenceHandles = (source.actionReferenceTargets ?? []).map(
        (target) => ({
          actionKinds: target.actionKinds,
          handle: `shh-handle-${randomUUID()}`,
          targetKind: target.targetKind,
          targetId: target.targetId,
          targetVersionId: target.targetVersionId,
          sourceRevision: target.sourceRevision,
        }),
      );

      return dependencies.repository.saveCompiledContext({
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
      if (
        currentInputs.length !== 1 ||
        !currentInput ||
        currentInput.actor !== "user" ||
        !dailySessionReference ||
        rawEventBudget === null ||
        rawEventBudget === undefined ||
        (dialogueStateSection && !dialogueStateSection.reference) ||
        (stopSignalSection && !stopSignalSection.reference) ||
        (safetyPostureSection && !safetyPostureSection.reference)
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

function renderActionFinalizationReceipt(
  receipt: ActionFinalizationReceiptSnapshot,
): string {
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

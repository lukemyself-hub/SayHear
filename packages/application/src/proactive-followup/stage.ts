import type {
  CompiledContextId,
  GenerationCommandId,
  ModelRunAttemptId,
  UserId,
} from "@sayhear/domain";

import type { CompleteResponseMetadata } from "../conversation-response";
import {
  ProviderDispatchError,
  type ProviderDispatchErrorCategory,
} from "../conversation-model";
import type {
  ModelRoleCommandService,
  ModelRoleProviderEgress,
} from "../model-role-runtime";
import { selectProactiveFollowupTarget } from "./selection";
import {
  PROACTIVE_FOLLOWUP_COMMIT_POLICY_VERSION,
  PROACTIVE_FOLLOWUP_DIALOGUE_CONFIDENCE_FLOOR,
  PROACTIVE_FOLLOWUP_EXPRESSION_POLICY_VERSION,
  PROACTIVE_FOLLOWUP_EXPRESSION_PROMPT_VERSION,
  PROACTIVE_FOLLOWUP_MANIFEST_VERSION,
  PROACTIVE_FOLLOWUP_MAX_CANDIDATES,
  PROACTIVE_FOLLOWUP_OPPORTUNITY_POLICY_VERSION,
  PROACTIVE_FOLLOWUP_OPEN_LOOP_LANE_MANIFEST_VERSION,
  PROACTIVE_FOLLOWUP_POLICY_BUNDLE_VERSION,
  PROACTIVE_FOLLOWUP_REASON_CODE_SCHEMA_VERSION,
  PROACTIVE_FOLLOWUP_SELECTION_POLICY_VERSION,
  PROACTIVE_FOLLOWUP_SUPPRESSION_POLICY_VERSION,
  PROACTIVE_FOLLOWUP_USE_SCHEMA_VERSION,
  type ProactiveFollowupCandidate,
  type ProactiveFollowupDialogueSnapshot,
  type ProactiveFollowupLaneSnapshot,
  type ProactiveFollowupOpportunityKind,
  type ProactiveFollowupSelectionManifest,
  type ProactiveFollowupStateSnapshot,
  type ProactiveFollowupTargetKind,
} from "./types";
import {
  classifyProactiveFollowupProviderError,
  validateProactiveFollowupDispositionModelOutput,
  validateProactiveFollowupSegmentModelOutput,
  type ProactiveFollowupModelProvider,
} from "./provider";
import type {
  ProactiveFollowupSegmentAbandonReason,
  ProactiveFollowupSegmentGeneration,
  ProactiveFollowupSegmentPlan,
  ProactiveFollowupSegmentPreparationInput,
  ProactiveFollowupSegmentStage,
} from "./segment";

/**
 * Application-owned `proactive.followup` segment lane (issue #207 layer 2c,
 * SPEC ch.7, ADR-0044).
 *
 * prepare() assembles the deterministic selection input from injected
 * content-free readers, runs the pure selector, admits one Segment
 * GenerationCommand through the model-role command service, reserves the
 * exchange, binds the command, and compiles the segment context. generate()
 * renders the isolated segment through the role provider behind the shared
 * egress fences; the atomic use commit stays with the response repository.
 * abandon() terminalizes the reservation and the segment command so a failed
 * segment never blocks its exchange. Every failure omits the segment and
 * preserves the main response.
 */

export type ProactiveFollowupTurnContext = Readonly<{
  dailySessionId: string;
  continuousExchangeNo: number;
  currentUserEventSequence: number;
  currentSourceRevision: number;
  dialogueRevision: number;
  expectedDataEpoch: number;
  timeZone: string;
  interactionTurnId: string;
  locale: string;
}>;

export type ProactiveFollowupPendingUse = Readonly<{
  useId: string;
  assistantEventRevisionId: string;
  targetKind: ProactiveFollowupTargetKind;
  targetId: string;
  targetVersionId: string;
  promptUserEventSequence: number;
  promptDailySessionId: string;
}>;

export type ProactiveFollowupReservationStore = Readonly<{
  reserveSelection(input: Readonly<{
    userId: string;
    expectedDataEpoch: number;
    dailySessionId: string;
    continuousExchangeNo: number;
    mainGenerationCommandId: string;
    target: Readonly<{
      targetKind: ProactiveFollowupTargetKind;
      targetId: string;
      targetVersionId: string;
    }>;
    manifest: ProactiveFollowupSelectionManifest;
    now: Date;
  }>): Promise<
    | Readonly<{
        outcome: "reserved" | "already_reserved";
        reservationId: string;
        targetKind: ProactiveFollowupTargetKind;
        targetId: string;
        targetVersionId: string;
      }>
    | Readonly<{ outcome: "fenced"; reason: string }>
  >;
  bindSegmentCommand(input: Readonly<{
    userId: string;
    expectedDataEpoch: number;
    reservationId: string;
    mainGenerationCommandId: string;
    segmentGenerationCommandId: string;
    now: Date;
  }>): Promise<
    Readonly<{ outcome: "bound" | "already_bound" | "fenced"; reason?: string }>
  >;
  abandonSegment(input: Readonly<{
    userId: string;
    expectedDataEpoch: number;
    reservationId: string;
    mainGenerationCommandId: string;
    segmentGenerationCommandId: string;
    now: Date;
  }>): Promise<void>;
  recordDisposition(input: Readonly<{
    userId: string;
    expectedDataEpoch: number;
    useId: string;
    targetKind: ProactiveFollowupTargetKind;
    targetId: string;
    targetVersionId: string;
    triggerUserEventRevisionId: string;
    triggerUserEventSequence: number;
    signal:
      | "no_stop_signal"
      | "short_response"
      | "evaded"
      | "refused"
      | "topic_changed";
    finalTextLocator: Readonly<{
      kind: "assistant_event_revision";
      assistantEventRevisionId: string;
      segment: "proactive_followup";
      ordinal: 0;
    }>;
    timeZone: string;
    now: Date;
  }>): Promise<
    | Readonly<{ outcome: "recorded" | "already_recorded"; stateVersionId: string | null }>
    | Readonly<{ outcome: "fenced"; reason: string }>
  >;
}>;

export type ProactiveFollowupStageReaders = Readonly<{
  readTurnContext(input: Readonly<{
    userId: UserId;
    requestEventRevisionId: string;
    mainGenerationCommandId: string;
  }>): Promise<ProactiveFollowupTurnContext | null>;
  readDialogue(input: Readonly<{
    userId: UserId;
    turn: ProactiveFollowupTurnContext;
    requestEventRevisionId: string;
  }>): Promise<ProactiveFollowupDialogueSnapshot | null>;
  readOpenLane(input: Readonly<{
    userId: UserId;
    turn: ProactiveFollowupTurnContext;
    requestEventRevisionId: string;
    now: Date;
  }>): Promise<ProactiveFollowupLaneSnapshot>;
  /**
   * Deterministic target rendering for the provider request. Null when the
   * lane carries no rendering; the model then renders a generic caring
   * expression without inventing facts.
   */
  readTargetSummary(input: Readonly<{
    userId: UserId;
    targetKind: ProactiveFollowupTargetKind;
    targetId: string;
    targetVersionId: string;
    now: Date;
  }>): Promise<string | null>;
  readStates(input: Readonly<{
    userId: UserId;
    candidates: readonly Readonly<{
      targetKind: ProactiveFollowupTargetKind;
      targetId: string;
    }>[];
    now: Date;
  }>): Promise<readonly ProactiveFollowupStateSnapshot[]>;
  readEventRevisionText(input: Readonly<{
    userId: UserId;
    revisionId: string;
  }>): Promise<Readonly<{ text: string }> | null>;
  listUsesAwaitingDisposition(input: Readonly<{
    userId: UserId;
    limit?: number;
  }>): Promise<readonly ProactiveFollowupPendingUse[]>;
}>;

export type ProactiveFollowupSegmentCompiler = Readonly<{
  compileSegmentContext(input: Readonly<{
    generationCommandId: GenerationCommandId;
    interactionTurnId: string;
    userId: UserId;
  }>): Promise<CompiledContextId>;
}>;

/**
 * Frozen policy bundle snapshot pinned into every plan. The manifest already
 * pins each component version; the bundle carries the mechanical values those
 * versions froze so a run stays interpretable without re-resolving code.
 */
export const PROACTIVE_FOLLOWUP_STAGE_POLICY_BUNDLE: Readonly<
  Record<string, unknown>
> = Object.freeze({
  policyBundleVersion: PROACTIVE_FOLLOWUP_POLICY_BUNDLE_VERSION,
  opportunityPolicyVersion: PROACTIVE_FOLLOWUP_OPPORTUNITY_POLICY_VERSION,
  selectionPolicyVersion: PROACTIVE_FOLLOWUP_SELECTION_POLICY_VERSION,
  suppressionPolicyVersion: PROACTIVE_FOLLOWUP_SUPPRESSION_POLICY_VERSION,
  commitPolicyVersion: PROACTIVE_FOLLOWUP_COMMIT_POLICY_VERSION,
  useSchemaVersion: PROACTIVE_FOLLOWUP_USE_SCHEMA_VERSION,
  expressionPromptVersion: PROACTIVE_FOLLOWUP_EXPRESSION_PROMPT_VERSION,
  expressionPolicyVersion: PROACTIVE_FOLLOWUP_EXPRESSION_POLICY_VERSION,
  reasonCodeSchemaVersion: PROACTIVE_FOLLOWUP_REASON_CODE_SCHEMA_VERSION,
  selectionManifestVersion: PROACTIVE_FOLLOWUP_MANIFEST_VERSION,
  openLoopLaneManifestVersion:
    PROACTIVE_FOLLOWUP_OPEN_LOOP_LANE_MANIFEST_VERSION,
  dialogueConfidenceFloor: PROACTIVE_FOLLOWUP_DIALOGUE_CONFIDENCE_FLOOR,
  maxCandidates: PROACTIVE_FOLLOWUP_MAX_CANDIDATES,
});

const MEMORY_LANE_DISABLED: ProactiveFollowupLaneSnapshot = {
  name: "memory",
  enabled: false,
  status: "unavailable",
  watermark: null,
  manifestVersion: "memory-retrieval:v1",
  integrity: "valid",
  candidates: [],
};

type FrozenSegmentInput = Readonly<{
  mainText: string;
  targetSummary: string | null;
  /**
   * No sensitivity marker exists on the open-loop lane in 2c scope, so an
   * unknown sensitivity stays conservative (gentle framing, ranked last).
   * A dedicated sensitivity source must replace this default.
   */
  targetSensitive: boolean;
  sourceRevision: number;
  locale: string;
  opportunity: ProactiveFollowupOpportunityKind;
}>;

export class InvalidProactiveFollowupSegmentError extends Error {
  public constructor(reason: string) {
    super(`Invalid proactive followup segment: ${reason}`);
    this.name = "InvalidProactiveFollowupSegmentError";
  }
}

function asUserIdString(userId: UserId): string {
  return String(userId);
}

export function createProactiveFollowupSegmentStage(dependencies: Readonly<{
  clock: () => Date;
  modelRoleCommandService: Pick<
    ModelRoleCommandService,
    "admit" | "configuration" | "discardAttempt" | "recordAttemptResult"
  >;
  providerEgress: ModelRoleProviderEgress;
  provider: ProactiveFollowupModelProvider;
  readers: ProactiveFollowupStageReaders;
  reservations: ProactiveFollowupReservationStore;
  compiler: ProactiveFollowupSegmentCompiler;
  /**
   * Conservative selection opportunity. Production stays on `natural_gap`:
   * with the memory candidate pipeline deferred, only open-loop candidates
   * can occur, so the greeting/open-start lane-precedence difference is
   * behavior-neutral; the dialogue focus gate remains the real guard against
   * interrupting task-focused turns. A DialogueState-content mapping must
   * replace this default when the memory lane lands.
   */
  opportunity?: ProactiveFollowupOpportunityKind;
}>): ProactiveFollowupSegmentStage {
  const opportunity = dependencies.opportunity ?? "natural_gap";
  // Frozen provider inputs retained between prepare and generate. In-memory
  // only by design: generate always follows prepare in one harness execution,
  // and a lost entry fails closed (generate throws, the segment is omitted).
  // Retry starts a new main Command and rebuilds via a new prepare.
  const frozenInputs = new Map<string, FrozenSegmentInput>();

  function rememberFrozenInput(reservationId: string, input: FrozenSegmentInput): void {
    if (frozenInputs.size >= 128) {
      const oldest = frozenInputs.keys().next();
      if (!oldest.done) frozenInputs.delete(oldest.value);
    }
    frozenInputs.set(reservationId, input);
  }

  async function settlePendingDisposition(input: {
    userId: UserId;
    turn: ProactiveFollowupTurnContext;
    requestEventRevisionId: string;
    now: Date;
  }): Promise<void> {
    const uses = await dependencies.readers.listUsesAwaitingDisposition({
      userId: input.userId,
      limit: 5,
    });
    const pending = uses.find(
      (use) =>
        use.promptDailySessionId === input.turn.dailySessionId &&
        use.promptUserEventSequence < input.turn.currentUserEventSequence,
    );
    if (!pending) return;
    const configuration = dependencies.modelRoleCommandService.configuration(
      "proactive.followup",
    );
    if (!configuration) return;
    const [userEvent, segmentRevision] = await Promise.all([
      dependencies.readers.readEventRevisionText({
        userId: input.userId,
        revisionId: input.requestEventRevisionId,
      }),
      dependencies.readers.readEventRevisionText({
        userId: input.userId,
        revisionId: pending.assistantEventRevisionId,
      }),
    ]);
    if (!userEvent || !segmentRevision) return;
    const admitted = await dependencies.modelRoleCommandService.admit({
      userId: input.userId,
      role: "proactive.followup",
      intentKey: `proactive-followup-disposition:${pending.useId}:${input.requestEventRevisionId}`,
      subjectType: "conversation_event_revision",
      subjectId: input.requestEventRevisionId,
      sourceRevision: input.turn.currentSourceRevision,
      sourceSnapshot: `proactive-followup-disposition:${input.requestEventRevisionId}`,
      inputManifest: [
        {
          key: `event:${input.requestEventRevisionId}`,
          revision: input.turn.currentSourceRevision,
          fingerprint: `event-revision:${input.requestEventRevisionId}`,
        },
      ],
      expectedDataEpoch: input.turn.expectedDataEpoch,
      now: input.now,
    });
    let signal:
      | "no_stop_signal"
      | "short_response"
      | "evaded"
      | "refused"
      | "topic_changed";
    try {
      const output = await dependencies.providerEgress.dispatch({
        userId: input.userId,
        generationCommandId: admitted.generationCommandId,
        modelRunAttemptId: admitted.modelRunAttemptId,
        role: "proactive.followup",
        attemptNo: admitted.attemptNo,
        attemptKind: admitted.attemptKind,
        rolloutPin: configuration.rolloutPin,
        currentSourceRevision: input.turn.currentSourceRevision,
        expectedDataEpoch: input.turn.expectedDataEpoch,
        now: dependencies.clock(),
        execute: () =>
          dependencies.provider.classifyDisposition({
            userId: input.userId,
            locale: input.turn.locale,
            userText: userEvent.text,
            segmentText: segmentRevision.text,
            use: {
              useId: pending.useId,
              assistantEventRevisionId: pending.assistantEventRevisionId,
              targetKind: pending.targetKind,
              targetId: pending.targetId,
              targetVersionId: pending.targetVersionId,
            },
            finalTextLocator: {
              kind: "assistant_event_revision",
              assistantEventRevisionId: pending.assistantEventRevisionId,
              segment: "proactive_followup",
              ordinal: 0,
            },
          }),
      });
      const validation = validateProactiveFollowupDispositionModelOutput({
        request: {
          userId: input.userId,
          locale: input.turn.locale,
          userText: userEvent.text,
          segmentText: segmentRevision.text,
          use: {
            useId: pending.useId,
            assistantEventRevisionId: pending.assistantEventRevisionId,
            targetKind: pending.targetKind,
            targetId: pending.targetId,
            targetVersionId: pending.targetVersionId,
          },
          finalTextLocator: {
            kind: "assistant_event_revision",
            assistantEventRevisionId: pending.assistantEventRevisionId,
            segment: "proactive_followup",
            ordinal: 0,
          },
        },
        output,
      });
      if (validation.outcome !== "valid") {
        throw new ProviderDispatchError("invalid_response", undefined, true);
      }
      signal = output.signal as typeof signal;
    } catch (error) {
      if (
        error instanceof ProviderDispatchError &&
        !error.settlesAttempt
      ) {
        // Egress fence (recovery/stale/pin): leave the use unsettled; the
        // target stays closed and a later turn retries with its own trigger.
        return;
      }
      const failureCode = classifyProactiveFollowupProviderError(error);
      await dependencies.modelRoleCommandService.recordAttemptResult({
        userId: input.userId,
        generationCommandId: admitted.generationCommandId,
        modelRunAttemptId: admitted.modelRunAttemptId,
        role: "proactive.followup",
        attemptNo: admitted.attemptNo,
        technicalRetriesUsed: 0,
        semanticRepairsUsed: 0,
        outcome: "failed",
        failureCode,
        currentSourceRevision: input.turn.currentSourceRevision,
        expectedDataEpoch: input.turn.expectedDataEpoch,
        now: dependencies.clock(),
      });
      return;
    }
    const recorded = await dependencies.reservations.recordDisposition({
      userId: asUserIdString(input.userId),
      expectedDataEpoch: input.turn.expectedDataEpoch,
      useId: pending.useId,
      targetKind: pending.targetKind,
      targetId: pending.targetId,
      targetVersionId: pending.targetVersionId,
      triggerUserEventRevisionId: input.requestEventRevisionId,
      triggerUserEventSequence: input.turn.currentUserEventSequence,
      signal,
      finalTextLocator: {
        kind: "assistant_event_revision",
        assistantEventRevisionId: pending.assistantEventRevisionId,
        segment: "proactive_followup",
        ordinal: 0,
      },
      timeZone: input.turn.timeZone,
      now: dependencies.clock(),
    });
    await dependencies.modelRoleCommandService.recordAttemptResult({
      userId: input.userId,
      generationCommandId: admitted.generationCommandId,
      modelRunAttemptId: admitted.modelRunAttemptId,
      role: "proactive.followup",
      attemptNo: admitted.attemptNo,
      technicalRetriesUsed: 0,
      semanticRepairsUsed: 0,
      outcome: recorded.outcome === "fenced" ? "failed" : "succeeded",
      ...(recorded.outcome === "fenced"
        ? { failureCode: "business_fence" as const }
        : {}),
      currentSourceRevision: input.turn.currentSourceRevision,
      expectedDataEpoch: input.turn.expectedDataEpoch,
      now: dependencies.clock(),
    });
  }

  async function discardSegmentCommand(input: {
    userId: UserId;
    generationCommandId: GenerationCommandId;
    modelRunAttemptId: ModelRunAttemptId;
    now: Date;
  }): Promise<void> {
    try {
      await dependencies.modelRoleCommandService.discardAttempt({
        userId: input.userId,
        generationCommandId: input.generationCommandId,
        modelRunAttemptId: input.modelRunAttemptId,
        reason: "segment_abandoned",
        now: input.now,
      });
    } catch {
      // Best-effort: the outbox workflow reclaims a lingering command, and
      // the reservation abandon below already blocks the exchange's reuse.
    }
  }

  return {
    async prepare(
      input: ProactiveFollowupSegmentPreparationInput,
    ): Promise<ProactiveFollowupSegmentPlan | null> {
      const now = dependencies.clock();
      const configuration =
        dependencies.modelRoleCommandService.configuration(
          "proactive.followup",
        );
      if (!configuration) return null;
      const turn = await dependencies.readers.readTurnContext({
        userId: input.userId,
        requestEventRevisionId: String(input.requestEventRevisionId),
        mainGenerationCommandId: String(input.mainGenerationCommandId),
      });
      if (!turn) return null;
      try {
        await settlePendingDisposition({
          userId: input.userId,
          turn,
          requestEventRevisionId: String(input.requestEventRevisionId),
          now,
        });
      } catch {
        // Disposition is best-effort inside prepare: a failure never changes
        // the ordinary selection path, and the target stays closed meanwhile.
      }
      const dialogue = await dependencies.readers.readDialogue({
        userId: input.userId,
        turn,
        requestEventRevisionId: String(input.requestEventRevisionId),
      });
      if (!dialogue) return null;
      const openLane = await dependencies.readers.readOpenLane({
        userId: input.userId,
        turn,
        requestEventRevisionId: String(input.requestEventRevisionId),
        now,
      });
      const selectionInput = {
        userId: asUserIdString(input.userId),
        dailySessionId: turn.dailySessionId,
        continuousExchangeNo: turn.continuousExchangeNo,
        currentUserEventRevisionId: String(input.requestEventRevisionId),
        currentUserEventSequence: turn.currentUserEventSequence,
        currentSourceRevision: turn.currentSourceRevision,
        opportunity,
        ordinaryQuestionAlreadyAsked: input.ordinaryQuestionAlreadyAsked,
        dialogue,
        lanes: [openLane, MEMORY_LANE_DISABLED] as const,
        states: await dependencies.readers.readStates({
          userId: input.userId,
          candidates: [...openLane.candidates],
          now,
        }),
        now,
      };
      const selection = selectProactiveFollowupTarget({
        ...selectionInput,
        lanes: [...selectionInput.lanes],
      });
      if (selection.outcome !== "selected") return null;
      const admitted = await dependencies.modelRoleCommandService.admit({
        userId: input.userId,
        role: "proactive.followup",
        intentKey: `proactive-followup-segment:${String(input.mainGenerationCommandId)}`,
        subjectType: "conversation_event_revision",
        subjectId: String(input.requestEventRevisionId),
        sourceRevision: turn.currentSourceRevision,
        sourceSnapshot: `proactive-followup-segment:${String(input.requestEventRevisionId)}`,
        inputManifest: [
          {
            key: `event:${String(input.requestEventRevisionId)}`,
            revision: turn.currentSourceRevision,
            fingerprint: `event-revision:${String(input.requestEventRevisionId)}`,
          },
        ],
        expectedDataEpoch: turn.expectedDataEpoch,
        now,
      });
      const reserved = await dependencies.reservations.reserveSelection({
        userId: asUserIdString(input.userId),
        expectedDataEpoch: turn.expectedDataEpoch,
        dailySessionId: turn.dailySessionId,
        continuousExchangeNo: turn.continuousExchangeNo,
        mainGenerationCommandId: String(input.mainGenerationCommandId),
        target: {
          targetKind: selection.target.targetKind,
          targetId: selection.target.targetId,
          targetVersionId: selection.target.targetVersionId,
        },
        manifest: selection.manifest,
        now,
      });
      if (reserved.outcome === "fenced") {
        await discardSegmentCommand({
          userId: input.userId,
          generationCommandId: admitted.generationCommandId,
          modelRunAttemptId: admitted.modelRunAttemptId,
          now: dependencies.clock(),
        });
        return null;
      }
      const bound = await dependencies.reservations.bindSegmentCommand({
        userId: asUserIdString(input.userId),
        expectedDataEpoch: turn.expectedDataEpoch,
        reservationId: reserved.reservationId,
        mainGenerationCommandId: String(input.mainGenerationCommandId),
        segmentGenerationCommandId: String(admitted.generationCommandId),
        now,
      });
      if (bound.outcome === "fenced") {
        await discardSegmentCommand({
          userId: input.userId,
          generationCommandId: admitted.generationCommandId,
          modelRunAttemptId: admitted.modelRunAttemptId,
          now: dependencies.clock(),
        });
        return null;
      }
      const segmentCompiledContextId =
        await dependencies.compiler.compileSegmentContext({
          generationCommandId: admitted.generationCommandId,
          interactionTurnId: turn.interactionTurnId,
          userId: input.userId,
        });
      const selectedCandidate = openLane.candidates.find(
        (candidate) =>
          candidate.targetId === selection.target.targetId &&
          candidate.targetVersionId === selection.target.targetVersionId,
      );
      const targetSummary = await dependencies.readers.readTargetSummary({
        userId: input.userId,
        targetKind: selection.target.targetKind,
        targetId: selection.target.targetId,
        targetVersionId: selection.target.targetVersionId,
        now,
      });
      const plan: ProactiveFollowupSegmentPlan = {
        expectedDataEpoch: turn.expectedDataEpoch,
        interactionTurnId: input.interactionTurnId,
        mainGenerationCommandId: input.mainGenerationCommandId,
        promptUserEventRevisionId: input.requestEventRevisionId,
        promptUserEventSequence: turn.currentUserEventSequence,
        policyBundle: { ...PROACTIVE_FOLLOWUP_STAGE_POLICY_BUNDLE },
        policyBundleVersion: PROACTIVE_FOLLOWUP_POLICY_BUNDLE_VERSION,
        promptPolicyVersion: PROACTIVE_FOLLOWUP_EXPRESSION_PROMPT_VERSION,
        reservationId: reserved.reservationId,
        segmentCompiledContextId,
        segmentGenerationCommandId: admitted.generationCommandId,
        segmentModelRunAttemptId: admitted.modelRunAttemptId,
        selectionPolicyVersion: PROACTIVE_FOLLOWUP_SELECTION_POLICY_VERSION,
        targetId: selection.target.targetId,
        targetKind: selection.target.targetKind,
        targetVersionId: selection.target.targetVersionId,
        userId: input.userId,
      };
      rememberFrozenInput(reserved.reservationId, {
        mainText: input.mainText,
        targetSummary,
        targetSensitive: selectedCandidate?.sensitive ?? true,
        sourceRevision: turn.currentSourceRevision,
        locale: turn.locale,
        opportunity,
      });
      return plan;
    },

    async generate(
      plan: ProactiveFollowupSegmentPlan,
      signal?: AbortSignal,
    ): Promise<ProactiveFollowupSegmentGeneration> {
      void signal;
      const frozen = frozenInputs.get(plan.reservationId);
      if (!frozen) {
        throw new InvalidProactiveFollowupSegmentError("frozen_input");
      }
      const configuration =
        dependencies.modelRoleCommandService.configuration(
          "proactive.followup",
        );
      if (!configuration) {
        throw new InvalidProactiveFollowupSegmentError("lane_closed");
      }
      let output;
      try {
        output = await dependencies.providerEgress.dispatch({
          userId: plan.userId,
          generationCommandId: plan.segmentGenerationCommandId,
          modelRunAttemptId: plan.segmentModelRunAttemptId,
          role: "proactive.followup",
          // The role never retries, so the admitted command carries exactly
          // one initial attempt; redelivery reuses the same attempt row.
          attemptNo: 1,
          attemptKind: "initial",
          rolloutPin: configuration.rolloutPin,
          currentSourceRevision: frozen.sourceRevision,
          expectedDataEpoch: plan.expectedDataEpoch,
          now: dependencies.clock(),
          execute: () =>
            dependencies.provider.generateSegment({
              userId: plan.userId,
              locale: frozen.locale,
              mainText: frozen.mainText,
              targetKind: plan.targetKind,
              targetId: plan.targetId,
              targetVersionId: plan.targetVersionId,
              targetRef: {
                targetKind: plan.targetKind,
                targetId: plan.targetId,
                targetVersionId: plan.targetVersionId,
              },
              targetSummary: frozen.targetSummary,
              targetSensitive: frozen.targetSensitive,
              opportunity: frozen.opportunity,
            }),
        });
      } catch (error) {
        if (error instanceof ProviderDispatchError && !error.settlesAttempt) {
          throw new InvalidProactiveFollowupSegmentError("egress_fenced");
        }
        const category: ProviderDispatchErrorCategory =
          error instanceof ProviderDispatchError ? error.category : "unknown";
        throw new InvalidProactiveFollowupSegmentError(category);
      }
      const validation = validateProactiveFollowupSegmentModelOutput({
        request: {
          userId: plan.userId,
          locale: frozen.locale,
          mainText: frozen.mainText,
          targetKind: plan.targetKind,
          targetId: plan.targetId,
          targetVersionId: plan.targetVersionId,
          targetRef: {
            targetKind: plan.targetKind,
            targetId: plan.targetId,
            targetVersionId: plan.targetVersionId,
          },
          targetSummary: frozen.targetSummary,
          targetSensitive: frozen.targetSensitive,
          opportunity: frozen.opportunity,
        },
        output,
      });
      if (validation.outcome !== "valid") {
        throw new InvalidProactiveFollowupSegmentError(validation.reason);
      }
      const metadata: CompleteResponseMetadata = {
        // The provider throws on any snapshot mismatch, so a returned output
        // guarantees the live snapshot equaled the frozen pin read here.
        modelSnapshot: configuration.modelSnapshot,
        finishReason: "completed",
        inputTokens: null,
        outputTokens: null,
        costMicros: null,
        providerRequestId: null,
      };
      return { metadata, output };
    },

    async abandon(
      plan: ProactiveFollowupSegmentPlan,
      reason: ProactiveFollowupSegmentAbandonReason,
    ): Promise<void> {
      void reason;
      frozenInputs.delete(plan.reservationId);
      try {
        await dependencies.reservations.abandonSegment({
          userId: asUserIdString(plan.userId),
          expectedDataEpoch: plan.expectedDataEpoch,
          reservationId: plan.reservationId,
          mainGenerationCommandId: String(plan.mainGenerationCommandId),
          segmentGenerationCommandId: String(plan.segmentGenerationCommandId),
          now: dependencies.clock(),
        });
      } catch {
        // Best-effort: the recovery scan reconciles a lingering reservation.
      }
      await discardSegmentCommand({
        userId: plan.userId,
        generationCommandId: plan.segmentGenerationCommandId,
        modelRunAttemptId: plan.segmentModelRunAttemptId,
        now: dependencies.clock(),
      });
    },
  };
}

export type ProactiveFollowupMaintenanceService = Readonly<{
  scan(): Promise<Readonly<{ reconciled: number }>>;
}>;

export function createProactiveFollowupMaintenanceService(input: Readonly<{
  reconcileTerminalReservations(input: Readonly<{
    now: Date;
    limit?: number;
  }>): Promise<number>;
  clock?: () => Date;
}>): ProactiveFollowupMaintenanceService {
  const clock = input.clock ?? (() => new Date());
  return {
    async scan() {
      const reconciled = await input.reconcileTerminalReservations({
        now: clock(),
      });
      return { reconciled };
    },
  };
}

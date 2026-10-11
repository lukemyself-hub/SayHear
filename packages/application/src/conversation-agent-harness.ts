import type {
  CompiledContextId,
  ConversationEventId,
  ConversationEventRevisionId,
  GenerationCommandId,
  InteractionTurnId,
  ModelRunAttemptId,
  UserId,
} from "@sayhear/domain";
import {
  asGenerationCommandId,
  asModelRunAttemptId,
} from "@sayhear/domain";

import type {
  CompleteResponseMetadata,
  ConversationResponseRepository,
} from "./conversation-response";
import type { ContextCompiler } from "./context-compiler";
import type {
  ActionReferenceHandle,
  ConversationActionCatalog,
  ConversationHarnessPolicy,
} from "./conversation-action-catalog";
import {
  actionDefinitionsForCatalog,
  conversationFunctionsForActionDefinitions,
  validateConversationActionCatalog,
} from "./conversation-action-catalog";
import type { ConversationActionGateway } from "./conversation-action-gateway";
import type {
  ConversationActionFinalizationCommand,
  ConversationActionReceipt,
} from "./conversation-action-gateway";
import type { ConversationActionProposal } from "./conversation-action-catalog";
import {
  CURIOSITY_STOP_SIGNAL_FUNCTION,
  CURIOSITY_STOP_SIGNAL_MAX_PROPOSALS_PER_TURN,
  type CuriosityStopSignalProposal,
} from "./curiosity-stop-signal";
import {
  HISTORY_REVIEW_FUNCTION,
  type HistoryAnswerCommandRef,
  type HistoryQueryProposal,
  type HistoryRecallGateway,
  type HistoryRecallReceipt,
} from "./history-recall";
import {
  ProviderDispatchError,
  type ProviderDispatchErrorCategory,
  type ProviderEgressPort,
} from "./conversation-model";
import type { RequestDeadline } from "./request-deadline";

/**
 * The application-owned Conversation Agent Harness (ADR-0093, ADR-0094).
 *
 * The Harness owns the bounded execution of one Conversation Decision Command:
 * it consumes the Provider Egress stream, distinguishes an ordinary Final
 * Response from a provider-native tool selection, atomically commits the
 * Complete Assistant Response, and runs the same-Command technical retry loop.
 * It does not own the Conversation, Memory, Journal, Profile, Entity, or any
 * long-term product state, and it is not a generic Agent Framework.
 *
 * The seam is application-owned. The caller (ConversationResponseService)
 * submits the frozen Decision Command, the already-compiled CompiledContext
 * reference, the immutable Catalog, and the Harness Policy; it consumes only the
 * user-visible decision stream. Provider messages, raw tool-call objects,
 * Framework sessions, and adapter types never cross this seam (issue #24 AC6).
 *
 * Issue #24 prefactors the existing response-only Text path behind this
 * interface without enabling any Conversation Action. The initial Catalog is
 * empty, so a tool_call selection fails closed and creates no product mutation
 * or fabricated success response (AC8). #25 admits the first Action.
 */

/**
 * The narrow execution surface the Harness reads from the response repository.
 * It is a `Pick` of ConversationResponseRepository rather than a fourth
 * interface, so the single Postgres repository satisfies both roles without a
 * new public type. Only the methods the Decision execution owns are required.
 */
export type ConversationAgentHarnessRepository = Pick<
  ConversationResponseRepository,
  | "claimResponseExecution"
  | "checkResponseFreshness"
  | "claimStaleResponseExecution"
  | "commitActionDecision"
  | "commitCompleteResponse"
  | "loadResponse"
  | "settleResponseFailure"
>;

/**
 * The existing-response projection the Harness replays when another owner
 * already finalized the attempt. It mirrors ConversationResponseRepository's
 * loadResponse return shape.
 */
type ExistingConversationResponse =
  | Readonly<{
      createdAt: string;
      eventId: ConversationEventId;
      outcome: "committed";
      revisionId: ConversationEventRevisionId;
      text: string;
    }>
  | Readonly<{ outcome: "prepared" | "running" }>
  | Readonly<{
      category: ProviderDispatchErrorCategory;
      outcome: "failed" | "interrupted";
    }>;

/**
 * The frozen identity of one Decision Command the Harness executes. The Service
 * has already committed the User Event, created the InteractionTurn, the
 * Decision GenerationCommand, and the first ModelRunAttempt, and compiled the
 * CompiledContext. The Harness receives references to all of these — it never
 * reconstructs or re-freezes them.
 */
export type ConversationDecisionCommand = Readonly<{
  actionReferenceHandles?: readonly ActionReferenceHandle[];
  catalog: ConversationActionCatalog;
  catalogVersion: string;
  compiledContextId: CompiledContextId;
  /**
   * The request's absolute deadline (issue #319). Every step the Harness
   * starts, including backoff and the acceptance commit, shares what is left;
   * after it passes nothing new starts and no late result is shown or kept.
   */
  deadline?: RequestDeadline;
  generationCommandId: GenerationCommandId;
  harnessPolicy: ConversationHarnessPolicy;
  interactionTurnId: InteractionTurnId;
  modelRunAttemptId: ModelRunAttemptId;
  requestEventRevisionId?: ConversationEventRevisionId;
  userId: UserId;
}>;

/**
 * The internal stream the Harness produces for one Decision execution. The
 * ConversationResponseService maps these onto the public response stream, so the
 * NDJSON wire contract and the BFF handlers are untouched (issue #24 AC10).
 */
export type ConversationHarnessEvent =
  | Readonly<{ delta: string; type: "decision_delta" }>
  | Readonly<{
      /**
       * The authoritative commit instant of the Assistant Event
       * (`conversation_events.created_at`, ISO 8601 UTC), surfaced from the
       * repository commit so the response stream can carry it without a new
       * clock read.
       */
      assistantCreatedAt: string;
      assistantEventId: ConversationEventId;
      assistantEventRevisionId: ConversationEventRevisionId;
      type: "decision_committed";
    }>
  | Readonly<{
      category: ProviderDispatchErrorCategory;
      interrupted: boolean;
      type: "decision_failed";
    }>
  | Readonly<{
      receipt: ConversationActionReceipt;
      type: "action_admitted";
    }>
  | Readonly<{
      /**
       * The Decision ended in a controlled read-only history query that was
       * executed and frozen; the caller now runs the History Answer command.
       */
      receipt: HistoryRecallReceipt;
      type: "history_recall_admitted";
    }>;

export type ConversationAgentHarness = Readonly<{
  /**
   * Execute one Decision Command. The Harness streams user-visible deltas while
   * no token may yet have been shown, then either commits the Complete
   * Assistant Response atomically or fails. Technical retries add
   * ModelRunAttempts under the same Decision Command; they never start a second
   * logical model stage, append an Action, or form an autonomous tool loop
   * (ADR-0094). A tool_call against the frozen Catalog fails closed.
   */
  runDecision(
    command: ConversationDecisionCommand,
    signal?: AbortSignal,
  ): AsyncIterable<ConversationHarnessEvent>;
  runFinalization?(
    command: ConversationDecisionCommand,
    signal?: AbortSignal,
  ): AsyncIterable<ConversationHarnessEvent>;
  /**
   * Run the independent History Answer command (issue #314): its own frozen
   * Context, tools disabled, the ordinary Complete Response acceptance point.
   */
  runHistoryAnswerCommand?(
    command: HistoryAnswerCommandRef,
    input: Readonly<{
      catalog: ConversationActionCatalog;
      deadline?: RequestDeadline;
      harnessPolicy: ConversationHarnessPolicy;
    }>,
    signal?: AbortSignal,
  ): AsyncIterable<ConversationHarnessEvent>;
  runFinalizationCommand?(
    command: ConversationActionFinalizationCommand,
    input: Readonly<{
      catalog: ConversationActionCatalog;
      deadline?: RequestDeadline;
      harnessPolicy: ConversationHarnessPolicy;
    }>,
    signal?: AbortSignal,
  ): AsyncIterable<ConversationHarnessEvent>;
}>;

export function createConversationAgentHarness(dependencies: {
  clock: () => Date;
  delay?: (delayMs: number) => Promise<void>;
  actionGateway?: ConversationActionGateway;
  egressPort: ProviderEgressPort;
  /** Executes the controlled read-only history query (issue #314). */
  historyRecall?: HistoryRecallGateway;
  /**
   * Content-free note that a history proposal was dropped because a
   * Trust-Control Action won the same Decision (ADR-0092).
   */
  onHistoryQuerySuppressed?: (info: Readonly<{
    generationCommandId: string;
    reason: "trust_control_priority";
  }>) => void;
  jitter?: () => number;
  /**
   * How long one first-token freshness probe may take before it counts as
   * failed (default 1500 ms). Tests shorten it.
   */
  freshnessProbeTimeoutMs?: number;
  onUnexpectedFailure?: (failure: Readonly<{
    generationCommandId: string;
    stage: "provider" | "action_admission" | "action_commit" | "response_commit" | "history_admission";
    databaseErrorCode: string | null;
  }>) => void;
  contextCompiler?: Pick<ContextCompiler, "compile">;
  repository: ConversationAgentHarnessRepository;
}): ConversationAgentHarness {
  const delay =
    dependencies.delay ??
    ((delayMs: number) =>
      new Promise<void>((resolve) => setTimeout(resolve, delayMs)));
  const jitter = dependencies.jitter ?? Math.random;

  async function* runDecisionAttempt(
    command: ConversationDecisionCommand,
    signal?: AbortSignal,
  ): AsyncIterable<ConversationHarnessEvent> {
    let possiblyVisible = false;
    let completeText = "";
    let completion: CompleteResponseMetadata | null = null;
    let pendingActionProposal: ConversationActionProposal | null = null;
    let stage: "provider" | "action_admission" | "action_commit" | "response_commit" | "history_admission" = "provider";
    let pendingHistoryProposal: HistoryQueryProposal | null = null;
    let historySuppressed = false;
    const stopSignalProposals: CuriosityStopSignalProposal[] = [];

    const interrupt = createInterrupt(signal, command.deadline);
    // One read-only, idempotent probe, bounded by the request's own deadline
    // and cancellation and by a short timeout of its own.
    const probeFreshness = () =>
      interrupt.guard(
        withTimeout(
          Promise.resolve<"current" | "deadline_exceeded" | "superseded">(
            dependencies.repository.checkResponseFreshness?.({
              generationCommandId: command.generationCommandId,
              now: dependencies.clock(),
              userId: command.userId,
            }) ?? "current",
          ),
          dependencies.freshnessProbeTimeoutMs ?? FRESHNESS_PROBE_TIMEOUT_MS,
        ),
      );
    async function assertStillCurrent(): Promise<void> {
      let freshness: "current" | "deadline_exceeded" | "superseded";
      try {
        freshness = await probeFreshness();
      } catch (first) {
        // The request ended while probing: that is its own, final answer.
        if (first instanceof ProviderDispatchError) throw first;
        // A probe is a single query and usually fails for a moment only, so it
        // is asked once more. If it still cannot be answered the reply is not
        // shown: the Provider-side first token is already recorded, so the
        // attempt ends as an interruption (nothing displayed, nothing
        // committed, explicit Retry) and the unexpected-failure callback gets
        // the SQLSTATE. The commit fence remains the correctness guarantee.
        freshness = await probeFreshness();
      }
      if (freshness === "superseded") throw new ProviderDispatchError("aborted");
      if (freshness === "deadline_exceeded") throw new ProviderDispatchError("timeout");
    }
    try {
      interrupt.throwIfInterrupted();
      if (!validateConversationActionCatalog(command.catalog).valid) {
        throw new ProviderDispatchError("invalid_response");
      }
      let actionSeen = false;
      // The Eligible Definition set is the normalization space for any Catalog
      // Action selection (ADR-0095); the offered Function list derives from the
      // same frozen inputs. The stop-signal proposal function is a
      // behavior-proposal channel, not a Conversation Action; commits stay
      // deterministic (issue #74).
      const eligibleDefinitions =
        command.harnessPolicy.toolsDisabled === true
          ? []
          : actionDefinitionsForCatalog(
              command.catalog,
              command.actionReferenceHandles,
            );
      // The read-only history review is offered only when this Decision can
      // actually execute it: a history-enabled policy, a request revision to
      // fence on (not on Retry/recovery turns) and an execution gateway.
      const historyReviewOffered =
        command.harnessPolicy.toolsDisabled !== true &&
        command.harnessPolicy.maxHistoryQueries === 1 &&
        command.requestEventRevisionId !== undefined &&
        dependencies.historyRecall !== undefined &&
        // Independent operator governance (#320): disabled means the function
        // is never offered and the turn is an ordinary reply.
        (await dependencies.historyRecall.isEnabled?.() ?? true);
      for await (const event of interrupt.race(dependencies.egressPort.stream({
        compiledContextId: command.compiledContextId,
        ...(command.requestEventRevisionId
          ? { requestEventRevisionId: command.requestEventRevisionId }
          : {}),
        definitions: eligibleDefinitions,
        functions:
          command.harnessPolicy.toolsDisabled === true
            ? []
            : [
                ...conversationFunctionsForActionDefinitions(
                  eligibleDefinitions,
                ),
                CURIOSITY_STOP_SIGNAL_FUNCTION,
                ...(historyReviewOffered ? [HISTORY_REVIEW_FUNCTION] : []),
              ],
        generationCommandId: command.generationCommandId,
        modelRunAttemptId: command.modelRunAttemptId,
        userId: command.userId,
        ...(interrupt.signal ? { signal: interrupt.signal } : {}),
        toolsDisabled: command.harnessPolicy.toolsDisabled === true,
      }))) {
        interrupt.throwIfInterrupted();
        if (event.type === "delta") {
          if (pendingActionProposal || pendingHistoryProposal) {
            throw new ProviderDispatchError("invalid_response");
          }
          if (!possiblyVisible) {
            // The first visible token is the point of no return: a retired
            // answer must not reach the screen (issue #319).
            await assertStillCurrent();
          }
          possiblyVisible = true;
          completeText += event.delta;
          yield { delta: event.delta, type: "decision_delta" };
        } else if (event.type === "tool_call") {
          // Provider-native events must be normalized by the Adapter before
          // reaching the application seam. A raw call is never admissible.
          throw new ProviderDispatchError("invalid_response");
        } else if (event.type === "action_proposal") {
          if (
            actionSeen ||
            stopSignalProposals.length > 0 ||
            completion !== null ||
            command.harnessPolicy.toolsDisabled === true ||
            !dependencies.actionGateway ||
            !command.requestEventRevisionId
          ) {
            throw new ProviderDispatchError("invalid_response");
          }
          actionSeen = true;
          if (pendingHistoryProposal !== null) {
            // ADR-0092: the Trust-Control Action wins deterministically.
            pendingHistoryProposal = null;
            historySuppressed = true;
          }
          const proposal = event.proposal;
          if (
            proposal.requestEventRevisionId !== command.requestEventRevisionId ||
            !command.catalog.definitions.some(
              (definition) => definition.actionKind === proposal.actionKind,
            )
          ) {
            throw new ProviderDispatchError("invalid_response");
          }
          pendingActionProposal = proposal;
        } else if (event.type === "history_query_proposal") {
          if (actionSeen || pendingActionProposal !== null) {
            // A Trust-Control Action already won this Decision; the read-only
            // proposal is dropped, never executed (ADR-0092).
            historySuppressed = true;
            continue;
          }
          if (
            !historyReviewOffered ||
            pendingHistoryProposal !== null ||
            completeText.length > 0 ||
            stopSignalProposals.length > 0 ||
            completion !== null
          ) {
            throw new ProviderDispatchError("invalid_response");
          }
          pendingHistoryProposal = event.proposal;
        } else if (event.type === "stop_signal_proposal") {
          if (
            actionSeen ||
            pendingActionProposal !== null ||
            pendingHistoryProposal !== null ||
            completion !== null ||
            command.harnessPolicy.toolsDisabled === true ||
            stopSignalProposals.length + event.proposals.length >
              CURIOSITY_STOP_SIGNAL_MAX_PROPOSALS_PER_TURN
          ) {
            throw new ProviderDispatchError("invalid_response");
          }
          stopSignalProposals.push(...event.proposals);
        } else {
          if (
            (pendingActionProposal || pendingHistoryProposal) &&
            event.type !== "completed"
          ) {
            throw new ProviderDispatchError("invalid_response");
          }
          completion = event;
        }
      }
      if (historySuppressed) {
        try {
          dependencies.onHistoryQuerySuppressed?.({
            generationCommandId: command.generationCommandId,
            reason: "trust_control_priority",
          });
        } catch {
          // Observability cannot change the Decision.
        }
      }
      interrupt.throwIfInterrupted();
      if (pendingActionProposal) {
        stage = "action_admission";
        const receipt = await dependencies.actionGateway!.admit({
          catalog: command.catalog,
          context: {
            compiledContextId: command.compiledContextId,
            decisionCommandId: command.generationCommandId,
            requestEventRevisionId: command.requestEventRevisionId!,
            userId: command.userId,
          },
          proposal: pendingActionProposal,
        });
        if (receipt.admission === "accepted" || receipt.finalization) {
          // The Decision produced a valid proposal that was evaluated; its
          // command and attempt end here whatever the admission was, so a
          // clarification or an honest "not found" reply (issue #312) cannot
          // leave the Decision running forever.
          stage = "action_commit";
          await dependencies.repository.commitActionDecision?.({
            completedAt: dependencies.clock(),
            generationCommandId: command.generationCommandId,
            modelRunAttemptId: command.modelRunAttemptId,
            userId: command.userId,
          });
        } else {
          // Turned down with no reply owed: nothing will ever answer this turn,
          // so settle it now instead of leaving it for the recovery window.
          stage = "action_commit";
          await dependencies.repository.settleResponseFailure({
            category: "policy_blocked",
            generationCommandId: command.generationCommandId,
            interrupted: false,
            jitter: normalizedJitter(jitter()),
            modelRunAttemptId: command.modelRunAttemptId,
            noRetry: true,
            settledAt: dependencies.clock(),
            userId: command.userId,
          });
        }
        yield { receipt, type: "action_admitted" };
        return;
      }
      if (pendingHistoryProposal !== null) {
        stage = "history_admission";
        // The lookup shares the request's deadline: it is bounded by what is
        // left of it, and the Harness stops waiting the moment it is reached.
        // A lookup that finishes later still meets the commit fence, which no
        // longer accepts a Decision that was settled as failed.
        const receipt = await interrupt.guard(
          dependencies.historyRecall!.admit({
            context: {
              decisionCommandId: command.generationCommandId,
              modelRunAttemptId: command.modelRunAttemptId,
              requestEventRevisionId: command.requestEventRevisionId!,
              userId: command.userId,
            },
            ...(command.deadline ? { deadline: command.deadline } : {}),
            proposal: pendingHistoryProposal,
          }),
        );
        if ("outcome" in receipt) {
          // The owner, epoch, request revision or Decision state no longer
          // permit the review: fail closed through the ordinary settlement.
          throw new ProviderDispatchError("policy_blocked");
        }
        yield { receipt, type: "history_recall_admitted" };
        return;
      }
      if (completion === null || completeText.length === 0) {
        throw new ProviderDispatchError("invalid_response");
      }

      interrupt.throwIfInterrupted();
      stage = "response_commit";
      const committed = await dependencies.repository.commitCompleteResponse({
        completedAt: dependencies.clock(),
        generationCommandId: command.generationCommandId,
        metadata: completion,
        modelRunAttemptId: command.modelRunAttemptId,
        ...(stopSignalProposals.length > 0
          ? { stopSignalProposals }
          : {}),
        text: completeText,
        userId: command.userId,
      });
      if (committed.outcome === "fence_rejected") {
        throw new ProviderDispatchError(
          committed.reason === "superseded"
            ? "aborted"
            : committed.reason === "deadline_exceeded"
              ? "timeout"
              : "policy_blocked",
        );
      }
      yield {
        assistantCreatedAt: committed.createdAt,
        assistantEventId: committed.eventId,
        assistantEventRevisionId: committed.revisionId,
        type: "decision_committed",
      };
    } catch (error) {
      if (!(error instanceof ProviderDispatchError)) {
        const code = error && typeof error === "object" && "code" in error ? error.code : null;
        // SQLSTATE is a fixed five-character code. Arbitrary messages, names,
        // details and Provider bodies never enter the diagnostic callback.
        const databaseErrorCode = typeof code === "string" && /^[0-9A-Z]{5}$/.test(code) ? code : null;
        try {
          dependencies.onUnexpectedFailure?.({ generationCommandId: command.generationCommandId, stage, databaseErrorCode });
        } catch {
          // Observability cannot prevent the existing failure settlement.
        }
      }
      if (error instanceof ProviderDispatchError && !error.settlesAttempt) {
        // Another owner already finalized this attempt; surface whatever it
        // committed without settling again.
        const response = await dependencies.repository.loadResponse({
          generationCommandId: command.generationCommandId,
          userId: command.userId,
        });
        yield* streamExistingDecision(response);
        return;
      }
      const category =
        error instanceof ProviderDispatchError ? error.category : "unknown";
      const interrupted = possiblyVisible || category === "unknown";
      // A request that ended (deadline or cancel) is never retried (#319).
      const requestEnded = interrupt.ended();
      const failure = await dependencies.repository.settleResponseFailure({
        category,
        generationCommandId: command.generationCommandId,
        interrupted,
        jitter: normalizedJitter(jitter()),
        modelRunAttemptId: command.modelRunAttemptId,
        ...(requestEnded ? { noRetry: true } : {}),
        settledAt: dependencies.clock(),
        userId: command.userId,
      });
      if (failure.outcome === "retry_scheduled") {
        try {
          await interrupt.sleep(
            delay,
            Math.max(
              0,
              failure.retryAt.getTime() - dependencies.clock().getTime(),
            ),
          );
        } catch (sleepError) {
          if (!(sleepError instanceof ProviderDispatchError)) throw sleepError;
          // The request ended while waiting to retry: close the pending retry
          // instead of resuming it later.
          const closed = await dependencies.repository.settleResponseFailure({
            category: sleepError.category,
            generationCommandId: command.generationCommandId,
            interrupted,
            jitter: normalizedJitter(jitter()),
            modelRunAttemptId: command.modelRunAttemptId,
            noRetry: true,
            settledAt: dependencies.clock(),
            userId: command.userId,
          });
          yield {
            category: closed.outcome === "settled" ? closed.category : sleepError.category,
            interrupted:
              closed.outcome === "settled" ? closed.status === "interrupted" : interrupted,
            type: "decision_failed",
          };
          return;
        }
        const recovery =
          await dependencies.repository.claimStaleResponseExecution({
            expectedModelRunAttemptId: command.modelRunAttemptId,
            generationCommandId: command.generationCommandId,
            now: failure.retryAt,
            userId: command.userId,
          });
        if (recovery.outcome === "execute") {
          // The scanner's claimStaleResponseExecution left the retried Command
          // in 'prepared'; the Provider Egress dispatch fence requires the
          // 'prepared' -> 'compiling' ownership transition before it admits a
          // new ModelRunAttempt. Re-claiming ownership is part of the same
          // request lifecycle the Harness owns for a single Decision (ADR-0094).
          // If another owner already finalized the retried Command, replay its
          // result instead of re-executing the Decision.
          const ownership =
            await dependencies.repository.claimResponseExecution({
              generationCommandId: recovery.generationCommandId,
              modelRunAttemptId: recovery.modelRunAttemptId,
              userId: command.userId,
            });
          if (ownership === "shared") {
            const response = await dependencies.repository.loadResponse({
              generationCommandId: recovery.generationCommandId,
              userId: command.userId,
            });
            yield* streamExistingDecision(response);
            return;
          }
          yield* runDecisionAttempt(
            {
              ...command,
              generationCommandId: recovery.generationCommandId,
              modelRunAttemptId: recovery.modelRunAttemptId,
            },
            signal,
          );
          return;
        }
      }
      const failureCategory =
        failure.outcome === "settled" ? failure.category : category;
      const failureInterrupted =
        failure.outcome === "settled" ? failure.status === "interrupted" : interrupted;
      yield {
        category: failureCategory,
        interrupted: failureInterrupted,
        type: "decision_failed",
      };
    }
  }

  const harnessApi: ConversationAgentHarness = {
    runDecision(command, signal) {
      return runDecisionAttempt(command, signal);
    },
    runFinalization(command, signal) {
      if (command.harnessPolicy.toolsDisabled !== true) {
        throw new Error("Action Finalization must disable tools.");
      }
      return runDecisionAttempt(command, signal);
    },
    async *runHistoryAnswerCommand(command, input, signal) {
      if (input.harnessPolicy.toolsDisabled !== true) {
        throw new Error("History Answer must disable tools.");
      }
      yield* runStageCommand(
        {
          generationCommandId: asGenerationCommandId(command.generationCommandId),
          interactionTurnId: command.interactionTurnId,
          modelRunAttemptId: asModelRunAttemptId(command.modelRunAttemptId),
          requestEventRevisionId: command.requestEventRevisionId,
          userId: command.userId,
        },
        input,
        signal,
      );
    },
    async *runFinalizationCommand(command, input, signal) {
      if (input.harnessPolicy.toolsDisabled !== true) {
        throw new Error("Action Finalization must disable tools.");
      }
      yield* runStageCommand(
        {
          generationCommandId: asGenerationCommandId(command.generationCommandId),
          interactionTurnId: command.interactionTurnId,
          modelRunAttemptId: asModelRunAttemptId(command.modelRunAttemptId),
          requestEventRevisionId: command.requestEventRevisionId,
          userId: command.userId,
        },
        input,
        signal,
      );
    },
  };

  async function* runStageCommand(
    command: Readonly<{
      generationCommandId: GenerationCommandId;
      interactionTurnId: InteractionTurnId;
      modelRunAttemptId: ModelRunAttemptId;
      requestEventRevisionId: ConversationEventRevisionId;
      userId: UserId;
    }>,
    input: Readonly<{
      catalog: ConversationActionCatalog;
      deadline?: RequestDeadline;
      harnessPolicy: ConversationHarnessPolicy;
    }>,
    signal?: AbortSignal,
  ): AsyncIterable<ConversationHarnessEvent> {
    {
      if (!dependencies.contextCompiler) {
        throw new Error("A stage command requires a Context Compiler.");
      }
      const ownership = await dependencies.repository.claimResponseExecution({
        generationCommandId: asGenerationCommandId(command.generationCommandId),
        modelRunAttemptId: asModelRunAttemptId(command.modelRunAttemptId),
        userId: command.userId,
      });
      if (ownership === "shared") {
        const existing = await dependencies.repository.loadResponse({
          generationCommandId: asGenerationCommandId(command.generationCommandId),
          userId: command.userId,
        });
        if (existing.outcome !== "running") {
          yield* streamExistingDecision(existing);
          return;
        }
        const recovery = await dependencies.repository.claimStaleResponseExecution({
          expectedModelRunAttemptId: asModelRunAttemptId(command.modelRunAttemptId),
          generationCommandId: asGenerationCommandId(command.generationCommandId),
          now: dependencies.clock(),
          userId: command.userId,
        });
        if (recovery.outcome !== "execute") {
          if (recovery.outcome !== "not_due") {
            yield* streamExistingDecision(
              await dependencies.repository.loadResponse({
                generationCommandId: asGenerationCommandId(command.generationCommandId),
                userId: command.userId,
              }),
            );
          }
          return;
        }
        command = {
          ...command,
          generationCommandId: recovery.generationCommandId,
          modelRunAttemptId: recovery.modelRunAttemptId,
        };
        const retryOwnership = await dependencies.repository.claimResponseExecution({
          generationCommandId: asGenerationCommandId(command.generationCommandId),
          modelRunAttemptId: asModelRunAttemptId(command.modelRunAttemptId),
          userId: command.userId,
        });
        if (retryOwnership === "shared") {
          yield* streamExistingDecision(
            await dependencies.repository.loadResponse({
              generationCommandId: asGenerationCommandId(command.generationCommandId),
              userId: command.userId,
            }),
          );
          return;
        }
      }
      const context = await dependencies.contextCompiler.compile({
        generationCommandId: asGenerationCommandId(command.generationCommandId),
        interactionTurnId: command.interactionTurnId,
        userId: command.userId,
      });
      yield* runDecisionAttempt(
        {
          ...(context.actionReferenceHandles === undefined
            ? {}
            : { actionReferenceHandles: context.actionReferenceHandles }),
          catalog: input.catalog,
          catalogVersion: input.catalog.version,
          compiledContextId: context.id,
          generationCommandId: asGenerationCommandId(command.generationCommandId),
          harnessPolicy: input.harnessPolicy,
          interactionTurnId: command.interactionTurnId,
          modelRunAttemptId: asModelRunAttemptId(command.modelRunAttemptId),
          requestEventRevisionId: command.requestEventRevisionId,
          ...(input.deadline ? { deadline: input.deadline } : {}),
          userId: command.userId,
        },
        signal,
      );
    }
  }
  return harnessApi;
}

function normalizedJitter(value: number): number {
  if (!Number.isFinite(value)) {
    return 0.5;
  }
  return Math.min(1, Math.max(0, value));
}

async function* streamExistingDecision(
  response: ExistingConversationResponse,
): AsyncIterable<ConversationHarnessEvent> {
  if (response.outcome === "committed") {
    yield { delta: response.text, type: "decision_delta" };
    yield {
      assistantCreatedAt: response.createdAt,
      assistantEventId: response.eventId,
      assistantEventRevisionId: response.revisionId,
      type: "decision_committed",
    };
    return;
  }
  if (response.outcome === "failed" || response.outcome === "interrupted") {
    yield {
      category: response.category,
      interrupted: response.outcome === "interrupted",
      type: "decision_failed",
    };
    return;
  }
  yield { category: "unavailable", interrupted: false, type: "decision_failed" };
}

const INTERRUPTED = Symbol("interrupted");

const FRESHNESS_PROBE_TIMEOUT_MS = 1_500;

/** Reject when the work takes longer than `ms`; the timer never keeps the process alive. */
function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("The freshness probe timed out.")),
      ms,
    );
    timer.unref?.();
    work.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

/**
 * Combines the consumer's cancellation and the request deadline (issue #319).
 * `race` lets the Harness stop waiting on a Provider call that ignores its
 * abort signal, so the deadline holds even when cancellation cannot be
 * delivered; `throwIfInterrupted` keeps new steps from starting afterwards.
 */
function createInterrupt(
  signal: AbortSignal | undefined,
  deadline: RequestDeadline | undefined,
) {
  const parts = [signal, deadline?.signal].filter(
    (part): part is AbortSignal => part !== undefined,
  );
  const combined = parts.length === 0 ? undefined : AbortSignal.any(parts);
  const reason = (): ProviderDispatchErrorCategory | null =>
    deadline?.expired()
      ? "timeout"
      : combined?.aborted
        ? "aborted"
        : null;
  const interrupted: Promise<typeof INTERRUPTED> =
    combined === undefined
      ? new Promise<never>(() => undefined)
      : new Promise((resolve) => {
          if (combined.aborted) resolve(INTERRUPTED);
          else
            combined.addEventListener("abort", () => resolve(INTERRUPTED), {
              once: true,
            });
        });
  function throwIfInterrupted(): void {
    const category = reason();
    if (category !== null) throw new ProviderDispatchError(category);
  }
  return {
    ended: () => reason() !== null,
    signal: combined,
    throwIfInterrupted,
    async sleep(
      delay: (ms: number) => Promise<void>,
      ms: number,
    ): Promise<void> {
      const waited = delay(ms);
      waited.catch(() => undefined);
      await Promise.race([waited, interrupted]);
      throwIfInterrupted();
    },
    /** Wait for one piece of work, but never past the end of the request. */
    async guard<T>(work: Promise<T>): Promise<T> {
      work.catch(() => undefined);
      const next = await Promise.race([work, interrupted]);
      if (next === INTERRUPTED) {
        throwIfInterrupted();
        throw new ProviderDispatchError("aborted");
      }
      return next;
    },
    async *race<T>(source: AsyncIterable<T>): AsyncIterable<T> {
      const iterator = source[Symbol.asyncIterator]();
      for (;;) {
        const pending = iterator.next();
        pending.catch(() => undefined);
        const next = await Promise.race([pending, interrupted]);
        if (next === INTERRUPTED) {
          // Never await this: a call that ignores cancellation never returns.
          void Promise.resolve(iterator.return?.()).catch(() => undefined);
          throwIfInterrupted();
          throw new ProviderDispatchError("aborted");
        }
        if (next.done === true) return;
        yield next.value;
      }
    },
  };
}

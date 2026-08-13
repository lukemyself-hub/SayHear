import type {
  CompiledContextId,
  ConversationEventId,
  ConversationEventRevisionId,
  GenerationCommandId,
  InteractionTurnId,
  ModelRunAttemptId,
  UserId,
} from "@sayhear/domain";

import type {
  CompleteResponseMetadata,
  ConversationResponseRepository,
} from "./conversation-response";
import type {
  ConversationActionCatalog,
  ConversationHarnessPolicy,
} from "./conversation-action-catalog";
import {
  ProviderDispatchError,
  type ProviderDispatchErrorCategory,
  type ProviderEgressPort,
} from "./conversation-model";

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
  | "claimStaleResponseExecution"
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
  catalog: ConversationActionCatalog;
  catalogVersion: string;
  compiledContextId: CompiledContextId;
  generationCommandId: GenerationCommandId;
  harnessPolicy: ConversationHarnessPolicy;
  interactionTurnId: InteractionTurnId;
  modelRunAttemptId: ModelRunAttemptId;
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
      assistantEventId: ConversationEventId;
      assistantEventRevisionId: ConversationEventRevisionId;
      type: "decision_committed";
    }>
  | Readonly<{
      category: ProviderDispatchErrorCategory;
      interrupted: boolean;
      type: "decision_failed";
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
}>;

export function createConversationAgentHarness(dependencies: {
  clock: () => Date;
  delay?: (delayMs: number) => Promise<void>;
  egressPort: ProviderEgressPort;
  jitter?: () => number;
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

    try {
      for await (const event of dependencies.egressPort.stream({
        compiledContextId: command.compiledContextId,
        generationCommandId: command.generationCommandId,
        modelRunAttemptId: command.modelRunAttemptId,
        ...(signal ? { signal } : {}),
      })) {
        if (event.type === "delta") {
          possiblyVisible = true;
          completeText += event.delta;
          yield { delta: event.delta, type: "decision_delta" };
        } else if (event.type === "tool_call") {
          // A provider-native tool selection is not a Final Response. With the
          // initial empty Catalog there is no eligible Definition, so the model
          // cannot have requested an admitted Action: fail closed, settle the
          // attempt, and never commit an Assistant Event or fabricate a success
          // response (issue #24 AC8). The raw function name and arguments stay
          // inside the Harness and never reach product truth (AC6).
          throw new ProviderDispatchError("invalid_response");
        } else {
          completion = event;
        }
      }
      if (completion === null || completeText.length === 0) {
        throw new ProviderDispatchError("invalid_response");
      }

      const committed = await dependencies.repository.commitCompleteResponse({
        completedAt: dependencies.clock(),
        generationCommandId: command.generationCommandId,
        metadata: completion,
        modelRunAttemptId: command.modelRunAttemptId,
        text: completeText,
        userId: command.userId,
      });
      if (committed.outcome === "fence_rejected") {
        throw new ProviderDispatchError("policy_blocked");
      }
      yield {
        assistantEventId: committed.eventId,
        assistantEventRevisionId: committed.revisionId,
        type: "decision_committed",
      };
    } catch (error) {
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
      const failure = await dependencies.repository.settleResponseFailure({
        category,
        generationCommandId: command.generationCommandId,
        interrupted,
        jitter: normalizedJitter(jitter()),
        modelRunAttemptId: command.modelRunAttemptId,
        settledAt: dependencies.clock(),
        userId: command.userId,
      });
      if (failure.outcome === "retry_scheduled") {
        await delay(
          Math.max(
            0,
            failure.retryAt.getTime() - dependencies.clock().getTime(),
          ),
        );
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

  return {
    runDecision(command, signal) {
      return runDecisionAttempt(command, signal);
    },
  };
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

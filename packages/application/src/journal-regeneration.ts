import {
  asWorkflowCommandId,
} from "@sayhear/domain";

import { assertWorkflowSafe } from "./journal-eligibility";
import {
  runJournalRegeneration,
  type JournalService,
} from "./journal";
import type {
  ConversationActionGatewayRepository,
  JournalRegenerationWorkflowCommand,
} from "./conversation-action-gateway";

export type JournalRegenerationWorkflowResult = Readonly<{
  actionExecutionId: string;
  dailySessionId: string;
  outcome:
    | "canceled"
    | "failed"
    | "published"
    | "replayed";
  workflowCommandId: string;
}>;

export async function runJournalRegenerationWorkflow(input: {
  actionRepository: ConversationActionGatewayRepository;
  journalService: JournalService;
  workflowCommandId: string;
}): Promise<JournalRegenerationWorkflowResult> {
  asWorkflowCommandId(input.workflowCommandId);
  const command = await input.actionRepository.readRegenerationWorkflowCommand?.({
    workflowCommandId: input.workflowCommandId,
  });
  if (!command) {
    throw new Error("Journal regeneration Workflow command was not found.");
  }
  assertWorkflowSafe(commandForWorkflow(command), "command");

  const claim = await input.actionRepository.claimRegenerationExecution?.({
    actionExecutionId: command.actionExecutionId,
  });
  if (!claim) {
    throw new Error("Journal regeneration execution recovery is unavailable.");
  }
  if (claim === "replayed") {
    return {
      actionExecutionId: command.actionExecutionId,
      dailySessionId: command.dailySessionId,
      outcome: "replayed",
      workflowCommandId: command.workflowCommandId,
    };
  }

  // The admission transaction does not call the provider. When it has not yet
  // created an attempt, use the stable regeneration command ID as the first
  // attempt ID so Workflow replay remains deterministic and Node-only UUID
  // generation stays outside the Workflow module graph.
  const modelRunAttemptId = command.modelRunAttemptId ?? command.generationCommandId;
  try {
    const result = await runJournalRegeneration({
      service: input.journalService,
      command: {
        workflowCommandId: command.workflowCommandId,
        subjectId: command.dailySessionId,
        sourceRevision: command.sourceRevision,
        policyVersion: command.generationPolicyVersion,
        expectedDataEpoch: command.expectedDataEpoch,
        actionExecutionId: command.actionExecutionId,
        guidance: command.guidance,
      },
      generationCommandId: command.generationCommandId,
      modelRunAttemptId,
    });
    const outcome = result.outcome === "published" ? "published" :
      result.outcome === "stale" || result.outcome === "fenced" ? "canceled" : "failed";
    await input.actionRepository.recordRegenerationExecution?.({
      actionExecutionId: command.actionExecutionId,
      disposition: result.reason ?? result.outcome,
      outcome: outcome === "published" ? "succeeded" : outcome,
    });
    return {
      actionExecutionId: command.actionExecutionId,
      dailySessionId: command.dailySessionId,
      outcome,
      workflowCommandId: command.workflowCommandId,
    };
  } catch (error) {
    await input.actionRepository.recordRegenerationExecution?.({
      actionExecutionId: command.actionExecutionId,
      disposition: error instanceof Error ? "provider_or_workflow_failed" : "unknown_failure",
      outcome: "failed",
    });
    throw error;
  }
}

function commandForWorkflow(command: JournalRegenerationWorkflowCommand) {
  return {
    workflowCommandId: command.workflowCommandId,
    subjectType: "daily_session",
    subjectId: command.dailySessionId,
    sourceRevision: command.sourceRevision,
    policyVersion: command.generationPolicyVersion,
    expectedDataEpoch: command.expectedDataEpoch,
    eventType: "journal_regeneration_requested",
    actionExecutionId: command.actionExecutionId,
    status: "pending",
  };
}

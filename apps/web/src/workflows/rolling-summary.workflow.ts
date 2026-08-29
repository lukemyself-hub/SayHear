import type { WorkflowStarter } from "@sayhear/application";
import { assertWorkflowSafe } from "@sayhear/application/journal-eligibility";
import { runJournalRegenerationWorkflow } from "@sayhear/application/journal-regeneration";
import { start } from "workflow/api";

import { createServerComposition } from "../server-composition";
import { journalEligibilityWorkflow } from "./journal-eligibility.workflow";
import { dialogueStateWorkflow } from "./dialogue-state.workflow";
import { ownerFullPurgeWorkflow } from "./owner-full-purge.workflow";
import { fastPathExtractionWorkflow } from "./fast-path-extraction.workflow";
import { memoryConsolidationWorkflow } from "./memory-consolidation.workflow";
import { memoryCorrectionFollowupWorkflow } from "./memory-trust-followup.workflow";
import { entityIdentityRevalidationWorkflow } from "./entity-identity-revalidation.workflow";

export async function journalRegenerationWorkflow(input: {
  workflowCommandId: string;
  subjectId: string;
  sourceRevision: number;
  policyVersion: string;
  expectedDataEpoch: number;
  actionExecutionId: string;
}) {
  "use workflow";
  assertWorkflowSafe(input, "input");
  return await runJournalRegenerationStep(input);
}

async function runJournalRegenerationStep(input: {
  workflowCommandId: string;
  subjectId: string;
  sourceRevision: number;
  policyVersion: string;
  expectedDataEpoch: number;
  actionExecutionId: string;
}) {
  "use step";
  const composition = createServerComposition();
  if (input.policyVersion !== composition.journalGenerationPolicyVersion) {
    throw new Error("Journal regeneration command policy does not match runtime policy.");
  }
  return runJournalRegenerationWorkflow({
    actionRepository: composition.actionRepository,
    journalService: composition.journalService,
    workflowCommandId: input.workflowCommandId,
  });
}

export async function rollingSummaryWorkflow(input: {
  workflowCommandId: string; subjectId: string; sourceRevision: number; policyVersion: string; expectedDataEpoch: number;
}): Promise<{ outcome: "published" | "stale" | "failed" }> {
  "use workflow";
  return await runRollingSummaryStep(input.workflowCommandId);
}

async function runRollingSummaryStep(commandId: string): Promise<{ outcome: "published" | "stale" | "failed" }> {
  "use step";
  return await createServerComposition().rollingSummaryService.run(commandId);
}

export function createWorkflowStarter(): WorkflowStarter {
  return async (input) => {
    const workflowInput = { workflowCommandId: input.workflowCommandId, subjectId: input.subjectId, sourceRevision: input.sourceRevision, policyVersion: input.policyVersion, expectedDataEpoch: input.expectedDataEpoch };
    let run;
    if (input.eventType === "rolling_summary_requested") {
      run = await start(rollingSummaryWorkflow, [workflowInput]);
    } else if (input.eventType === "dialogue_state_requested") {
      run = await start(dialogueStateWorkflow, [workflowInput]);
    } else if (input.eventType === "journal_eligibility_requested") {
      run = await start(journalEligibilityWorkflow, [workflowInput]);
    } else if (input.eventType === "owner_full_purge_requested") {
      run = await start(ownerFullPurgeWorkflow, [
        {
          workflowCommandId: input.workflowCommandId,
          subjectId: input.subjectId,
          expectedDataEpoch: input.expectedDataEpoch,
        },
      ]);
    } else if (input.eventType === "journal_regeneration_requested") {
      if (!input.actionExecutionId) {
        throw new Error("Journal regeneration outbox event has no Action execution.");
      }
      run = await start(journalRegenerationWorkflow, [{
        ...workflowInput,
        actionExecutionId: input.actionExecutionId,
      }]);
    } else if (input.eventType === "fast_path_extraction_requested") {
      run = await start(fastPathExtractionWorkflow, [workflowInput]);
    } else if (
      input.eventType === "daily_consolidation_requested" ||
      input.eventType === "weekly_consolidation_requested" ||
      input.eventType === "memory_sweeper_requested"
    ) {
      run = await start(memoryConsolidationWorkflow, [workflowInput]);
    } else if (input.eventType === "memory_correction_followup_requested") {
      run = await start(memoryCorrectionFollowupWorkflow, [workflowInput]);
    } else if (input.eventType === "entity_identity_revalidation_requested") {
      run = await start(entityIdentityRevalidationWorkflow, [workflowInput]);
    } else {
      throw new Error(`Unsupported outbox event type: ${input.eventType}`);
    }
    return { workflowReceiptId: run.runId };
  };
}

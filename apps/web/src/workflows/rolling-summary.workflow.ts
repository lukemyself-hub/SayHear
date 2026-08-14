import { type WorkflowStarter } from "@sayhear/application";
import { start } from "workflow/api";

import { createServerComposition } from "../server-composition";
import { journalEligibilityWorkflow } from "./journal-eligibility.workflow";
import { dialogueStateWorkflow } from "./dialogue-state.workflow";

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
    } else {
      throw new Error(`Unsupported outbox event type: ${input.eventType}`);
    }
    return { workflowReceiptId: run.runId };
  };
}

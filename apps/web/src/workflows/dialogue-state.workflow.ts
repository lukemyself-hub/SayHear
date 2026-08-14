import { randomUUID } from "node:crypto";

import { assertWorkflowSafe, type WorkflowStarter } from "@sayhear/application";
import { start } from "workflow/api";

import { createServerComposition } from "../server-composition";
import { journalEligibilityWorkflow } from "./journal-eligibility.workflow";

export async function dialogueStateWorkflow(input: {
  workflowCommandId: string;
  subjectId: string;
  sourceRevision: number;
  policyVersion: string;
  expectedDataEpoch: number;
}): Promise<{
  dailySessionId: string;
  outcome: "failed" | "published" | "stale";
  workflowReceiptId: string;
}> {
  "use workflow";
  return await runDialogueStateStep(input);
}

async function runDialogueStateStep(input: {
  workflowCommandId: string;
  subjectId: string;
  sourceRevision: number;
  policyVersion: string;
  expectedDataEpoch: number;
}) {
  "use step";
  const composition = createServerComposition();
  const result = await composition.dialogueStateService.run(input.workflowCommandId);
  const output = {
    dailySessionId: input.subjectId,
    outcome: result.outcome,
    workflowReceiptId: `wf-${randomUUID()}`,
  } as const;
  assertWorkflowSafe(output, "result");
  return output;
}

export function createWorkflowStarter(): WorkflowStarter {
  return async (input) => {
    const workflowInput = {
      expectedDataEpoch: input.expectedDataEpoch,
      policyVersion: input.policyVersion,
      sourceRevision: input.sourceRevision,
      subjectId: input.subjectId,
      workflowCommandId: input.workflowCommandId,
    };
    if (input.eventType === "dialogue_state_requested") {
      const run = await start(dialogueStateWorkflow, [workflowInput]);
      return { workflowReceiptId: run.runId };
    }
    if (input.eventType === "journal_eligibility_requested") {
      const run = await start(journalEligibilityWorkflow, [workflowInput]);
      return { workflowReceiptId: run.runId };
    }
    throw new Error(`Unsupported Workflow event type: ${input.eventType}`);
  };
}

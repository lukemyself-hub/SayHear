import { assertWorkflowSafe } from "@sayhear/application/journal-eligibility";
import { runJournalRegenerationWorkflow } from "@sayhear/application/journal-regeneration";

import { createServerComposition } from "../server-composition";

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

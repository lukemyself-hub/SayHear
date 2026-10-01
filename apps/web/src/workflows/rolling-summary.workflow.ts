import { assertWorkflowSafe } from "@sayhear/application/workflow-contract";

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
  console.info("[journal-regeneration] step started", {
    workflowCommandId: input.workflowCommandId,
    actionExecutionId: input.actionExecutionId,
  });
  const { runJournalRegenerationWorkflow } = await import(
    "@sayhear/application/journal-regeneration"
  );
  const { createServerComposition } = await import("../server-composition");
  const composition = createServerComposition();
  if (input.policyVersion !== composition.journalGenerationPolicyVersion) {
    throw new Error("Journal regeneration command policy does not match runtime policy.");
  }
  const result = await runJournalRegenerationWorkflow({
    actionRepository: composition.actionRepository,
    journalService: composition.journalService,
    workflowCommandId: input.workflowCommandId,
  });
  console.info("[journal-regeneration] step finished", {
    workflowCommandId: input.workflowCommandId,
    actionExecutionId: input.actionExecutionId,
    outcome: result.outcome,
  });
  return result;
}

export async function rollingSummaryWorkflow(input: {
  workflowCommandId: string; subjectId: string; sourceRevision: number; policyVersion: string; expectedDataEpoch: number;
}): Promise<{ outcome: "published" | "stale" | "failed" }> {
  "use workflow";
  return await runRollingSummaryStep(input.workflowCommandId);
}

async function runRollingSummaryStep(commandId: string): Promise<{ outcome: "published" | "stale" | "failed" }> {
  "use step";
  const { createServerComposition } = await import("../server-composition");
  return await createServerComposition().rollingSummaryService.run(commandId);
}

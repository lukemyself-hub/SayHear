import type { FastPathExtractionEntrypointResult } from "@sayhear/application";
import { start } from "workflow/api";

/**
 * 1A.3a Fast-path extraction Workflow application entrypoint (issue #113).
 *
 * The directive function below is the durable-at-least-once wrapper deployed
 * to the Vercel platform. Its single step delegates to the directly-callable
 * application entrypoint `runFastPathExtraction()`, which owns all
 * deterministic domain logic and the per-revision idempotent commit. The
 * system test exercises the application entrypoint directly; platform-level
 * durability/replay is verified per ADR-0066 layering.
 *
 * Step input/output carries only IDs, revisions, policy versions, outcome,
 * and allowlisted error codes — never conversation text (architecture 13.3).
 * Routing happens through the shared createWorkflowStarter router in
 * workflow-starter.ts (event type `fast_path_extraction_requested`).
 */
export async function fastPathExtractionWorkflow(input: {
  workflowCommandId: string;
  subjectId: string;
  sourceRevision: number;
  policyVersion: string;
  expectedDataEpoch: number;
}): Promise<FastPathExtractionEntrypointResult> {
  "use workflow";
  return await runFastPathStep(input);
}

async function runFastPathStep(input: {
  workflowCommandId: string;
  subjectId: string;
  sourceRevision: number;
  policyVersion: string;
  expectedDataEpoch: number;
}): Promise<FastPathExtractionEntrypointResult> {
  "use step";
  const { randomUUID } = await import("node:crypto");
  const { runFastPathExtraction } = await import("@sayhear/application");
  const { createServerComposition } = await import("../server-composition");
  const composition = createServerComposition();
  const policy = await composition.fastPathExtractionService.resolvePolicyForStep();
  if (input.policyVersion !== policy.policyVersion) {
    throw new Error(
      "Fast path extraction command policy does not match runtime policy.",
    );
  }
  return runFastPathExtraction({
    dependencies: await composition.fastPathExtractionEntrypointDependencies(
      `wf-${randomUUID()}`,
    ),
    command: {
      workflowCommandId: input.workflowCommandId,
      policyVersion: input.policyVersion,
    },
  });
}

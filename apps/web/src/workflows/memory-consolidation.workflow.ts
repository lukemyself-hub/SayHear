import type { MemoryConsolidationEntrypointResult } from "@sayhear/application";
import { start } from "workflow/api";

/**
 * 1A.3a Slow-path consolidation Workflow application entrypoint (issue #114):
 * daily / weekly `memory.consolidate` runs and the deterministic candidate
 * sweeper, all behind the per-run idempotency anchor. The directive function
 * is the durable-at-least-once wrapper; its single step delegates to the
 * directly-callable application entrypoint `runMemoryConsolidation()`, which
 * owns the model call, the deterministic validators, and the transactional
 * commit. Step input/output carries only IDs, versions, outcomes, and
 * counters — never conversation text (architecture 13.3). Routing happens
 * through the shared createWorkflowStarter router in workflow-starter.ts
 * (event types `daily_consolidation_requested`,
 * `weekly_consolidation_requested`, `memory_sweeper_requested`).
 */
export async function memoryConsolidationWorkflow(input: {
  workflowCommandId: string;
  subjectId: string;
  sourceRevision: number;
  policyVersion: string;
  expectedDataEpoch: number;
}): Promise<MemoryConsolidationEntrypointResult> {
  "use workflow";
  return await runConsolidationStep(input);
}

async function runConsolidationStep(input: {
  workflowCommandId: string;
  subjectId: string;
  sourceRevision: number;
  policyVersion: string;
  expectedDataEpoch: number;
}): Promise<MemoryConsolidationEntrypointResult> {
  "use step";
  const { randomUUID } = await import("node:crypto");
  const { runMemoryConsolidation } = await import("@sayhear/application");
  const { createServerComposition } = await import("../server-composition");
  const composition = createServerComposition();
  const policy = await composition.memoryConsolidationService.resolvePolicyForStep();
  if (input.policyVersion !== policy.policyVersion) {
    throw new Error(
      "Memory consolidation command policy does not match runtime policy.",
    );
  }
  return runMemoryConsolidation({
    dependencies: await composition.memoryConsolidationEntrypointDependencies(
      `wf-${randomUUID()}`,
    ),
    command: {
      workflowCommandId: input.workflowCommandId,
      policyVersion: input.policyVersion,
    },
  });
}

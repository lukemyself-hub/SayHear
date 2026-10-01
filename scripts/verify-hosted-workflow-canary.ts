import { readFile } from "node:fs/promises";

import {
  assertWorkflowHistoryCanaryClean,
  type WorkflowCanaryArtifacts,
  type WorkflowCanaryValues,
} from "@sayhear/application";

function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is required.`);
  }
  return value;
}

function parseJson<T>(value: string, name: string): T {
  try {
    return JSON.parse(value) as T;
  } catch {
    throw new Error(`${name} must contain valid JSON.`);
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.length !== 0 && (args.length !== 4 || args[0] !== "--artifacts" || args[2] !== "--values" || !args[1] || !args[3])) {
    throw new Error("Expected --artifacts and --values file paths.");
  }
  const artifactFile = args[1] ?? requiredEnvironment("SAYHEAR_WORKFLOW_CANARY_ARTIFACTS_FILE");
  const values = parseJson<WorkflowCanaryValues>(
    args[3] ? await readFile(args[3], "utf8") : requiredEnvironment("SAYHEAR_WORKFLOW_CANARY_VALUES"),
    "SAYHEAR_WORKFLOW_CANARY_VALUES",
  );
  const artifacts = parseJson<WorkflowCanaryArtifacts>(
    await readFile(artifactFile, "utf8"),
    "SAYHEAR_WORKFLOW_CANARY_ARTIFACTS_FILE",
  );

  assertWorkflowHistoryCanaryClean(artifacts, values);
  console.log("Hosted Workflow canary passed: exported artifacts contain no configured private canary values.");
}

main().catch((error: unknown) => {
  console.error("Hosted Workflow canary failed:", error);
  process.exitCode = 1;
});

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

const artifactFile = requiredEnvironment("SAYHEAR_WORKFLOW_CANARY_ARTIFACTS_FILE");
const values = parseJson<WorkflowCanaryValues>(
  requiredEnvironment("SAYHEAR_WORKFLOW_CANARY_VALUES"),
  "SAYHEAR_WORKFLOW_CANARY_VALUES",
);
const artifacts = parseJson<WorkflowCanaryArtifacts>(
  await readFile(artifactFile, "utf8"),
  "SAYHEAR_WORKFLOW_CANARY_ARTIFACTS_FILE",
);

assertWorkflowHistoryCanaryClean(artifacts, values);
console.log("Hosted Workflow canary passed: exported artifacts contain no configured private canary values.");

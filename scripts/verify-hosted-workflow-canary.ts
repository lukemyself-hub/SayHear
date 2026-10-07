import { readFile } from "node:fs/promises";

import {
  assertHostedWorkflowCanaryEvidence,
  type WorkflowCanaryArtifacts,
  type WorkflowCanaryValues,
} from "./hosted-workflow-canary-gate";

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
  const options = new Map<string, string>();
  const allowed = new Set(["--artifacts", "--values", "--deployment-id", "--expected-run-ids"]);
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index], value = args[index + 1];
    if (!key || !allowed.has(key) || !value || value.startsWith("--") || options.has(key)) throw new Error("Expected unique canary artifact, values, deployment and run-set options.");
    options.set(key, value);
  }
  const artifactFile = options.get("--artifacts") ?? requiredEnvironment("SAYHEAR_WORKFLOW_CANARY_ARTIFACTS_FILE");
  const valuesFile = options.get("--values");
  const values = parseJson<WorkflowCanaryValues>(
    valuesFile ? await readFile(valuesFile, "utf8") : requiredEnvironment("SAYHEAR_WORKFLOW_CANARY_VALUES"),
    "SAYHEAR_WORKFLOW_CANARY_VALUES",
  );
  const artifacts = parseJson<WorkflowCanaryArtifacts>(
    await readFile(artifactFile, "utf8"),
    "SAYHEAR_WORKFLOW_CANARY_ARTIFACTS_FILE",
  );

  // The verifier is the producer's consumption entry point, so it runs the
  // full shared gate — decrypted/resolved data, correlation, page completeness
  // — rather than only the privacy probe scan.
  const deploymentId = options.get("--deployment-id") ?? requiredEnvironment("SAYHEAR_WORKFLOW_CANARY_DEPLOYMENT_ID");
  const runIds = (options.get("--expected-run-ids") ?? requiredEnvironment("SAYHEAR_WORKFLOW_CANARY_RUN_IDS")).split(",");
  if (runIds.some(id => !/^wrun_[A-Za-z0-9]+$/.test(id)) || new Set(runIds).size !== runIds.length) throw new Error("Expected run IDs must be unique platform IDs.");
  assertHostedWorkflowCanaryEvidence(artifacts, values, { deploymentId, runIds });
  console.log("Hosted Workflow canary passed: exported artifacts are a complete, correlated, probe-free export.");
}

main().catch((error: unknown) => {
  console.error("Hosted Workflow canary failed:", error);
  process.exitCode = 1;
});

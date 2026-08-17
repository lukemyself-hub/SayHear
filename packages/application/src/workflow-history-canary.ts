/**
 * The hosted-workflow privacy check works on artifacts exported from the
 * platform rather than on application state.  Its result deliberately names
 * only the artifact source and the canary category: returning a matching value
 * would reproduce the private data in a log, CI result, or operator console.
 */
export type WorkflowCanaryArtifacts = Readonly<{
  errors: readonly unknown[];
  logs: readonly unknown[];
  outboxPayloads: readonly unknown[];
  receipts: readonly unknown[];
  traces: readonly unknown[];
  workflowHistory: readonly unknown[];
}>;

export type WorkflowCanaryValues = Readonly<{
  actionPayload: string;
  contentHmac: string;
  privateBody: string;
  rawProviderError: string;
  renderedPrompt: string;
  secret: string;
}>;

type CanaryCategory =
  | "action_payload"
  | "content_hmac"
  | "private_body"
  | "raw_provider_error"
  | "rendered_prompt"
  | "secret";

const artifactSources = [
  "workflowHistory",
  "outboxPayloads",
  "logs",
  "traces",
  "errors",
  "receipts",
] as const;

function entries(values: WorkflowCanaryValues): readonly [CanaryCategory, string][] {
  return [
    ["private_body", values.privateBody],
    ["rendered_prompt", values.renderedPrompt],
    ["secret", values.secret],
    ["content_hmac", values.contentHmac],
    ["action_payload", values.actionPayload],
    ["raw_provider_error", values.rawProviderError],
  ];
}

function serializedArtifacts(artifacts: readonly unknown[]): string {
  // Platform exports must first be parsed JSON values. JSON serialization keeps
  // this scanner independent of platform-specific record shapes and avoids
  // calling custom toString implementations on those plain data records.
  return JSON.stringify(artifacts);
}

export function assertWorkflowHistoryCanaryClean(
  artifacts: WorkflowCanaryArtifacts,
  values: WorkflowCanaryValues,
): void {
  const categories = entries(values);
  if (categories.some(([, value]) => value.trim().length === 0)) {
    throw new Error("Hosted Workflow canary values must all be non-empty.");
  }

  const findings: string[] = [];
  for (const source of artifactSources) {
    const records = artifacts[source];
    if (!Array.isArray(records) || records.length === 0) {
      throw new Error(
        `Hosted Workflow canary requires a non-empty ${source} artifact export.`,
      );
    }
    const serialized = serializedArtifacts(records);
    for (const [category, value] of categories) {
      if (serialized.includes(value)) {
        findings.push(`${source}:${category}`);
      }
    }
  }

  if (findings.length > 0) {
    throw new Error(
      `Hosted Workflow canary found private data in ${findings.join(", ")}.`,
    );
  }
}

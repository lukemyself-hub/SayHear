/**
 * The hosted-workflow privacy check works on artifacts exported from the
 * platform rather than on application state.  Its result deliberately names
 * only the artifact source and the canary category: returning a matching value
 * would reproduce the private data in a log, CI result, or operator console.
 *
 * ADR-0145 approves exactly one narrow waiver for the 2026-10-01 G1
 * restoration: the raw Provider error probe is skipped.  It is honoured only
 * when the configured `rawProviderError` is `null` and the typed waiver below
 * carries every approved field.  The other five probes are never skippable and
 * an existing raw Provider error value is still scanned, so the waiver cannot
 * suppress a real leak.
 */
export type WorkflowCanaryArtifacts = Readonly<{
  errors: readonly unknown[];
  logs: readonly unknown[];
  outboxPayloads: readonly unknown[];
  receipts: readonly unknown[];
  traces: readonly unknown[];
  workflowHistory: readonly unknown[];
}>;

export const RAW_PROVIDER_ERROR_WAIVER_VERSION = "g1-raw-provider-error-waiver:v1";

/**
 * The single waiver ADR-0145 permits.  It is intentionally closed: the exact
 * six fields, the exact values, and no extras.  Any other object (a missing
 * waiver, a different approver, an unknown decision, a re-used scope, a
 * different check or status) is rejected.
 */
export type RawProviderErrorWaiver = Readonly<{
  approvedBy: "Luke";
  check: "raw_provider_error";
  decision: "ADR-0145";
  scope: "g1-restoration-2026-10-01";
  status: "skipped";
  version: "g1-raw-provider-error-waiver:v1";
}>;

export const RAW_PROVIDER_ERROR_WAIVER: RawProviderErrorWaiver = {
  approvedBy: "Luke",
  check: "raw_provider_error",
  decision: "ADR-0145",
  scope: "g1-restoration-2026-10-01",
  status: "skipped",
  version: RAW_PROVIDER_ERROR_WAIVER_VERSION,
};

const RAW_PROVIDER_ERROR_WAIVER_KEYS = [
  "approvedBy",
  "check",
  "decision",
  "scope",
  "status",
  "version",
] as const;

export function isRawProviderErrorWaiver(
  value: unknown,
): value is RawProviderErrorWaiver {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const record = value as Record<string, unknown>;
  if (Object.keys(record).length !== RAW_PROVIDER_ERROR_WAIVER_KEYS.length) {
    return false;
  }
  return RAW_PROVIDER_ERROR_WAIVER_KEYS.every(
    (key) => record[key] === RAW_PROVIDER_ERROR_WAIVER[key],
  );
}

export type WorkflowCanaryValues = Readonly<{
  actionPayload: string;
  contentHmac: string;
  privateBody: string;
  /**
   * `null` only when {@link RawProviderErrorWaiver} authorises skipping the
   * probe; otherwise it must be the real configured non-empty value.
   */
  rawProviderError: string | null;
  /** Validated at runtime by {@link isRawProviderErrorWaiver}. */
  rawProviderErrorWaiver?: unknown;
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

/**
 * True only for the approved ADR-0145 waiver over a null raw Provider error.
 * A non-null value never reaches here, so a supplied waiver cannot suppress an
 * existing real value; such a value is always scanned.
 */
function rawProviderErrorIsSkipped(values: WorkflowCanaryValues): boolean {
  if (values.rawProviderError !== null) return false;
  if (!isRawProviderErrorWaiver(values.rawProviderErrorWaiver)) {
    throw new Error(
      "Hosted Workflow canary may only skip raw_provider_error with the approved ADR-0145 waiver.",
    );
  }
  return true;
}

function entries(
  values: WorkflowCanaryValues,
  skipRawProviderError: boolean,
): readonly [CanaryCategory, string][] {
  const categories: [CanaryCategory, string][] = [
    ["private_body", values.privateBody],
    ["rendered_prompt", values.renderedPrompt],
    ["secret", values.secret],
    ["content_hmac", values.contentHmac],
    ["action_payload", values.actionPayload],
  ];
  if (!skipRawProviderError) {
    categories.push(["raw_provider_error", values.rawProviderError as string]);
  }
  return categories;
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
  const skipRawProviderError = rawProviderErrorIsSkipped(values);
  const categories = entries(values, skipRawProviderError);
  // The five non-skippable probes, and the raw Provider error whenever it is
  // present, must be real non-empty strings. A null raw value is only valid on
  // the waiver path handled above.
  if (
    categories.some(
      ([, value]) => typeof value !== "string" || value.trim().length === 0,
    )
  ) {
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

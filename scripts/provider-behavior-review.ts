/**
 * Shared provider behavior review protocol for SPEC #362 / Issue #365.
 *
 * Codex verifies semantics before submit; this module only validates the
 * evidence binding (shape, lengths, SHA/digest identity and context binding).
 * No semantic regex/AST, no new dependencies. Parse at the external boundary.
 */

export type ProviderReviewIdentity = Readonly<{
  headSha: string;
  baseSha: string;
  diffDigest: string;
}>;

export type ProviderReviewContext = ProviderReviewIdentity &
  Readonly<{ diffComplete: boolean }>;

export type ProviderObservation = Readonly<{
  file: string;
  line: number;
  before: string | null;
  after: string | null;
}>;

export type ProviderBehaviorReview = ProviderReviewIdentity &
  Readonly<{
    verdict: "affected" | "unaffected" | "unknown";
    rationale: string;
    evidence: readonly ProviderObservation[];
    missingEvidence: readonly string[];
  }>;

export type ProviderReviewInput = Readonly<{
  context?: ProviderReviewContext;
  assessment?: ProviderBehaviorReview;
}>;

export type ProviderResolution = Readonly<{
  verdict: ProviderBehaviorReview["verdict"];
  reason: string;
  missingEvidence: readonly string[];
}>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertRecord(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new Error(`${label} must be a JSON object.`);
  }
  return value;
}

function parseSha40(value: unknown, label: string): string {
  if (typeof value !== "string" || /^[0-9a-fA-F]{40}$/.test(value) !== true) {
    throw new Error(`${label} must be 40 lowercase hex characters.`);
  }
  return value.toLowerCase();
}

function parseDigest64(value: unknown, label: string): string {
  if (typeof value !== "string" || /^[0-9a-fA-F]{64}$/.test(value) !== true) {
    throw new Error(`${label} must be 64 lowercase hex characters.`);
  }
  return value.toLowerCase();
}

function parseRationale(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 2000) {
    throw new Error(`${label} rationale must be a non-empty string of at most 2000 characters.`);
  }
  if (value.trim().length === 0) {
    throw new Error(`${label} rationale must be non-empty.`);
  }
  if (/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F-\x9F]/.test(value)) {
    throw new Error(`${label} rationale must not contain non-text control characters.`);
  }
  return value;
}

function parseObservationFile(value: unknown): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 512) {
    throw new Error("Provider observation file must be a non-empty path of at most 512 characters.");
  }
  if (value.trim().length === 0) {
    throw new Error("Provider observation file must not be blank.");
  }
  if (/[\u0000-\u001f\u007f]/.test(value)) {
    throw new Error("Provider observation file must not contain control characters.");
  }
  if (value.startsWith("/")) {
    throw new Error("Provider observation file must not be absolute.");
  }
  if (/^[a-zA-Z]:[\\/]/.test(value)) {
    throw new Error("Provider observation file must not be absolute.");
  }
  const segments = value.split("/");
  if (segments.some((segment) => segment === "..")) {
    throw new Error("Provider observation file must not contain path traversal.");
  }
  return value;
}

function parseObservationLine(value: unknown): number {
  if (typeof value !== "number" || Number.isSafeInteger(value) !== true || value <= 0) {
    throw new Error("Provider observation line must be a positive safe integer.");
  }
  return value;
}

function parseBeforeAfter(value: unknown, label: string): string | null {
  if (value === null) return null;
  if (typeof value !== "string" || value.length > 2000) {
    throw new Error(`Provider observation ${label} must be a string of at most 2000 characters or null.`);
  }
  return value;
}

function parseObservation(value: unknown, index: number): ProviderObservation {
  const raw = assertRecord(value, `Provider observation ${index}`);
  const file = parseObservationFile(raw.file);
  const line = parseObservationLine(raw.line);
  const before = parseBeforeAfter(raw.before, "before");
  const after = parseBeforeAfter(raw.after, "after");
  const beforeNonEmpty = typeof before === "string" && before.length > 0;
  const afterNonEmpty = typeof after === "string" && after.length > 0;
  if (beforeNonEmpty !== true && afterNonEmpty !== true) {
    throw new Error(
      `Provider observation ${index} requires at least one non-empty before or after side.`,
    );
  }
  return { file, line, before, after };
}

function parseEvidence(value: unknown, label: string): readonly ProviderObservation[] {
  if (!Array.isArray(value)) {
    throw new Error(`${label} evidence must be an array.`);
  }
  if (value.length > 32) {
    throw new Error(`${label} evidence must contain at most 32 observations.`);
  }
  return value.map((entry, index) => parseObservation(entry, index));
}

function parseMissingEvidence(value: unknown, label: string): readonly string[] {
  if (!Array.isArray(value)) {
    throw new Error(`${label} missingEvidence must be an array.`);
  }
  if (value.length > 32) {
    throw new Error(`${label} missingEvidence must contain at most 32 entries.`);
  }
  return value.map((entry, index) => {
    if (typeof entry !== "string" || entry.length === 0 || entry.length > 512) {
      throw new Error(
        `${label} missingEvidence ${index} must be a non-empty string of at most 512 characters.`,
      );
    }
    if (entry.trim().length === 0) {
      throw new Error(`${label} missingEvidence ${index} must be non-empty.`);
    }
    if (/[\n\r\u2028\u2029]/.test(entry)) {
      throw new Error(`${label} missingEvidence ${index} must be a single line without line breaks.`);
    }
    if (/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F-\x9F]/.test(entry)) {
      throw new Error(`${label} missingEvidence ${index} must not contain non-text control characters.`);
    }
    return entry;
  });
}

export function parseProviderReviewContext(value: unknown): ProviderReviewContext {
  const raw = assertRecord(value, "Provider review context");
  const headSha = parseSha40(raw.headSha, "Provider review context headSha");
  const baseSha = parseSha40(raw.baseSha, "Provider review context baseSha");
  const diffDigest = parseDigest64(raw.diffDigest, "Provider review context diffDigest");
  if (typeof raw.diffComplete !== "boolean") {
    throw new Error("Provider review context diffComplete must be a boolean.");
  }
  return { headSha, baseSha, diffDigest, diffComplete: raw.diffComplete };
}

export function parseProviderBehaviorReview(value: unknown): ProviderBehaviorReview {
  const raw = assertRecord(value, "Provider behavior review");
  const headSha = parseSha40(raw.headSha, "Provider behavior review headSha");
  const baseSha = parseSha40(raw.baseSha, "Provider behavior review baseSha");
  const diffDigest = parseDigest64(raw.diffDigest, "Provider behavior review diffDigest");
  if (raw.verdict !== "affected" && raw.verdict !== "unaffected" && raw.verdict !== "unknown") {
    throw new Error('Provider behavior review verdict must be affected, unaffected or unknown.');
  }
  const verdict = raw.verdict;
  const rationale = parseRationale(raw.rationale, "Provider behavior review");
  const evidence = parseEvidence(raw.evidence, "Provider behavior review");
  const missingEvidence = parseMissingEvidence(raw.missingEvidence, "Provider behavior review");
  if (verdict === "affected" || verdict === "unaffected") {
    if (evidence.length === 0) {
      throw new Error(`Provider behavior review ${verdict} requires at least one observation.`);
    }
    if (missingEvidence.length !== 0) {
      throw new Error(`Provider behavior review ${verdict} must not list missing evidence.`);
    }
  } else {
    if (missingEvidence.length === 0) {
      throw new Error("Provider behavior review unknown requires concrete missing evidence.");
    }
  }
  if (verdict === "affected" || verdict === "unaffected" || verdict === "unknown") {
    return { headSha, baseSha, diffDigest, verdict, rationale, evidence, missingEvidence };
  }
  const _exhaustive: never = verdict;
  throw new Error(`Unexpected provider verdict: ${String(_exhaustive)}`);
}

/**
 * Pure binding check: context exists, diff complete, assessment exists and the
 * head/base/digest identities match exactly. No filename, declaration or
 * confidence heuristics. Unknown preserves the assessment explanation when the
 * binding itself is intact.
 */
export function resolveProviderBehavior(input?: ProviderReviewInput): ProviderResolution {
  if (input === undefined || input === null || input.context === undefined) {
    return {
      verdict: "unknown",
      reason: "Missing provider review context; cannot bind an assessment to the current diff.",
      missingEvidence: ["provider-review-context"],
    };
  }
  const context = input.context;
  if (context.diffComplete !== true) {
    return {
      verdict: "unknown",
      reason: "Review context reports an incomplete diff; the full diff is required to rule out provider behavior changes.",
      missingEvidence: ["complete-diff"],
    };
  }
  if (input.assessment === undefined) {
    return {
      verdict: "unknown",
      reason: "Missing provider behavior assessment for the current diff.",
      missingEvidence: ["provider-behavior-assessment"],
    };
  }
  const assessment = input.assessment;
  const stale: string[] = [];
  if (assessment.headSha !== context.headSha) stale.push("matching-head-sha");
  if (assessment.baseSha !== context.baseSha) stale.push("matching-base-sha");
  if (assessment.diffDigest !== context.diffDigest) stale.push("matching-diff-digest");
  if (stale.length > 0) {
    return {
      verdict: "unknown",
      reason: `Provider assessment is stale for the current diff; it does not match ${stale.join(", ")}.`,
      missingEvidence: stale,
    };
  }
  if (assessment.verdict === "unknown") {
    return {
      verdict: "unknown",
      reason: assessment.rationale,
      missingEvidence: [...assessment.missingEvidence],
    };
  }
  return {
    verdict: assessment.verdict,
    reason: assessment.rationale,
    missingEvidence: [],
  };
}

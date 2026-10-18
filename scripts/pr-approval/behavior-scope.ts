/**
 * Behavior-scope review protocol for SPEC #362 / Issue #365 (leaf unit).
 *
 * Codex verifies semantics before submit; this module only validates the
 * evidence binding (shape, lengths, SHA/digest identity and context binding)
 * plus per-status coverage. No semantic regex/AST, no new dependencies.
 * Parse at the external boundary.
 */

import type {
  ProviderReviewContext,
  ProviderReviewIdentity,
  ProviderObservation,
} from "../provider-behavior-review.ts";

export type BehaviorScopeReview = ProviderReviewIdentity &
  Readonly<{
    verdict: "in-scope" | "needs-human" | "insufficient-info";
    runtimeImpact: "none" | "changed" | "unknown";
    rationale: string;
    evidence: readonly ProviderObservation[];
    contractRefs: readonly string[];
    missingEvidence: readonly string[];
  }>;

export type ScopeChangedFile = Readonly<{
  path: string;
  status: "added" | "modified" | "removed" | "renamed" | "copied";
}>;

export type BehaviorScopeResolution = Readonly<{
  verdict: BehaviorScopeReview["verdict"];
  reason: string;
  coveredPaths: readonly string[];
  noRuntimeImpact: boolean;
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
    throw new Error(`${label} must be 40 hex characters.`);
  }
  return value.toLowerCase();
}

function parseDigest64(value: unknown, label: string): string {
  if (typeof value !== "string" || /^[0-9a-fA-F]{64}$/.test(value) !== true) {
    throw new Error(`${label} must be 64 hex characters.`);
  }
  return value.toLowerCase();
}

function hasNonTextControl(value: string): boolean {
  for (const char of value) {
    const code = char.codePointAt(0) ?? 0;
    if (code === 0x09 || code === 0x0a || code === 0x0d) continue;
    if ((code >= 0x00 && code <= 0x1f) || code === 0x7f) return true;
  }
  return false;
}

function parseRationale(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 2000) {
    throw new Error(`${label} rationale must be a non-empty string of at most 2000 characters.`);
  }
  if (value.trim().length === 0) {
    throw new Error(`${label} rationale must be non-empty.`);
  }
  if (hasNonTextControl(value)) {
    throw new Error(`${label} rationale must not contain non-text control characters.`);
  }
  return value;
}

function parseObservationFile(value: unknown): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 512) {
    throw new Error("Behavior scope observation file must be a non-empty path of at most 512 characters.");
  }
  if (value.trim().length === 0) {
    throw new Error("Behavior scope observation file must be non-empty.");
  }
  if (/[\u0000-\u001f\u007f]/.test(value)) {
    throw new Error("Behavior scope observation file must not contain control characters.");
  }
  if (value.startsWith("/")) {
    throw new Error("Behavior scope observation file must not be absolute.");
  }
  if (/^[a-zA-Z]:[\\/]/.test(value)) {
    throw new Error("Behavior scope observation file must not be absolute.");
  }
  const segments = value.split("/");
  if (segments.some((segment) => segment === "..")) {
    throw new Error("Behavior scope observation file must not contain path traversal.");
  }
  return value;
}

function parseObservationLine(value: unknown): number {
  if (typeof value !== "number" || Number.isSafeInteger(value) !== true || value <= 0) {
    throw new Error("Behavior scope observation line must be a positive safe integer.");
  }
  return value;
}

function parseBeforeAfter(value: unknown, label: string): string | null {
  if (value === null) return null;
  if (typeof value !== "string" || value.length > 2000) {
    throw new Error(`Behavior scope observation ${label} must be a string of at most 2000 characters or null.`);
  }
  return value;
}

function parseObservation(value: unknown, index: number): ProviderObservation {
  const raw = assertRecord(value, `Behavior scope observation ${index}`);
  const file = parseObservationFile(raw.file);
  const line = parseObservationLine(raw.line);
  const before = parseBeforeAfter(raw.before, "before");
  const after = parseBeforeAfter(raw.after, "after");
  const beforeNonBlank = typeof before === "string" && before.trim().length > 0;
  const afterNonBlank = typeof after === "string" && after.trim().length > 0;
  if (beforeNonBlank !== true && afterNonBlank !== true) {
    throw new Error(
      `Behavior scope observation ${index} requires at least one non-blank before or after side.`,
    );
  }
  return { file, line, before, after };
}

function parseEvidence(value: unknown, label: string): readonly ProviderObservation[] {
  if (!Array.isArray(value)) {
    throw new Error(`${label} evidence must be an array.`);
  }
  if (value.length > 64) {
    throw new Error(`${label} evidence must contain at most 64 observations.`);
  }
  return value.map((entry, index) => parseObservation(entry, index));
}

function parseSingleLineList(
  value: unknown,
  label: string,
  field: string,
): readonly string[] {
  if (!Array.isArray(value)) {
    throw new Error(`${label} ${field} must be an array.`);
  }
  if (value.length > 32) {
    throw new Error(`${label} ${field} must contain at most 32 entries.`);
  }
  return value.map((entry, index) => {
    if (typeof entry !== "string" || entry.length === 0 || entry.length > 512) {
      throw new Error(
        `${label} ${field} ${index} must be a non-empty string of at most 512 characters.`,
      );
    }
    if (entry.trim().length === 0) {
      throw new Error(`${label} ${field} ${index} must be non-empty.`);
    }
    // Single-line refs: Unicode line/paragraph separators break lines but sit
    // outside the ASCII control range, so reject them by character code.
    if (
      /[\u0000-\u001f\u007f]/.test(entry) ||
      entry.includes(String.fromCharCode(0x2028)) ||
      entry.includes(String.fromCharCode(0x2029))
    ) {
      throw new Error(`${label} ${field} ${index} must be a single line without control characters.`);
    }
    return entry;
  });
}

export function parseBehaviorScopeReview(value: unknown): BehaviorScopeReview {
  const raw = assertRecord(value, "Behavior scope review");
  const headSha = parseSha40(raw.headSha, "Behavior scope review headSha");
  const baseSha = parseSha40(raw.baseSha, "Behavior scope review baseSha");
  const diffDigest = parseDigest64(raw.diffDigest, "Behavior scope review diffDigest");
  if (raw.verdict !== "in-scope" && raw.verdict !== "needs-human" && raw.verdict !== "insufficient-info") {
    throw new Error("Behavior scope review verdict must be in-scope, needs-human or insufficient-info.");
  }
  const verdict = raw.verdict;
  if (raw.runtimeImpact !== "none" && raw.runtimeImpact !== "changed" && raw.runtimeImpact !== "unknown") {
    throw new Error("Behavior scope review runtimeImpact must be none, changed or unknown.");
  }
  const runtimeImpact = raw.runtimeImpact;
  const rationale = parseRationale(raw.rationale, "Behavior scope review");
  const evidence = parseEvidence(raw.evidence, "Behavior scope review");
  const contractRefs = parseSingleLineList(raw.contractRefs, "Behavior scope review", "contractRefs");
  const missingEvidence = parseSingleLineList(raw.missingEvidence, "Behavior scope review", "missingEvidence");
  if (verdict === "in-scope") {
    if (runtimeImpact !== "none" && runtimeImpact !== "changed") {
      throw new Error("Behavior scope review in-scope requires runtime none or changed.");
    }
    if (evidence.length === 0) {
      throw new Error("Behavior scope review in-scope requires at least one observation.");
    }
    if (contractRefs.length === 0) {
      throw new Error("Behavior scope review in-scope requires at least one contract reference.");
    }
    if (missingEvidence.length !== 0) {
      throw new Error("Behavior scope review in-scope must not list missing evidence.");
    }
  } else if (verdict === "needs-human") {
    if (evidence.length === 0) {
      throw new Error("Behavior scope review needs-human requires at least one observation.");
    }
    if (contractRefs.length === 0) {
      throw new Error("Behavior scope review needs-human requires at least one contract reference.");
    }
    if (missingEvidence.length !== 0) {
      throw new Error("Behavior scope review needs-human must not list missing evidence.");
    }
  } else {
    if (missingEvidence.length === 0) {
      throw new Error("Behavior scope review insufficient-info requires concrete missing evidence.");
    }
  }
  return { headSha, baseSha, diffDigest, verdict, runtimeImpact, rationale, evidence, contractRefs, missingEvidence };
}

function isNonBlankSide(value: string | null): boolean {
  return typeof value === "string" && value.trim().length > 0;
}

function coversStatus(
  status: ScopeChangedFile["status"],
  observations: readonly ProviderObservation[],
): boolean {
  const hasBefore = observations.some((observation) => isNonBlankSide(observation.before));
  const hasAfter = observations.some((observation) => isNonBlankSide(observation.after));
  const hasEither = observations.some(
    (observation) => isNonBlankSide(observation.before) || isNonBlankSide(observation.after),
  );
  switch (status) {
    case "added":
      return hasAfter;
    case "removed":
      return hasBefore;
    case "renamed":
    case "copied":
      return hasBefore && hasAfter;
    case "modified":
      return hasEither;
  }
}

/**
 * Pure binding/coverage check: context exists, diff complete, assessment
 * exists and head/base/digest match exactly. Fresh in-scope derives
 * coveredPaths from usable evidence; no Provider verdict is inferred.
 * Covered paths are derived proof of locations, not an authorization grant.
 */
export function resolveBehaviorScope(
  review: BehaviorScopeReview | undefined,
  context: ProviderReviewContext | undefined,
  changedFiles: readonly ScopeChangedFile[],
): BehaviorScopeResolution {
  if (context === undefined) {
    return {
      verdict: "insufficient-info",
      reason: "Missing behavior scope context; cannot bind an assessment to the current diff.",
      coveredPaths: [],
      noRuntimeImpact: false,
      missingEvidence: ["behavior-scope-context"],
    };
  }
  if (context.diffComplete !== true) {
    return {
      verdict: "insufficient-info",
      reason: "Review context reports an incomplete diff; the full diff is required to confirm behavior scope.",
      coveredPaths: [],
      noRuntimeImpact: false,
      missingEvidence: ["complete-diff"],
    };
  }
  if (review === undefined) {
    return {
      verdict: "insufficient-info",
      reason: "Missing behavior scope assessment for the current diff.",
      coveredPaths: [],
      noRuntimeImpact: false,
      missingEvidence: ["behavior-scope-assessment"],
    };
  }
  const stale: string[] = [];
  if (review.headSha !== context.headSha) stale.push("matching-head-sha");
  if (review.baseSha !== context.baseSha) stale.push("matching-base-sha");
  if (review.diffDigest !== context.diffDigest) stale.push("matching-diff-digest");
  if (stale.length > 0) {
    return {
      verdict: "insufficient-info",
      reason: `Behavior scope assessment is stale for the current diff; it does not match ${stale.join(", ")}.`,
      coveredPaths: [],
      noRuntimeImpact: false,
      missingEvidence: stale,
    };
  }
  if (review.verdict === "insufficient-info") {
    return {
      verdict: "insufficient-info",
      reason: review.rationale,
      coveredPaths: [],
      noRuntimeImpact: false,
      missingEvidence: [...review.missingEvidence],
    };
  }
  if (review.verdict === "needs-human") {
    return {
      verdict: "needs-human",
      reason: review.rationale,
      coveredPaths: [],
      noRuntimeImpact: false,
      missingEvidence: [],
    };
  }
  const coveredPaths: string[] = [];
  for (const file of changedFiles) {
    const observations = review.evidence.filter((observation) => observation.file === file.path);
    if (observations.length > 0 && coversStatus(file.status, observations)) {
      if (!coveredPaths.includes(file.path)) coveredPaths.push(file.path);
    }
  }
  const fullyCovered = changedFiles.length > 0 && coveredPaths.length === changedFiles.length;
  return {
    verdict: "in-scope",
    reason: review.rationale,
    coveredPaths,
    noRuntimeImpact: review.runtimeImpact === "none" && fullyCovered,
    missingEvidence: [],
  };
}

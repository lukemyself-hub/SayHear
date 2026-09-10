import { createHash } from "node:crypto";

import type { ReflectionBaselineEntry } from "./types";

/**
 * Structured Claim comparison baseline (issue #199, SPEC 5.1). The baseline
 * shares the Bio eligible-Claim eligibility fence: current, active, not
 * Forget-fenced, Entity-valid ClaimVersions only; contested, review_due,
 * dormant, retracted and Candidate material never enter. It carries typed
 * comparison fields only — never narrative projection bodies — and is never
 * Evidence.
 */

export type BaselineCanonicalEntry = Readonly<{
  claimId: string;
  claimVersionId: string;
  kind: string;
  predicateId: string;
  scopeKey: string;
  typedValue: string;
  temporalStatus: string;
  validFrom: string | null;
  validFromPrecision: string;
  validTo: string | null;
  validToPrecision: string;
  epistemicStatus: string;
  lastObservedAt: string;
}>;

export function toBaselineCanonicalEntry(
  entry: ReflectionBaselineEntry,
): BaselineCanonicalEntry {
  return {
    claimId: entry.claimId,
    claimVersionId: entry.claimVersionId,
    kind: entry.kind,
    predicateId: entry.predicateId,
    scopeKey: entry.scopeKey,
    typedValue: Array.isArray(entry.typedValue)
      ? entry.typedValue.join("\u0001")
      : (entry.typedValue as string),
    temporalStatus: entry.temporalStatus,
    validFrom: entry.validFrom,
    validFromPrecision: entry.validFromPrecision,
    validTo: entry.validTo,
    validToPrecision: entry.validToPrecision,
    epistemicStatus: entry.epistemicStatus,
    lastObservedAt: entry.lastObservedAt,
  };
}

/**
 * Deterministic baseline digest over the stable-ordered canonical entries.
 * The digest is part of the Daily command identity (Q3): a baseline-only
 * change freezes a new snapshot and a new command; identical snapshots dedupe.
 */
export function claimBaselineDigest(
  entries: readonly ReflectionBaselineEntry[],
): string {
  const canonical = entries
    .map(toBaselineCanonicalEntry)
    .sort(
      (left, right) =>
        left.claimVersionId.localeCompare(right.claimVersionId) ||
        left.claimId.localeCompare(right.claimId),
    );
  const payload = JSON.stringify({
    version: "reflection-claim-baseline:v1",
    entries: canonical,
  });
  return sha256(payload);
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

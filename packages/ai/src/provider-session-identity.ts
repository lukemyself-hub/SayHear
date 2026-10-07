import { createHash } from "node:crypto";

/**
 * Derive the opaque `x-opencode-session` value for a logical Provider call.
 *
 * The value is a SHA-256 digest of a trusted logical scope: the owner plus the
 * conversation / task scope that the release already treats as one logical
 * unit (for conversation, the Daily Session; for a G1 role, the Daily Session /
 * week / draft it operates on). It is deliberately NOT keyed on the per-attempt
 * GenerationCommand or ModelRunAttempt, so the same conversation keeps one
 * stable Provider session across attempts and the OpenCode Go continuation,
 * while a different owner or a different logical conversation is a different
 * session. It never contains a raw id, body, or header plaintext.
 *
 * `scopeId` is required and must be non-empty; a caller with no trusted scope
 * fails closed rather than falling back to a random value or a shared sentinel.
 *
 * The value is transport metadata only: it never enters a model payload, frozen
 * Evidence, or the baseline digest.
 */
export function providerSessionIdFor(input: {
  ownerId?: string;
  scopeId: string;
}): string {
  if (typeof input.scopeId !== "string" || input.scopeId.trim() === "") {
    throw new Error(
      "providerSessionIdFor requires a non-empty trusted logical scope.",
    );
  }
  return createHash("sha256")
    .update(
      `sayhear-provider-session:v1\0${input.ownerId ?? ""}\0${input.scopeId}`,
    )
    .digest("hex");
}

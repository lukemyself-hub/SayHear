/**
 * The one shared content-free guard for the release tooling.
 *
 * SPEC #275 decision 7 forbids recording a secret, a connection string, a
 * bearer value or a private body in any report. Both the effective-config gate
 * and the release-closure report used to carry their own copy of this pattern
 * list; keeping one list here means a new pattern cannot land in only one place.
 */
export const FORBIDDEN_CONTENT_PATTERNS: readonly RegExp[] = [
  /postgres(?:ql)?:\/\//i,
  /\bsk-[A-Za-z0-9_-]{8,}/,
  /bearer\s+\S+/i,
  /-----BEGIN [A-Z ]+-----/,
];

export function containsForbiddenContent(value: string): boolean {
  return FORBIDDEN_CONTENT_PATTERNS.some((pattern) => pattern.test(value));
}

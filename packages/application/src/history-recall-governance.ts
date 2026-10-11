/**
 * Independent, versioned operator governance for the history-recall path
 * (issue #320, the same pattern as the recent-context governance of #295).
 *
 * A row is content-free. Disabling revokes the single active row; re-enabling
 * inserts a brand-new immutable version, so a revoked identity can never be
 * resurrected and a result frozen under it stays unusable forever.
 *
 * Stop rules once the active row is revoked (each re-checked under a row
 * lock, in either ordering with the revocation):
 *  - a Decision that has not yet had its proposal admitted gets no function
 *    offered and, if the call already left, is refused at admission;
 *  - a History Answer frozen under the revoked version is refused at dispatch,
 *    at the first visible token, at Provider-result time and at commit;
 *  - text that was already shown cannot be retracted; it is never committed as
 *    an Assistant Event.
 */
export const HISTORY_RECALL_GOVERNANCE_PREFIX =
  "history-recall-governance:" as const;

export type HistoryRecallGovernanceStatus = "active" | "revoked" | "absent";

export type HistoryRecallGovernancePolicy = Readonly<{
  /** The actor who enabled this version; write-once, never overwritten. */
  changedBy: string;
  compilerVersion: string;
  createdAt: string;
  harnessPolicyVersion: string;
  historyPolicyVersion: string;
  policyVersion: string;
  revokedAt: string | null;
  revokedBy: string | null;
  status: "active" | "revoked";
}>;

export type HistoryRecallGovernanceEffectiveState = Readonly<{
  active: HistoryRecallGovernancePolicy | null;
  enabled: boolean;
  latest: HistoryRecallGovernancePolicy | null;
  policyCount: number;
}>;

export type HistoryRecallGovernanceInput = Readonly<{
  changedBy: string;
  compilerVersion: string;
  harnessPolicyVersion: string;
  historyPolicyVersion: string;
  now: Date;
  policyVersion?: string;
}>;

export class HistoryRecallGovernanceConflictError extends Error {
  public constructor(
    message = "A history-recall governance policy is already active, or the requested version already exists.",
  ) {
    super(message);
    this.name = "HistoryRecallGovernanceConflictError";
  }
}

export type HistoryRecallGovernanceRepository = Readonly<{
  findActivePolicy(): Promise<HistoryRecallGovernancePolicy | null>;
  findEffectiveState(): Promise<HistoryRecallGovernanceEffectiveState>;
  findPolicyStatus(
    policyVersion: string,
  ): Promise<HistoryRecallGovernanceStatus>;
  insertActivePolicy(
    input: HistoryRecallGovernanceInput,
  ): Promise<HistoryRecallGovernancePolicy>;
  revokeActivePolicy(input: {
    now: Date;
    revokedBy: string;
  }): Promise<
    | Readonly<{ outcome: "revoked"; policy: HistoryRecallGovernancePolicy }>
    | Readonly<{ outcome: "already_disabled" }>
  >;
}>;

/** What the gateway needs: the active identity, if any. */
export type HistoryRecallGovernancePort = Pick<
  HistoryRecallGovernanceRepository,
  "findActivePolicy"
>;

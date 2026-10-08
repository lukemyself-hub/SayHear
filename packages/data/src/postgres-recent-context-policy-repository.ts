import {
  RECENT_CONTEXT_GOVERNANCE_PREFIX,
  RecentContextGovernanceConflictError,
  type RecentContextGovernanceEffectiveState,
  type RecentContextGovernanceInput,
  type RecentContextGovernancePolicy,
  type RecentContextGovernanceRepository,
  type RecentContextGovernanceStatus,
} from "@sayhear/application";
import type { Pool } from "pg";

import { createUuidV7 } from "./uuid-v7";

type PolicyRow = Readonly<{
  budget_tokens: number;
  changed_by: string;
  compiler_version: string;
  created_at: Date;
  max_candidate_bytes: number;
  max_candidate_rows: number;
  max_single_event_tokens: number;
  policy_version: string;
  read_timeout_ms: number;
  revoked_at: Date | null;
  revoked_by: string | null;
  selection_policy_version: string;
  selector_policy_version: string;
  status: "active" | "revoked";
}>;

function mapPolicy(row: PolicyRow): RecentContextGovernancePolicy {
  return {
    budgetTokens: Number(row.budget_tokens),
    changedBy: row.changed_by,
    compilerVersion: row.compiler_version,
    createdAt: row.created_at.toISOString(),
    maxCandidateBytes: Number(row.max_candidate_bytes),
    maxCandidateRows: Number(row.max_candidate_rows),
    maxSingleEventTokens: Number(row.max_single_event_tokens),
    policyVersion: row.policy_version,
    readTimeoutMs: Number(row.read_timeout_ms),
    revokedAt: row.revoked_at === null ? null : row.revoked_at.toISOString(),
    revokedBy: row.revoked_by,
    selectionPolicyVersion: row.selection_policy_version,
    selectorPolicyVersion: row.selector_policy_version,
    status: row.status,
  };
}

const POLICY_COLUMNS = `
  policy_version,
  status,
  compiler_version,
  selector_policy_version,
  selection_policy_version,
  budget_tokens,
  max_candidate_rows,
  max_candidate_bytes,
  max_single_event_tokens,
  read_timeout_ms,
  changed_by,
  created_at,
  revoked_at,
  revoked_by
`;

/**
 * Immutable recent-context governance repository (issue #295).
 *
 * Rows are content-free operator configuration. `insertActivePolicy` is the
 * only enable path and always creates a new version; `revokeActivePolicy`
 * flips the single active row under a row lock. The partial unique index makes
 * a second active row impossible even under concurrency.
 */
export class PostgresRecentContextPolicyRepository
  implements RecentContextGovernanceRepository
{
  public constructor(private readonly pool: Pool) {}

  public async findActivePolicy(): Promise<RecentContextGovernancePolicy | null> {
    const result = await this.pool.query<PolicyRow>(
      `SELECT ${POLICY_COLUMNS}
       FROM recent_context_policies
       WHERE status = 'active'
       LIMIT 1`,
    );
    const row = result.rows[0];
    return row ? mapPolicy(row) : null;
  }

  public async findEffectiveState(): Promise<RecentContextGovernanceEffectiveState> {
    const result = await this.pool.query<PolicyRow>(
      `SELECT ${POLICY_COLUMNS}
       FROM recent_context_policies
       ORDER BY created_at DESC, policy_version DESC`,
    );
    const policies = result.rows.map(mapPolicy);
    const active = policies.find((policy) => policy.status === "active") ?? null;
    return {
      active,
      enabled: active !== null,
      latest: policies[0] ?? null,
      policyCount: policies.length,
    };
  }

  public async findPolicyStatus(
    policyVersion: string,
  ): Promise<RecentContextGovernanceStatus> {
    const result = await this.pool.query<{ status: "active" | "revoked" }>(
      `SELECT status FROM recent_context_policies WHERE policy_version = $1`,
      [policyVersion],
    );
    return result.rows[0]?.status ?? "absent";
  }

  public async insertActivePolicy(
    input: RecentContextGovernanceInput,
  ): Promise<RecentContextGovernancePolicy> {
    const policyVersion =
      input.policyVersion ??
      `${RECENT_CONTEXT_GOVERNANCE_PREFIX}${createUuidV7(input.now)}`;
    try {
      const result = await this.pool.query<PolicyRow>(
        `INSERT INTO recent_context_policies (
           policy_version, status, compiler_version, selector_policy_version,
           selection_policy_version, budget_tokens, max_candidate_rows,
           max_candidate_bytes, max_single_event_tokens, read_timeout_ms,
           changed_by, created_at, revoked_at, revoked_by
         ) VALUES (
           $1, 'active', $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, NULL, NULL
         )
         RETURNING ${POLICY_COLUMNS}`,
        [
          policyVersion,
          input.compilerVersion,
          input.selectorPolicyVersion,
          input.selectionPolicyVersion,
          input.budgetTokens,
          input.maxCandidateRows,
          input.maxCandidateBytes,
          input.maxSingleEventTokens,
          input.readTimeoutMs,
          input.changedBy,
          input.now,
        ],
      );
      return mapPolicy(result.rows[0]!);
    } catch (error) {
      // 23505 = unique_violation: either the one-active partial index (already
      // enabled) or a reused immutable version. Both fail closed without
      // mutating the existing governance history.
      if ((error as { code?: string }).code === "23505") {
        throw new RecentContextGovernanceConflictError();
      }
      throw error;
    }
  }

  public async revokeActivePolicy(input: {
    now: Date;
    revokedBy: string;
  }): ReturnType<RecentContextGovernanceRepository["revokeActivePolicy"]> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const active = await client.query<PolicyRow>(
        `SELECT ${POLICY_COLUMNS}
         FROM recent_context_policies
         WHERE status = 'active'
         FOR UPDATE`,
      );
      const row = active.rows[0];
      if (!row) {
        await client.query("COMMIT");
        return { outcome: "already_disabled" as const };
      }
      // `changed_by` stays the enable actor; the revoker is recorded once in
      // `revoked_by`. The row is immutable after this transition.
      const revoked = await client.query<PolicyRow>(
        `UPDATE recent_context_policies
         SET status = 'revoked', revoked_at = $2, revoked_by = $3
         WHERE policy_version = $1
         RETURNING ${POLICY_COLUMNS}`,
        [row.policy_version, input.now, input.revokedBy],
      );
      await client.query("COMMIT");
      return { outcome: "revoked" as const, policy: mapPolicy(revoked.rows[0]!) };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
}

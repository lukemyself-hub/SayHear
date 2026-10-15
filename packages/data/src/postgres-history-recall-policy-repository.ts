import {
  HISTORY_RECALL_GOVERNANCE_PREFIX,
  HistoryRecallGovernanceConflictError,
  type HistoryRecallGovernanceEffectiveState,
  type HistoryRecallGovernanceInput,
  type HistoryRecallGovernancePolicy,
  type HistoryRecallGovernanceRepository,
  type HistoryRecallGovernanceStatus,
} from "@sayhear/application";
import type { Pool } from "pg";

import { createUuidV7 } from "./uuid-v7";

type PolicyRow = Readonly<{
  changed_by: string;
  compiler_version: string;
  created_at: Date;
  harness_policy_version: string;
  history_policy_version: string;
  policy_version: string;
  revoked_at: Date | null;
  revoked_by: string | null;
  status: "active" | "revoked";
}>;

function mapPolicy(row: PolicyRow): HistoryRecallGovernancePolicy {
  return {
    changedBy: row.changed_by,
    compilerVersion: row.compiler_version,
    createdAt: row.created_at.toISOString(),
    harnessPolicyVersion: row.harness_policy_version,
    historyPolicyVersion: row.history_policy_version,
    policyVersion: row.policy_version,
    revokedAt: row.revoked_at === null ? null : row.revoked_at.toISOString(),
    revokedBy: row.revoked_by,
    status: row.status,
  };
}

const POLICY_COLUMNS = `
  policy_version, status, history_policy_version, harness_policy_version,
  compiler_version, changed_by, created_at, revoked_at, revoked_by
`;

/**
 * Immutable history-recall governance repository (issue #320). Rows are
 * content-free operator configuration. `insertActivePolicy` is the only enable
 * path and always creates a new version; `revokeActivePolicy` flips the single
 * active row under a row lock; the partial unique index makes a second active
 * row impossible even under concurrency.
 */
export class PostgresHistoryRecallPolicyRepository
  implements HistoryRecallGovernanceRepository
{
  public constructor(private readonly pool: Pool) {}

  public async findActivePolicy(): Promise<HistoryRecallGovernancePolicy | null> {
    const result = await this.pool.query<PolicyRow>(
      `SELECT ${POLICY_COLUMNS} FROM history_recall_policies
       WHERE status = 'active' LIMIT 1`,
    );
    const row = result.rows[0];
    return row ? mapPolicy(row) : null;
  }

  public async findEffectiveState(): Promise<HistoryRecallGovernanceEffectiveState> {
    const result = await this.pool.query<PolicyRow>(
      `SELECT ${POLICY_COLUMNS} FROM history_recall_policies
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
  ): Promise<HistoryRecallGovernanceStatus> {
    const result = await this.pool.query<{ status: "active" | "revoked" }>(
      `SELECT status FROM history_recall_policies WHERE policy_version = $1`,
      [policyVersion],
    );
    return result.rows[0]?.status ?? "absent";
  }

  public async insertActivePolicy(
    input: HistoryRecallGovernanceInput,
  ): Promise<HistoryRecallGovernancePolicy> {
    const policyVersion =
      input.policyVersion ??
      `${HISTORY_RECALL_GOVERNANCE_PREFIX}${createUuidV7(input.now)}`;
    try {
      const result = await this.pool.query<PolicyRow>(
        `INSERT INTO history_recall_policies (
           policy_version, status, history_policy_version, harness_policy_version,
           compiler_version, changed_by, created_at, revoked_at, revoked_by
         ) VALUES ($1, 'active', $2, $3, $4, $5, $6, NULL, NULL)
         RETURNING ${POLICY_COLUMNS}`,
        [
          policyVersion,
          input.historyPolicyVersion,
          input.harnessPolicyVersion,
          input.compilerVersion,
          input.changedBy,
          input.now,
        ],
      );
      return mapPolicy(result.rows[0]!);
    } catch (error) {
      if ((error as { code?: string }).code === "23505") {
        throw new HistoryRecallGovernanceConflictError();
      }
      throw error;
    }
  }

  public async revokeActivePolicy(input: {
    now: Date;
    revokedBy: string;
  }): ReturnType<HistoryRecallGovernanceRepository["revokeActivePolicy"]> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const active = await client.query<PolicyRow>(
        `SELECT ${POLICY_COLUMNS} FROM history_recall_policies
         WHERE status = 'active' FOR UPDATE`,
      );
      const row = active.rows[0];
      if (!row) {
        await client.query("COMMIT");
        return { outcome: "already_disabled" as const };
      }
      const revoked = await client.query<PolicyRow>(
        `UPDATE history_recall_policies
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

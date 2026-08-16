import type {
  InternalOwnerAccessRepository,
} from "@sayhear/application";
import {
  asUserId,
  type BackupPolicyEvidence,
  type UserId,
} from "@sayhear/domain";
import type { Pool } from "pg";

import { findLatestBackupPolicyEvidence } from "./postgres-backup-policy-evidence";

export class PostgresInternalOwnerAccessRepository
  implements InternalOwnerAccessRepository
{
  public constructor(private readonly pool: Pool) {}

  public async findActiveOwner(
    userId: UserId,
  ): Promise<{ userId: UserId } | null> {
    const result = await this.pool.query<{ user_id: string }>(
      `
        SELECT user_id
        FROM active_internal_owner
        WHERE user_id = $1
      `,
      [userId],
    );
    const row = result.rows[0];
    return row ? { userId: asUserId(row.user_id) } : null;
  }

  public async findInternalOwner(userId: UserId) {
    const result = await this.pool.query<{ user_id: string }>(
      `SELECT user_id
       FROM internal_owner_identities
       WHERE user_id = $1 AND active = TRUE`,
      [userId],
    );
    const row = result.rows[0];
    return row ? { userId: asUserId(row.user_id) } : null;
  }

  public async findRecoveryBusinessState(userId: UserId) {
    const result = await this.pool.query<{
      data_epoch: string;
      status: "active" | "deleting" | "disabled";
    }>(
      `SELECT data_epoch::text, status
       FROM app_users
       WHERE user_id = $1`,
      [userId],
    );
    const row = result.rows[0];
    return row
      ? { dataEpoch: Number(row.data_epoch), status: row.status }
      : null;
  }

  public async findLatestBackupPolicyEvidence(): Promise<BackupPolicyEvidence | null> {
    return findLatestBackupPolicyEvidence(this.pool);
  }

  public async provisionInternalOwner(input: {
    issuer: string;
    subject: string;
    userId: UserId;
  }): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const existing = await client.query<{
        issuer: string;
        subject: string;
        user_id: string;
      }>(
        `
          SELECT issuer, subject, user_id
          FROM internal_owner_identities
          WHERE owner_slot = 1
          FOR UPDATE
        `,
      );
      const owner = existing.rows[0];
      if (owner) {
        if (
          owner.issuer === input.issuer &&
          owner.subject === input.subject &&
          owner.user_id === input.userId
        ) {
          await client.query("COMMIT");
          return;
        }
        throw new Error(
          "The Internal Owner is already provisioned with a different immutable identity.",
        );
      }

      await client.query(
        `
          INSERT INTO app_users (user_id, status)
          VALUES ($1, 'active')
          ON CONFLICT (user_id) DO NOTHING
        `,
        [input.userId],
      );
      await client.query(
        `
          INSERT INTO internal_owner_identities (issuer, subject, user_id)
          VALUES ($1, $2, $3)
        `,
        [input.issuer, input.subject, input.userId],
      );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  public async recordBackupPolicyEvidence(input: {
    backupPolicyId: string;
    configurationFingerprint: string | null;
    databaseRetentionDays: number;
    evidenceReference: string;
    policyVersion: string;
    pitrRetentionDays: number;
    snapshotRetentionDays: number;
    status: "unknown" | "verified";
    validUntil: Date | null;
    verifiedAt: Date | null;
  }): Promise<void> {
    await this.pool.query(
      `
        INSERT INTO backup_policy_versions (
          backup_policy_id,
          policy_version,
          verification_status,
          verified_at,
          valid_until,
          configuration_fingerprint,
          database_retention_days,
          pitr_retention_days,
          snapshot_retention_days,
          longest_known_window_days,
          evidence_reference
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
      `,
      [
        input.backupPolicyId,
        input.policyVersion,
        input.status,
        input.verifiedAt,
        input.validUntil,
        input.configurationFingerprint,
        input.databaseRetentionDays,
        input.pitrRetentionDays,
        input.snapshotRetentionDays,
        Math.max(
          input.databaseRetentionDays,
          input.pitrRetentionDays,
          input.snapshotRetentionDays,
        ),
        input.evidenceReference,
      ],
    );
  }
}

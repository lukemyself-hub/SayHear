import type { BackupPolicyEvidence } from "@sayhear/domain";
import type { QueryResult, QueryResultRow } from "pg";

type BackupPolicyQueryable = Readonly<{
  query<Row extends QueryResultRow>(
    text: string,
  ): Promise<QueryResult<Row>>;
}>;

export async function findLatestBackupPolicyEvidence(
  queryable: BackupPolicyQueryable,
): Promise<BackupPolicyEvidence | null> {
  const result = await queryable.query<{
    configuration_fingerprint: string | null;
    database_retention_days: number | null;
    evidence_reference: string | null;
    longest_known_window_days: number | null;
    policy_version: string;
    pitr_retention_days: number | null;
    snapshot_retention_days: number | null;
    valid_until: Date | null;
    verification_status: "unknown" | "verified";
    verified_at: Date | null;
  }>(`
    SELECT
      configuration_fingerprint,
      database_retention_days,
      evidence_reference,
      longest_known_window_days,
      policy_version,
      pitr_retention_days,
      snapshot_retention_days,
      valid_until,
      verification_status,
      verified_at
    FROM backup_policy_versions
    ORDER BY created_at DESC, backup_policy_id DESC
    LIMIT 1
  `);
  const row = result.rows[0];

  return row
    ? {
        configurationFingerprint: row.configuration_fingerprint,
        databaseRetentionDays: row.database_retention_days,
        evidenceReference: row.evidence_reference,
        longestKnownWindowDays: row.longest_known_window_days,
        policyVersion: row.policy_version,
        pitrRetentionDays: row.pitr_retention_days,
        snapshotRetentionDays: row.snapshot_retention_days,
        status: row.verification_status,
        validUntil: row.valid_until,
        verifiedAt: row.verified_at,
      }
    : null;
}

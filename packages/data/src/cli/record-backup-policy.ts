import { randomUUIDv7 } from "node:crypto";

import { createPostgresPool } from "../pool";
import { PostgresInternalOwnerAccessRepository } from "../postgres-internal-owner-access-repository";
import {
  requiredEnvironment,
  requiredNonNegativeNumberEnvironment,
} from "./environment";

const verifiedAt = new Date(requiredEnvironment("SAYHEAR_BACKUP_VERIFIED_AT"));
const validUntil = new Date(requiredEnvironment("SAYHEAR_BACKUP_VALID_UNTIL"));
if (
  Number.isNaN(verifiedAt.getTime()) ||
  Number.isNaN(validUntil.getTime()) ||
  verifiedAt > new Date() ||
  validUntil <= verifiedAt
) {
  throw new Error(
    "Backup verification timestamps must be valid, not future-dated, and have valid-until after verified-at.",
  );
}

const pool = createPostgresPool({
  applicationName: "sayhear-record-backup-policy",
  connectionString: requiredEnvironment("DATABASE_URL"),
});

try {
  const repository = new PostgresInternalOwnerAccessRepository(pool);
  await repository.recordBackupPolicyEvidence({
    backupPolicyId: randomUUIDv7(),
    configurationFingerprint: requiredEnvironment(
      "SAYHEAR_BACKUP_CONFIGURATION_FINGERPRINT",
    ),
    databaseRetentionDays: requiredNonNegativeNumberEnvironment(
      "SAYHEAR_DATABASE_RETENTION_DAYS",
    ),
    evidenceReference: requiredEnvironment(
      "SAYHEAR_BACKUP_EVIDENCE_REFERENCE",
    ),
    pitrRetentionDays: requiredNonNegativeNumberEnvironment(
      "SAYHEAR_PITR_RETENTION_DAYS",
    ),
    policyVersion: requiredEnvironment("SAYHEAR_BACKUP_POLICY_VERSION"),
    snapshotRetentionDays: requiredNonNegativeNumberEnvironment(
      "SAYHEAR_SNAPSHOT_RETENTION_DAYS",
    ),
    status: "verified",
    validUntil,
    verifiedAt,
  });
  console.log("The verified backup policy version is recorded.");
} finally {
  await pool.end();
}

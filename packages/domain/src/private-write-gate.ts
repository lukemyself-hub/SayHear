export type PrivateWriteGateReason =
  | "backup_evidence_missing"
  | "backup_evidence_unknown"
  | "backup_evidence_expired"
  | "backup_evidence_drifted"
  | "backup_evidence_current";

export type PrivateWriteGateStatus = Readonly<{
  allowed: boolean;
  reason: PrivateWriteGateReason;
}>;

export type BackupPolicyEvidence = Readonly<{
  configurationFingerprint: string | null;
  databaseRetentionDays?: number | null;
  evidenceReference?: string | null;
  longestKnownWindowDays?: number | null;
  policyVersion: string;
  pitrRetentionDays?: number | null;
  snapshotRetentionDays?: number | null;
  status: "unknown" | "verified";
  validUntil: Date | null;
  verifiedAt: Date | null;
}>;

export function evaluatePrivateWriteGate(input: {
  evidence: BackupPolicyEvidence | null;
  expectedConfigurationFingerprint: string;
  expectedPolicyVersion: string;
  now: Date;
}): PrivateWriteGateStatus {
  const { evidence } = input;

  if (evidence === null) {
    return { allowed: false, reason: "backup_evidence_missing" };
  }

  if (
    evidence.status !== "verified" ||
    evidence.verifiedAt === null ||
    evidence.validUntil === null ||
    evidence.configurationFingerprint === null ||
    evidence.databaseRetentionDays === null ||
    evidence.databaseRetentionDays === undefined ||
    evidence.pitrRetentionDays === null ||
    evidence.pitrRetentionDays === undefined ||
    evidence.snapshotRetentionDays === null ||
    evidence.snapshotRetentionDays === undefined ||
    evidence.longestKnownWindowDays === null ||
    evidence.longestKnownWindowDays === undefined ||
    evidence.evidenceReference === null ||
    evidence.evidenceReference === undefined ||
    evidence.evidenceReference.length === 0
  ) {
    return { allowed: false, reason: "backup_evidence_unknown" };
  }

  if (evidence.validUntil.getTime() <= input.now.getTime()) {
    return { allowed: false, reason: "backup_evidence_expired" };
  }

  if (evidence.verifiedAt.getTime() > input.now.getTime()) {
    return { allowed: false, reason: "backup_evidence_unknown" };
  }

  if (
    evidence.longestKnownWindowDays !==
    Math.max(
      evidence.databaseRetentionDays,
      evidence.pitrRetentionDays,
      evidence.snapshotRetentionDays,
    )
  ) {
    return { allowed: false, reason: "backup_evidence_drifted" };
  }

  if (
    evidence.policyVersion !== input.expectedPolicyVersion ||
    evidence.configurationFingerprint !==
      input.expectedConfigurationFingerprint
  ) {
    return { allowed: false, reason: "backup_evidence_drifted" };
  }

  return { allowed: true, reason: "backup_evidence_current" };
}

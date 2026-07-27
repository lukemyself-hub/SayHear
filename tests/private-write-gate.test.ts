import { describe, expect, it } from "vitest";

import { evaluatePrivateWriteGate } from "@sayhear/domain";

const now = new Date("2026-07-27T16:00:00.000Z");

describe("private-write backup gate", () => {
  it("does not treat a verified label as retention evidence", () => {
    expect(
      evaluatePrivateWriteGate({
        evidence: {
          configurationFingerprint: "sha256:expected",
          policyVersion: "neon-production-v1",
          status: "verified",
          validUntil: new Date("2026-08-27T16:00:00.000Z"),
          verifiedAt: new Date("2026-07-27T15:00:00.000Z"),
        },
        expectedConfigurationFingerprint: "sha256:expected",
        expectedPolicyVersion: "neon-production-v1",
        now,
      }),
    ).toEqual({ allowed: false, reason: "backup_evidence_unknown" });
  });

  it("does not open for evidence dated after the controlled clock", () => {
    expect(
      evaluatePrivateWriteGate({
        evidence: {
          configurationFingerprint: "sha256:expected",
          databaseRetentionDays: 30,
          evidenceReference: "synthetic evidence",
          longestKnownWindowDays: 30,
          policyVersion: "neon-production-v1",
          pitrRetentionDays: 7,
          snapshotRetentionDays: 30,
          status: "verified",
          validUntil: new Date("2026-09-01T00:00:00.000Z"),
          verifiedAt: new Date("2026-08-01T00:00:00.000Z"),
        },
        expectedConfigurationFingerprint: "sha256:expected",
        expectedPolicyVersion: "neon-production-v1",
        now,
      }),
    ).toEqual({ allowed: false, reason: "backup_evidence_unknown" });
  });

  it.each([
    {
      evidence: {
        configurationFingerprint: null,
        policyVersion: "neon-production-v1",
        status: "unknown" as const,
        validUntil: null,
        verifiedAt: null,
      },
      reason: "backup_evidence_unknown",
    },
    {
      evidence: {
        configurationFingerprint: "sha256:expected",
        databaseRetentionDays: 30,
        evidenceReference: "synthetic evidence",
        longestKnownWindowDays: 30,
        policyVersion: "neon-production-v1",
        pitrRetentionDays: 7,
        snapshotRetentionDays: 30,
        status: "verified" as const,
        validUntil: new Date("2026-07-27T15:59:59.000Z"),
        verifiedAt: new Date("2026-07-20T16:00:00.000Z"),
      },
      reason: "backup_evidence_expired",
    },
    {
      evidence: {
        configurationFingerprint: "sha256:old-configuration",
        databaseRetentionDays: 30,
        evidenceReference: "synthetic evidence",
        longestKnownWindowDays: 30,
        policyVersion: "neon-production-v1",
        pitrRetentionDays: 7,
        snapshotRetentionDays: 30,
        status: "verified" as const,
        validUntil: new Date("2026-08-27T16:00:00.000Z"),
        verifiedAt: new Date("2026-07-27T15:00:00.000Z"),
      },
      reason: "backup_evidence_drifted",
    },
  ])("fails closed for $reason", ({ evidence, reason }) => {
    expect(
      evaluatePrivateWriteGate({
        evidence,
        expectedConfigurationFingerprint: "sha256:expected",
        expectedPolicyVersion: "neon-production-v1",
        now,
      }),
    ).toEqual({ allowed: false, reason });
  });
});

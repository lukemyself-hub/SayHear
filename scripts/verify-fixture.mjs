#!/usr/bin/env node
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createPostgresPool, createPostgresAuthAdapter, PostgresInternalOwnerAccessRepository, runMigrations, purgeMarkerMigrationsDirectory } from "../packages/data/src/index.ts";
import { asUserId } from "../packages/domain/src/index.ts";

const state = JSON.parse(readFileSync(process.argv[2], "utf8"));
assert.equal(process.env.SAYHEAR_DEPLOYMENT, "test");
assert.equal(process.env.SAYHEAR_PROVIDER_ADAPTER, state.standIns.provider);
const now = state.testNowInitial
  ? new Date(state.testNowInitial)
  : process.env.SAYHEAR_TEST_NOW
    ? new Date(process.env.SAYHEAR_TEST_NOW)
    : new Date();
const hour = 3_600_000;
for (const [name, database] of [["DATABASE_URL", "business"], ["PURGE_MARKER_DATABASE_URL", "marker"]]) {
  const url = new URL(process.env[name]);
  assert.equal(url.hostname, "127.0.0.1");
  assert.equal(url.port, String(state.pgPort));
  assert.equal(url.pathname, `/${database}`);
}
const pool = createPostgresPool({ connectionString: process.env.DATABASE_URL, applicationName: "sayhear-verify-fixture" });
const marker = createPostgresPool({ connectionString: process.env.PURGE_MARKER_DATABASE_URL, applicationName: "sayhear-verify-marker" });
try {
  await runMigrations(pool);
  await runMigrations(marker, { migrationsDirectory: purgeMarkerMigrationsDirectory });
  const repository = new PostgresInternalOwnerAccessRepository(pool);
  await repository.provisionInternalOwner({ issuer: "https://github.com", subject: process.env.SAYHEAR_VERIFY_OWNER_SUBJECT, userId: asUserId(state.ownerId) });
  await repository.recordBackupPolicyEvidence({ backupPolicyId: "01984477-31e1-7595-92c6-06889cb0fddd", configurationFingerprint: process.env.SAYHEAR_BACKUP_CONFIGURATION_FINGERPRINT, databaseRetentionDays: 0, evidenceReference: "LOCAL SYNTHETIC FIXTURE ONLY; no external backups asserted", policyVersion: process.env.SAYHEAR_BACKUP_POLICY_VERSION, pitrRetentionDays: 0, snapshotRetentionDays: 0, status: "verified", validUntil: new Date(now.getTime() + 365 * 24 * hour), verifiedAt: new Date(now.getTime() - hour) });
  if (state.standIns.session === "fixture") await createPostgresAuthAdapter(pool, { clock: () => now }).createSession({ expires: new Date(now.getTime() + 365 * 24 * hour), sessionToken: state.sessionToken, userId: state.ownerId });
  console.log(`Migrated separate business/marker databases; provisioned the Owner (${state.standIns.owner} subject) with ${state.standIns.session === "fixture" ? "a fixture session" : "no session"}. No conversation, Journal or Reflection records seeded.`);
} finally {
  await pool.end();
  await marker.end();
}

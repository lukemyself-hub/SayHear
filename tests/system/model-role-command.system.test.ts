import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  createModelRoleCommandService,
  createModelRoleRegistry,
  executeModelRoleAttempt,
  type ModelRoleAdapter,
  type ModelRoleConfigurationSnapshot,
} from "@sayhear/application";
import {
  PostgresBioInspectionRepository,
  PostgresModelRoleCommandRepository,
  runMigrations,
} from "@sayhear/data";
import { asUserId } from "@sayhear/domain";
import { createIsolatedPostgresSchema, type IsolatedPostgresSchema } from "@sayhear/test-support";

const testDatabaseUrl = process.env.TEST_DATABASE_URL;

const systemDescribe = testDatabaseUrl ? describe : describe.skip;

const userId = asUserId("01984477-1f9a-7b25-a5cc-83c3b21fbc68");
const now = new Date("2026-09-08T23:40:00.000Z");
const configuration: ModelRoleConfigurationSnapshot = {
  role: "episode.build",
  configVersion: "system-episode:v1",
  provider: "system-test",
  model: "synthetic-model",
  modelSnapshot: "synthetic-model@fixture",
  promptVersion: "system-prompt:v1",
  schemaVersion: "system-schema:v1",
  rolePolicyVersion: "1a3b-model-role-policy:v1",
  providerPolicyVersion: "system-episode-egress:v1",
  rolloutPin: "system-episode-pin:v1",
  freshnessPolicy: "source_valid:v1",
  fallbackMode: "disabled",
  maxTechnicalRetries: 1,
  maxSemanticRepairs: 0,
  parameterSnapshot: {
    budgetPolicyVersion: "system-test-budget:v1",
    providerCallBudget: 2,
  },
};

systemDescribe("1A.3b model role persistence", () => {
  let database: IsolatedPostgresSchema | undefined;

  beforeAll(async () => {
    const seededDatabase = await createIsolatedPostgresSchema(testDatabaseUrl!);
    database = seededDatabase;
    await runMigrations(seededDatabase.pool);
    await seededDatabase.pool.query(
      `INSERT INTO app_users (user_id, status, data_epoch, created_at, updated_at)
       VALUES ($1, 'active', 1, $2, $2)`,
      [userId, now],
    );
    await seededDatabase.pool.query(
      `INSERT INTO provider_egress_policy_versions (
         policy_version, provider, role, model_config_version, status, created_at
       ) VALUES ($1, $2, $3, $4, 'active', $5)`,
      [
        configuration.providerPolicyVersion,
        configuration.provider,
        configuration.role,
        configuration.configVersion,
        now,
      ],
    );
    await seededDatabase.pool.query(
      `INSERT INTO model_role_configurations (
         role, config_version, provider, model, model_snapshot, prompt_version,
         schema_version, role_policy_version, provider_policy_version,
         freshness_policy, fallback_mode, max_technical_retries,
         max_semantic_repairs, parameter_snapshot, created_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14::jsonb, $15)`,
      [
        configuration.role,
        configuration.configVersion,
        configuration.provider,
        configuration.model,
        configuration.modelSnapshot,
        configuration.promptVersion,
        configuration.schemaVersion,
        configuration.rolePolicyVersion,
        configuration.providerPolicyVersion,
        configuration.freshnessPolicy,
        configuration.fallbackMode,
        configuration.maxTechnicalRetries,
        configuration.maxSemanticRepairs,
        JSON.stringify(configuration.parameterSnapshot),
        now,
      ],
    );
    await seededDatabase.pool.query(
      "UPDATE model_role_definitions SET enabled = TRUE WHERE role = $1",
      [configuration.role],
    );
    await seededDatabase.pool.query(
      `INSERT INTO model_role_rollout_pins (
         role, rollout_pin, config_version, provider_policy_version,
         status, activated_at
       ) VALUES ($1, $2, $3, $4, 'active', $5)`,
      [
        configuration.role,
        configuration.rolloutPin,
        configuration.configVersion,
        configuration.providerPolicyVersion,
        now,
      ],
    );
  }, 60_000);

  afterAll(async () => {
    await database?.dispose();
  });

  it("rejects a retired G2 role before creating a command", async () => {
    const service = createModelRoleCommandService({
      registry: createModelRoleRegistry([configuration]),
      repository: new PostgresModelRoleCommandRepository(database!.pool),
    });
    await expect(service.admit({
      userId,
      role: "open_loop.extract",
      intentKey: "retired-role-probe",
      subjectType: "app_user",
      subjectId: userId,
      sourceRevision: 1,
      sourceSnapshot: "probe:1",
      inputManifest: [],
      expectedDataEpoch: 1,
      now,
    })).rejects.toThrow("not admitted in the G1-only runtime");
    const rows = await database!.pool.query<{ count: number }>(
      "SELECT count(*)::int AS count FROM generation_commands WHERE user_id = $1",
      [userId],
    );
    expect(rows.rows[0]?.count).toBe(0);
  });

  it("deduplicates admission, retries once, and keeps the same logical command", async () => {
    const service = createModelRoleCommandService({
      registry: createModelRoleRegistry([configuration]),
      repository: new PostgresModelRoleCommandRepository(database!.pool),
    });
    const input = {
      userId,
      role: configuration.role,
      intentKey: "episode:synthetic:2026-09-08",
      subjectType: "app_user" as const,
      subjectId: userId,
      sourceRevision: 4,
      sourceSnapshot: "daily-session:4",
      inputManifest: [
        { key: "evidence:4", revision: 4, fingerprint: "sha256:e4" },
      ],
      expectedDataEpoch: 1,
      now,
    };
    const first = await service.admit(input);
    const repeated = await service.admit(input);
    expect(first.outcome).toBe("created");
    expect(repeated.outcome).toBe("reused");
    expect(repeated.generationCommandId).toBe(first.generationCommandId);
    expect(repeated.modelRunAttemptId).toBe(first.modelRunAttemptId);

    const adapter: ModelRoleAdapter = {
      async execute(request) {
        return request.attemptNo === 1
          ? { outcome: "failed" as const, failureCode: "timeout" as const }
          : { outcome: "succeeded" as const };
      },
    };
    const retry = await executeModelRoleAttempt({
      adapter,
      commandService: service,
      userId,
      request: {
        generationCommandId: first.generationCommandId,
        modelRunAttemptId: first.modelRunAttemptId,
        role: configuration.role,
        attemptNo: 1,
        configuration,
        sourceRevision: 4,
        sourceSnapshot: input.sourceSnapshot,
        inputManifest: input.inputManifest,
      },
      technicalRetriesUsed: 0,
      semanticRepairsUsed: 0,
      currentSourceRevision: 4,
      expectedDataEpoch: 1,
      now,
    });
    expect(retry.outcome).toBe("retry_scheduled");
    expect(retry.nextModelRunAttemptId).toBeDefined();

    await expect(
      service.recordAttemptResult({
        userId,
        generationCommandId: first.generationCommandId,
        modelRunAttemptId: retry.nextModelRunAttemptId!,
        role: configuration.role,
        attemptNo: 2,
        technicalRetriesUsed: 0,
        semanticRepairsUsed: 0,
        outcome: "failed",
        failureCode: "timeout",
        currentSourceRevision: 4,
        expectedDataEpoch: 1,
        now: new Date(now.getTime() + 500),
      }),
    ).rejects.toThrow("retry counters");

    await expect(
      service.recordAttemptResult({
        userId,
        generationCommandId: first.generationCommandId,
        modelRunAttemptId: first.modelRunAttemptId,
        role: configuration.role,
        attemptNo: 1,
        technicalRetriesUsed: 0,
        semanticRepairsUsed: 0,
        outcome: "succeeded",
        currentSourceRevision: 5,
        expectedDataEpoch: 1,
        now: new Date(now.getTime() + 750),
      }),
    ).resolves.toMatchObject({ outcome: "discarded", reason: "already_settled" });

    const settled = await executeModelRoleAttempt({
      adapter,
      commandService: service,
      userId,
      request: {
        generationCommandId: first.generationCommandId,
        modelRunAttemptId: retry.nextModelRunAttemptId!,
        role: configuration.role,
        attemptNo: 2,
        configuration,
        sourceRevision: 4,
        sourceSnapshot: input.sourceSnapshot,
        inputManifest: input.inputManifest,
      },
      technicalRetriesUsed: 1,
      semanticRepairsUsed: 0,
      currentSourceRevision: 4,
      expectedDataEpoch: 1,
      now: new Date(now.getTime() + 1_000),
    });
    expect(settled.outcome).toBe("succeeded");

    const counts = await database!.pool.query<{
      commands: number;
      attempts: number;
      workflows: number;
      outbox: number;
    }>(
      `SELECT
         (SELECT count(*)::int FROM generation_commands WHERE user_id = $1) AS commands,
         (SELECT count(*)::int FROM model_run_attempts WHERE user_id = $1) AS attempts,
         (SELECT count(*)::int FROM workflow_commands WHERE subject_type = 'app_user' AND subject_id = $1) AS workflows,
         (SELECT count(*)::int FROM outbox_events WHERE aggregate_type = 'app_user' AND aggregate_id = $1) AS outbox`,
      [userId],
    );
    expect(counts.rows[0]).toMatchObject({
      commands: 1,
      attempts: 2,
      workflows: 2,
      outbox: 2,
    });
    await expect(
      new PostgresBioInspectionRepository(database!.pool).readCurrentBio({ userId }),
    ).resolves.toMatchObject({ outcome: "no_record" });
  }, 60_000);

  it("discards a late result after the owner epoch advances", async () => {
    const service = createModelRoleCommandService({
      registry: createModelRoleRegistry([configuration]),
      repository: new PostgresModelRoleCommandRepository(database!.pool),
    });
    const command = await service.admit({
      userId,
      role: configuration.role,
      intentKey: "episode:synthetic:late-epoch",
      subjectType: "app_user",
      subjectId: userId,
      sourceRevision: 5,
      sourceSnapshot: "daily-session:5",
      inputManifest: [],
      expectedDataEpoch: 1,
      now,
    });
    await database!.pool.query(
      "UPDATE app_users SET data_epoch = 2, updated_at = $2 WHERE user_id = $1",
      [userId, now],
    );
    await expect(
      service.recordAttemptResult({
        userId,
        generationCommandId: command.generationCommandId,
        modelRunAttemptId: command.modelRunAttemptId,
        role: configuration.role,
        attemptNo: 1,
        technicalRetriesUsed: 0,
        semanticRepairsUsed: 0,
        outcome: "succeeded",
        currentSourceRevision: 5,
        expectedDataEpoch: 1,
        now,
      }),
    ).resolves.toMatchObject({ outcome: "discarded", reason: "data_epoch" });
  }, 60_000);

  it("reads the typed Bio trace and refuses it after the owner fence changes", async () => {
    const bioId = "01984477-3f9a-7b25-a5cc-83c3b21fbc68";
    const bioVersionId = "01984477-4f9a-7b25-a5cc-83c3b21fbc68";
    const statementId = "01984477-5f9a-7b25-a5cc-83c3b21fbc68";
    const propositionId = "01984477-6f9a-7b25-a5cc-83c3b21fbc68";
    const coverageUnitId = "01984477-7f9a-7b25-a5cc-83c3b21fbc68";
    const claimVersionId = "01984477-8f9a-7b25-a5cc-83c3b21fbc68";
    const writerCommandId = "01984477-9f9a-7b25-a5cc-83c3b21fbc68";
    const writerAttemptId = "01984477-aff9-7b25-a5cc-83c3b21fbc68";
    const validatorCommandId = "01984477-bf9a-7b25-a5cc-83c3b21fbc68";
    const validatorAttemptId = "01984477-cf9a-7b25-a5cc-83c3b21fbc68";

    await database!.pool.query(
      "UPDATE app_users SET data_epoch = 1, updated_at = $2 WHERE user_id = $1",
      [userId, now],
    );
    await database!.pool.query(
      `INSERT INTO bios (
         bio_id, user_id, current_source_revision, current_data_epoch,
         created_at, updated_at
       ) VALUES ($1, $2, 8, 1, $3, $3)`,
      [bioId, userId, now],
    );
    await database!.pool.query(
      `INSERT INTO bio_versions (
         bio_version_id, bio_id, user_id, revision, status, source_revision,
         expected_data_epoch, source_manifest, presentation_locale,
         generation_command_id, writer_model_run_attempt_id,
         validator_generation_command_id, validator_model_run_attempt_id,
         created_at
       ) VALUES ($1, $2, $3, 1, 'published', 8, 1, $4::jsonb, 'en-US',
         $5, $6, $7, $8, $9)`,
      [
        bioVersionId,
        bioId,
        userId,
        JSON.stringify({ eligibleInputRevision: 8, fixture: "synthetic" }),
        writerCommandId,
        writerAttemptId,
        validatorCommandId,
        validatorAttemptId,
        now,
      ],
    );
    await database!.pool.query(
      "UPDATE bios SET current_version_id = $2 WHERE bio_id = $1 AND user_id = $3",
      [bioId, bioVersionId, userId],
    );
    await database!.pool.query(
      `INSERT INTO bio_statements (
         bio_statement_id, bio_version_id, bio_id, user_id, ordinal,
         section_key, statement_key, statement_text, created_at
       ) VALUES ($1, $2, $3, $4, 0, 'identity', 'synthetic.identity',
         'Synthetic statement', $5)`,
      [statementId, bioVersionId, bioId, userId, now],
    );
    await database!.pool.query(
      `INSERT INTO bio_atomic_propositions (
         bio_atomic_proposition_id, bio_version_id, bio_id, user_id,
         proposition_key, proposition_text, created_at
       ) VALUES ($1, $2, $3, $4, 'synthetic.proposition',
         'Synthetic proposition', $5)`,
      [propositionId, bioVersionId, bioId, userId, now],
    );
    await database!.pool.query(
      `INSERT INTO bio_coverage_units (
         bio_coverage_unit_id, bio_version_id, bio_id, user_id, unit_key,
         disposition, coverage_policy_version, source_revision,
         expected_data_epoch, created_at
       ) VALUES ($1, $2, $3, $4, 'background.synthetic', 'background_absent',
         'bio-coverage:v1', 8, 1, $5)`,
      [coverageUnitId, bioVersionId, bioId, userId, now],
    );
    await database!.pool.query(
      `INSERT INTO bio_coverage_members (
         bio_coverage_unit_id, bio_version_id, user_id,
         memory_claim_version_id, created_at
       ) VALUES ($1, $2, $3, $4, $5)`,
      [coverageUnitId, bioVersionId, userId, claimVersionId, now],
    );
    await database!.pool.query(
      `INSERT INTO bio_claim_links (
         bio_claim_link_id, bio_version_id, bio_id, user_id,
         memory_claim_version_id, link_role, support_status,
         source_revision, expected_data_epoch, created_at
       ) VALUES ($1, $2, $3, $4, $5, 'support', 'eligible', 8, 1, $6)`,
      [
        "01984477-df9a-7b25-a5cc-83c3b21fbc68",
        bioVersionId,
        bioId,
        userId,
        claimVersionId,
        now,
      ],
    );
    await database!.pool.query(
      `INSERT INTO bio_validation_findings (
         bio_validation_finding_id, bio_version_id, bio_id, user_id,
         bio_statement_id, bio_atomic_proposition_id, finding_code, severity,
         disposition, created_at
       ) VALUES ($1, $2, $3, $4, $5, $6, 'synthetic.accepted', 'warning',
         'accepted', $7)`,
      [
        "01984477-eff9-7b25-a5cc-83c3b21fbc68",
        bioVersionId,
        bioId,
        userId,
        statementId,
        propositionId,
        now,
      ],
    );

    const repository = new PostgresBioInspectionRepository(database!.pool);
    await expect(repository.readCurrentBio({ userId })).resolves.toMatchObject({
      outcome: "ok",
      bioId,
      bioVersionId,
      revision: 1,
      sourceRevision: 8,
      expectedDataEpoch: 1,
      statements: [
        expect.objectContaining({ statementKey: "synthetic.identity" }),
      ],
      propositions: [
        expect.objectContaining({ propositionKey: "synthetic.proposition" }),
      ],
      coverageUnits: [
        expect.objectContaining({
          disposition: "background_absent",
          claimVersionIds: [claimVersionId],
        }),
      ],
      claimLinks: [
        expect.objectContaining({
          memoryClaimVersionId: claimVersionId,
          linkRole: "support",
        }),
      ],
    });

    await database!.pool.query(
      "UPDATE app_users SET data_epoch = 2, updated_at = $2 WHERE user_id = $1",
      [userId, new Date(now.getTime() + 1_000)],
    );
    await expect(repository.readCurrentBio({ userId })).resolves.toMatchObject({
      outcome: "state_changed",
      bioId,
      bioVersionId,
      observedDataEpoch: 2,
    });
  }, 60_000);
});

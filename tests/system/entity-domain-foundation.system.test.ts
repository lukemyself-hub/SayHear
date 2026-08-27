import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  ACTION_ENABLED_CONVERSATION_HARNESS_POLICY,
  JOURNAL_REGENERATION_CONVERSATION_ACTION_CATALOG,
  createEntityService,
  createUserTextConversationService,
  EntityEvidenceNotFoundError,
  EntityEvidenceRevisionMismatchError,
  EntityNotFoundError,
  type EntityMentionProposal,
  type EntityService,
} from "@sayhear/application";
import {
  PostgresEntityRepository,
  PostgresInternalOwnerAccessRepository,
  PostgresUserTextConversationRepository,
  runMigrations,
} from "@sayhear/data";
import {
  createIsolatedPostgresSchema,
  fixedInternalOwnerPrincipal,
  type IsolatedPostgresSchema,
} from "@sayhear/test-support";

/**
 * SPEC #107 AC 1–3 and story 22 / 34 / 35 / 37, proven through the real
 * authenticated conversation seam: turns are submitted through the production
 * user-text conversation service against real PostgreSQL, and every Entity
 * domain assertion reads authoritative state back from the database.
 */

const testDatabaseUrl = process.env.TEST_DATABASE_URL;
if (!testDatabaseUrl) {
  throw new Error("TEST_DATABASE_URL is required.");
}

const OWNER = fixedInternalOwnerPrincipal.userId;
const now = new Date();
const clock = () => now;

const policy = Object.freeze({
  consentPolicyVersion: null,
  freshnessPolicy: "source_valid:v1" as const,
  chineseLocalePackVersion: "locale-pack-zh:v1",
  englishLocalePackVersion: "locale-pack-en:v1",
  harnessPolicyVersion: ACTION_ENABLED_CONVERSATION_HARNESS_POLICY.version,
  conversationActionCatalogVersion:
    JOURNAL_REGENERATION_CONVERSATION_ACTION_CATALOG.version,
  model: "gpt-5.4",
  modelConfigVersion: "conversation-text-champion:v1",
  modelSnapshot: "gpt-5.4",
  outputFormatVersion: "conversation-output:v1",
  canonicalPersonaVersion: "canonical-persona:v1",
  personaBehaviorAnchorsVersion: "persona-behavior-anchors:v1",
  personaContractInvariantVersion: "persona-contract-invariant:v1",
  productPolicyVersion: "product-policy:v1",
  taskInstructionVersion: "task-instruction-decision:v1",
  provider: "openai" as const,
  providerPolicyVersion: "openai-conversation-text:v1",
  relationshipPolicyVersion: "relationship-boundary:v1",
  safetyPolicyVersion: "minimum-high-risk-response:v1",
});

const EVIDENCE_SNAPSHOT_ID = "01984477-31e1-7595-92c6-0688a0b0c001";
const EVIDENCE_ITEM_ID = "01984477-31e1-7595-92c6-0688a0b0c002";

function span(text: string, surfaceForm: string, fromIndex = 0) {
  const startOffset = text.indexOf(surfaceForm, fromIndex);
  if (startOffset < 0) {
    throw new Error(`Test fixture error: ${surfaceForm} not in ${text}`);
  }
  return {
    locatorType: "text_span" as const,
    startOffset,
    endOffset: startOffset + surfaceForm.length,
  };
}

function namedProposal(
  text: string,
  surfaceForm: string,
  fromIndex = 0,
  overrides: Partial<EntityMentionProposal> = {},
): EntityMentionProposal {
  return {
    surfaceForm,
    ...span(text, surfaceForm, fromIndex),
    mentionKind: "named",
    newIntroduction: false,
    entityKindId: "sh.entity.person",
    evidenceId: null,
    ...overrides,
  };
}

describe("Entity domain foundation system seam", () => {
  let database: IsolatedPostgresSchema;
  let entityService: EntityService;
  let entityRepository: PostgresEntityRepository;
  let submitTurn: (
    text: string,
    locale: "zh-CN" | "en-US",
    sequence: number,
  ) => Promise<string>;

  beforeAll(async () => {
    database = await createIsolatedPostgresSchema(testDatabaseUrl);
    await runMigrations(database.pool);
    await new PostgresInternalOwnerAccessRepository(database.pool).provisionInternalOwner({
      issuer: "https://github.com",
      subject: "entity-test-owner",
      userId: OWNER,
    });
    entityRepository = new PostgresEntityRepository(database.pool);
    entityService = createEntityService({ repository: entityRepository, clock });
    const conversationService = createUserTextConversationService({
      clock,
      expectedBackupPolicyVersion: "neon-production-v1",
      expectedConfigurationFingerprint: "sha256:expected",
      generationPolicy: policy,
      inactivityPolicy: {
        timeoutMs: 1_800_000,
        version: "continuous-exchange-inactivity:v1",
      },
      repository: new PostgresUserTextConversationRepository(database.pool),
    });
    submitTurn = async (text, locale, sequence) => {
      const turn = await conversationService.submit(OWNER, {
        clientEventId: `entity-event-${sequence}`,
        clientTurnId: `entity-turn-${sequence}`,
        locale,
        text,
        timezone: locale === "zh-CN" ? "Asia/Shanghai" : "America/Los_Angeles",
      });
      return turn.message.revisionId;
    };
  }, 20_000);

  beforeEach(async () => {
    await database.pool.query(`
      TRUNCATE TABLE
        memory_consolidation_diffs,
        memory_consolidation_runs,
        fast_path_session_items,
        entity_resolve_gate_outcomes,
        entity_clarification_proposals,
        fast_path_extraction_runs,
        entity_mention_candidates,
        memory_forget_reversals,
        memory_forget_evidence_exclusions,
        memory_forget_requests,
        memory_candidate_evidence_links,
        memory_candidates,
        claim_evidence_links,
        memory_claim_versions,
        memory_claims,
        entity_mentions,
        entity_labels,
        user_self_entities,
        entity_versions,
        entities,
        conversation_action_payloads,
        conversation_action_receipts,
        conversation_action_executions,
        conversation_action_handles,
        current_rolling_summaries,
        rolling_summary_versions,
        rolling_summary_command_source_refs,
        rolling_summary_commands,
        journal_statement_evidence_links,
        journal_diagnostic_findings,
        journal_statements,
        journal_validation_results,
        journal_versions,
        journals,
        journal_model_run_attempts,
        journal_generation_commands,
        journal_workflow_outcomes,
        dialogue_state_command_source_refs,
        dialogue_state_versions,
        current_curiosity_stop_signals,
        current_safety_postures,
        safety_posture_alerts,
        safety_postures,
        curiosity_stop_signals,
        current_dialogue_states,
        dialogue_state_commands,
        evidence_lineage,
        evidence_model_run_attempts,
        evidence_items,
        evidence_source_snapshots,
        daily_session_date_outcomes,
        outbox_events,
        workflow_commands,
        sensitive_access_audits,
        internal_diagnostic_access_grants,
        provider_egress_consents,
        provider_egress_dispositions,
        compiled_context_revision_refs,
        compiled_contexts,
        model_run_attempts,
        generation_commands,
        continuous_exchange_inactivity_evaluations,
        conversation_event_revisions,
        conversation_events,
        interaction_turns,
        daily_sessions
    `);
    await database.pool.query("DELETE FROM backup_policy_versions");
    await database.pool.query(
      "UPDATE app_users SET status = 'active', data_epoch = 1",
    );
    await new PostgresInternalOwnerAccessRepository(
      database.pool,
    ).recordBackupPolicyEvidence({
      backupPolicyId: "01984477-31e1-7595-92c6-06889cb0fdde",
      configurationFingerprint: "sha256:expected",
      databaseRetentionDays: 30,
      evidenceReference: "synthetic backup evidence",
      policyVersion: "neon-production-v1",
      pitrRetentionDays: 7,
      snapshotRetentionDays: 30,
      status: "verified",
      validUntil: new Date("2027-08-27T00:00:00.000Z"),
      verifiedAt: new Date("2026-08-13T00:00:00.000Z"),
    });
  });

  afterAll(async () => {
    await database?.dispose();
  }, 10_000);

  async function countEntities(excludeEntityIds: readonly string[] = []) {
    const result = await database.pool.query<{ count: string }>(
      "SELECT count(*) AS count FROM entities WHERE user_id = $1",
      [OWNER],
    );
    const total = Number(result.rows[0]!.count);
    if (excludeEntityIds.length === 0) return total;
    const excluded = await database.pool.query<{ count: string }>(
      "SELECT count(*) AS count FROM entities WHERE user_id = $1 AND entity_id = ANY($2)",
      [OWNER, excludeEntityIds],
    );
    return total - Number(excluded.rows[0]!.count);
  }

  async function seedWholeRevisionEvidence(revisionId: string) {
    await database.pool.query(
      `INSERT INTO evidence_source_snapshots (
         evidence_source_snapshot_id, user_id, daily_session_id, source_revision,
         extraction_policy_version, command_id, attempt_id, champion_config_version,
         champion_provider, champion_model, champion_snapshot,
         champion_provider_policy_version, created_at
       ) VALUES ($1, $2, (SELECT daily_session_id FROM conversation_events WHERE conversation_event_id = (SELECT conversation_event_id FROM conversation_event_revisions WHERE conversation_event_revision_id = $3)), 1, 'evidence-extraction:v2', 'seed', 'seed', 'test', 'openai', 'test', 'test', 'test', $4)`,
      [EVIDENCE_SNAPSHOT_ID, OWNER, revisionId, now],
    );
    await database.pool.query(
      `INSERT INTO evidence_items (
         evidence_item_id, user_id, evidence_source_snapshot_id, source_event_id,
         source_revision_id, source_actor, source_status, locator_type,
         locator_key, extraction_policy_version, evidence_role, created_at
       ) VALUES ($1, $2, $3,
         (SELECT conversation_event_id FROM conversation_event_revisions WHERE conversation_event_revision_id = $4),
         $4, 'user', 'final', 'whole_revision', $5, 'evidence-extraction:v2',
         'factual_support', $6)`,
      [EVIDENCE_ITEM_ID, OWNER, EVIDENCE_SNAPSHOT_ID, revisionId, `revision:${revisionId}`, now],
    );
  }

  it("provisions exactly one active Self Entity through the shared lazy-in-write path, with no synthetic label", async () => {
    const text = "今天我和朋友聊了很久。";
    const revisionId = await submitTurn(text, "zh-CN", 1);

    const [resolution] = await entityService.resolveMentions({
      userId: OWNER,
      eventRevisionId: revisionId,
      proposals: [
        {
          surfaceForm: "我",
          ...span(text, "我"),
          mentionKind: "first_person",
          newIntroduction: false,
          entityKindId: "sh.entity.person",
          evidenceId: null,
        },
      ],
    });

    expect(resolution).toMatchObject({
      outcome: "bound_self",
      resolutionStatus: "resolved",
      alreadyRecorded: false,
    });
    const selfEntityId = resolution!.entityId!;
    const binding = await database.pool.query(
      "SELECT user_id, entity_id FROM user_self_entities WHERE user_id = $1",
      [OWNER],
    );
    expect(binding.rows).toHaveLength(1);
    expect(binding.rows[0]!.entity_id).toBe(selfEntityId);
    const selfState = await database.pool.query<{
      status: string;
      kind: string;
      deleted_at: Date | null;
    }>(
      `SELECT version.status, version.entity_kind_id AS kind, entity.deleted_at
       FROM entities entity
       INNER JOIN entity_versions version
         ON version.entity_version_id = entity.current_version_id
       WHERE entity.entity_id = $1`,
      [selfEntityId],
    );
    expect(selfState.rows[0]).toMatchObject({
      status: "active",
      kind: "sh.entity.person",
      deleted_at: null,
    });
    const selfLabels = await database.pool.query(
      "SELECT count(*) AS count FROM entity_labels WHERE entity_id = $1",
      [selfEntityId],
    );
    expect(Number(selfLabels.rows[0]!.count)).toBe(0);
  });

  it("converges on re-runs and when the owner backoff path provisions first", async () => {
    // Owner backoff (the db:ensure-self-entity CLI path): provisions before
    // any conversation write ever resolves a mention.
    const backfill = await entityRepository.ensureSelfEntity({
      userId: OWNER,
      now: clock(),
    });
    expect(backfill.created).toBe(true);
    const again = await entityRepository.ensureSelfEntity({
      userId: OWNER,
      now: clock(),
    });
    expect(again.created).toBe(false);
    expect(again.entityId).toBe(backfill.entityId);

    const text = "我最近还不错。";
    const revisionId = await submitTurn(text, "zh-CN", 1);
    const firstRun = await entityService.resolveMentions({
      userId: OWNER,
      eventRevisionId: revisionId,
      proposals: [
        {
          surfaceForm: "我",
          ...span(text, "我"),
          mentionKind: "first_person",
          newIntroduction: false,
          entityKindId: "sh.entity.person",
          evidenceId: null,
        },
      ],
    });
    expect(firstRun[0]!.entityId).toBe(backfill.entityId);
    const secondRun = await entityService.resolveMentions({
      userId: OWNER,
      eventRevisionId: revisionId,
      proposals: [
        {
          surfaceForm: "我",
          ...span(text, "我"),
          mentionKind: "first_person",
          newIntroduction: false,
          entityKindId: "sh.entity.person",
          evidenceId: null,
        },
      ],
    });
    expect(secondRun[0]).toMatchObject({
      alreadyRecorded: true,
      entityId: backfill.entityId,
    });
    const bindings = await database.pool.query(
      "SELECT entity_id FROM user_self_entities WHERE user_id = $1",
      [OWNER],
    );
    expect(bindings.rows).toHaveLength(1);
    const mentions = await database.pool.query(
      "SELECT count(*) AS count FROM entity_mentions WHERE user_id = $1",
      [OWNER],
    );
    expect(Number(mentions.rows[0]!.count)).toBe(1);
  });

  it("structurally refuses Self Entity merge/split versions and independent deletion", async () => {
    const { entityId, entityVersionId } = await entityRepository.ensureSelfEntity({
      userId: OWNER,
      now: clock(),
    });
    await expect(
      database.pool.query(
        `INSERT INTO entity_versions (
           entity_version_id, entity_id, user_id, revision, entity_kind_id,
           status, merged_into_entity_id, created_at
         ) VALUES ($1, $2, $3, 2, 'sh.entity.person', 'merged', NULL, $4)`,
        ["01984477-31e1-7595-92c6-0688a0b0d001", entityId, OWNER, now],
      ),
    ).rejects.toThrow(/Self Entity/);
    await expect(
      database.pool.query(
        "UPDATE entities SET deleted_at = $1 WHERE entity_id = $2 AND user_id = $3",
        [now, entityId, OWNER],
      ),
    ).rejects.toThrow(/independently deleted/);
    expect(entityVersionId).toBeTruthy();
  });

  it("creates unresolved Entities for named introductions, binds later exact matches, and keeps history on rename", async () => {
    const introText = "我认识了新同事王小龙。";
    const introRevisionId = await submitTurn(introText, "zh-CN", 1);
    const [introduction] = await entityService.resolveMentions({
      userId: OWNER,
      eventRevisionId: introRevisionId,
      proposals: [
        {
          surfaceForm: "王小龙",
          ...span(introText, "王小龙"),
          mentionKind: "named",
          newIntroduction: true,
          entityKindId: "sh.entity.person",
          evidenceId: null,
        },
      ],
    });
    expect(introduction).toMatchObject({
      outcome: "created_unresolved",
      resolutionStatus: "resolved",
    });
    const wangEntityId = introduction!.entityId!;
    const wang = await entityService.inspectEntity(OWNER, wangEntityId);
    expect(wang).toMatchObject({ isSelf: false, deletedAt: null });
    expect(wang!.versions).toHaveLength(1);
    expect(wang!.versions[0]).toMatchObject({
      revision: 1,
      status: "unresolved",
      entityKindId: "sh.entity.person",
    });
    expect(wang!.labels).toHaveLength(1);
    expect(wang!.labels[0]).toMatchObject({
      labelKind: "primary",
      isCurrent: true,
      label: "王小龙",
    });

    const referenceText = "王小龙今天请我喝了咖啡。";
    const referenceRevisionId = await submitTurn(referenceText, "zh-CN", 2);
    const [reference] = await entityService.resolveMentions({
      userId: OWNER,
      eventRevisionId: referenceRevisionId,
      proposals: [
        {
          surfaceForm: "王小龙",
          ...span(referenceText, "王小龙"),
          mentionKind: "named",
          newIntroduction: false,
          entityKindId: "sh.entity.person",
          evidenceId: null,
        },
      ],
    });
    expect(reference).toMatchObject({
      outcome: "bound",
      entityId: wangEntityId,
    });

    const rename = await entityService.renamePrimaryLabel({
      userId: OWNER,
      entityId: wangEntityId,
      locale: "zh-CN",
      label: "小龙",
    });
    expect(rename.created).toBe(true);
    const renamed = await entityService.inspectEntity(OWNER, wangEntityId);
    expect(renamed!.entityId).toBe(wangEntityId);
    expect(renamed!.labels).toHaveLength(2);
    const currentPrimary = renamed!.labels.find(
      (label) => label.labelKind === "primary" && label.isCurrent,
    );
    const historicalPrimary = renamed!.labels.find(
      (label) => label.labelKind === "primary" && !label.isCurrent,
    );
    expect(currentPrimary?.label).toBe("小龙");
    expect(historicalPrimary?.label).toBe("王小龙");
    expect(renamed!.versions[0]!.revision).toBe(1);

    await expect(
      entityService.renamePrimaryLabel({
        userId: OWNER,
        entityId: "01984477-31e1-7595-92c6-0688a0b0e001",
        locale: "zh-CN",
        label: "不存在",
      }),
    ).rejects.toBeInstanceOf(EntityNotFoundError);
  });

  it("never auto-merges same-name introductions and keeps multi-candidate mentions unbound", async () => {
    const firstIntro = "我认识了新同事王小龙。";
    const firstRevisionId = await submitTurn(firstIntro, "zh-CN", 1);
    const [first] = await entityService.resolveMentions({
      userId: OWNER,
      eventRevisionId: firstRevisionId,
      proposals: [
        {
          surfaceForm: "王小龙",
          ...span(firstIntro, "王小龙"),
          mentionKind: "named",
          newIntroduction: true,
          entityKindId: "sh.entity.person",
          evidenceId: null,
        },
      ],
    });
    const secondIntro = "对了，我健身房的教练也叫王小龙。";
    const secondRevisionId = await submitTurn(secondIntro, "zh-CN", 2);
    const [second] = await entityService.resolveMentions({
      userId: OWNER,
      eventRevisionId: secondRevisionId,
      proposals: [
        {
          surfaceForm: "王小龙",
          ...span(secondIntro, "王小龙"),
          mentionKind: "named",
          newIntroduction: true,
          entityKindId: "sh.entity.person",
          evidenceId: null,
        },
      ],
    });
    expect(second!.outcome).toBe("created_unresolved");
    expect(second!.entityId).not.toBe(first!.entityId);
    // Self Entity + the two same-name Entities; same-name never auto-merges.
    expect(await countEntities()).toBe(3);

    const ambiguousText = "王小龙约我周末打球。";
    const ambiguousRevisionId = await submitTurn(ambiguousText, "zh-CN", 3);
    const [ambiguous] = await entityService.resolveMentions({
      userId: OWNER,
      eventRevisionId: ambiguousRevisionId,
      proposals: [
        {
          surfaceForm: "王小龙",
          ...span(ambiguousText, "王小龙"),
          mentionKind: "named",
          newIntroduction: false,
          entityKindId: "sh.entity.person",
          evidenceId: null,
        },
      ],
    });
    expect(ambiguous).toMatchObject({
      outcome: "ambiguous",
      entityId: null,
      resolutionStatus: "ambiguous",
    });
    expect(ambiguous!.candidates.map((c) => c.candidateKind)).toEqual([
      "multi_exact",
      "multi_exact",
    ]);
    const mentionRow = await database.pool.query(
      `SELECT resolved_entity_id, resolution_status, confidence
       FROM entity_mentions WHERE user_id = $1 AND event_revision_id = $2`,
      [OWNER, ambiguousRevisionId],
    );
    expect(mentionRow.rows[0]).toMatchObject({
      resolved_entity_id: null,
      resolution_status: "ambiguous",
      confidence: null,
    });
    const diagnostics = await database.pool.query(
      `SELECT count(*) AS count FROM entity_mention_candidates
       WHERE user_id = $1 AND candidate_kind = 'multi_exact'`,
      [OWNER],
    );
    expect(Number(diagnostics.rows[0]!.count)).toBe(2);
  });

  it("resolves cross-language aliases to one Entity with no duplicates (story 22)", async () => {
    const introText = "我认识了新同事王小龙。";
    const introRevisionId = await submitTurn(introText, "zh-CN", 1);
    const [introduction] = await entityService.resolveMentions({
      userId: OWNER,
      eventRevisionId: introRevisionId,
      proposals: [
        {
          surfaceForm: "王小龙",
          ...span(introText, "王小龙"),
          mentionKind: "named",
          newIntroduction: true,
          entityKindId: "sh.entity.person",
          evidenceId: null,
        },
      ],
    });
    const wangEntityId = introduction!.entityId!;

    await seedWholeRevisionEvidence(introRevisionId);

    const alias = await entityService.addVerifiedAlias({
      userId: OWNER,
      entityId: wangEntityId,
      locale: "en-US",
      label: "Xiaolong Wang",
      evidenceId: EVIDENCE_ITEM_ID,
    });
    expect(alias.created).toBe(true);
    const aliasAgain = await entityService.addVerifiedAlias({
      userId: OWNER,
      entityId: wangEntityId,
      locale: "en-US",
      label: "Xiaolong Wang",
      evidenceId: EVIDENCE_ITEM_ID,
    });
    expect(aliasAgain.created).toBe(false);

    const enText = "I went hiking with Xiaolong Wang today.";
    const enRevisionId = await submitTurn(enText, "en-US", 2);
    const [resolved] = await entityService.resolveMentions({
      userId: OWNER,
      eventRevisionId: enRevisionId,
      proposals: [
        {
          surfaceForm: "Xiaolong Wang",
          ...span(enText, "Xiaolong Wang"),
          mentionKind: "named",
          newIntroduction: false,
          entityKindId: "sh.entity.person",
          evidenceId: null,
        },
      ],
    });
    expect(resolved).toMatchObject({
      outcome: "bound",
      entityId: wangEntityId,
    });
    // Self Entity + the one introduced Entity: the alias bound, nothing new.
    expect(await countEntities()).toBe(2);

    await expect(
      entityService.addVerifiedAlias({
        userId: OWNER,
        entityId: wangEntityId,
        locale: "en-US",
        label: "Unverified Form",
        evidenceId: "01984477-31e1-7595-92c6-0688a0b0f001",
      }),
    ).rejects.toBeInstanceOf(EntityEvidenceNotFoundError);
  });

  it("keeps pronoun mentions unbound without creating Entities", async () => {
    const text = "她昨天看起来很开心。";
    const revisionId = await submitTurn(text, "zh-CN", 1);
    const [pronoun] = await entityService.resolveMentions({
      userId: OWNER,
      eventRevisionId: revisionId,
      proposals: [
        {
          surfaceForm: "她",
          ...span(text, "她"),
          mentionKind: "pronoun",
          newIntroduction: false,
          entityKindId: "sh.entity.person",
          evidenceId: null,
        },
      ],
    });
    expect(pronoun).toMatchObject({
      outcome: "unbound",
      entityId: null,
      resolutionStatus: "unresolved",
      candidates: [],
    });
    const mentionRow = await database.pool.query(
      "SELECT resolved_entity_id FROM entity_mentions WHERE user_id = $1",
      [OWNER],
    );
    expect(mentionRow.rows[0]!.resolved_entity_id).toBeNull();
    const { entityId: selfEntityId } = await entityRepository.ensureSelfEntity({
      userId: OWNER,
      now: clock(),
    });
    expect(await countEntities([selfEntityId])).toBe(0);
  });

  it("treats fuzzy near-forms as candidates only — no auto-bind, no duplicate Entities", async () => {
    const introText = "My new colleague Marla started today.";
    const introRevisionId = await submitTurn(introText, "en-US", 1);
    const [introduction] = await entityService.resolveMentions({
      userId: OWNER,
      eventRevisionId: introRevisionId,
      proposals: [
        {
          surfaceForm: "Marla",
          ...span(introText, "Marla"),
          mentionKind: "named",
          newIntroduction: true,
          entityKindId: "sh.entity.person",
          evidenceId: null,
        },
      ],
    });
    const marlaEntityId = introduction!.entityId!;

    const nearText = "Marie said the trail was steep.";
    const nearRevisionId = await submitTurn(nearText, "en-US", 2);
    const [nearForm] = await entityService.resolveMentions({
      userId: OWNER,
      eventRevisionId: nearRevisionId,
      proposals: [
        {
          surfaceForm: "Marie",
          ...span(nearText, "Marie"),
          mentionKind: "named",
          newIntroduction: false,
          entityKindId: "sh.entity.person",
          evidenceId: null,
        },
      ],
    });
    expect(nearForm).toMatchObject({
      outcome: "unbound",
      entityId: null,
      resolutionStatus: "unresolved",
    });
    expect(nearForm!.candidates).toEqual([
      {
        entityId: marlaEntityId,
        matchedLabel: "Marla",
        candidateKind: "near_form",
        editDistance: 2,
      },
    ]);
    // Only the Self Entity and Marla exist — the near-form created nothing.
    expect(await countEntities()).toBe(2);

    const mentionRow = await database.pool.query(
      `SELECT resolved_entity_id, resolution_status FROM entity_mentions
       WHERE user_id = $1 AND event_revision_id = $2`,
      [OWNER, nearRevisionId],
    );
    expect(mentionRow.rows[0]!.resolved_entity_id).toBeNull();
    const diagnostics = await database.pool.query(
      `SELECT candidate_entity_id, matched_label, candidate_kind, edit_distance
       FROM entity_mention_candidates WHERE user_id = $1`,
      [OWNER],
    );
    expect(diagnostics.rows).toEqual([
      {
        candidate_entity_id: marlaEntityId,
        matched_label: "Marla",
        candidate_kind: "near_form",
        edit_distance: 2,
      },
    ]);
  });

  it("binds a same-revision re-mention to the Entity the batch just introduced", async () => {
    const text = "我认识了新同事王小龙。王小龙很高。";
    const first = span(text, "王小龙");
    const revisionId = await submitTurn(text, "zh-CN", 1);
    const [introduction, remention] = await entityService.resolveMentions({
      userId: OWNER,
      eventRevisionId: revisionId,
      proposals: [
        namedProposal(text, "王小龙", 0, { newIntroduction: true }),
        namedProposal(text, "王小龙", first.endOffset),
      ],
    });
    expect(introduction!.outcome).toBe("created_unresolved");
    expect(remention).toMatchObject({
      outcome: "created_unresolved",
      entityId: introduction!.entityId,
      resolutionStatus: "resolved",
    });
    // Self Entity + the one introduced Entity — the re-mention duplicated
    // nothing and both mentions are bound to the new Entity.
    expect(await countEntities()).toBe(2);
    const resolvedMentions = await database.pool.query(
      `SELECT count(*) AS count FROM entity_mentions
       WHERE user_id = $1 AND event_revision_id = $2 AND resolved_entity_id = $3`,
      [OWNER, revisionId, introduction!.entityId],
    );
    expect(Number(resolvedMentions.rows[0]!.count)).toBe(2);
  });

  it("rejects mention evidence that cites a different revision", async () => {
    const introText = "我认识了新同事王小龙。";
    const introRevisionId = await submitTurn(introText, "zh-CN", 1);
    await seedWholeRevisionEvidence(introRevisionId);
    const laterText = "王小龙很高。";
    const laterRevisionId = await submitTurn(laterText, "zh-CN", 2);
    await expect(
      entityService.resolveMentions({
        userId: OWNER,
        eventRevisionId: laterRevisionId,
        proposals: [
          namedProposal(laterText, "王小龙", 0, {
            evidenceId: EVIDENCE_ITEM_ID,
          }),
        ],
      }),
    ).rejects.toBeInstanceOf(EntityEvidenceRevisionMismatchError);
  });
});

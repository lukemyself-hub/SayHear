import type { Pool } from "pg";

import type {
  CandidateFenceState,
  MemoryRetrievalPolicy,
  MemorySectionKey,
  MemoryRetrievalRepository,
  MemoryVersionDetail,
  MemoryVersionEvidence,
  RetrievalLane,
  RetrievalLaneRow,
  RetrievalQuerySourceRef,
  RetrievalQuerySubstrate,
  RetrievalRunManifest,
  RankComponents,
  TrustFenceResult,
  RetrievalLanePlanEntry,
} from "@sayhear/application";
import type { DailySessionId, UserId } from "@sayhear/domain";

import { createUuidV7 } from "./uuid-v7";

/**
 * Postgres implementation of the Structured-Lexical Retrieval Baseline
 * repository (issue #116, architecture §10). Lane queries read only active
 * projections of current claim versions; the fence loader re-checks the
 * full trust-fence state per candidate so a stale projection can never serve.
 * Run rows and candidate rows store references and codes only — never User
 * Event prose or Evidence quotes.
 */

type LaneRow = {
  memory_claim_id: string;
  memory_claim_version_id: string;
  claim_retrieval_projection_id: string;
  canonical_key: string;
  subject_entity_id: string;
  object_entity_id: string | null;
  predicate_id: string;
  kind: "objective" | "impression";
  temporal_status: "current" | "ended" | "unknown";
  valid_from: string | null;
  valid_to: string | null;
  last_observed_at: string;
  typed_value_text: string | null;
  matched_terms: string[] | null;
  fts_rank: string | number | null;
};

const LANE_TARGET_JOIN = `
  FROM memory_claims claim
  INNER JOIN memory_claim_versions v
    ON v.memory_claim_version_id = claim.current_version_id
   AND v.user_id = claim.user_id
   AND v.content_purged_at IS NULL
  INNER JOIN claim_retrieval_projections proj
    ON proj.memory_claim_version_id = v.memory_claim_version_id
   AND proj.user_id = v.user_id
   AND proj.status = 'active'
   AND proj.content_purged_at IS NULL
  WHERE claim.user_id = $1
    AND claim.deleted_at IS NULL
    AND claim.content_purged_at IS NULL
`;

const LANE_COLUMNS = `
  claim.memory_claim_id::text,
  v.memory_claim_version_id::text,
  proj.claim_retrieval_projection_id::text,
  claim.canonical_key,
  claim.subject_entity_id::text,
  claim.object_entity_id::text,
  claim.predicate_id,
  v.kind,
  v.temporal_status,
  v.valid_from,
  v.valid_to,
  v.last_observed_at,
  v.typed_value::text
`;

// A ClaimVersion matches through ANY of its active locale projections;
// matched material aggregates across both locales so an English-only hit
// never collapses into a false single-term zh row (architecture §10.3
// cross-language identity rule). The representative projection row stays
// deterministic (zh preferred).
const LANE_MATCHED_TERMS_SQL = `
  (SELECT array_agg(DISTINCT term) FROM (
     SELECT p2.memory_claim_version_id, term
     FROM claim_retrieval_projections p2
     CROSS JOIN LATERAL unnest(p2.lexical_terms) AS term
     WHERE p2.user_id = claim.user_id
       AND p2.memory_claim_version_id = v.memory_claim_version_id
       AND p2.status = 'active'
       AND p2.content_purged_at IS NULL
       AND term = ANY($2::text[])
   ) matched)
`;

const LANE_MATCHING_PROJECTION_EXISTS_SQL = `
  EXISTS (
    SELECT 1 FROM claim_retrieval_projections p2
    WHERE p2.user_id = claim.user_id
      AND p2.memory_claim_version_id = v.memory_claim_version_id
      AND p2.status = 'active'
      AND p2.content_purged_at IS NULL
      AND p2.lexical_terms && $2::text[]
  )
`;

export class PostgresMemoryRetrievalRepository
  implements MemoryRetrievalRepository
{
  public constructor(private readonly pool: Pool) {}

  public async loadPolicy(version: string): Promise<MemoryRetrievalPolicy | null> {
    const result = await this.pool.query<
      { policy_version: string; deadline_ms: number; candidate_limit_per_lane: number }
    >(
      `SELECT policy_version, deadline_ms, candidate_limit_per_lane
       FROM retrieval_policies WHERE policy_version = $1`,
      [version],
    );
    const row = result.rows[0];
    if (!row) return null;
    return {
      version: row.policy_version,
      deadlineMs: Number(row.deadline_ms),
      candidateLimitPerLane: Number(row.candidate_limit_per_lane),
    };
  }

  public async loadQueryConstructionSources(input: {
    userId: UserId;
    dailySessionId: DailySessionId;
    exchangeNo: number;
    beforeSequence: number;
  }): Promise<RetrievalQuerySubstrate> {
    // The last two final / corrected User Events of the current Continuous
    // Exchange — Assistant Events are structurally excluded (story 44).
    const priorEvents = await this.pool.query<{
      revision_id: string;
      text: string;
    }>(
      `SELECT revision.conversation_event_revision_id::text AS revision_id,
              revision.canonical_text AS text
       FROM conversation_events event
       INNER JOIN interaction_turns turn
         ON turn.interaction_turn_id = event.interaction_turn_id
        AND turn.user_id = event.user_id
       INNER JOIN conversation_event_revisions revision
         ON revision.conversation_event_revision_id = event.current_revision_id
        AND revision.user_id = event.user_id
       WHERE event.user_id = $1
         AND event.daily_session_id = $2
         AND turn.continuous_exchange_no = $3
         AND event.actor = 'user'
         AND event.lifecycle_status = 'active'
         AND revision.content_purged_at IS NULL
         AND revision.transcript_status IN ('final', 'corrected')
         AND event.sequence_no < $4
       ORDER BY event.sequence_no DESC
       LIMIT 2`,
      [
        input.userId,
        input.dailySessionId,
        input.exchangeNo,
        input.beforeSequence,
      ],
    );

    const labelIndex = await this.pool.query<{
      entity_id: string;
      label: string;
      label_kind: "primary" | "alias";
      locale: string;
    }>(
      `SELECT label.entity_id::text, label.label, label.label_kind, label.locale
       FROM entity_labels label
       INNER JOIN entities entity
         ON entity.entity_id = label.entity_id AND entity.user_id = label.user_id
       INNER JOIN entity_versions version
         ON version.entity_version_id = entity.current_version_id
        AND version.entity_id = entity.entity_id
        AND version.user_id = entity.user_id
       WHERE label.user_id = $1
         AND label.is_current
         AND label.content_purged_at IS NULL
         AND entity.deleted_at IS NULL
         AND version.status IN ('active', 'unresolved')
         AND (label.label_kind = 'primary' OR label.source_evidence_id IS NOT NULL)`,
      [input.userId],
    );

    const selfEntity = await this.pool.query<{ entity_id: string }>(
      `SELECT binding.entity_id::text
       FROM user_self_entities binding
       INNER JOIN entities entity
         ON entity.entity_id = binding.entity_id AND entity.user_id = binding.user_id
       INNER JOIN entity_versions version
         ON version.entity_version_id = entity.current_version_id
        AND version.entity_id = entity.entity_id
        AND version.user_id = entity.user_id
       WHERE binding.user_id = $1
         AND entity.deleted_at IS NULL
         AND version.status = 'active'`,
      [input.userId],
    );

    // Resolver Hints re-validated at read time: only hints whose source
    // version is still the claim's current version can bind (ADR-0027 /
    // knowledge model §7.11 — stale hints fail closed).
    const hints = await this.pool.query<{
      resolved_entity_id: string;
      phrase: string;
      locale: string;
    }>(
      `SELECT hint.resolved_entity_id::text, hint.phrase, hint.locale
       FROM relationship_resolver_hints hint
       INNER JOIN memory_claims claim
         ON claim.memory_claim_id = hint.memory_claim_id
        AND claim.user_id = hint.user_id
       WHERE hint.user_id = $1
         AND hint.phrase IS NOT NULL
         AND claim.current_version_id = hint.memory_claim_version_id
         AND claim.deleted_at IS NULL
         AND claim.content_purged_at IS NULL`,
      [input.userId],
    );

    return {
      priorUserEvents: priorEvents.rows.map((row) => ({
        revisionId: row.revision_id,
        text: row.text,
      })),
      selfEntityId: selfEntity.rows[0]?.entity_id ?? null,
      labelIndex: labelIndex.rows.map((row) => ({
        entityId: row.entity_id,
        label: row.label,
        labelKind: row.label_kind,
        locale: row.locale,
      })),
      resolverHints: hints.rows.map((row) => ({
        entityId: row.resolved_entity_id,
        phrase: row.phrase!,
        locale: row.locale,
      })),
    };
  }

  public async runStructuredLane(input: {
    userId: UserId;
    entityIds: readonly string[];
    predicateIds: readonly string[];
    canonicalKeys: readonly string[];
    dateTokens: readonly string[];
    limit: number;
  }): Promise<readonly RetrievalLaneRow[]> {
    const valuePatterns = input.dateTokens.map((token) => `%${token}%`);
    const result = await this.pool.query<LaneRow>(
      `SELECT * FROM (
        SELECT DISTINCT ON (v.memory_claim_version_id)
          ${LANE_COLUMNS},
          NULL::text[] AS matched_terms,
          NULL::numeric AS fts_rank
        ${LANE_TARGET_JOIN}
        AND (
          claim.subject_entity_id = ANY($2::uuid[])
          OR claim.object_entity_id = ANY($2::uuid[])
          OR claim.predicate_id = ANY($3::text[])
          OR claim.canonical_key = ANY($4::text[])
          OR v.typed_value::text LIKE ANY($5::text[])
        )
        ORDER BY v.memory_claim_version_id, proj.locale DESC
      ) lane_rows
      -- Exact signals outrank weaker dimensions so the per-lane cap can
      -- never evict a canonical-key or Entity hit (deterministic under cap).
      ORDER BY
        (lane_rows.canonical_key = ANY($4::text[])) DESC,
        (
          lane_rows.subject_entity_id::uuid = ANY($2::uuid[])
          OR lane_rows.object_entity_id::uuid = ANY($2::uuid[])
        ) DESC,
        (lane_rows.predicate_id = ANY($3::text[])) DESC,
        lane_rows.last_observed_at DESC
      LIMIT $6`,
      [
        input.userId,
        input.entityIds,
        input.predicateIds,
        input.canonicalKeys,
        valuePatterns,
        input.limit,
      ],
    );
    return result.rows.map((row) => toLaneRow("structured_exact", row));
  }

  public async runLexicalLane(input: {
    userId: UserId;
    terms: readonly string[];
    limit: number;
  }): Promise<readonly RetrievalLaneRow[]> {
    const result = await this.pool.query<LaneRow>(
      `SELECT * FROM (
        SELECT DISTINCT ON (v.memory_claim_version_id)
          ${LANE_COLUMNS},
          ${LANE_MATCHED_TERMS_SQL} AS matched_terms,
          NULL::numeric AS fts_rank
        ${LANE_TARGET_JOIN}
        AND ${LANE_MATCHING_PROJECTION_EXISTS_SQL}
        ORDER BY v.memory_claim_version_id, proj.locale DESC
      ) lane_rows
      ORDER BY coalesce(array_length(lane_rows.matched_terms, 1), 0) DESC,
               lane_rows.last_observed_at DESC
      LIMIT $3`,
      [input.userId, input.terms, input.limit],
    );
    return result.rows.map((row) => toLaneRow("lexical_term_overlap", row));
  }

  public async runEnglishLane(input: {
    userId: UserId;
    queryText: string;
    limit: number;
  }): Promise<readonly RetrievalLaneRow[]> {
    // plainto_tsquery is inlined per reference so the GIN index and the rank
    // expression bind to the same query (architecture §10.1 lane 3); the
    // match may come from either locale's projection, so the rank is the
    // best row of the version.
    const result = await this.pool.query<LaneRow>(
      `SELECT * FROM (
        SELECT DISTINCT ON (v.memory_claim_version_id)
          ${LANE_COLUMNS},
          NULL::text[] AS matched_terms,
          (
            SELECT max(ts_rank_cd(p2.english_search,
                                  plainto_tsquery('pg_catalog.english', $2)))
            FROM claim_retrieval_projections p2
            WHERE p2.user_id = claim.user_id
              AND p2.memory_claim_version_id = v.memory_claim_version_id
              AND p2.status = 'active'
              AND p2.content_purged_at IS NULL
              AND p2.english_search @@ plainto_tsquery('pg_catalog.english', $2)
          ) AS fts_rank
        ${LANE_TARGET_JOIN}
        AND EXISTS (
          SELECT 1 FROM claim_retrieval_projections p2
          WHERE p2.user_id = claim.user_id
            AND p2.memory_claim_version_id = v.memory_claim_version_id
            AND p2.status = 'active'
            AND p2.content_purged_at IS NULL
            AND p2.english_search @@ plainto_tsquery('pg_catalog.english', $2)
        )
        ORDER BY v.memory_claim_version_id, proj.locale DESC
      ) lane_rows
      ORDER BY lane_rows.fts_rank DESC, lane_rows.last_observed_at DESC
      LIMIT $3`,
      [input.userId, input.queryText, input.limit],
    );
    return result.rows.map((row) => toLaneRow("english_fts", row));
  }

  public async loadCandidateFenceStates(
    userId: UserId,
    versionIds: readonly string[],
  ): Promise<readonly CandidateFenceState[]> {
    if (versionIds.length === 0) return [];
    const result = await this.pool.query<{
      memory_claim_version_id: string;
      is_current_version: boolean;
      claim_deleted: boolean;
      claim_content_purged: boolean;
      version_content_purged: boolean;
      projection_content_purged: boolean;
      version_status: CandidateFenceState["versionStatus"];
      epistemic_status: CandidateFenceState["epistemicStatus"];
      active_whole_claim_forget: boolean;
      valid_evidence_count: string;
      subject_entity_version_status: string | null;
      object_entity_version_status: string | null;
      subject_entity_current_version_status: string | null;
      object_entity_current_version_status: string | null;
      subject_entity_deleted: boolean | null;
      object_entity_deleted: boolean | null;
    }>(
      `SELECT
        v.memory_claim_version_id::text,
        (claim.current_version_id = v.memory_claim_version_id) AS is_current_version,
        (claim.deleted_at IS NOT NULL) AS claim_deleted,
        (claim.content_purged_at IS NOT NULL) AS claim_content_purged,
        (v.content_purged_at IS NOT NULL) AS version_content_purged,
        EXISTS (
          SELECT 1 FROM claim_retrieval_projections p
          WHERE p.memory_claim_version_id = v.memory_claim_version_id
            AND p.user_id = v.user_id
            AND p.content_purged_at IS NOT NULL
        ) AS projection_content_purged,
        v.status AS version_status,
        v.epistemic_status,
        EXISTS (
          SELECT 1 FROM memory_forget_requests f
          WHERE f.user_id = v.user_id
            AND f.target_claim_id = v.memory_claim_id
            AND f.target_scope = 'whole_claim'
            AND f.status = 'applied'
            AND NOT EXISTS (
              SELECT 1 FROM memory_forget_reversals r
              WHERE r.memory_forget_request_id = f.memory_forget_request_id
                AND r.user_id = f.user_id
                AND r.status = 'active'
            )
        ) AS active_whole_claim_forget,
        (
          SELECT COUNT(*)
          FROM claim_evidence_links l
          INNER JOIN evidence_items e
            ON e.evidence_item_id = l.evidence_item_id
           AND e.user_id = l.user_id
          WHERE l.user_id = v.user_id
            AND l.memory_claim_version_id = v.memory_claim_version_id
            AND l.status = 'active'
            AND l.link_role IN ('support', 'subjective_report')
            AND e.status = 'active'
            AND NOT EXISTS (
              SELECT 1 FROM memory_forget_evidence_exclusions x
              WHERE x.user_id = l.user_id
                AND x.evidence_item_id = l.evidence_item_id
                AND x.status = 'active'
                AND x.exclusion_scope = 'whole_claim'
            )
        ) AS valid_evidence_count,
        subject_version.status AS subject_entity_version_status,
        object_version.status AS object_entity_version_status,
        subject_entity_current.status AS subject_entity_current_version_status,
        object_entity_current.status AS object_entity_current_version_status,
        (subject_entity.deleted_at IS NOT NULL) AS subject_entity_deleted,
        (object_entity.deleted_at IS NOT NULL) AS object_entity_deleted
      FROM memory_claim_versions v
      INNER JOIN memory_claims claim
        ON claim.memory_claim_id = v.memory_claim_id
       AND claim.user_id = v.user_id
      LEFT JOIN entity_versions subject_version
        ON subject_version.entity_version_id = v.subject_entity_version_id
       AND subject_version.user_id = v.user_id
      LEFT JOIN entity_versions object_version
        ON object_version.entity_version_id = v.object_entity_version_id
       AND object_version.user_id = v.user_id
      LEFT JOIN entities subject_entity
        ON subject_entity.entity_id = claim.subject_entity_id
       AND subject_entity.user_id = claim.user_id
      LEFT JOIN entities object_entity
        ON object_entity.entity_id = claim.object_entity_id
       AND object_entity.user_id = claim.user_id
      LEFT JOIN entity_versions subject_entity_current
        ON subject_entity_current.entity_version_id = subject_entity.current_version_id
       AND subject_entity_current.user_id = claim.user_id
      LEFT JOIN entity_versions object_entity_current
        ON object_entity_current.entity_version_id = object_entity.current_version_id
       AND object_entity_current.user_id = claim.user_id
      WHERE v.user_id = $1
        AND v.memory_claim_version_id = ANY($2::uuid[])`,
      [userId, versionIds],
    );
    return result.rows.map((row) => ({
      versionId: row.memory_claim_version_id,
      isCurrentVersion: row.is_current_version,
      claimDeleted: row.claim_deleted,
      claimContentPurged: row.claim_content_purged,
      versionContentPurged: row.version_content_purged,
      projectionContentPurged: row.projection_content_purged,
      versionStatus: row.version_status,
      epistemicStatus: row.epistemic_status,
      activeWholeClaimForget: row.active_whole_claim_forget,
      validEvidenceCount: Number(row.valid_evidence_count),
      subjectEntityVersionStatus: row.subject_entity_version_status,
      objectEntityVersionStatus: row.object_entity_version_status,
      subjectEntityCurrentVersionStatus:
        row.subject_entity_current_version_status,
      objectEntityCurrentVersionStatus: row.object_entity_current_version_status,
      subjectEntityDeleted: row.subject_entity_deleted === true,
      objectEntityDeleted: row.object_entity_deleted === true,
    }));
  }

  public async loadPortraitCandidateVersions(input: {
    userId: UserId;
    predicateIds: readonly string[];
    locale: "zh" | "en";
  }): Promise<readonly MemoryVersionDetail[]> {
    if (input.predicateIds.length === 0) return [];
    const result = await this.pool.query<MemoryDetailRow>(
      `SELECT ${MEMORY_DETAIL_COLUMNS}
       ${MEMORY_DETAIL_TARGET_JOIN}
        AND claim.predicate_id = ANY($2::text[])`,
      [input.userId, input.predicateIds, input.locale],
    );
    return result.rows.map(toMemoryVersionDetail);
  }

  public async loadMemoryVersionDetails(input: {
    userId: UserId;
    versionIds: readonly string[];
    locale: "zh" | "en";
  }): Promise<readonly MemoryVersionDetail[]> {
    if (input.versionIds.length === 0) return [];
    const result = await this.pool.query<MemoryDetailRow>(
      `SELECT ${MEMORY_DETAIL_COLUMNS}
       ${MEMORY_DETAIL_TARGET_JOIN}
        AND v.memory_claim_version_id = ANY($2::uuid[])`,
      [input.userId, input.versionIds, input.locale],
    );
    return result.rows.map(toMemoryVersionDetail);
  }

  public async loadMemoryVersionEvidence(
    userId: UserId,
    versionIds: readonly string[],
  ): Promise<readonly MemoryVersionEvidence[]> {
    if (versionIds.length === 0) return [];
    // The same validity rules the fence loader applies: active support /
    // subjective-report links onto active Evidence, minus Forget exclusions.
    const result = await this.pool.query<{
      memory_claim_version_id: string;
      evidence_ids: string[];
      latest_evidence_at: Date | null;
    }>(
      `SELECT
        l.memory_claim_version_id::text,
        array_agg(e.evidence_item_id::text ORDER BY e.created_at, e.evidence_item_id) AS evidence_ids,
        max(e.created_at) AS latest_evidence_at
      FROM claim_evidence_links l
      INNER JOIN evidence_items e
        ON e.evidence_item_id = l.evidence_item_id
       AND e.user_id = l.user_id
      WHERE l.user_id = $1
        AND l.memory_claim_version_id = ANY($2::uuid[])
        AND l.status = 'active'
        AND l.link_role IN ('support', 'subjective_report')
        AND e.status = 'active'
        AND NOT EXISTS (
          SELECT 1 FROM memory_forget_evidence_exclusions x
          WHERE x.user_id = l.user_id
            AND x.evidence_item_id = l.evidence_item_id
            AND x.status = 'active'
            AND x.exclusion_scope = 'whole_claim'
        )
      GROUP BY l.memory_claim_version_id`,
      [userId, versionIds],
    );
    return result.rows.map((row) => ({
      versionId: row.memory_claim_version_id,
      evidenceIds: row.evidence_ids ?? [],
      latestEvidenceAt:
        row.latest_evidence_at === null
          ? null
          : new Date(row.latest_evidence_at).toISOString(),
    }));
  }

  public async insertRetrievalRun(input: {
    retrievalRunId: string;
    userId: UserId;
    dailySessionId: DailySessionId;
    sourceEventRevisionId: string;
    retrievalPolicyVersion: string;
    queryConstructionPolicyVersion: string;
    projectionPolicyVersion: string;
    deadlineMs: number;
    querySourceRefs: readonly RetrievalQuerySourceRef[];
    normalizedQueryTerms: RetrievalRunManifest["normalized_query_terms"];
    lanePlan: readonly RetrievalLanePlanEntry[];
    startedAt: Date;
  }): Promise<void> {
    await this.pool.query(
      `INSERT INTO retrieval_runs (
        retrieval_run_id, user_id, daily_session_id, source_event_revision_id,
        compiled_context_id, retrieval_policy_version,
        query_construction_policy_version, projection_policy_version,
        query_source_refs, normalized_query_terms, lane_plan, deadline_ms,
        status, degraded_reason_codes, duration_ms, deadline_exceeded_stage,
        timings, started_at, completed_at
      ) VALUES (
        $1, $2, $3, $4, NULL, $5, $6, $7,
        $8::jsonb, $9::jsonb, $10::jsonb, $11,
        'running', '{}', 0, NULL, '{}'::jsonb, $12, NULL
      )`,
      [
        input.retrievalRunId,
        input.userId,
        input.dailySessionId,
        input.sourceEventRevisionId,
        input.retrievalPolicyVersion,
        input.queryConstructionPolicyVersion,
        input.projectionPolicyVersion,
        JSON.stringify(input.querySourceRefs ?? []),
        JSON.stringify(input.normalizedQueryTerms ?? {}),
        JSON.stringify(input.lanePlan ?? []),
        input.deadlineMs,
        input.startedAt,
      ],
    );
  }

  public async completeRetrievalRun(input: {
    retrievalRunId: string;
    userId: UserId;
    status: "completed" | "degraded" | "failed";
    degradedReasonCodes: readonly string[];
    durationMs: number;
    deadlineExceededStage: string | null;
    timings: Readonly<Record<string, number>>;
    completedAt: Date;
  }): Promise<void> {
    await this.pool.query(
      `UPDATE retrieval_runs SET
        status = $3,
        degraded_reason_codes = $4,
        duration_ms = $5,
        deadline_exceeded_stage = $6,
        timings = $7::jsonb,
        completed_at = $8
      WHERE user_id = $1 AND retrieval_run_id = $2 AND status = 'running'`,
      [
        input.userId,
        input.retrievalRunId,
        input.status,
        input.degradedReasonCodes,
        input.durationMs,
        input.deadlineExceededStage,
        JSON.stringify(input.timings),
        input.completedAt,
      ],
    );
  }

  public async insertRetrievalCandidates(input: {
    retrievalRunId: string;
    userId: UserId;
    candidates: readonly {
      claimVersionId: string;
      retrievalProjectionId: string;
      lane: RetrievalLane;
      matchedFields: readonly string[];
      matchedTerms: readonly string[];
      trustFenceResults: readonly TrustFenceResult[];
      rankComponents: RankComponents;
      finalRank: number | null;
      selectedSection: MemorySectionKey | null;
      selectionReasonCodes: readonly string[];
      rejectionReasonCodes: readonly string[];
    }[];
    now: Date;
  }): Promise<void> {
    if (input.candidates.length === 0) return;
    // One round trip for the whole candidate set: the insert sits inside the
    // shared retrieval deadline. Parameter numbers are assigned explicitly.
    const tuples: string[] = [];
    const values: unknown[] = [input.retrievalRunId, input.userId];
    for (const candidate of input.candidates) {
      const base = values.length;
      tuples.push(
        `($${base + 1}::uuid, $1, $2, $${base + 2}::uuid, $${base + 3}::uuid,` +
          ` $${base + 4}, $${base + 5}::jsonb, $${base + 6}::jsonb,` +
          ` $${base + 7}::jsonb, $${base + 8}::jsonb, $${base + 9},` +
          ` $${base + 10}, $${base + 11}, $${base + 12}, $${base + 13})`,
      );
      values.push(
        createUuidV7(input.now),
        candidate.claimVersionId,
        candidate.retrievalProjectionId,
        candidate.lane,
        JSON.stringify(candidate.matchedFields),
        JSON.stringify(candidate.matchedTerms),
        JSON.stringify(candidate.trustFenceResults),
        JSON.stringify(candidate.rankComponents),
        candidate.finalRank,
        candidate.selectedSection,
        candidate.selectionReasonCodes,
        candidate.rejectionReasonCodes,
        input.now,
      );
    }
    await this.pool.query(
      `INSERT INTO retrieval_run_candidates (
        retrieval_run_candidate_id, retrieval_run_id, user_id,
        memory_claim_version_id, claim_retrieval_projection_id,
        retrieval_lane, matched_fields, matched_terms,
        trust_fence_results, rank_components, final_rank,
        selected_section, selection_reason_codes, rejection_reason_codes,
        created_at
      ) VALUES ${tuples.join(", ")}`,
      values,
    );
  }
}

function toLaneRow(
  lane: RetrievalLaneRow["lane"],
  row: LaneRow,
): RetrievalLaneRow {
  return {
    lane,
    memory_claim_id: row.memory_claim_id,
    memory_claim_version_id: row.memory_claim_version_id,
    claim_retrieval_projection_id: row.claim_retrieval_projection_id,
    canonical_key: row.canonical_key,
    subject_entity_id: row.subject_entity_id,
    object_entity_id: row.object_entity_id,
    predicate_id: row.predicate_id,
    kind: row.kind,
    temporal_status: row.temporal_status,
    valid_from: row.valid_from === null ? null : iso(row.valid_from),
    valid_to: row.valid_to === null ? null : iso(row.valid_to),
    last_observed_at: iso(row.last_observed_at),
    typed_value_text: row.typed_value_text,
    matched_terms: row.matched_terms,
    fts_rank: row.fts_rank === null ? null : Number(row.fts_rank),
  };
}

function iso(value: string | Date): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

// #117: memory-compilation hydration reads the locale-resolved projection of
// current claim versions — the same structural prefilter the lanes apply;
// trust fences re-check per candidate in the service layer.

type MemoryDetailRow = {
  memory_claim_id: string;
  memory_claim_version_id: string;
  predicate_id: string;
  kind: "objective" | "impression";
  epistemic_status: "confirmed" | "inferred" | "contested";
  temporal_status: "current" | "ended" | "unknown";
  valid_from: string | null;
  valid_to: string | null;
  subject_entity_id: string;
  object_entity_id: string | null;
  subject_entity_version_id: string | null;
  object_entity_version_id: string | null;
  retrieval_text: string;
  lexical_terms: string[] | null;
  last_observed_at: string;
};

const MEMORY_DETAIL_TARGET_JOIN = `
  FROM memory_claims claim
  INNER JOIN memory_claim_versions v
    ON v.memory_claim_version_id = claim.current_version_id
   AND v.user_id = claim.user_id
   AND v.content_purged_at IS NULL
  INNER JOIN claim_retrieval_projections proj
    ON proj.memory_claim_version_id = v.memory_claim_version_id
   AND proj.user_id = v.user_id
   AND proj.status = 'active'
   AND proj.content_purged_at IS NULL
   AND proj.locale = $3::text
  WHERE claim.user_id = $1
    AND claim.deleted_at IS NULL
    AND claim.content_purged_at IS NULL
`;

const MEMORY_DETAIL_COLUMNS = `
  claim.memory_claim_id::text,
  v.memory_claim_version_id::text,
  claim.predicate_id,
  v.kind,
  v.epistemic_status,
  v.temporal_status,
  v.valid_from,
  v.valid_to,
  claim.subject_entity_id::text,
  claim.object_entity_id::text,
  v.subject_entity_version_id::text,
  v.object_entity_version_id::text,
  proj.retrieval_text,
  proj.lexical_terms,
  v.last_observed_at
`;

function toMemoryVersionDetail(row: MemoryDetailRow): MemoryVersionDetail {
  return {
    versionId: row.memory_claim_version_id,
    claimId: row.memory_claim_id,
    predicateId: row.predicate_id,
    kind: row.kind,
    epistemicStatus: row.epistemic_status,
    temporalStatus: row.temporal_status,
    validFrom: row.valid_from === null ? null : iso(row.valid_from),
    validTo: row.valid_to === null ? null : iso(row.valid_to),
    subjectEntityId: row.subject_entity_id,
    objectEntityId: row.object_entity_id,
    subjectEntityVersionId: row.subject_entity_version_id,
    objectEntityVersionId: row.object_entity_version_id,
    renderedText: row.retrieval_text,
    lexicalTerms: row.lexical_terms ?? [],
    lastObservedAt: iso(row.last_observed_at),
  };
}

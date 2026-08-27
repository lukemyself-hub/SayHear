import {
  EntityEvidenceNotFoundError,
  EntityEvidenceRevisionMismatchError,
  EntityNotFoundError,
  EntityRevisionNotFoundError,
  planEntityMentionResolution,
  planGateCommit,
  SelfEntityIntegrityError,
  type EntityLabelIndexEntry,
  type EntityMentionProposal,
  type EntityMentionResolution,
  type EntityRecord,
  type EntityRepository,
  type EntityResolutionStatus,
  type EntityVersionStatus,
  type SelfEntityBinding,
} from "@sayhear/application";
import type { Pool, PoolClient } from "pg";
import { lockActiveOwnerEpoch } from "./postgres-owner-epoch-fence";
import { createUuidV7 } from "./uuid-v7";

/** The entity.resolve gate referenced a mention that does not exist. */
export class EntityMentionNotFoundError extends Error {
  public constructor(mentionId: string) {
    super(`EntityMention ${mentionId} does not exist for this user.`);
  }
}

type MentionRow = {
  entity_mention_id: string;
  conversation_event_id: string;
  event_revision_id: string;
  evidence_id: string | null;
  locator_type: "whole_revision" | "text_span";
  start_offset: number | null;
  end_offset: number | null;
  mention_kind: "first_person" | "named" | "pronoun";
  resolved_entity_id: string | null;
  resolution_status: EntityResolutionStatus;
  resolver_policy_version: string;
};

type CandidateRow = {
  entity_mention_id: string;
  candidate_entity_id: string;
  matched_label: string;
  candidate_kind: "near_form" | "multi_exact";
  edit_distance: number | null;
};

function mentionSpanKey(row: {
  locator_type: string;
  start_offset: number | null;
  end_offset: number | null;
}): string {
  // "whole" marks the null offsets of a whole_revision locator so the key
  // never collides with a text_span offset pair.
  return `${row.locator_type}:${row.start_offset ?? "whole"}-${row.end_offset ?? "whole"}`;
}

function alreadyRecordedOutcome(row: MentionRow): EntityMentionResolution["outcome"] {
  if (row.resolution_status === "resolved") {
    return row.mention_kind === "first_person" ? "bound_self" : "bound";
  }
  return row.resolution_status === "ambiguous" ? "ambiguous" : "unbound";
}

export class PostgresEntityRepository implements EntityRepository {
  public constructor(private readonly pool: Pool) {}

  public async ensureSelfEntity(input: {
    userId: string;
    now: Date;
  }): Promise<SelfEntityBinding> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const binding = await ensureSelfEntityWithin(client, input.userId, input.now);
      await client.query("COMMIT");
      return binding;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  public async findSelfEntity(
    userId: string,
  ): Promise<{ entityId: string; entityVersionId: string } | null> {
    const result = await this.pool.query<{ entity_id: string; entity_version_id: string }>(
      `SELECT binding.entity_id, entity.current_version_id AS entity_version_id
       FROM user_self_entities binding
       INNER JOIN entities entity
         ON entity.entity_id = binding.entity_id AND entity.user_id = binding.user_id
       WHERE binding.user_id = $1`,
      [userId],
    );
    const row = result.rows[0];
    return row
      ? { entityId: row.entity_id, entityVersionId: row.entity_version_id }
      : null;
  }

  public async loadCurrentLabelIndex(
    userId: string,
  ): Promise<readonly EntityLabelIndexEntry[]> {
    const client = await this.pool.connect();
    try {
      return await loadCurrentLabelIndexWithin(client, userId);
    } finally {
      client.release();
    }
  }

  public async resolveMentions(input: {
    userId: string;
    eventRevisionId: string;
    proposals: readonly EntityMentionProposal[];
    resolverPolicyVersion: string;
    now: Date;
  }): Promise<readonly EntityMentionResolution[]> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const results = await resolveMentionsWithin(client, input);
      await client.query("COMMIT");
      return results;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * The single `entity.resolve` LLM gate commit (issue #113, #97): binds the
   * mention only when the selection is a recorded candidate, the verdict is
   * match, and confidence ≥ t_auto — validated again in-transaction, because
   * deterministic code (never the model response) commits. Idempotent per
   * (mention, resolver policy, gate policy); replays return the existing
   * binding. Every outcome, committed or not, lands in the audit table.
   */
  public async applyEntityResolveGateOutcome(input: {
    userId: string;
    mentionId: string;
    selectedEntityId: string | null;
    verdict: "match" | "no_match" | "unclear";
    confidence: number;
    tAuto: number;
    candidateEntityIds: readonly string[];
    gatePolicyVersion: string;
    resolverPolicyVersion: string;
    expectedDataEpoch: number;
    now: Date;
  }): Promise<{ applied: boolean; boundEntityId: string | null }> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      // Authoritative write fence (architecture 13.4): lock the owner and
      // verify the epoch the command froze before binding identity.
      const epoch = await lockActiveOwnerEpoch(client, input.userId);
      if (epoch === null || epoch !== input.expectedDataEpoch) {
        await client.query("ROLLBACK");
        throw new Error(
          "entity.resolve gate commit was fenced by the owner epoch.",
        );
      }
      const existing = await client.query<{
        committed: boolean;
        selected_entity_id: string | null;
      }>(
        `SELECT committed, selected_entity_id FROM entity_resolve_gate_outcomes
         WHERE user_id = $1 AND entity_mention_id = $2
           AND resolver_policy_version = $3 AND gate_policy_version = $4`,
        [
          input.userId,
          input.mentionId,
          input.resolverPolicyVersion,
          input.gatePolicyVersion,
        ],
      );
      if (existing.rows.length > 0) {
        await client.query("COMMIT");
        return {
          applied: existing.rows[0]!.committed,
          boundEntityId: existing.rows[0]!.selected_entity_id,
        };
      }
      const mention = await client.query<{
        entity_mention_id: string;
        resolved_entity_id: string | null;
        resolution_status: string;
      }>(
        `SELECT entity_mention_id, resolved_entity_id, resolution_status
         FROM entity_mentions
         WHERE user_id = $1 AND entity_mention_id = $2
         AND resolver_policy_version = $3
         FOR UPDATE`,
        [input.userId, input.mentionId, input.resolverPolicyVersion],
      );
      const mentionRow = mention.rows[0];
      if (!mentionRow) {
        await client.query("ROLLBACK");
        throw new EntityMentionNotFoundError(input.mentionId);
      }
      const candidates = await client.query<{ candidate_entity_id: string }>(
        `SELECT candidate_entity_id FROM entity_mention_candidates
         WHERE user_id = $1 AND entity_mention_id = $2`,
        [input.userId, input.mentionId],
      );
      const candidateIds = candidates.rows.map((row) => row.candidate_entity_id);
      if (candidateIds.length === 0) {
        await client.query("ROLLBACK");
        throw new Error(
          "entity.resolve gate applied to a mention with no recorded candidates.",
        );
      }
      const plan = planGateCommit({
        tAuto: input.tAuto,
        candidates: candidateIds.map((entityId) => ({ entityId })),
        response: {
          verdict: input.verdict,
          entityId: input.selectedEntityId,
          confidence: input.confidence,
        },
      });
      if (plan.committed && plan.boundEntityId !== null) {
        await client.query(
          `UPDATE entity_mentions
           SET resolved_entity_id = $1, resolution_status = 'resolved',
               confidence = $2
           WHERE user_id = $3 AND entity_mention_id = $4`,
          [
            plan.boundEntityId,
            input.confidence,
            input.userId,
            input.mentionId,
          ],
        );
      }
      await client.query(
        `INSERT INTO entity_resolve_gate_outcomes (
           entity_resolve_gate_outcome_id, user_id, entity_mention_id,
           gate_policy_version, resolver_policy_version, t_auto, verdict,
           selected_entity_id, confidence, candidate_count, committed,
           not_committed_reason, created_at
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
        [
          createUuidV7(input.now),
          input.userId,
          input.mentionId,
          input.gatePolicyVersion,
          input.resolverPolicyVersion,
          input.tAuto,
          input.verdict,
          plan.boundEntityId,
          input.confidence,
          candidateIds.length,
          plan.committed,
          plan.notCommittedReason,
          input.now,
        ],
      );
      await client.query("COMMIT");
      return { applied: plan.committed, boundEntityId: plan.boundEntityId };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  public async addVerifiedAlias(input: {
    userId: string;
    entityId: string;
    locale: string;
    label: string;
    normalizedLabel: string;
    evidenceId: string;
    now: Date;
  }): Promise<{ labelId: string; created: boolean }> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await lockEntityForLabelWrite(client, input.userId, input.entityId);
      await assertEvidenceExists(client, input.userId, input.evidenceId);
      const inserted = await client.query<{ entity_label_id: string }>(
        `INSERT INTO entity_labels (
           entity_label_id, entity_id, user_id, locale, label, normalized_label,
           label_kind, is_current, source_evidence_id, created_at
         ) VALUES ($1, $2, $3, $4, $5, $6, 'alias', TRUE, $7, $8)
         ON CONFLICT DO NOTHING
         RETURNING entity_label_id`,
        [
          createUuidV7(input.now),
          input.entityId,
          input.userId,
          input.locale,
          input.label,
          input.normalizedLabel,
          input.evidenceId,
          input.now,
        ],
      );
      if (inserted.rows[0]) {
        await client.query("COMMIT");
        return { labelId: inserted.rows[0].entity_label_id, created: true };
      }
      const existing = await client.query<{ entity_label_id: string }>(
        `SELECT entity_label_id FROM entity_labels
         WHERE user_id = $1 AND entity_id = $2 AND locale = $3
           AND normalized_label = $4 AND label_kind = 'alias' AND is_current
           AND content_purged_at IS NULL`,
        [input.userId, input.entityId, input.locale, input.normalizedLabel],
      );
      await client.query("COMMIT");
      return {
        labelId: existing.rows[0]!.entity_label_id,
        created: false,
      };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  public async renamePrimaryLabel(input: {
    userId: string;
    entityId: string;
    locale: string;
    label: string;
    normalizedLabel: string;
    evidenceId: string | null;
    now: Date;
  }): Promise<{ labelId: string; created: boolean }> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await lockEntityForLabelWrite(client, input.userId, input.entityId);
      if (input.evidenceId != null) {
        await assertEvidenceExists(client, input.userId, input.evidenceId);
      }
      const existing = await client.query<{ entity_label_id: string }>(
        `SELECT entity_label_id FROM entity_labels
         WHERE user_id = $1 AND entity_id = $2 AND locale = $3
           AND label_kind = 'primary' AND is_current AND content_purged_at IS NULL`,
        [input.userId, input.entityId, input.locale],
      );
      const current = existing.rows[0];
      if (current) {
        const sameForm = await client.query<{ entity_label_id: string }>(
          `SELECT entity_label_id FROM entity_labels
           WHERE entity_label_id = $1 AND normalized_label = $2`,
          [current.entity_label_id, input.normalizedLabel],
        );
        if (sameForm.rows[0]) {
          await client.query("COMMIT");
          return { labelId: current.entity_label_id, created: false };
        }
        await client.query(
          `UPDATE entity_labels SET is_current = FALSE
           WHERE entity_label_id = $1`,
          [current.entity_label_id],
        );
      }
      const inserted = await client.query<{ entity_label_id: string }>(
        `INSERT INTO entity_labels (
           entity_label_id, entity_id, user_id, locale, label, normalized_label,
           label_kind, is_current, source_evidence_id, created_at
         ) VALUES ($1, $2, $3, $4, $5, $6, 'primary', TRUE, $7, $8)
         RETURNING entity_label_id`,
        [
          createUuidV7(input.now),
          input.entityId,
          input.userId,
          input.locale,
          input.label,
          input.normalizedLabel,
          input.evidenceId,
          input.now,
        ],
      );
      await client.query("COMMIT");
      return { labelId: inserted.rows[0]!.entity_label_id, created: true };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  public async inspectEntity(
    userId: string,
    entityId: string,
  ): Promise<EntityRecord | null> {
    const entity = await this.pool.query<{
      entity_id: string;
      created_at: Date;
      deleted_at: Date | null;
      self_bound: boolean;
    }>(
      `SELECT entity.entity_id, entity.created_at, entity.deleted_at,
         EXISTS (
           SELECT 1 FROM user_self_entities binding WHERE binding.entity_id = entity.entity_id
         ) AS self_bound
       FROM entities entity
       WHERE entity.entity_id = $1 AND entity.user_id = $2`,
      [entityId, userId],
    );
    const row = entity.rows[0];
    if (!row) return null;
    const versions = await this.pool.query<{
      entity_version_id: string;
      revision: number;
      entity_kind_id: string;
      status: EntityVersionStatus;
      merged_into_entity_id: string | null;
      supersedes_version_id: string | null;
      created_at: Date;
    }>(
      `SELECT entity_version_id, revision, entity_kind_id, status,
         merged_into_entity_id, supersedes_version_id, created_at
       FROM entity_versions
       WHERE user_id = $1 AND entity_id = $2
       ORDER BY revision`,
      [userId, entityId],
    );
    const labels = await this.pool.query<{
      entity_label_id: string;
      locale: string;
      label: string;
      normalized_label: string;
      label_kind: "primary" | "alias";
      is_current: boolean;
      source_evidence_id: string | null;
      created_at: Date;
    }>(
      `SELECT entity_label_id, locale, label, normalized_label, label_kind,
         is_current, source_evidence_id, created_at
       FROM entity_labels
       WHERE user_id = $1 AND entity_id = $2
       ORDER BY created_at, entity_label_id`,
      [userId, entityId],
    );
    return {
      entityId: row.entity_id,
      userId,
      createdAt: row.created_at,
      deletedAt: row.deleted_at,
      isSelf: row.self_bound,
      versions: versions.rows.map((version) => ({
        id: version.entity_version_id,
        revision: Number(version.revision),
        entityKindId: version.entity_kind_id,
        status: version.status,
        mergedIntoEntityId: version.merged_into_entity_id,
        supersedesVersionId: version.supersedes_version_id,
        createdAt: version.created_at,
      })),
      labels: labels.rows.map((label) => ({
        id: label.entity_label_id,
        locale: label.locale,
        label: label.label,
        normalizedLabel: label.normalized_label,
        labelKind: label.label_kind,
        isCurrent: label.is_current,
        sourceEvidenceId: label.source_evidence_id,
        createdAt: label.created_at,
      })),
    };
  }
}

/**
 * The one idempotent ensure-self-entity path (SPEC AC 2 / story 37), shared by
 * lazy-in-write mention resolution and the owner backoff CLI. Convergence: an
 * advisory lock per user serializes provisioning, an existing binding is
 * returned as-is, and an inconsistent binding fails closed instead of creating
 * a second Self Entity. The created Entity carries no label — first-person
 * references resolve through the binding, never a synthetic label.
 */
async function ensureSelfEntityWithin(
  client: PoolClient,
  userId: string,
  now: Date,
): Promise<SelfEntityBinding> {
  await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [
    userId,
  ]);
  const boundOnly = await client.query<{ entity_id: string }>(
    "SELECT entity_id FROM user_self_entities WHERE user_id = $1",
    [userId],
  );
  if (boundOnly.rows[0]) {
    const state = await client.query<{
      entity_id: string;
      entity_version_id: string | null;
      deleted_at: Date | null;
      status: EntityVersionStatus | null;
    }>(
      `SELECT entity.entity_id, entity.current_version_id AS entity_version_id,
         entity.deleted_at, version.status
       FROM entities entity
       LEFT JOIN entity_versions version
         ON version.entity_version_id = entity.current_version_id
       WHERE entity.entity_id = $1 AND entity.user_id = $2`,
      [boundOnly.rows[0].entity_id, userId],
    );
    const row = state.rows[0];
    if (
      !row ||
      row.deleted_at !== null ||
      !row.entity_version_id ||
      row.status !== "active"
    ) {
      throw new SelfEntityIntegrityError(
        userId,
        `bound entity ${boundOnly.rows[0].entity_id} is not an active Self Entity`,
      );
    }
    return {
      entityId: row.entity_id,
      entityVersionId: row.entity_version_id,
      created: false,
    };
  }
  const entityId = createUuidV7(now);
  const versionId = createUuidV7(now);
  await client.query(
    "INSERT INTO entities (entity_id, user_id, created_at) VALUES ($1, $2, $3)",
    [entityId, userId, now],
  );
  await client.query(
    `INSERT INTO entity_versions (
       entity_version_id, entity_id, user_id, revision, entity_kind_id,
       status, created_at
     ) VALUES ($1, $2, $3, 1, 'sh.entity.person', 'active', $4)`,
    [versionId, entityId, userId, now],
  );
  await client.query(
    "UPDATE entities SET current_version_id = $1 WHERE entity_id = $2 AND user_id = $3",
    [versionId, entityId, userId],
  );
  await client.query(
    "INSERT INTO user_self_entities (user_id, entity_id, created_at) VALUES ($1, $2, $3)",
    [userId, entityId, now],
  );
  return { entityId, entityVersionId: versionId, created: true };
}

async function loadCurrentLabelIndexWithin(
  client: PoolClient | Pool,
  userId: string,
): Promise<readonly EntityLabelIndexEntry[]> {
  const result = await client.query<{
    entity_id: string;
    label: string;
    normalized_label: string;
    label_kind: "primary" | "alias";
    locale: string;
  }>(
    `SELECT label.entity_id, label.label, label.normalized_label,
       label.label_kind, label.locale
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
       -- Verified-alias discipline: only current primary labels and
       -- evidence-backed aliases are deterministic binding surfaces.
       AND (label.label_kind = 'primary' OR label.source_evidence_id IS NOT NULL)`,
    [userId],
  );
  return result.rows.map((row) => ({
    entityId: row.entity_id,
    label: row.label,
    normalizedLabel: row.normalized_label,
    labelKind: row.label_kind,
    locale: row.locale,
  }));
}

async function resolveMentionsWithin(
  client: PoolClient,
  input: {
    userId: string;
    eventRevisionId: string;
    proposals: readonly EntityMentionProposal[];
    resolverPolicyVersion: string;
    now: Date;
  },
): Promise<readonly EntityMentionResolution[]> {
  const revision = await client.query<{
    conversation_event_id: string;
    locale: string;
    canonical_text: string;
  }>(
    `SELECT conversation_event_id, locale, canonical_text
     FROM conversation_event_revisions
     WHERE conversation_event_revision_id = $1 AND user_id = $2
       AND transcript_status IN ('final', 'corrected')
       AND content_purged_at IS NULL`,
    [input.eventRevisionId, input.userId],
  );
  const sourceRevision = revision.rows[0];
  if (!sourceRevision) {
    throw new EntityRevisionNotFoundError(input.eventRevisionId);
  }
  for (const proposal of input.proposals) {
    if (
      proposal.locatorType === "text_span" &&
      proposal.endOffset! > sourceRevision.canonical_text.length
    ) {
      throw new Error(
        `text_span offsets exceed the revision text (end ${proposal.endOffset} > length ${sourceRevision.canonical_text.length}).`,
      );
    }
  }
  // Architecture §7.7: EntityMention evidence must cite the very revision
  // the mention lives in, preventing cross-source misbinding.
  const citedEvidenceIds = [
    ...new Set(
      input.proposals
        .map((proposal) => proposal.evidenceId)
        .filter((evidenceId): evidenceId is string => evidenceId != null),
    ),
  ];
  if (citedEvidenceIds.length > 0) {
    const cited = await client.query<{ evidence_item_id: string }>(
      `SELECT evidence_item_id FROM evidence_items
       WHERE user_id = $1 AND evidence_item_id = ANY($2)
         AND source_revision_id = $3`,
      [input.userId, citedEvidenceIds, input.eventRevisionId],
    );
    if (cited.rows.length !== citedEvidenceIds.length) {
      const found = new Set(cited.rows.map((row) => row.evidence_item_id));
      const missing = citedEvidenceIds.filter((id) => !found.has(id));
      const existing = await client.query<{ evidence_item_id: string }>(
        "SELECT evidence_item_id FROM evidence_items WHERE user_id = $1 AND evidence_item_id = ANY($2)",
        [input.userId, missing],
      );
      if (existing.rows.length !== missing.length) {
        throw new EntityEvidenceNotFoundError(input.userId, missing[0]!);
      }
      throw new EntityEvidenceRevisionMismatchError(
        missing[0]!,
        input.eventRevisionId,
      );
    }
  }
  // Lazy-in-write: the first 1A.3a entity write provisions the Self Entity
  // through the same shared path as the owner backoff (architecture §7.7).
  const self = await ensureSelfEntityWithin(client, input.userId, input.now);
  const existing = await client.query<MentionRow>(
    `SELECT entity_mention_id, conversation_event_id, event_revision_id,
       evidence_id, locator_type, start_offset, end_offset, mention_kind,
       resolved_entity_id, resolution_status, resolver_policy_version
     FROM entity_mentions
     WHERE user_id = $1 AND event_revision_id = $2
       AND resolver_policy_version = $3`,
    [input.userId, input.eventRevisionId, input.resolverPolicyVersion],
  );
  const existingByKey = new Map(
    existing.rows.map((row) => [mentionSpanKey(row), row]),
  );
  const candidateRows = existing.rows.length
    ? await client.query<CandidateRow>(
        `SELECT entity_mention_id, candidate_entity_id, matched_label,
           candidate_kind, edit_distance
         FROM entity_mention_candidates
         WHERE user_id = $1 AND entity_mention_id = ANY($2)`,
        [input.userId, existing.rows.map((row) => row.entity_mention_id)],
      )
    : { rows: [] as CandidateRow[] };
  const candidatesByMention = new Map<string, CandidateRow[]>();
  for (const candidate of candidateRows.rows) {
    const list = candidatesByMention.get(candidate.entity_mention_id) ?? [];
    list.push(candidate);
    candidatesByMention.set(candidate.entity_mention_id, list);
  }
  const labels = await loadCurrentLabelIndexWithin(client, input.userId);
  const plans = planEntityMentionResolution(
    { selfEntityId: self.entityId, locale: sourceRevision.locale, labels },
    input.proposals,
  );
  const batchEntityIds = new Map<number, string>();
  const results: EntityMentionResolution[] = [];
  for (let index = 0; index < input.proposals.length; index++) {
    const proposal = input.proposals[index]!;
    const alreadyRow = existingByKey.get(
      mentionSpanKey({
        locator_type: proposal.locatorType,
        start_offset: proposal.startOffset,
        end_offset: proposal.endOffset,
      }),
    );
    if (alreadyRow) {
      results.push({
        mentionId: alreadyRow.entity_mention_id,
        surfaceForm: proposal.surfaceForm,
        outcome: alreadyRecordedOutcome(alreadyRow),
        entityId: alreadyRow.resolved_entity_id,
        resolutionStatus: alreadyRow.resolution_status,
        alreadyRecorded: true,
        candidates: (candidatesByMention.get(alreadyRow.entity_mention_id) ?? []).map(
          (candidate) => ({
            entityId: candidate.candidate_entity_id,
            matchedLabel: candidate.matched_label,
            candidateKind: candidate.candidate_kind,
            editDistance: candidate.edit_distance,
          }),
        ),
      });
      continue;
    }
    const plan = plans[index]!;
    let entityId = plan.entityId;
    if (plan.createEntity) {
      entityId = await insertUnresolvedEntity(client, {
        userId: input.userId,
        entityKindId: plan.entityKindId!,
        label: plan.primaryLabel!,
        evidenceId: proposal.evidenceId,
        now: input.now,
      });
      batchEntityIds.set(index, entityId);
    } else if (plan.bindToBatchIndex !== null) {
      entityId = batchEntityIds.get(plan.bindToBatchIndex) ?? null;
      if (!entityId) {
        throw new Error(
          "Resolution plan referenced an introduction outside this batch.",
        );
      }
    }
    const mentionId = await insertMentionRow(client, {
      userId: input.userId,
      conversationEventId: sourceRevision.conversation_event_id,
      eventRevisionId: input.eventRevisionId,
      proposal,
      entityId,
      resolutionStatus: plan.resolutionStatus,
      resolverPolicyVersion: input.resolverPolicyVersion,
      now: input.now,
    });
    if (mentionId.newlyInserted) {
      for (const candidate of plan.candidates) {
        await client.query(
          `INSERT INTO entity_mention_candidates (
             entity_mention_candidate_id, entity_mention_id, user_id,
             candidate_entity_id, matched_label, candidate_kind, edit_distance,
             created_at
           ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
           ON CONFLICT DO NOTHING`,
          [
            createUuidV7(input.now),
            mentionId.id,
            input.userId,
            candidate.entityId,
            candidate.matchedLabel,
            candidate.candidateKind,
            candidate.editDistance,
            input.now,
          ],
        );
      }
    }
    results.push({
      mentionId: mentionId.id,
      surfaceForm: proposal.surfaceForm,
      outcome: plan.outcome,
      entityId,
      resolutionStatus: plan.resolutionStatus,
      alreadyRecorded: !mentionId.newlyInserted,
      candidates: plan.candidates,
    });
  }
  return results;
}

async function insertUnresolvedEntity(
  client: PoolClient,
  input: {
    userId: string;
    entityKindId: string;
    label: { locale: string; label: string; normalizedLabel: string };
    evidenceId: string | null;
    now: Date;
  },
): Promise<string> {
  const entityId = createUuidV7(input.now);
  const versionId = createUuidV7(input.now);
  await client.query(
    "INSERT INTO entities (entity_id, user_id, created_at) VALUES ($1, $2, $3)",
    [entityId, input.userId, input.now],
  );
  await client.query(
    `INSERT INTO entity_versions (
       entity_version_id, entity_id, user_id, revision, entity_kind_id,
       status, created_at
     ) VALUES ($1, $2, $3, 1, $4, 'unresolved', $5)`,
    [versionId, entityId, input.userId, input.entityKindId, input.now],
  );
  await client.query(
    "UPDATE entities SET current_version_id = $1 WHERE entity_id = $2 AND user_id = $3",
    [versionId, entityId, input.userId],
  );
  await client.query(
    `INSERT INTO entity_labels (
       entity_label_id, entity_id, user_id, locale, label, normalized_label,
       label_kind, is_current, source_evidence_id, created_at
     ) VALUES ($1, $2, $3, $4, $5, $6, 'primary', TRUE, $7, $8)`,
    [
      createUuidV7(input.now),
      entityId,
      input.userId,
      input.label.locale,
      input.label.label,
      input.label.normalizedLabel,
      input.evidenceId,
      input.now,
    ],
  );
  return entityId;
}

async function insertMentionRow(
  client: PoolClient,
  input: {
    userId: string;
    conversationEventId: string;
    eventRevisionId: string;
    proposal: EntityMentionProposal;
    entityId: string | null;
    resolutionStatus: EntityResolutionStatus;
    resolverPolicyVersion: string;
    now: Date;
  },
): Promise<{ id: string; newlyInserted: boolean }> {
  const mentionId = createUuidV7(input.now);
  const inserted = await client.query<{ entity_mention_id: string }>(
    `INSERT INTO entity_mentions (
       entity_mention_id, user_id, conversation_event_id, event_revision_id,
       evidence_id, locator_type, start_offset, end_offset, mention_kind,
       resolved_entity_id, resolution_status, confidence,
       resolver_policy_version, created_at
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
     ON CONFLICT DO NOTHING
     RETURNING entity_mention_id`,
    [
      mentionId,
      input.userId,
      input.conversationEventId,
      input.eventRevisionId,
      input.proposal.evidenceId,
      input.proposal.locatorType,
      input.proposal.startOffset,
      input.proposal.endOffset,
      input.proposal.mentionKind,
      input.entityId,
      input.resolutionStatus,
      input.resolutionStatus === "resolved" ? 1 : null,
      input.resolverPolicyVersion,
      input.now,
    ],
  );
  if (inserted.rows[0]) {
    return { id: inserted.rows[0].entity_mention_id, newlyInserted: true };
  }
  const existing = await client.query<{ entity_mention_id: string }>(
    `SELECT entity_mention_id FROM entity_mentions
     WHERE user_id = $1 AND event_revision_id = $2 AND locator_type = $3
       AND COALESCE(start_offset, -1) = COALESCE($4, -1)
       AND COALESCE(end_offset, -1) = COALESCE($5, -1)
       AND resolver_policy_version = $6`,
    [
      input.userId,
      input.eventRevisionId,
      input.proposal.locatorType,
      input.proposal.startOffset,
      input.proposal.endOffset,
      input.resolverPolicyVersion,
    ],
  );
  return {
    id: existing.rows[0]!.entity_mention_id,
    newlyInserted: false,
  };
}

async function lockEntityForLabelWrite(
  client: PoolClient,
  userId: string,
  entityId: string,
): Promise<void> {
  const entity = await client.query<{ deleted_at: Date | null; status: string }>(
    `SELECT entity.deleted_at, version.status
     FROM entities entity
     INNER JOIN entity_versions version
       ON version.entity_version_id = entity.current_version_id
     WHERE entity.entity_id = $1 AND entity.user_id = $2
     FOR UPDATE OF entity`,
    [entityId, userId],
  );
  const row = entity.rows[0];
  if (!row || row.deleted_at !== null || !["active", "unresolved"].includes(row.status)) {
    throw new EntityNotFoundError(userId, entityId);
  }
}

async function assertEvidenceExists(
  client: PoolClient,
  userId: string,
  evidenceId: string,
): Promise<void> {
  const evidence = await client.query(
    "SELECT 1 FROM evidence_items WHERE evidence_item_id = $1 AND user_id = $2",
    [evidenceId, userId],
  );
  if (!evidence.rows[0]) {
    throw new EntityEvidenceNotFoundError(userId, evidenceId);
  }
}

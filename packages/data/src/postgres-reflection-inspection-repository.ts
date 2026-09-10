import type {
  ReflectionInspectionBioImpact,
  ReflectionInspectionCandidate,
  ReflectionInspectionCandidateSuccessor,
  ReflectionInspectionClaimImpact,
  ReflectionInspectionContentState,
  ReflectionInspectionEvidenceExpansion,
  ReflectionInspectionEvidenceLink,
  ReflectionInspectionFilters,
  ReflectionInspectionLayerResult,
  ReflectionInspectionPage,
  ReflectionInspectionProposition,
  ReflectionInspectionReflection,
  ReflectionInspectionRepository,
  ReflectionInspectionStatement,
  ReflectionInspectionVersionMetadata,
  ReflectionInspectionVersionSummary,
} from "@sayhear/application";
import {
  decodeReflectionInspectionCursor,
  encodeReflectionInspectionCursor,
  reflectionInspectionFilterFingerprint,
  ReflectionInspectionAuditError,
  ReflectionInspectionCursorError,
  type ReflectionInspectionCursorLayer,
} from "@sayhear/application";
import {
  asBioCoverageUnitId,
  asBioId,
  asBioVersionId,
  asEvidenceItemId,
  asMemoryCandidateId,
  asMemoryClaimId,
  asMemoryClaimVersionId,
  asReflectionAtomicPropositionId,
  asReflectionId,
  asReflectionStatementId,
  asReflectionVersionId,
  type ReflectionAtomicPropositionId,
  type ReflectionStatementId,
  type MemoryCandidateId,
  type ReflectionId,
  type ReflectionVersionId,
  type UserId,
} from "@sayhear/domain";
import type { Pool, PoolClient } from "pg";

import { createUuidV7 } from "./uuid-v7";

const REFLECTION_SORT = "scope_end_desc_reflection_id_asc";
const VERSION_SORT = "revision_desc_version_id_asc";
const STATEMENT_SORT = "statement_index_asc_statement_id_asc";
const PROPOSITION_SORT = "proposition_index_asc_proposition_id_asc";
const EVIDENCE_SORT = "created_at_asc_evidence_link_id_asc";
const CANDIDATE_SORT = "created_at_asc_proposal_id_asc";
const PREDECESSOR_SORT = "created_at_desc_candidate_id_asc";
const SUCCESSOR_SORT = "created_at_asc_candidate_id_asc";
const CLAIM_SORT = "created_at_asc_diff_id_asc";
const BIO_SORT =
  "revision_desc_bio_version_id_asc_link_id_asc_coverage_unit_id_asc";

type ReflectionRow = Readonly<{
  content_purged_at: Date | null;
  created_at: Date;
  current_status: string | null;
  current_version_id: string | null;
  current_version_content_purged_at: Date | null;
  current_version_expires_at: Date | null;
  current_version_locale: string | null;
  current_version_prompt_version: string | null;
  current_version_revision: number | null;
  current_version_schema_version: string | null;
  current_version_degraded_episode_reason: string | null;
  current_version_source_digest: string | null;
  current_version_source_revision: string | null;
  current_attempt_kind: string | null;
  current_attempt_status: string | null;
  current_authoritative_model_attempt_id: string | null;
  current_generation_command_id: string | null;
  current_model: string | null;
  current_model_config_version: string | null;
  current_model_role: string | null;
  current_model_snapshot: string | null;
  current_policy_version: string | null;
  current_provider: string | null;
  current_provider_policy_version: string | null;
  current_rollout_pin: string | null;
  current_schedule_policy_version: string | null;
  current_validation_policy_version: string | null;
  current_validation_prompt_version: string | null;
  current_validation_schema_version: string | null;
  current_validation_blocking_findings: unknown;
  current_validation_advisory_findings: unknown;
  current_validation_coverage: unknown;
  current_validation_verdict: "accepted" | "blocked" | null;
  current_validator_request_id: string | null;
  current_validator_result_id: string | null;
  daily_session_id: string | null;
  logical_date: string | null;
  reflection_id: string;
  scope_type: "daily_session" | "date_range";
  sort_date: string;
  week_identifier: string | null;
  window_end_date: string | null;
  window_start_date: string | null;
}>;

type VersionRow = Readonly<{
  content_expires_at: Date | null;
  content_purged_at: Date | null;
  current_version_id: string | null;
  created_at: Date;
  degraded_episode_reason: string | null;
  attempt_kind: string | null;
  attempt_status: string | null;
  authoritative_model_attempt_id: string | null;
  generation_command_id: string | null;
  locale: string;
  model: string | null;
  model_config_version: string | null;
  model_role: string | null;
  model_snapshot: string | null;
  policy_version: string | null;
  provider: string | null;
  provider_policy_version: string | null;
  prompt_version: string;
  rollout_pin: string | null;
  reflection_id: string;
  reflection_version_id: string;
  revision: number;
  schedule_policy_version: string | null;
  schema_version: string;
  source_digest: string | null;
  source_revision: string;
  status: string;
  validation_policy_version: string | null;
  validation_prompt_version: string | null;
  validation_schema_version: string | null;
  validation_blocking_findings: unknown;
  validation_advisory_findings: unknown;
  validation_coverage: unknown;
  validation_verdict: "accepted" | "blocked" | null;
  validator_request_id: string | null;
  validator_result_id: string | null;
}>;

type VersionGateRow = VersionRow & Readonly<{
  current_version_id: string | null;
}>;

type StatementParentRow = Readonly<{
  current_version_id: string | null;
  reflection_id: string;
  reflection_version_id: string;
  version_content_expires_at: Date | null;
  version_content_purged_at: Date | null;
  version_status: string;
}>;

type PropositionParentRow = StatementParentRow;

type EvidenceLinkRow = Readonly<{
  created_at: Date;
  evidence_item_id: string | null;
  evidence_link_id: string;
  link_evidence_item_id: string;
  item_locator_key: string | null;
  item_locator_type: string | null;
  item_source_event_id: string | null;
  item_source_revision_id: string | null;
  item_source_status: "final" | "corrected" | null;
  item_status: string | null;
  logical_date: string | null;
  revision_content_purged_at: Date | null;
  revision_transcript_status: string | null;
  snapshot_source_revision: string | null;
  source_event_current_revision_id: string | null;
  source_event_lifecycle_status: string | null;
  source_locale: string | null;
}>;

type CandidateRow = Readonly<{
  candidate_created_at: Date | null;
  candidate_content_purged_at: Date | null;
  candidate_id: string | null;
  candidate_status: string | null;
  candidate_evidence_item_ids: string[];
  candidate_terminal_content_expires_at: Date | null;
  decided_at: Date | null;
  disposition_policy_version: string | null;
  disposition_reason_code: string | null;
  material_change_reason_codes: string[] | null;
  memory_candidate_id: string | null;
  outcome: "created" | "blocked_terminal" | "skipped";
  predecessor_candidate_id: string | null;
  proposal_id: string;
  proposal_created_at: Date;
  reason_code: string | null;
  registry_release_due_at: Date | null;
  review_due_at: Date | null;
  successor_trigger: "materially_new_evidence" | "explicit_reconsideration" | null;
  terminal_effective_at: Date | null;
  version_content_expires_at: Date | null;
  version_content_purged_at: Date | null;
  version_status: string;
}>;

type SuccessorRow = Readonly<{
  candidate_id: string;
  content_purged_at: Date | null;
  created_at: Date;
  decided_at: Date | null;
  disposition_policy_version: string | null;
  disposition_reason_code: string | null;
  material_change_reason_codes: string[] | null;
  predecessor_candidate_id: string | null;
  registry_release_due_at: Date | null;
  review_due_at: Date | null;
  status: string;
  successor_trigger: "materially_new_evidence" | "explicit_reconsideration" | null;
  terminal_content_expires_at: Date | null;
  terminal_effective_at: Date | null;
}>;

type ClaimImpactRow = Readonly<{
  claim_content_purged_at: Date | null;
  claim_id: string | null;
  claim_version_content_purged_at: Date | null;
  claim_version_id: string | null;
  current_claim_version_id: string | null;
  diff_id: string;
  diff_kind: string;
  entity_subject_current_version_id: string | null;
  entity_subject_deleted_at: Date | null;
  entity_subject_version_status: string | null;
  entity_object_current_version_id: string | null;
  entity_object_exists: boolean;
  entity_object_deleted_at: Date | null;
  entity_object_version_status: string | null;
  outcome: string;
  revision: number | null;
  status: string | null;
  created_at: Date;
  claim_deleted_at: Date | null;
  epistemic_status: string | null;
}>;

type BioImpactRow = Readonly<{
  bio_claim_link_id: string;
  bio_coverage_unit_id: string | null;
  bio_id: string;
  bio_version_id: string;
  coverage_disposition: string | null;
  coverage_policy_version: string | null;
  current_version_id: string | null;
  expected_data_epoch: string;
  link_role: "input" | "support";
  revision: number;
  source_revision: string;
  status: string;
  support_status: "eligible" | "deferred_by_budget" | "invalidated" | "missing";
  unit_key: string | null;
  created_at: Date;
}>;

type EvidenceMetadataRow = Readonly<{
  evidence_item_id: string;
  item_locator_key: string;
  item_locator_type: ReflectionInspectionEvidenceLink["locatorType"];
  item_source_event_id: string;
  item_source_revision_id: string;
  item_source_status: "final" | "corrected";
  item_status: string;
  logical_date: string | null;
  revision_content_purged_at: Date | null;
  revision_transcript_status: string;
  source_event_current_revision_id: string;
  source_event_lifecycle_status: string;
}>;

type EvidenceContentRow = EvidenceMetadataRow & Readonly<{
  canonical_text: string;
  locale: string | null;
}>;

type AccessGrantRow = Readonly<{
  capability_status: string;
  step_up_authenticated_at: Date | null;
}>;

type PageContext = Readonly<{
  after: readonly string[];
  filter: string;
  layer: ReflectionInspectionCursorLayer;
  limit: number;
  snapshot: Date;
  sort: string;
}>;

type VersionState = ReflectionInspectionContentState;

async function withReadOnlySnapshot<T>(
  pool: Pool,
  callback: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  let transactionStarted = false;
  try {
    await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    transactionStarted = true;
    const result = await callback(client);
    await client.query("COMMIT");
    transactionStarted = false;
    return result;
  } catch (error) {
    if (transactionStarted) {
      await client.query("ROLLBACK");
    }
    throw error;
  } finally {
    client.release();
  }
}

function versionState(
  row: Readonly<{
    content_expires_at: Date | null;
    content_purged_at: Date | null;
    status: string;
  }>,
  now: Date,
): VersionState {
  if (row.content_purged_at) return "content_purged";
  if (
    row.content_expires_at &&
    row.content_expires_at.getTime() <= now.getTime()
  ) {
    return "content_expired";
  }
  if (row.status === "stale") return "source_invalidated";
  return "available";
}

function unavailableOutcome(state: VersionState): Exclude<
  ReflectionInspectionContentState,
  "available"
> | null {
  return state === "available" ? null : state;
}

function stringArray(value: unknown): readonly string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function findingCodes(value: unknown): readonly string[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (
      typeof item === "object" &&
      item !== null &&
      typeof (item as { findingCode?: unknown }).findingCode === "string"
    ) {
      return [(item as { findingCode: string }).findingCode];
    }
    return [];
  });
}

function coverageKeys(value: unknown, key: "coveredKeys" | "uncoveredPlannedKeys"): readonly string[] {
  if (typeof value !== "object" || value === null) return [];
  return stringArray((value as Record<string, unknown>)[key]);
}

function validDate(value: string): Date | null {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function isoOrNull(value: Date | null): string | null {
  return value ? value.toISOString() : null;
}

function pageFromRowsForOwner<Row, Item>(input: Readonly<{
  context: PageContext;
  map: (row: Row) => Item;
  owner: UserId;
  rows: readonly Row[];
  secret: string;
  after: (row: Row) => readonly string[];
}>): ReflectionInspectionPage<Item> {
  const items = input.rows.slice(0, input.context.limit).map(input.map);
  const last = input.rows[input.context.limit - 1];
  const nextCursor =
    input.rows.length > input.context.limit && last
      ? encodeReflectionInspectionCursor(
          {
            after: input.after(last),
            filter: input.context.filter,
            layer: input.context.layer,
            limit: input.context.limit,
            owner: input.owner,
            snapshot: input.context.snapshot.toISOString(),
            sort: input.context.sort,
            version: 1,
          },
          input.secret,
        )
      : null;
  return {
    outcome: "ok",
    items,
    nextCursor,
    snapshot: input.context.snapshot.toISOString(),
  };
}

function currentOutcome(
  row: ReflectionRow,
  now: Date,
): ReflectionInspectionReflection["currentOutcome"] {
  if (row.content_purged_at) return "content_purged";
  if (!row.current_version_id) return "no_current_version";
  if (!row.current_status) return "target_missing";
  return unavailableOutcome(
    versionState(
      {
        content_expires_at: row.current_version_expires_at,
        content_purged_at: row.current_version_content_purged_at,
        status: row.current_status,
      },
      now,
    ),
  );
}

function reflectionFromRow(
  row: ReflectionRow,
  now: Date,
): ReflectionInspectionReflection {
  const currentState = row.content_purged_at
    ? "content_purged"
    : row.current_status
    ? versionState(
        {
          content_expires_at: row.current_version_expires_at,
          content_purged_at: row.current_version_content_purged_at,
          status: row.current_status,
        },
        now,
      )
    : null;
  return {
    createdAt: row.created_at.toISOString(),
    current:
      row.current_version_id &&
      row.current_status &&
      row.current_version_revision !== null &&
      row.current_version_source_revision !== null &&
      row.current_version_locale !== null &&
      row.current_version_prompt_version !== null &&
      row.current_version_schema_version !== null
        ? {
            contentState: currentState ?? "content_purged",
            current: true,
            degradedEpisodeReason: row.current_version_degraded_episode_reason,
            locale: row.current_version_locale,
            metadata: {
              authoritativeModelAttemptId:
                row.current_authoritative_model_attempt_id,
              attemptKind: row.current_attempt_kind,
              attemptStatus: row.current_attempt_status,
              generationCommandId: row.current_generation_command_id,
              model: row.current_model,
              modelConfigVersion: row.current_model_config_version,
              modelRole: row.current_model_role,
              modelSnapshot: row.current_model_snapshot,
              policyVersion: row.current_policy_version,
              provider: row.current_provider,
              providerPolicyVersion: row.current_provider_policy_version,
              rolloutPin: row.current_rollout_pin,
              schedulePolicyVersion: row.current_schedule_policy_version,
              validationPolicyVersion: row.current_validation_policy_version,
              validationPromptVersion: row.current_validation_prompt_version,
              validationSchemaVersion: row.current_validation_schema_version,
              validationBlockingFindingCodes: findingCodes(
                row.current_validation_blocking_findings,
              ),
              validationAdvisoryFindingCodes: findingCodes(
                row.current_validation_advisory_findings,
              ),
              validationCoveredKeys: coverageKeys(
                row.current_validation_coverage,
                "coveredKeys",
              ),
              validationUncoveredPlannedKeys: coverageKeys(
                row.current_validation_coverage,
                "uncoveredPlannedKeys",
              ),
              validationVerdict: row.current_validation_verdict,
              validatorRequestId: row.current_validator_request_id,
              validatorResultId: row.current_validator_result_id,
            },
            promptVersion: row.current_version_prompt_version,
            revision: row.current_version_revision,
            schemaVersion: row.current_version_schema_version,
            sourceDigest: row.current_version_source_digest,
            sourceRevision: Number(row.current_version_source_revision),
            status: row.current_status as ReflectionInspectionVersionSummary["status"],
            versionId: asReflectionVersionId(row.current_version_id),
          }
        : null,
    currentOutcome: currentOutcome(row, now),
    currentVersionId: row.current_version_id
      ? asReflectionVersionId(row.current_version_id)
      : null,
    dailySessionId: row.daily_session_id,
    logicalDate: row.logical_date,
    reflectionId: asReflectionId(row.reflection_id),
    scopeType: row.scope_type,
    weekIdentifier: row.week_identifier,
    windowEndDate: row.window_end_date,
    windowStartDate: row.window_start_date,
  };
}

function versionSummaryFromRow(
  row: VersionRow,
  now: Date,
): ReflectionInspectionVersionSummary {
  return {
    contentState: versionState(row, now),
    current: row.current_version_id === row.reflection_version_id,
    degradedEpisodeReason: row.degraded_episode_reason,
    locale: row.locale,
    metadata: {
      authoritativeModelAttemptId: row.authoritative_model_attempt_id,
      attemptKind: row.attempt_kind,
      attemptStatus: row.attempt_status,
      generationCommandId: row.generation_command_id,
      model: row.model,
      modelConfigVersion: row.model_config_version,
      modelRole: row.model_role,
      modelSnapshot: row.model_snapshot,
      policyVersion: row.policy_version,
      provider: row.provider,
      providerPolicyVersion: row.provider_policy_version,
      rolloutPin: row.rollout_pin,
      schedulePolicyVersion: row.schedule_policy_version,
      validationPolicyVersion: row.validation_policy_version,
      validationPromptVersion: row.validation_prompt_version,
      validationSchemaVersion: row.validation_schema_version,
      validationBlockingFindingCodes: findingCodes(
        row.validation_blocking_findings,
      ),
      validationAdvisoryFindingCodes: findingCodes(
        row.validation_advisory_findings,
      ),
      validationCoveredKeys: coverageKeys(
        row.validation_coverage,
        "coveredKeys",
      ),
      validationUncoveredPlannedKeys: coverageKeys(
        row.validation_coverage,
        "uncoveredPlannedKeys",
      ),
      validationVerdict: row.validation_verdict,
      validatorRequestId: row.validator_request_id,
      validatorResultId: row.validator_result_id,
    },
    promptVersion: row.prompt_version,
    revision: row.revision,
    schemaVersion: row.schema_version,
    sourceDigest: row.source_digest,
    sourceRevision: Number(row.source_revision),
    status: row.status as ReflectionInspectionVersionSummary["status"],
    versionId: asReflectionVersionId(row.reflection_version_id),
  };
}

function afterValue(context: PageContext, index: number): string | null {
  if (context.after.length === 0) return null;
  if (index < 0 || index >= context.after.length) {
    throw new ReflectionInspectionCursorError();
  }
  return context.after[index] ?? null;
}

function cursorFilter(filters: ReflectionInspectionFilters): string {
  return reflectionInspectionFilterFingerprint(filters);
}

function sourceOutcome(row: EvidenceLinkRow): ReflectionInspectionEvidenceLink["sourceOutcome"] {
  if (!row.evidence_item_id || !row.item_locator_key || !row.item_locator_type) {
    return "target_missing";
  }
  if (row.item_status !== "active") return "source_invalidated";
  if (row.revision_content_purged_at) return "content_purged";
  if (
    row.source_event_lifecycle_status !== "active" ||
    row.source_event_current_revision_id !== row.item_source_revision_id ||
    !["final", "corrected"].includes(row.revision_transcript_status ?? "")
  ) {
    return "source_invalidated";
  }
  if (![
    "segment",
    "text_span",
  ].includes(row.item_locator_type ?? "")) {
    return "source_invalidated";
  }
  return "available";
}

function candidateContentState(
  row: CandidateRow,
  now: Date,
): ReflectionInspectionContentState {
  if (row.candidate_content_purged_at) return "content_purged";
  if (
    row.candidate_terminal_content_expires_at &&
    row.candidate_terminal_content_expires_at.getTime() <= now.getTime()
  ) {
    return "content_expired";
  }
  if (row.version_content_purged_at) return "content_purged";
  if (
    row.version_content_expires_at &&
    row.version_content_expires_at.getTime() <= now.getTime()
  ) {
    return "content_expired";
  }
  if (row.version_status === "stale") return "source_invalidated";
  return "available";
}

function claimEligibility(row: ClaimImpactRow): ReflectionInspectionClaimImpact["eligibility"] {
  if (
    row.claim_content_purged_at ||
    row.claim_version_content_purged_at
  ) {
    return "content_purged";
  }
  if (!row.claim_id || !row.claim_version_id) return "no_record";
  if (row.claim_deleted_at) return "forgotten";
  if (row.claim_version_id !== row.current_claim_version_id) return "superseded";
  if (row.status === "retracted") return "forgotten";
  if (row.epistemic_status === "contested") return "contested";
  if (row.status === "dormant") return "dormant";
  const subjectInvalid =
    !row.entity_subject_current_version_id ||
    row.entity_subject_deleted_at !== null ||
    row.entity_subject_version_status !== "active";
  const objectInvalid =
    row.entity_object_exists &&
    (!row.entity_object_current_version_id ||
      row.entity_object_deleted_at !== null ||
      row.entity_object_version_status !== "active");
  if (subjectInvalid || objectInvalid) return "entity_invalid";
  if (row.status === "active") return "eligible";
  return "not_eligible";
}

function textAtLocator(
  canonicalText: string,
  locatorType: ReflectionInspectionEvidenceLink["locatorType"],
  locatorKey: string,
): string | null {
  if (locatorType !== "segment" && locatorType !== "text_span") return null;
  const match = locatorKey.match(/^(\d+):(\d+)$/);
  if (!match) return null;
  const start = Number(match[1]);
  const end = Number(match[2]);
  if (
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(end) ||
    start < 0 ||
    end < start ||
    end > canonicalText.length
  ) {
    return null;
  }
  return canonicalText.slice(start, end);
}

export class PostgresReflectionInspectionRepository
  implements ReflectionInspectionRepository
{
  public constructor(
    private readonly pool: Pool,
    private readonly cursorSecret: string,
    private readonly clock: () => Date = () => new Date(),
  ) {
    if (!cursorSecret) {
      throw new Error("Reflection inspection cursor secret is required.");
    }
  }

  public async authorizeReflectionInspection(input: {
    authSessionId: string;
    userId: UserId;
  }) {
    return withReadOnlySnapshot(this.pool, async (client) => {
      const result = await client.query<Readonly<{ user_id: string }>>(
        `SELECT session.user_id
         FROM auth_sessions session
         INNER JOIN active_internal_owner owner
           ON owner.user_id = session.user_id
         INNER JOIN internal_diagnostic_access_grants diagnostic_grant
           ON diagnostic_grant.session_token_hash = session.session_token_hash
          AND diagnostic_grant.capability = 'reflection_inspection:read'
         WHERE session.user_id = $1
           AND session.session_token_hash = decode($2, 'hex')
           AND session.expires_at > CURRENT_TIMESTAMP
           AND diagnostic_grant.status = 'active'`,
        [input.userId, input.authSessionId],
      );
      return result.rows[0]
        ? ({ outcome: "allowed" } as const)
        : ({ outcome: "denied", reason: "reflection_capability_required" } as const);
    });
  }

  public async listReflections(input: {
    cursor: string | null;
    filters: ReflectionInspectionFilters;
    limit: number;
    userId: UserId;
  }): Promise<ReflectionInspectionPage<ReflectionInspectionReflection>> {
    const context = this.pageContext({
      cursor: input.cursor,
      filter: cursorFilter(input.filters),
      layer: "reflections",
      limit: input.limit,
      owner: input.userId,
      sort: REFLECTION_SORT,
    });
    const now = this.clock();
    return withReadOnlySnapshot(this.pool, async (client) => {
      const result = await client.query<ReflectionRow>(
        `SELECT r.reflection_id, r.scope_type,
                r.daily_session_id::text,
                s.logical_date::text AS logical_date,
                r.week_identifier, r.window_start_date, r.window_end_date,
                r.current_version_id,
                r.content_purged_at,
                r.created_at,
                COALESCE(r.window_end_date, s.logical_date::text) AS sort_date,
                v.revision AS current_version_revision,
                v.status AS current_status,
                v.source_revision::text AS current_version_source_revision,
                v.source_digest AS current_version_source_digest,
                v.locale AS current_version_locale,
                v.prompt_version AS current_version_prompt_version,
                v.schema_version AS current_version_schema_version,
                v.degraded_episode_reason AS current_version_degraded_episode_reason,
                v.generation_command_id::text AS current_generation_command_id,
                v.authoritative_model_attempt_id::text AS current_authoritative_model_attempt_id,
                v.validator_request_id::text AS current_validator_request_id,
                v.validator_result_id::text AS current_validator_result_id,
                v.schedule_policy_version AS current_schedule_policy_version,
                v.policy_version AS current_policy_version,
                command.model_role AS current_model_role,
                command.provider AS current_provider,
                command.model AS current_model,
                command.model_snapshot AS current_model_snapshot,
                command.model_config_version AS current_model_config_version,
                command.provider_policy_version AS current_provider_policy_version,
                command.rollout_pin AS current_rollout_pin,
                attempt.attempt_kind AS current_attempt_kind,
                attempt.status AS current_attempt_status,
                validator.verdict AS current_validation_verdict,
                validator.validation_policy_version AS current_validation_policy_version,
                validator.prompt_version AS current_validation_prompt_version,
                validator.schema_version AS current_validation_schema_version,
                validator.blocking_findings AS current_validation_blocking_findings,
                validator.advisory_findings AS current_validation_advisory_findings,
                validator.coverage AS current_validation_coverage,
                v.content_expires_at AS current_version_expires_at,
                v.content_purged_at AS current_version_content_purged_at
         FROM reflections r
         INNER JOIN app_users owner ON owner.user_id = r.user_id
         LEFT JOIN daily_sessions s
           ON s.daily_session_id = r.daily_session_id
          AND s.user_id = r.user_id
         LEFT JOIN reflection_versions v
           ON v.reflection_version_id = r.current_version_id
          AND v.user_id = r.user_id
          AND v.created_at <= $2
         LEFT JOIN generation_commands command
           ON command.generation_command_id = v.generation_command_id
          AND command.user_id = r.user_id
         LEFT JOIN model_run_attempts attempt
           ON attempt.model_run_attempt_id = v.authoritative_model_attempt_id
          AND attempt.user_id = r.user_id
         LEFT JOIN narrative_validator_results validator
           ON validator.narrative_validator_result_id = v.validator_result_id
          AND validator.user_id = r.user_id
         WHERE r.user_id = $1
           AND owner.status = 'active'
           AND r.created_at <= $2
           AND ($3::text IS NULL OR r.scope_type = $3)
           AND ($4::date IS NULL OR COALESCE(r.window_end_date::date, s.logical_date) >= $4::date)
           AND ($5::date IS NULL OR COALESCE(r.window_end_date::date, s.logical_date) <= $5::date)
           AND ($6::text[] IS NULL OR v.status = ANY($6::text[]))
           AND ($7::uuid IS NULL OR EXISTS (
             SELECT 1 FROM reflection_versions located_version
             WHERE located_version.reflection_version_id = $7::uuid
               AND located_version.reflection_id = r.reflection_id
               AND located_version.user_id = r.user_id
               AND located_version.created_at <= $2
           ))
           AND ($8::uuid IS NULL OR EXISTS (
             SELECT 1
             FROM reflection_candidate_proposals located_proposal
             INNER JOIN reflection_versions located_version
               ON located_version.reflection_version_id = located_proposal.reflection_version_id
              AND located_version.user_id = located_proposal.user_id
             WHERE located_proposal.memory_candidate_id = $8::uuid
               AND located_proposal.user_id = r.user_id
               AND located_version.reflection_id = r.reflection_id
               AND located_proposal.created_at <= $2
           ))
           AND ($9::date IS NULL OR COALESCE(r.window_end_date::date, s.logical_date) < $9::date
             OR (COALESCE(r.window_end_date::date, s.logical_date) = $9::date
                 AND r.reflection_id > $10::uuid))
         ORDER BY sort_date DESC, r.reflection_id ASC
         LIMIT $11`,
        [
          input.userId,
          context.snapshot,
          input.filters.scopeType ?? null,
          input.filters.fromDate ?? null,
          input.filters.toDate ?? null,
          input.filters.status?.length ? input.filters.status : null,
          input.filters.reflectionVersionId ?? null,
          input.filters.candidateId ?? null,
          afterValue(context, 0),
          afterValue(context, 1),
          context.limit + 1,
        ],
      );
      return pageFromRowsForOwner({
        after: (row) => [row.sort_date, row.reflection_id],
        context,
        map: (row) => reflectionFromRow(row, now),
        owner: input.userId,
        rows: result.rows,
        secret: this.cursorSecret,
      });
    });
  }

  public async readReflection(input: {
    expectedCurrentVersionId: ReflectionVersionId | null;
    reflectionId: ReflectionId;
    userId: UserId;
  }) {
    const now = this.clock();
    return withReadOnlySnapshot(this.pool, async (client) => {
      const result = await client.query<ReflectionRow>(
        `SELECT r.reflection_id, r.scope_type,
                r.daily_session_id::text,
                s.logical_date::text AS logical_date,
                r.week_identifier, r.window_start_date, r.window_end_date,
                r.current_version_id,
                r.content_purged_at,
                r.created_at,
                COALESCE(r.window_end_date, s.logical_date::text) AS sort_date,
                v.revision AS current_version_revision,
                v.status AS current_status,
                v.source_revision::text AS current_version_source_revision,
                v.source_digest AS current_version_source_digest,
                v.locale AS current_version_locale,
                v.prompt_version AS current_version_prompt_version,
                v.schema_version AS current_version_schema_version,
                v.degraded_episode_reason AS current_version_degraded_episode_reason,
                v.generation_command_id::text AS current_generation_command_id,
                v.authoritative_model_attempt_id::text AS current_authoritative_model_attempt_id,
                v.validator_request_id::text AS current_validator_request_id,
                v.validator_result_id::text AS current_validator_result_id,
                v.schedule_policy_version AS current_schedule_policy_version,
                v.policy_version AS current_policy_version,
                command.model_role AS current_model_role,
                command.provider AS current_provider,
                command.model AS current_model,
                command.model_snapshot AS current_model_snapshot,
                command.model_config_version AS current_model_config_version,
                command.provider_policy_version AS current_provider_policy_version,
                command.rollout_pin AS current_rollout_pin,
                attempt.attempt_kind AS current_attempt_kind,
                attempt.status AS current_attempt_status,
                validator.verdict AS current_validation_verdict,
                validator.validation_policy_version AS current_validation_policy_version,
                validator.prompt_version AS current_validation_prompt_version,
                validator.schema_version AS current_validation_schema_version,
                validator.blocking_findings AS current_validation_blocking_findings,
                validator.advisory_findings AS current_validation_advisory_findings,
                validator.coverage AS current_validation_coverage,
                v.content_expires_at AS current_version_expires_at,
                v.content_purged_at AS current_version_content_purged_at
         FROM reflections r
         INNER JOIN app_users owner ON owner.user_id = r.user_id
         LEFT JOIN daily_sessions s
           ON s.daily_session_id = r.daily_session_id
          AND s.user_id = r.user_id
         LEFT JOIN reflection_versions v
           ON v.reflection_version_id = r.current_version_id
          AND v.user_id = r.user_id
          AND v.created_at <= $3
         LEFT JOIN generation_commands command
           ON command.generation_command_id = v.generation_command_id
          AND command.user_id = r.user_id
         LEFT JOIN model_run_attempts attempt
           ON attempt.model_run_attempt_id = v.authoritative_model_attempt_id
          AND attempt.user_id = r.user_id
         LEFT JOIN narrative_validator_results validator
           ON validator.narrative_validator_result_id = v.validator_result_id
          AND validator.user_id = r.user_id
         WHERE r.user_id = $1 AND r.reflection_id = $2
           AND owner.status = 'active'`,
        [input.userId, input.reflectionId, now],
      );
      const row = result.rows[0];
      if (!row) return { outcome: "no_record" } as const;
      const currentVersionId = row.current_version_id
        ? asReflectionVersionId(row.current_version_id)
        : null;
      if (
        input.expectedCurrentVersionId !== null &&
        input.expectedCurrentVersionId !== currentVersionId
      ) {
        return {
          outcome: "state_changed",
          reflectionId: asReflectionId(row.reflection_id),
          expectedVersionId: input.expectedCurrentVersionId,
          currentVersionId,
        } as const;
      }
      if (row.content_purged_at) {
        return {
          outcome: "content_purged",
          reflectionId: asReflectionId(row.reflection_id),
          reflectionVersionId: currentVersionId,
        } as const;
      }
      if (!currentVersionId) {
        return {
          outcome: "no_current_version",
          reflectionId: asReflectionId(row.reflection_id),
          reflectionVersionId: null,
        } as const;
      }
      if (!row.current_status) {
        return {
          outcome: "target_missing",
          reflectionId: asReflectionId(row.reflection_id),
          reflectionVersionId: currentVersionId,
        } as const;
      }
      const state = versionState(
        {
          content_expires_at: row.current_version_expires_at,
          content_purged_at: row.current_version_content_purged_at,
          status: row.current_status,
        },
        now,
      );
      if (state !== "available") {
        return {
          outcome: state,
          reflectionId: asReflectionId(row.reflection_id),
          reflectionVersionId: currentVersionId,
        } as const;
      }
      return reflectionFromRow(row, now);
    });
  }

  public async listVersions(input: {
    cursor: string | null;
    expectedCurrentVersionId: ReflectionVersionId | null;
    limit: number;
    reflectionId: ReflectionId;
    userId: UserId;
  }): Promise<ReflectionInspectionLayerResult<ReflectionInspectionVersionSummary>> {
    const context = this.pageContext({
      cursor: input.cursor,
      filter: input.reflectionId,
      layer: "versions",
      limit: input.limit,
      owner: input.userId,
      sort: VERSION_SORT,
    });
    const now = this.clock();
    return withReadOnlySnapshot(this.pool, async (client) => {
      const parent = await client.query<{
        current_version_id: string | null;
        reflection_id: string;
      }>(
        `SELECT reflection_id, current_version_id FROM reflections
         WHERE reflection_id = $1 AND user_id = $2
           AND created_at <= $3`,
        [input.reflectionId, input.userId, context.snapshot],
      );
      if (!parent.rows[0]) return { outcome: "no_record" } as const;
      const actualCurrentVersionId = parent.rows[0].current_version_id
        ? asReflectionVersionId(parent.rows[0].current_version_id)
        : null;
      if (
        input.expectedCurrentVersionId !== null &&
        input.expectedCurrentVersionId !== actualCurrentVersionId
      ) {
        return {
          outcome: "state_changed",
          reflectionId: asReflectionId(parent.rows[0].reflection_id),
          expectedVersionId: input.expectedCurrentVersionId,
          currentVersionId: actualCurrentVersionId,
        } as const;
      }
      const result = await client.query<VersionRow>(
        `SELECT v.reflection_id, v.reflection_version_id, v.revision,
                v.status, v.source_revision::text, v.source_digest,
                v.locale, v.prompt_version, v.schema_version,
                v.degraded_episode_reason, v.content_expires_at,
                v.content_purged_at, v.created_at, r.current_version_id,
                v.generation_command_id::text AS generation_command_id,
                v.authoritative_model_attempt_id::text AS authoritative_model_attempt_id,
                v.validator_request_id::text AS validator_request_id,
                v.validator_result_id::text AS validator_result_id,
                v.schedule_policy_version,
                v.policy_version,
                command.model_role,
                command.provider,
                command.model,
                command.model_snapshot,
                command.model_config_version,
                command.provider_policy_version,
                command.rollout_pin,
                attempt.attempt_kind,
                attempt.status AS attempt_status,
                validator.verdict AS validation_verdict,
                validator.validation_policy_version AS validation_policy_version,
                validator.prompt_version AS validation_prompt_version,
                validator.schema_version AS validation_schema_version,
                validator.blocking_findings AS validation_blocking_findings,
                validator.advisory_findings AS validation_advisory_findings,
                validator.coverage AS validation_coverage
         FROM reflection_versions v
         INNER JOIN reflections r
           ON r.reflection_id = v.reflection_id AND r.user_id = v.user_id
         INNER JOIN app_users owner ON owner.user_id = v.user_id
         LEFT JOIN generation_commands command
           ON command.generation_command_id = v.generation_command_id
          AND command.user_id = v.user_id
         LEFT JOIN model_run_attempts attempt
           ON attempt.model_run_attempt_id = v.authoritative_model_attempt_id
          AND attempt.user_id = v.user_id
         LEFT JOIN narrative_validator_results validator
           ON validator.narrative_validator_result_id = v.validator_result_id
          AND validator.user_id = v.user_id
         WHERE v.reflection_id = $1 AND v.user_id = $2
           AND owner.status = 'active'
           AND v.created_at <= $3
           AND ($4::int IS NULL OR v.revision < $4::int
             OR (v.revision = $4::int AND v.reflection_version_id > $5::uuid))
         ORDER BY v.revision DESC, v.reflection_version_id ASC
         LIMIT $6`,
        [
          input.reflectionId,
          input.userId,
          context.snapshot,
          afterValue(context, 0),
          afterValue(context, 1),
          context.limit + 1,
        ],
      );
      return pageFromRowsForOwner({
        after: (row) => [String(row.revision), row.reflection_version_id],
        context,
        map: (row) => versionSummaryFromRow(row, now),
        owner: input.userId,
        rows: result.rows,
        secret: this.cursorSecret,
      });
    });
  }

  public async listStatements(input: {
    cursor: string | null;
    expectedCurrentVersionId: ReflectionVersionId | null;
    limit: number;
    reflectionVersionId: ReflectionVersionId;
    userId: UserId;
  }): Promise<ReflectionInspectionLayerResult<ReflectionInspectionStatement>> {
    const context = this.pageContext({
      cursor: input.cursor,
      filter: input.reflectionVersionId,
      layer: "statements",
      limit: input.limit,
      owner: input.userId,
      sort: STATEMENT_SORT,
    });
    const now = this.clock();
    return withReadOnlySnapshot(this.pool, async (client) => {
      const gate = await this.versionGate(
        client,
        input.userId,
        input.reflectionVersionId,
        context.snapshot,
      );
      if (!gate) return { outcome: "no_record" } as const;
      const expected = input.expectedCurrentVersionId;
      const actual = gate.current_version_id
        ? asReflectionVersionId(gate.current_version_id)
        : null;
      if (expected !== null && expected !== actual) {
        return {
          outcome: "state_changed",
          reflectionId: asReflectionId(gate.reflection_id),
          expectedVersionId: expected,
          currentVersionId: actual,
        } as const;
      }
      const state = versionState(gate, now);
      if (state !== "available") {
        return {
          outcome: state,
          reflectionId: asReflectionId(gate.reflection_id),
          reflectionVersionId: asReflectionVersionId(gate.reflection_version_id),
        } as const;
      }
      const result = await client.query<{
        content_purged_at: Date | null;
        statement_id: string;
        statement_index: number;
        statement_kind: ReflectionInspectionStatement["statementKind"];
        statement_text: string | null;
      }>(
        `SELECT reflection_statement_id AS statement_id,
                statement_index, statement_kind, statement_text,
                content_purged_at
         FROM reflection_statements
         WHERE reflection_version_id = $1 AND user_id = $2
           AND ($3::int IS NULL OR statement_index > $3::int
             OR (statement_index = $3::int AND reflection_statement_id > $4::uuid))
         ORDER BY statement_index ASC, reflection_statement_id ASC
         LIMIT $5`,
        [
          input.reflectionVersionId,
          input.userId,
          afterValue(context, 0),
          afterValue(context, 1),
          context.limit + 1,
        ],
      );
      return pageFromRowsForOwner({
        after: (row) => [String(row.statement_index), row.statement_id],
        context,
        map: (row) => ({
          contentState: row.content_purged_at ? "content_purged" : "available",
          statementId: asReflectionStatementId(row.statement_id),
          statementIndex: row.statement_index,
          statementKind: row.statement_kind,
          statementText: row.content_purged_at ? null : row.statement_text,
        }),
        owner: input.userId,
        rows: result.rows,
        secret: this.cursorSecret,
      });
    });
  }

  public async listPropositions(input: {
    cursor: string | null;
    expectedCurrentVersionId: ReflectionVersionId | null;
    limit: number;
    statementId: ReflectionStatementId;
    userId: UserId;
  }): Promise<ReflectionInspectionLayerResult<ReflectionInspectionProposition>> {
    const context = this.pageContext({
      cursor: input.cursor,
      filter: input.statementId,
      layer: "propositions",
      limit: input.limit,
      owner: input.userId,
      sort: PROPOSITION_SORT,
    });
    const now = this.clock();
    return withReadOnlySnapshot(this.pool, async (client) => {
      const parent = await client.query<PropositionParentRow>(
        `SELECT r.reflection_id, v.reflection_version_id,
                r.current_version_id,
                v.status AS version_status,
                v.content_expires_at AS version_content_expires_at,
                v.content_purged_at AS version_content_purged_at
         FROM reflection_statements s
         INNER JOIN reflection_versions v
           ON v.reflection_version_id = s.reflection_version_id
          AND v.user_id = s.user_id
         INNER JOIN reflections r
           ON r.reflection_id = v.reflection_id AND r.user_id = v.user_id
         INNER JOIN app_users owner ON owner.user_id = s.user_id
         WHERE s.reflection_statement_id = $1 AND s.user_id = $2
           AND v.created_at <= $3
           AND owner.status = 'active'`,
        [input.statementId, input.userId, context.snapshot],
      );
      const parentRow = parent.rows[0];
      if (!parentRow) return { outcome: "no_record" } as const;
      const actualCurrentVersionId = parentRow.current_version_id
        ? asReflectionVersionId(parentRow.current_version_id)
        : null;
      if (
        input.expectedCurrentVersionId !== null &&
        input.expectedCurrentVersionId !== actualCurrentVersionId
      ) {
        return {
          outcome: "state_changed",
          reflectionId: asReflectionId(parentRow.reflection_id),
          expectedVersionId: input.expectedCurrentVersionId,
          currentVersionId: actualCurrentVersionId,
        } as const;
      }
      const state = versionState(
        {
          content_expires_at: parentRow.version_content_expires_at,
          content_purged_at: parentRow.version_content_purged_at,
          status: parentRow.version_status,
        },
        now,
      );
      if (state !== "available") {
        return {
          outcome: state,
          reflectionId: asReflectionId(parentRow.reflection_id),
          reflectionVersionId: asReflectionVersionId(parentRow.reflection_version_id),
        } as const;
      }
      const result = await client.query<{
        baseline_claim_ids: unknown;
        content_purged_at: Date | null;
        epistemic_rendering: ReflectionInspectionProposition["epistemicRendering"];
        proposition_id: string;
        proposition_index: number;
        proposition_kind: ReflectionInspectionProposition["propositionKind"];
        proposition_text: string | null;
      }>(
        `SELECT reflection_atomic_proposition_id AS proposition_id,
                proposition_index, normalized_proposition AS proposition_text,
                proposition_kind, epistemic_rendering, baseline_claim_ids,
                content_purged_at
         FROM reflection_atomic_propositions
         WHERE reflection_statement_id = $1 AND user_id = $2
           AND ($3::int IS NULL OR proposition_index > $3::int
             OR (proposition_index = $3::int
                 AND reflection_atomic_proposition_id > $4::uuid))
         ORDER BY proposition_index ASC, reflection_atomic_proposition_id ASC
         LIMIT $5`,
        [
          input.statementId,
          input.userId,
          afterValue(context, 0),
          afterValue(context, 1),
          context.limit + 1,
        ],
      );
      return pageFromRowsForOwner({
        after: (row) => [String(row.proposition_index), row.proposition_id],
        context,
        map: (row) => ({
          baselineClaimIds: stringArray(row.baseline_claim_ids),
          contentState: row.content_purged_at ? "content_purged" : "available",
          epistemicRendering: row.epistemic_rendering,
          propositionId: asReflectionAtomicPropositionId(row.proposition_id),
          propositionIndex: row.proposition_index,
          propositionKind: row.proposition_kind,
          propositionText: row.content_purged_at ? null : row.proposition_text,
        }),
        owner: input.userId,
        rows: result.rows,
        secret: this.cursorSecret,
      });
    });
  }

  public async listEvidenceLinks(input: {
    cursor: string | null;
    expectedCurrentVersionId: ReflectionVersionId | null;
    limit: number;
    propositionId: ReflectionAtomicPropositionId;
    userId: UserId;
  }): Promise<ReflectionInspectionLayerResult<ReflectionInspectionEvidenceLink>> {
    const context = this.pageContext({
      cursor: input.cursor,
      filter: input.propositionId,
      layer: "evidence",
      limit: input.limit,
      owner: input.userId,
      sort: EVIDENCE_SORT,
    });
    const now = this.clock();
    return withReadOnlySnapshot(this.pool, async (client) => {
      const parent = await client.query<PropositionParentRow>(
        `SELECT r.reflection_id, v.reflection_version_id,
                r.current_version_id,
                v.status AS version_status,
                v.content_expires_at AS version_content_expires_at,
                v.content_purged_at AS version_content_purged_at
         FROM reflection_atomic_propositions p
         INNER JOIN reflection_statements s
           ON s.reflection_statement_id = p.reflection_statement_id
          AND s.user_id = p.user_id
         INNER JOIN reflection_versions v
           ON v.reflection_version_id = s.reflection_version_id
          AND v.user_id = s.user_id
         INNER JOIN reflections r
           ON r.reflection_id = v.reflection_id AND r.user_id = v.user_id
         INNER JOIN app_users owner ON owner.user_id = p.user_id
         WHERE p.reflection_atomic_proposition_id = $1 AND p.user_id = $2
           AND v.created_at <= $3
           AND owner.status = 'active'`,
        [input.propositionId, input.userId, context.snapshot],
      );
      const parentRow = parent.rows[0];
      if (!parentRow) return { outcome: "no_record" } as const;
      const actualCurrentVersionId = parentRow.current_version_id
        ? asReflectionVersionId(parentRow.current_version_id)
        : null;
      if (
        input.expectedCurrentVersionId !== null &&
        input.expectedCurrentVersionId !== actualCurrentVersionId
      ) {
        return {
          outcome: "state_changed",
          reflectionId: asReflectionId(parentRow.reflection_id),
          expectedVersionId: input.expectedCurrentVersionId,
          currentVersionId: actualCurrentVersionId,
        } as const;
      }
      const state = versionState(
        {
          content_expires_at: parentRow.version_content_expires_at,
          content_purged_at: parentRow.version_content_purged_at,
          status: parentRow.version_status,
        },
        now,
      );
      if (state !== "available") {
        return {
          outcome: state,
          reflectionId: asReflectionId(parentRow.reflection_id),
          reflectionVersionId: asReflectionVersionId(parentRow.reflection_version_id),
        } as const;
      }
      const result = await client.query<EvidenceLinkRow>(
        `SELECT link.reflection_statement_evidence_link_id AS evidence_link_id,
                link.evidence_item_id::text AS link_evidence_item_id,
                link.created_at,
                item.evidence_item_id,
                item.locator_type AS item_locator_type,
                item.locator_key AS item_locator_key,
                item.source_event_id::text AS item_source_event_id,
                item.source_revision_id::text AS item_source_revision_id,
                item.source_status AS item_source_status,
                item.status AS item_status,
                snap.source_revision::text AS snapshot_source_revision,
                rev.locale AS source_locale,
                rev.transcript_status AS revision_transcript_status,
                rev.content_purged_at AS revision_content_purged_at,
                ev.lifecycle_status AS source_event_lifecycle_status,
                ev.current_revision_id::text AS source_event_current_revision_id,
                ds.logical_date::text AS logical_date
         FROM reflection_statement_evidence_links link
         LEFT JOIN evidence_items item
           ON item.evidence_item_id = link.evidence_item_id
          AND item.user_id = link.user_id
         LEFT JOIN evidence_source_snapshots snap
           ON snap.evidence_source_snapshot_id = item.evidence_source_snapshot_id
          AND snap.user_id = item.user_id
         LEFT JOIN conversation_event_revisions rev
           ON rev.conversation_event_revision_id = item.source_revision_id
          AND rev.user_id = item.user_id
         LEFT JOIN conversation_events ev
           ON ev.conversation_event_id = item.source_event_id
          AND ev.user_id = item.user_id
         LEFT JOIN daily_sessions ds
           ON ds.daily_session_id = snap.daily_session_id
          AND ds.user_id = item.user_id
         WHERE link.reflection_atomic_proposition_id = $1
           AND link.user_id = $2
           AND link.created_at <= $3
           AND ($4::timestamptz IS NULL OR link.created_at > $4::timestamptz
             OR (link.created_at = $4::timestamptz
                 AND link.reflection_statement_evidence_link_id > $5::uuid))
         ORDER BY link.created_at ASC, link.reflection_statement_evidence_link_id ASC
         LIMIT $6`,
        [
          input.propositionId,
          input.userId,
          context.snapshot,
          afterValue(context, 0),
          afterValue(context, 1),
          context.limit + 1,
        ],
      );
      return pageFromRowsForOwner({
        after: (row) => [row.created_at.toISOString(), row.evidence_link_id],
        context,
        map: (row) => ({
          evidenceItemId: asEvidenceItemId(row.link_evidence_item_id),
          evidenceLinkId: row.evidence_link_id,
          locatorKey: row.item_locator_key ?? "",
          locatorType: (row.item_locator_type ?? "whole_revision") as ReflectionInspectionEvidenceLink["locatorType"],
          locale: row.source_locale,
          logicalDate: row.logical_date,
          sourceEventId: row.item_source_event_id ?? "",
          sourceOutcome: sourceOutcome(row),
          sourceRevision: row.snapshot_source_revision
            ? Number(row.snapshot_source_revision)
            : 0,
          sourceRevisionId: row.item_source_revision_id ?? "",
          sourceStatus: row.item_source_status,
        }),
        owner: input.userId,
        rows: result.rows,
        secret: this.cursorSecret,
      });
    });
  }

  public async listCandidates(input: {
    cursor: string | null;
    expectedCurrentVersionId: ReflectionVersionId | null;
    limit: number;
    reflectionVersionId: ReflectionVersionId;
    userId: UserId;
  }): Promise<ReflectionInspectionLayerResult<ReflectionInspectionCandidate>> {
    const context = this.pageContext({
      cursor: input.cursor,
      filter: input.reflectionVersionId,
      layer: "candidates",
      limit: input.limit,
      owner: input.userId,
      sort: CANDIDATE_SORT,
    });
    const now = this.clock();
    return withReadOnlySnapshot(this.pool, async (client) => {
      const gate = await this.versionGate(
        client,
        input.userId,
        input.reflectionVersionId,
        context.snapshot,
      );
      if (!gate) return { outcome: "no_record" } as const;
      const actualCurrentVersionId = gate.current_version_id
        ? asReflectionVersionId(gate.current_version_id)
        : null;
      if (
        input.expectedCurrentVersionId !== null &&
        input.expectedCurrentVersionId !== actualCurrentVersionId
      ) {
        return {
          outcome: "state_changed",
          reflectionId: asReflectionId(gate.reflection_id),
          expectedVersionId: input.expectedCurrentVersionId,
          currentVersionId: actualCurrentVersionId,
        } as const;
      }
      const result = await client.query<CandidateRow>(
        `SELECT proposal.reflection_candidate_proposal_id AS proposal_id,
                proposal.created_at AS proposal_created_at,
                proposal.memory_candidate_id,
                proposal.outcome, proposal.reason_code,
                candidate.memory_candidate_id AS candidate_id,
                candidate.created_at AS candidate_created_at,
                candidate.status AS candidate_status,
                candidate.disposition_reason_code,
                candidate.disposition_policy_version,
                candidate.review_due_at,
                candidate.registry_release_due_at,
                candidate.decided_at,
                candidate.terminal_effective_at,
                candidate.predecessor_candidate_id,
                candidate.successor_trigger,
                candidate.material_change_reason_codes,
                candidate.content_purged_at AS candidate_content_purged_at,
                candidate.terminal_content_expires_at AS candidate_terminal_content_expires_at,
                COALESCE((
                  SELECT ARRAY_AGG(candidate_evidence.evidence_item_id::text
                                  ORDER BY candidate_evidence.memory_candidate_evidence_link_id)
                  FROM memory_candidate_evidence_links candidate_evidence
                  WHERE candidate_evidence.memory_candidate_id = candidate.memory_candidate_id
                    AND candidate_evidence.user_id = proposal.user_id
                    AND candidate_evidence.created_at <= $3
                ), ARRAY[]::text[]) AS candidate_evidence_item_ids,
                version.status AS version_status,
                version.content_expires_at AS version_content_expires_at,
                version.content_purged_at AS version_content_purged_at
         FROM reflection_candidate_proposals proposal
         LEFT JOIN memory_candidates candidate
           ON candidate.memory_candidate_id = proposal.memory_candidate_id
          AND candidate.user_id = proposal.user_id
          AND candidate.created_at <= $3
         INNER JOIN reflection_versions version
           ON version.reflection_version_id = proposal.reflection_version_id
          AND version.user_id = proposal.user_id
         WHERE proposal.reflection_version_id = $1
           AND proposal.user_id = $2
           AND proposal.created_at <= $3
           AND ($4::timestamptz IS NULL OR proposal.created_at > $4::timestamptz
             OR (proposal.created_at = $4::timestamptz
                 AND proposal.reflection_candidate_proposal_id > $5::uuid))
         ORDER BY proposal.created_at ASC, proposal.reflection_candidate_proposal_id ASC
         LIMIT $6`,
        [
          input.reflectionVersionId,
          input.userId,
          context.snapshot,
          afterValue(context, 0),
          afterValue(context, 1),
          context.limit + 1,
        ],
      );
      return pageFromRowsForOwner({
        after: (row) => [row.proposal_created_at.toISOString(), row.proposal_id],
        context,
        map: (row) => ({
          candidateId: row.candidate_id ? asMemoryCandidateId(row.candidate_id) : null,
          candidateEvidenceItemIds: row.candidate_evidence_item_ids.map((id) =>
            asEvidenceItemId(id),
          ),
          candidateStatus: row.candidate_status as ReflectionInspectionCandidate["candidateStatus"],
          contentState: candidateContentState(
            { ...row, version_content_expires_at: gate.content_expires_at, version_content_purged_at: gate.content_purged_at },
            now,
          ),
          createdAt: (row.candidate_created_at ?? row.proposal_created_at).toISOString(),
          decidedAt: isoOrNull(row.decided_at),
          dispositionPolicyVersion: row.disposition_policy_version,
          dispositionReasonCode: row.disposition_reason_code ?? row.reason_code,
          materialChangeReasonCodes: stringArray(row.material_change_reason_codes),
          outcome: row.outcome,
          predecessorCandidateId: row.predecessor_candidate_id
            ? asMemoryCandidateId(row.predecessor_candidate_id)
            : null,
          proposalId: row.proposal_id,
          registryReleaseDueAt: isoOrNull(row.registry_release_due_at),
          reviewDueAt: isoOrNull(row.review_due_at),
          successorTrigger: row.successor_trigger,
          terminalContentExpiresAt: isoOrNull(row.candidate_terminal_content_expires_at),
          terminalEffectiveAt: isoOrNull(row.terminal_effective_at),
        }),
        owner: input.userId,
        rows: result.rows,
        secret: this.cursorSecret,
      });
    });
  }

  public async listCandidateSuccessors(input: {
    candidateId: MemoryCandidateId;
    cursor: string | null;
    limit: number;
    userId: UserId;
  }): Promise<ReflectionInspectionLayerResult<ReflectionInspectionCandidateSuccessor>> {
    const context = this.pageContext({
      cursor: input.cursor,
      filter: input.candidateId,
      layer: "candidate_successors",
      limit: input.limit,
      owner: input.userId,
      sort: SUCCESSOR_SORT,
    });
    return withReadOnlySnapshot(this.pool, async (client) => {
      const parent = await client.query<{ memory_candidate_id: string }>(
        `SELECT candidate.memory_candidate_id FROM memory_candidates candidate
         INNER JOIN app_users owner ON owner.user_id = candidate.user_id
         WHERE candidate.memory_candidate_id = $1 AND candidate.user_id = $2
           AND owner.status = 'active'
           AND candidate.created_at <= $3`,
        [input.candidateId, input.userId, context.snapshot],
      );
      if (!parent.rows[0]) return { outcome: "no_record" } as const;
      const result = await client.query<SuccessorRow>(
        `SELECT memory_candidate_id AS candidate_id,
                predecessor_candidate_id, successor_trigger, status,
                content_purged_at, created_at,
                disposition_reason_code, disposition_policy_version,
                review_due_at, registry_release_due_at, decided_at,
                terminal_effective_at, terminal_content_expires_at,
                material_change_reason_codes
         FROM memory_candidates
         WHERE predecessor_candidate_id = $1 AND user_id = $2
           AND created_at <= $3
           AND ($4::timestamptz IS NULL OR created_at > $4::timestamptz
             OR (created_at = $4::timestamptz AND memory_candidate_id > $5::uuid))
         ORDER BY created_at ASC, memory_candidate_id ASC
         LIMIT $6`,
        [
          input.candidateId,
          input.userId,
          context.snapshot,
          afterValue(context, 0),
          afterValue(context, 1),
          context.limit + 1,
        ],
      );
      return pageFromRowsForOwner({
        after: (row) => [row.created_at.toISOString(), row.candidate_id],
        context,
        map: (row) => ({
          candidateId: asMemoryCandidateId(row.candidate_id),
          contentPurged: row.content_purged_at !== null,
          createdAt: row.created_at.toISOString(),
          decidedAt: isoOrNull(row.decided_at),
          dispositionPolicyVersion: row.disposition_policy_version,
          dispositionReasonCode: row.disposition_reason_code,
          materialChangeReasonCodes: stringArray(row.material_change_reason_codes),
          predecessorCandidateId: row.predecessor_candidate_id
            ? asMemoryCandidateId(row.predecessor_candidate_id)
            : null,
          registryReleaseDueAt: isoOrNull(row.registry_release_due_at),
          reviewDueAt: isoOrNull(row.review_due_at),
          status: row.status as ReflectionInspectionCandidateSuccessor["status"],
          successorTrigger: row.successor_trigger,
          terminalContentExpiresAt: isoOrNull(row.terminal_content_expires_at),
          terminalEffectiveAt: isoOrNull(row.terminal_effective_at),
        }),
        owner: input.userId,
        rows: result.rows,
        secret: this.cursorSecret,
      });
    });
  }

  public async listCandidatePredecessors(input: {
    candidateId: MemoryCandidateId;
    cursor: string | null;
    limit: number;
    userId: UserId;
  }): Promise<ReflectionInspectionLayerResult<ReflectionInspectionCandidateSuccessor>> {
    const context = this.pageContext({
      cursor: input.cursor,
      filter: input.candidateId,
      layer: "candidate_predecessors",
      limit: input.limit,
      owner: input.userId,
      sort: PREDECESSOR_SORT,
    });
    return withReadOnlySnapshot(this.pool, async (client) => {
      const parent = await client.query<{ predecessor_candidate_id: string | null }>(
        `SELECT candidate.predecessor_candidate_id FROM memory_candidates candidate
         INNER JOIN app_users owner ON owner.user_id = candidate.user_id
         WHERE candidate.memory_candidate_id = $1 AND candidate.user_id = $2
           AND owner.status = 'active'
           AND candidate.created_at <= $3`,
        [input.candidateId, input.userId, context.snapshot],
      );
      if (!parent.rows[0]) return { outcome: "no_record" } as const;
      const result = await client.query<SuccessorRow>(
        `SELECT predecessor.memory_candidate_id AS candidate_id,
                predecessor.content_purged_at,
                predecessor.created_at,
                predecessor.decided_at,
                predecessor.disposition_policy_version,
                predecessor.disposition_reason_code,
                predecessor.review_due_at,
                predecessor.registry_release_due_at,
                predecessor.terminal_effective_at,
                predecessor.terminal_content_expires_at,
                predecessor.material_change_reason_codes,
                predecessor.predecessor_candidate_id,
                predecessor.status,
                predecessor.successor_trigger
         FROM memory_candidates predecessor
         WHERE predecessor.memory_candidate_id = $1
           AND predecessor.user_id = $2
           AND predecessor.created_at <= $3
           AND (
             $4::timestamptz IS NULL OR predecessor.created_at < $4::timestamptz
             OR (
               predecessor.created_at = $4::timestamptz
               AND predecessor.memory_candidate_id > $5::uuid
             )
           )
         ORDER BY predecessor.created_at DESC, predecessor.memory_candidate_id ASC
         LIMIT $6`,
        [
          parent.rows[0].predecessor_candidate_id,
          input.userId,
          context.snapshot,
          afterValue(context, 0),
          afterValue(context, 1),
          context.limit + 1,
        ],
      );
      return pageFromRowsForOwner({
        after: (row) => [row.created_at.toISOString(), row.candidate_id],
        context,
        map: (row) => ({
          candidateId: asMemoryCandidateId(row.candidate_id),
          contentPurged: row.content_purged_at !== null,
          createdAt: row.created_at.toISOString(),
          decidedAt: isoOrNull(row.decided_at),
          dispositionPolicyVersion: row.disposition_policy_version,
          dispositionReasonCode: row.disposition_reason_code,
          materialChangeReasonCodes: stringArray(row.material_change_reason_codes),
          predecessorCandidateId: row.predecessor_candidate_id
            ? asMemoryCandidateId(row.predecessor_candidate_id)
            : null,
          registryReleaseDueAt: isoOrNull(row.registry_release_due_at),
          reviewDueAt: isoOrNull(row.review_due_at),
          status: row.status as ReflectionInspectionCandidateSuccessor["status"],
          successorTrigger: row.successor_trigger,
          terminalContentExpiresAt: isoOrNull(row.terminal_content_expires_at),
          terminalEffectiveAt: isoOrNull(row.terminal_effective_at),
        }),
        owner: input.userId,
        rows: result.rows,
        secret: this.cursorSecret,
      });
    });
  }

  public async listClaimImpacts(input: {
    candidateId: MemoryCandidateId;
    cursor: string | null;
    limit: number;
    userId: UserId;
  }): Promise<ReflectionInspectionLayerResult<ReflectionInspectionClaimImpact>> {
    const context = this.pageContext({
      cursor: input.cursor,
      filter: input.candidateId,
      layer: "claims",
      limit: input.limit,
      owner: input.userId,
      sort: CLAIM_SORT,
    });
    return withReadOnlySnapshot(this.pool, async (client) => {
      const parent = await client.query<{ memory_candidate_id: string }>(
        `SELECT candidate.memory_candidate_id FROM memory_candidates candidate
         INNER JOIN app_users owner ON owner.user_id = candidate.user_id
         WHERE candidate.memory_candidate_id = $1 AND candidate.user_id = $2
           AND owner.status = 'active'
           AND candidate.created_at <= $3`,
        [input.candidateId, input.userId, context.snapshot],
      );
      if (!parent.rows[0]) return { outcome: "no_record" } as const;
      const result = await client.query<ClaimImpactRow>(
        `SELECT diff.memory_consolidation_diff_id AS diff_id,
                diff.diff_kind, diff.outcome, diff.created_at,
                claim.memory_claim_id AS claim_id,
                claim.deleted_at AS claim_deleted_at,
                claim.content_purged_at AS claim_content_purged_at,
                claim.current_version_id AS current_claim_version_id,
                version.memory_claim_version_id AS claim_version_id,
                version.revision, version.status, version.epistemic_status,
                version.content_purged_at AS claim_version_content_purged_at,
                subject.current_version_id AS entity_subject_current_version_id,
                subject.deleted_at AS entity_subject_deleted_at,
                subject_version.status AS entity_subject_version_status,
                object.current_version_id AS entity_object_current_version_id,
                (object.entity_id IS NOT NULL) AS entity_object_exists,
                object.deleted_at AS entity_object_deleted_at,
                object_version.status AS entity_object_version_status
         FROM memory_consolidation_diffs diff
         LEFT JOIN memory_claims claim
           ON claim.memory_claim_id = diff.memory_claim_id
          AND claim.user_id = diff.user_id
         LEFT JOIN memory_claim_versions version
           ON version.memory_claim_version_id = claim.current_version_id
          AND version.memory_claim_id = claim.memory_claim_id
          AND version.user_id = claim.user_id
         LEFT JOIN entities subject
           ON subject.entity_id = claim.subject_entity_id
          AND subject.user_id = claim.user_id
         LEFT JOIN entity_versions subject_version
           ON subject_version.entity_version_id = subject.current_version_id
          AND subject_version.entity_id = subject.entity_id
          AND subject_version.user_id = subject.user_id
         LEFT JOIN entities object
           ON object.entity_id = claim.object_entity_id
          AND object.user_id = claim.user_id
         LEFT JOIN entity_versions object_version
           ON object_version.entity_version_id = object.current_version_id
          AND object_version.entity_id = object.entity_id
          AND object_version.user_id = object.user_id
         WHERE diff.memory_candidate_id = $1 AND diff.user_id = $2
           AND diff.created_at <= $3
           AND ($4::timestamptz IS NULL OR diff.created_at > $4::timestamptz
             OR (diff.created_at = $4::timestamptz
                 AND diff.memory_consolidation_diff_id > $5::uuid))
         ORDER BY diff.created_at ASC, diff.memory_consolidation_diff_id ASC
         LIMIT $6`,
        [
          input.candidateId,
          input.userId,
          context.snapshot,
          afterValue(context, 0),
          afterValue(context, 1),
          context.limit + 1,
        ],
      );
      return pageFromRowsForOwner({
        after: (row) => [row.created_at.toISOString(), row.diff_id],
        context,
        map: (row) => ({
          claimId: row.claim_id ? asMemoryClaimId(row.claim_id) : null,
          claimVersionId: row.claim_version_id
            ? asMemoryClaimVersionId(row.claim_version_id)
            : null,
          diffId: row.diff_id,
          diffKind: row.diff_kind,
          eligibility: claimEligibility(row),
          isCurrentVersion:
            row.claim_version_id !== null &&
            row.claim_version_id === row.current_claim_version_id,
          outcome: row.outcome,
          revision: row.revision,
          status: row.status,
        }),
        owner: input.userId,
        rows: result.rows,
        secret: this.cursorSecret,
      });
    });
  }

  public async listBioImpacts(input: {
    cursor: string | null;
    limit: number;
    memoryClaimVersionId: import("@sayhear/domain").MemoryClaimVersionId;
    userId: UserId;
  }): Promise<ReflectionInspectionLayerResult<ReflectionInspectionBioImpact>> {
    const context = this.pageContext({
      cursor: input.cursor,
      filter: input.memoryClaimVersionId,
      layer: "bio_impact",
      limit: input.limit,
      owner: input.userId,
      sort: BIO_SORT,
    });
    return withReadOnlySnapshot(this.pool, async (client) => {
      const result = await client.query<BioImpactRow>(
        `SELECT link.bio_claim_link_id,
                link.bio_id, link.bio_version_id, link.link_role,
                link.support_status, link.source_revision::text,
                link.expected_data_epoch::text,
                version.revision, version.status,
                bio.current_version_id,
                unit.bio_coverage_unit_id,
                unit.unit_key, unit.disposition AS coverage_disposition,
                unit.coverage_policy_version,
                link.created_at
         FROM bio_claim_links link
         INNER JOIN bio_versions version
           ON version.bio_version_id = link.bio_version_id
          AND version.bio_id = link.bio_id
          AND version.user_id = link.user_id
         INNER JOIN bios bio
           ON bio.bio_id = link.bio_id AND bio.user_id = link.user_id
         LEFT JOIN bio_coverage_members member
           ON member.bio_version_id = link.bio_version_id
          AND member.memory_claim_version_id = link.memory_claim_version_id
          AND member.user_id = link.user_id
          AND member.created_at <= $3
         LEFT JOIN bio_coverage_units unit
           ON unit.bio_coverage_unit_id = member.bio_coverage_unit_id
          AND unit.bio_version_id = link.bio_version_id
          AND unit.user_id = link.user_id
          AND unit.created_at <= $3
         INNER JOIN app_users owner ON owner.user_id = link.user_id
         WHERE link.memory_claim_version_id = $1
           AND link.user_id = $2
           AND owner.status = 'active'
           AND version.created_at <= $3
           AND link.created_at <= $3
           AND (
             $4::int IS NULL OR version.revision < $4::int
             OR (
               version.revision = $4::int
               AND (
                 version.bio_version_id > $5::uuid
                 OR (
                   version.bio_version_id = $5::uuid
                   AND (
                     link.bio_claim_link_id > $6::uuid
                     OR (
                       link.bio_claim_link_id = $6::uuid
                       AND COALESCE(unit.bio_coverage_unit_id::text, '') > $7::text
                     )
                   )
                 )
               )
             )
           )
         ORDER BY version.revision DESC, version.bio_version_id ASC,
                  link.bio_claim_link_id ASC,
                  COALESCE(unit.bio_coverage_unit_id::text, '') ASC
         LIMIT $8`,
        [
          input.memoryClaimVersionId,
          input.userId,
          context.snapshot,
          afterValue(context, 0),
          afterValue(context, 1),
          afterValue(context, 2),
          afterValue(context, 3),
          context.limit + 1,
        ],
      );
      return pageFromRowsForOwner({
        after: (row) => [
          String(row.revision),
          row.bio_version_id,
          row.bio_claim_link_id,
          row.bio_coverage_unit_id ?? "",
        ],
        context,
        map: (row) => ({
          bioCoverageUnitId: row.bio_coverage_unit_id
            ? asBioCoverageUnitId(row.bio_coverage_unit_id)
            : null,
          bioId: asBioId(row.bio_id),
          bioVersionId: asBioVersionId(row.bio_version_id),
          coverageDisposition: row.coverage_disposition as ReflectionInspectionBioImpact["coverageDisposition"],
          coveragePolicyVersion: row.coverage_policy_version,
          current: row.current_version_id === row.bio_version_id,
          expectedDataEpoch: Number(row.expected_data_epoch),
          linkRole: row.link_role,
          revision: row.revision,
          sourceRevision: Number(row.source_revision),
          status: row.status,
          supportStatus: row.support_status,
          unitKey: row.unit_key,
        }),
        owner: input.userId,
        rows: result.rows,
        secret: this.cursorSecret,
      });
    });
  }

  public async expandEvidence(input: {
    authSessionId: string;
    evidenceItemId: import("@sayhear/domain").EvidenceItemId;
    now: Date;
    policyVersion: string;
    stepUpMaxAgeMs: number;
    userId: UserId;
  }): Promise<ReflectionInspectionEvidenceExpansion> {
    const evaluation = await withReadOnlySnapshot(this.pool, async (client) => {
      let denialReason:
        | "elevated_capability_required"
        | "recent_step_up_required"
        | null = null;
      let metadata: EvidenceMetadataRow | null = null;
      let auditReason:
        | "authorized"
        | "elevated_capability_required"
        | "recent_step_up_required"
        | "target_not_found"
        | "source_invalidated"
        | "content_purged" = "target_not_found";

      const grant = await client.query<AccessGrantRow>(
        `SELECT diagnostic_grant.status AS capability_status,
                diagnostic_grant.step_up_authenticated_at
         FROM auth_sessions session
         INNER JOIN active_internal_owner owner
           ON owner.user_id = session.user_id
         INNER JOIN internal_diagnostic_access_grants reflection_grant
           ON reflection_grant.session_token_hash = session.session_token_hash
          AND reflection_grant.capability = 'reflection_inspection:read'
          AND reflection_grant.status = 'active'
         LEFT JOIN internal_diagnostic_access_grants diagnostic_grant
           ON diagnostic_grant.session_token_hash = session.session_token_hash
          AND diagnostic_grant.capability = 'conversation_content:read'
         WHERE session.user_id = $1
           AND session.session_token_hash = decode($2, 'hex')
           AND session.expires_at > $3`,
        [input.userId, input.authSessionId, input.now],
      );
      const grantRow = grant.rows[0];
      if (grantRow?.capability_status !== "active") {
        denialReason = "elevated_capability_required";
      } else {
        const stepUpTime = grantRow.step_up_authenticated_at?.getTime();
        if (
          stepUpTime === undefined ||
          stepUpTime > input.now.getTime() ||
          stepUpTime < input.now.getTime() - input.stepUpMaxAgeMs
        ) {
          denialReason = "recent_step_up_required";
        } else {
          const target = await client.query<EvidenceMetadataRow>(
            `SELECT item.evidence_item_id,
                    item.source_event_id::text AS item_source_event_id,
                    item.source_revision_id::text AS item_source_revision_id,
                    item.locator_type AS item_locator_type,
                    item.locator_key AS item_locator_key,
                    item.source_status AS item_source_status,
                    item.status AS item_status,
                    daily.logical_date::text AS logical_date,
                    rev.content_purged_at AS revision_content_purged_at,
                    rev.transcript_status AS revision_transcript_status,
                    ev.lifecycle_status AS source_event_lifecycle_status,
                    ev.current_revision_id::text AS source_event_current_revision_id
             FROM evidence_items item
             INNER JOIN conversation_event_revisions rev
               ON rev.conversation_event_revision_id = item.source_revision_id
              AND rev.user_id = item.user_id
             INNER JOIN conversation_events ev
               ON ev.conversation_event_id = item.source_event_id
              AND ev.user_id = item.user_id
             INNER JOIN evidence_source_snapshots snapshot
               ON snapshot.evidence_source_snapshot_id = item.evidence_source_snapshot_id
              AND snapshot.user_id = item.user_id
             LEFT JOIN daily_sessions daily
               ON daily.daily_session_id = snapshot.daily_session_id
              AND daily.user_id = item.user_id
             WHERE item.evidence_item_id = $1 AND item.user_id = $2`,
            [input.evidenceItemId, input.userId],
          );
          metadata = target.rows[0] ?? null;
          if (!metadata) {
            auditReason = "target_not_found";
          } else if (metadata.revision_content_purged_at) {
            auditReason = "content_purged";
          } else if (
            metadata.item_status !== "active" ||
            metadata.source_event_lifecycle_status !== "active" ||
            metadata.source_event_current_revision_id !==
              metadata.item_source_revision_id ||
            !["final", "corrected"].includes(metadata.revision_transcript_status)
          ) {
            auditReason = "source_invalidated";
          } else if (
            metadata.item_locator_type !== "segment" &&
            metadata.item_locator_type !== "text_span"
          ) {
            auditReason = "source_invalidated";
          } else {
            auditReason = "authorized";
          }
        }
      }
      if (denialReason) {
        auditReason = denialReason;
      }
      return { auditReason, denialReason, metadata };
    });
    const { auditReason, denialReason, metadata } = evaluation;

    const auditClient = await this.pool.connect();
    let auditTransactionStarted = false;
    try {
      await auditClient.query("BEGIN");
      auditTransactionStarted = true;
      await auditClient.query(
        `INSERT INTO sensitive_access_audits (
           sensitive_access_audit_id, user_id, capability, target_type,
           target_id, disposition, reason, policy_version, accessed_at
         ) VALUES ($1, $2, 'conversation_content:read', 'evidence_item', $3,
                   $4, $5, $6, $7)`,
        [
          createUuidV7(input.now),
          input.userId,
          input.evidenceItemId,
          auditReason === "authorized"
            ? "allowed"
            : "denied",
          auditReason,
          input.policyVersion,
          input.now,
        ],
      );
      await auditClient.query("COMMIT");
      auditTransactionStarted = false;
    } catch {
      if (auditTransactionStarted) {
        await auditClient.query("ROLLBACK");
      }
      throw new ReflectionInspectionAuditError();
    } finally {
      auditClient.release();
    }

    if (denialReason) {
      return {
        outcome: "denied",
        evidenceItemId: input.evidenceItemId,
        reason: denialReason,
      };
    }
    if (!metadata || auditReason === "target_not_found") {
      return { outcome: "target_missing", evidenceItemId: input.evidenceItemId };
    }
    if (auditReason === "content_purged") {
      return { outcome: "content_purged", evidenceItemId: input.evidenceItemId };
    }
    if (auditReason === "source_invalidated") {
      return { outcome: "source_invalidated", evidenceItemId: input.evidenceItemId };
    }

    return withReadOnlySnapshot(this.pool, async (readClient) => {
      const result = await readClient.query<EvidenceContentRow>(
        `SELECT item.evidence_item_id,
                item.source_event_id::text AS item_source_event_id,
                item.source_revision_id::text AS item_source_revision_id,
                item.locator_type AS item_locator_type,
                item.locator_key AS item_locator_key,
                item.source_status AS item_source_status,
                item.status AS item_status,
                daily.logical_date::text AS logical_date,
                rev.content_purged_at AS revision_content_purged_at,
                rev.transcript_status AS revision_transcript_status,
                ev.lifecycle_status AS source_event_lifecycle_status,
                ev.current_revision_id::text AS source_event_current_revision_id,
                rev.canonical_text, rev.locale
         FROM evidence_items item
         INNER JOIN conversation_event_revisions rev
           ON rev.conversation_event_revision_id = item.source_revision_id
          AND rev.user_id = item.user_id
         INNER JOIN conversation_events ev
           ON ev.conversation_event_id = item.source_event_id
          AND ev.user_id = item.user_id
         INNER JOIN evidence_source_snapshots snapshot
           ON snapshot.evidence_source_snapshot_id = item.evidence_source_snapshot_id
          AND snapshot.user_id = item.user_id
         LEFT JOIN daily_sessions daily
           ON daily.daily_session_id = snapshot.daily_session_id
          AND daily.user_id = item.user_id
         WHERE item.evidence_item_id = $1 AND item.user_id = $2
           AND item.status = 'active'
           AND rev.content_purged_at IS NULL
           AND rev.transcript_status IN ('final', 'corrected')
           AND ev.lifecycle_status = 'active'
           AND ev.current_revision_id = rev.conversation_event_revision_id`,
        [input.evidenceItemId, input.userId],
      );
      const row = result.rows[0];
      if (!row) {
        return { outcome: "source_invalidated", evidenceItemId: input.evidenceItemId } as const;
      }
      const text = textAtLocator(
        row.canonical_text,
        row.item_locator_type,
        row.item_locator_key,
      );
      if (text === null) {
        return { outcome: "source_invalidated", evidenceItemId: input.evidenceItemId } as const;
      }
      return {
        outcome: "allowed",
        evidenceItemId: input.evidenceItemId,
        locale: row.locale,
        logicalDate: row.logical_date,
        locatorKey: row.item_locator_key,
        locatorType: row.item_locator_type,
        sourceEventId: row.item_source_event_id,
        sourceRevisionId: row.item_source_revision_id,
        sourceStatus: row.item_source_status,
        text,
      } as const;
    });
  }

  private pageContext(input: Readonly<{
    cursor: string | null;
    filter: string;
    layer: ReflectionInspectionCursorLayer;
    limit: number;
    owner: UserId;
    sort: string;
  }>): PageContext {
    if (!input.cursor) {
      const snapshot = this.clock();
      if (Number.isNaN(snapshot.getTime())) throw new Error("Invalid inspection clock.");
      return {
        after: [],
        filter: input.filter,
        layer: input.layer,
        limit: input.limit,
        snapshot,
        sort: input.sort,
      };
    }
    const decoded = decodeReflectionInspectionCursor(
      input.cursor,
      this.cursorSecret,
    );
    const snapshot = decoded ? validDate(decoded.snapshot) : null;
    if (
      !decoded ||
      !snapshot ||
      decoded.owner !== input.owner ||
      decoded.layer !== input.layer ||
      decoded.filter !== input.filter ||
      decoded.sort !== input.sort ||
      decoded.limit !== input.limit ||
      decoded.after.length !== (input.layer === "bio_impact" ? 4 : 2)
    ) {
      throw new ReflectionInspectionCursorError();
    }
    return {
      after: decoded.after,
      filter: decoded.filter,
      layer: decoded.layer,
      limit: decoded.limit,
      snapshot,
      sort: decoded.sort,
    };
  }

  private async versionGate(
    client: PoolClient,
    userId: UserId,
    reflectionVersionId: ReflectionVersionId,
    snapshot: Date,
  ): Promise<VersionGateRow | null> {
    const result = await client.query<VersionGateRow>(
      `SELECT v.reflection_id, v.reflection_version_id, v.revision,
              v.status, v.source_revision::text, v.source_digest,
              v.locale, v.prompt_version, v.schema_version,
              v.degraded_episode_reason, v.content_expires_at,
              v.content_purged_at, v.created_at, r.current_version_id
       FROM reflection_versions v
       INNER JOIN reflections r
         ON r.reflection_id = v.reflection_id AND r.user_id = v.user_id
       INNER JOIN app_users owner ON owner.user_id = v.user_id
       WHERE v.reflection_version_id = $1 AND v.user_id = $2
         AND v.created_at <= $3
         AND owner.status = 'active'`,
      [reflectionVersionId, userId, snapshot],
    );
    return result.rows[0] ?? null;
  }
}

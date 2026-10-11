import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { PURGE_SURFACE_REGISTRY } from "@sayhear/application";
import { runMigrations } from "@sayhear/data";
import {
  createIsolatedPostgresSchema,
  type IsolatedPostgresSchema,
} from "@sayhear/test-support";

const testDatabaseUrl = process.env.TEST_DATABASE_URL;
const systemDescribe = testDatabaseUrl ? describe : describe.skip;

/**
 * Issue #234: every immutability trigger that guards a table the Owner Full
 * Purge clear path DELETEs or UPDATEs must accept the operation only under a
 * verified purge pass (`sayhear_purge_pass_active()`); otherwise a purge bricks
 * deterministically once the table holds a row and the failure is sanitized to
 * `needs_attention/unknown_error`.
 *
 * This is the durable form of the trigger audit. The inventory below is the
 * complete set of non-internal BEFORE UPDATE/DELETE triggers as of migration
 * 0070. Verdicts:
 *
 *   exempted-under-pass  DELETE-cleared; the trigger carries the 0019/0041/0050
 *                        `sayhear_purge_pass_active()` bypass.
 *   update-clear         the purge clears the surface with an UPDATE null-out;
 *                        the trigger allows exactly that shape and no
 *                        DELETE bypass is needed.
 *   delete-guard         the purge DELETEs the surface; the trigger only fires
 *                        on UPDATE (normal-path write guard), so DELETE is
 *                        already unguarded.
 *   owner-write-guard    registry surface guarded for normal-path writes
 *                        (ownership / scope / owner-boundary); the purge never
 *                        mutates the guarded fields, so no exemption applies.
 *   policy               immutable global policy versions, not owner-scoped and
 *                        never cleared by Full Purge.
 *
 * Any new trigger or verdict drift fails this suite until it is re-audited
 * against the purge clear path.
 */
type Verdict =
  | "exempted-under-pass"
  | "update-clear"
  | "delete-guard"
  | "owner-write-guard"
  | "policy";

const EXPECTED_TRIGGER_INVENTORY: ReadonlyArray<
  Readonly<{
    table: string;
    trigger: string;
    fn: string;
    migration: string;
    verdict: Verdict;
  }>
> = [
  // --- exempted under a verified purge pass -------------------------------
  {
    table: "continuous_exchange_inactivity_evaluations",
    trigger: "continuous_exchange_inactivity_evaluation_snapshot_immutable",
    fn: "enforce_inactivity_evaluation_snapshot_immutability",
    migration: "0005 (upgraded by 0019)",
    verdict: "exempted-under-pass",
  },
  {
    table: "evidence_items",
    trigger: "evidence_items_immutable",
    fn: "reject_evidence_item_mutation",
    migration: "0010 (upgraded by 0019)",
    verdict: "exempted-under-pass",
  },
  {
    table: "evidence_source_snapshots",
    trigger: "evidence_source_snapshots_immutable",
    fn: "reject_evidence_item_mutation",
    migration: "0010 (upgraded by 0019)",
    verdict: "exempted-under-pass",
  },
  {
    table: "journal_diagnostic_findings",
    trigger: "journal_diagnostic_findings_immutable",
    fn: "reject_journal_diagnostic_finding_mutation",
    migration: "0025 (upgraded by 0050)",
    verdict: "exempted-under-pass",
  },
  {
    table: "journal_statement_evidence_links",
    trigger: "journal_statement_evidence_links_immutable",
    fn: "reject_journal_artifact_mutation",
    migration: "0011 (upgraded by 0019)",
    verdict: "exempted-under-pass",
  },
  {
    table: "journal_statements",
    trigger: "journal_statements_immutable",
    fn: "reject_journal_artifact_mutation",
    migration: "0011 (upgraded by 0019)",
    verdict: "exempted-under-pass",
  },
  {
    table: "journal_validation_results",
    trigger: "journal_validation_results_immutable",
    fn: "reject_journal_artifact_mutation",
    migration: "0011 (upgraded by 0019)",
    verdict: "exempted-under-pass",
  },
  {
    table: "journal_versions",
    trigger: "journal_versions_immutable",
    fn: "reject_journal_artifact_mutation",
    migration: "0011 (upgraded by 0019)",
    verdict: "exempted-under-pass",
  },
  {
    table: "retrieval_run_candidates",
    trigger: "retrieval_run_candidates_immutable",
    fn: "enforce_retrieval_run_candidate_immutability",
    migration: "0037 (upgraded by 0041)",
    verdict: "exempted-under-pass",
  },
  {
    table: "retrieval_runs",
    trigger: "retrieval_runs_outcome_update_guard",
    fn: "enforce_retrieval_run_outcome_update",
    migration: "0037 (upgraded by 0041)",
    verdict: "exempted-under-pass",
  },
  // --- purge clears the surface with an UPDATE null-out -------------------
  {
    table: "conversation_event_revisions",
    trigger: "conversation_event_revisions_immutable",
    fn: "enforce_conversation_event_revision_immutability",
    migration: "0002",
    verdict: "update-clear",
  },
  {
    table: "entity_versions",
    trigger: "entity_versions_immutable",
    fn: "enforce_entity_version_immutability",
    migration: "0031 (replaced by 0041)",
    verdict: "update-clear",
  },
  {
    table: "episode_versions",
    trigger: "episode_versions_immutability",
    fn: "enforce_episode_version_immutability",
    migration: "0045",
    verdict: "update-clear",
  },
  {
    table: "memory_claim_version_qualifiers",
    trigger: "memory_claim_version_qualifiers_immutable",
    fn: "enforce_memory_claim_version_qualifier_immutability",
    migration: "0036 (replaced by 0041)",
    verdict: "update-clear",
  },
  {
    table: "memory_claim_versions",
    trigger: "memory_claim_versions_immutable",
    fn: "enforce_memory_claim_version_immutability",
    migration: "0033 (replaced by 0044)",
    verdict: "update-clear",
  },
  {
    table: "narrative_validator_requests",
    trigger: "narrative_validator_requests_immutability",
    fn: "enforce_narrative_request_immutability",
    migration: "0046",
    verdict: "update-clear",
  },
  {
    table: "narrative_validator_results",
    trigger: "narrative_validator_results_immutability",
    fn: "enforce_narrative_result_immutability",
    migration: "0046",
    verdict: "update-clear",
  },
  {
    table: "open_loop_versions",
    trigger: "open_loop_versions_immutability",
    fn: "enforce_open_loop_version_immutability",
    migration: "0049",
    verdict: "update-clear",
  },
  // --- purge DELETEs the surface; the trigger guards UPDATE only ----------
  {
    table: "claim_retrieval_projections",
    trigger: "claim_retrieval_projections_frozen",
    fn: "enforce_claim_retrieval_projection_freeze",
    migration: "0037",
    verdict: "delete-guard",
  },
  {
    table: "episode_candidates",
    trigger: "episode_candidates_terminal_fence",
    fn: "enforce_episode_candidate_terminal_fence",
    migration: "0045",
    verdict: "delete-guard",
  },
  {
    table: "memory_candidates",
    trigger: "memory_candidates_terminal_fence",
    fn: "enforce_memory_candidate_terminal_fence",
    migration: "0033 (replaced by 0035)",
    verdict: "delete-guard",
  },
  {
    table: "proactive_followup_state_versions",
    trigger: "proactive_followup_state_versions_immutable",
    fn: "reject_proactive_followup_state_version_mutation",
    migration: "0050",
    verdict: "delete-guard",
  },
  {
    table: "reflection_versions",
    trigger: "reflection_versions_immutability",
    fn: "enforce_reflection_version_immutability",
    migration: "0047",
    verdict: "delete-guard",
  },
  // --- normal-path owner-write guards, not purge-cleared content ----------
  {
    table: "compiled_context_revision_refs",
    trigger: "compiled_context_revision_refs_recent_session",
    fn: "enforce_compiled_context_recent_ref_session",
    migration: "0068",
    verdict: "owner-write-guard",
  },
  {
    table: "conversation_events",
    trigger: "conversation_event_user_correction_advances_journal_source",
    fn: "advance_daily_session_source_for_user_correction",
    migration: "0014",
    verdict: "owner-write-guard",
  },
  {
    table: "daily_sessions",
    trigger: "daily_session_ownership_immutable",
    fn: "enforce_daily_session_ownership_immutability",
    migration: "0005",
    verdict: "owner-write-guard",
  },
  {
    table: "dialogue_state_command_source_refs",
    trigger: "dialogue_state_source_ref_scope",
    fn: "enforce_dialogue_state_source_ref_scope",
    migration: "0016",
    verdict: "owner-write-guard",
  },
  {
    table: "entities",
    trigger: "self_entities_row_protected",
    fn: "enforce_self_entity_no_independent_delete",
    migration: "0031",
    verdict: "owner-write-guard",
  },
  {
    table: "entity_versions",
    trigger: "self_entities_version_protected",
    fn: "enforce_self_entity_version_status",
    migration: "0031",
    verdict: "owner-write-guard",
  },
  {
    table: "generation_commands",
    trigger: "generation_commands_conversation_owner_fence",
    fn: "enforce_generation_command_conversation_owner_fence",
    migration: "0044",
    verdict: "owner-write-guard",
  },
  {
    table: "rolling_summary_command_source_refs",
    trigger: "rolling_summary_source_ref_scope",
    fn: "enforce_rolling_summary_source_ref_scope",
    migration: "0015",
    verdict: "owner-write-guard",
  },
  // --- immutable global policy versions, never owner-cleared --------------
  {
    table: "continuous_exchange_inactivity_policies",
    trigger: "continuous_exchange_inactivity_policies_immutable",
    fn: "reject_inactivity_policy_mutation",
    migration: "0005",
    verdict: "policy",
  },
  {
    table: "conversation_response_recovery_policies",
    trigger: "conversation_response_recovery_policies_immutable",
    fn: "reject_conversation_response_recovery_policy_mutation",
    migration: "0007",
    verdict: "policy",
  },
  {
    table: "dialogue_state_policies",
    trigger: "dialogue_state_policies_immutable",
    fn: "reject_dialogue_state_policy_mutation",
    migration: "0016",
    verdict: "policy",
  },
  {
    table: "curiosity_stop_signal_policies",
    trigger: "curiosity_stop_signal_policies_immutable",
    fn: "reject_curiosity_stop_signal_policy_mutation",
    migration: "0027",
    verdict: "policy",
  },
  {
    table: "safety_posture_policies",
    trigger: "safety_posture_policies_immutable",
    fn: "reject_safety_posture_policy_mutation",
    migration: "0028",
    verdict: "policy",
  },
  {
    table: "fast_path_extraction_policies",
    trigger: "fast_path_extraction_policies_immutable",
    fn: "reject_fast_path_policy_mutation",
    migration: "0034",
    verdict: "policy",
  },
  {
    table: "memory_consolidation_policies",
    trigger: "memory_consolidation_policies_immutable",
    fn: "reject_memory_consolidation_policy_mutation",
    migration: "0035",
    verdict: "policy",
  },
  {
    table: "retrieval_policies",
    trigger: "retrieval_policies_immutable",
    fn: "reject_retrieval_policy_mutation",
    migration: "0037",
    verdict: "policy",
  },
  {
    table: "episode_policies",
    trigger: "episode_policies_immutable",
    fn: "reject_episode_policy_mutation",
    migration: "0045",
    verdict: "policy",
  },
  {
    table: "reflection_policies",
    trigger: "reflection_policies_immutable",
    fn: "reject_reflection_policy_mutation",
    migration: "0047",
    verdict: "policy",
  },
  {
    table: "open_loop_policies",
    trigger: "open_loop_policies_immutable",
    fn: "reject_open_loop_policy_mutation",
    migration: "0049",
    verdict: "policy",
  },
  {
    table: "journal_eligibility_policies",
    trigger: "journal_eligibility_policies_immutable",
    fn: "reject_journal_eligibility_policy_mutation",
    migration: "0009",
    verdict: "policy",
  },
  {
    table: "rolling_summary_policies",
    trigger: "rolling_summary_policy_immutable",
    fn: "reject_rolling_summary_policy_mutation",
    migration: "0015",
    verdict: "policy",
  },
];

/** pg_trigger.tgtype bits we probe (see PostgreSQL catalog docs). */
const TG_INSERT = 4;
const TG_DELETE = 8;
const TG_UPDATE = 16;

const DELETE_CLEAR_HANDLERS = new Set([
  "delete_owner_rows",
  "delete_owner_workflow_commands",
  "delete_owner_outbox_events",
  "purge_bios",
  "purge_bio_versions",
]);

type CatalogTrigger = Readonly<{
  table_name: string;
  trigger_name: string;
  function_name: string;
  has_insert: boolean;
  has_delete: boolean;
  has_update: boolean;
  has_pass: boolean;
}>;

systemDescribe(
  "Owner Full Purge immutability-trigger audit (issue #234)",
  () => {
    let database: IsolatedPostgresSchema;

    beforeAll(async () => {
      database = await createIsolatedPostgresSchema(testDatabaseUrl!);
      await runMigrations(database.pool);
    }, 60_000);

    afterAll(async () => {
      await database?.dispose();
    }, 60_000);

    const clearHandlerByTable = new Map(
      PURGE_SURFACE_REGISTRY.map((surface) => [
        surface.surfaceId,
        surface.clearHandler,
      ]),
    );

    async function listWriteEventTriggers(): Promise<CatalogTrigger[]> {
      const result = await database.pool.query<{
        table_name: string;
        trigger_name: string;
        function_name: string;
        has_insert: boolean;
        has_delete: boolean;
        has_update: boolean;
        has_pass: boolean;
      }>(
        `
        SELECT c.relname AS table_name,
               t.tgname AS trigger_name,
               p.proname AS function_name,
               (t.tgtype::int & ${TG_INSERT}) <> 0 AS has_insert,
               (t.tgtype::int & ${TG_DELETE}) <> 0 AS has_delete,
               (t.tgtype::int & ${TG_UPDATE}) <> 0 AS has_update,
               position('purge_pass_active' in p.prosrc) > 0 AS has_pass
        FROM pg_trigger t
        JOIN pg_class c ON c.oid = t.tgrelid
        JOIN pg_namespace n ON n.oid = c.relnamespace
        JOIN pg_proc p ON p.oid = t.tgfoid
        WHERE n.nspname = current_schema()
          AND NOT t.tgisinternal
          AND (t.tgtype::int & (${TG_DELETE} | ${TG_UPDATE})) <> 0
        ORDER BY c.relname, t.tgname
      `,
      );
      return result.rows;
    }

    it("has exactly the reviewed set of BEFORE UPDATE/DELETE triggers", async () => {
      const triggers = await listWriteEventTriggers();
      const actual = triggers
        .map(
          (row) =>
            `${row.table_name}|${row.trigger_name}|${row.function_name}`,
        )
        .sort();
      const expected = EXPECTED_TRIGGER_INVENTORY.map(
        (entry) => `${entry.table}|${entry.trigger}|${entry.fn}`,
      ).sort();
      expect(actual).toEqual(expected);
    });

    it("exempts every owner-deleted immutable table under a verified pass", async () => {
      const triggers = await listWriteEventTriggers();
      const ownerDeleted = triggers.filter(
        (row) =>
          row.has_delete &&
          DELETE_CLEAR_HANDLERS.has(
            clearHandlerByTable.get(row.table_name) ?? "",
          ),
      );
      // Independently authored expectation: these are the only immutable
      // tables whose trigger carries a DELETE event and whose registry clear
      // handler removes rows. Every one of them must hold the 0019/0041/0050
      // exemption, or a purge bricks once the table holds a row.
      expect(ownerDeleted.map((row) => row.table_name).sort()).toEqual([
        "continuous_exchange_inactivity_evaluations",
        "evidence_items",
        "evidence_source_snapshots",
        "journal_diagnostic_findings",
        "journal_statement_evidence_links",
        "journal_statements",
        "journal_validation_results",
        "journal_versions",
        "retrieval_run_candidates",
        "retrieval_runs",
      ]);
      for (const row of ownerDeleted) {
        expect(
          row.has_pass,
          `${row.table_name} must carry the purge-pass exemption`,
        ).toBe(true);
      }
    });

    it("declares each trigger's event/verdict against the registry", async () => {
      const triggers = await listWriteEventTriggers();
      const byTable = new Map(triggers.map((row) => [row.table_name, row]));
      for (const entry of EXPECTED_TRIGGER_INVENTORY) {
        const row = byTable.get(entry.table);
        expect(row, `missing trigger for ${entry.table}`).toBeDefined();
        const clearHandler = clearHandlerByTable.get(entry.table);
        switch (entry.verdict) {
          case "exempted-under-pass":
            expect(row!.has_delete).toBe(true);
            expect(row!.has_pass).toBe(true);
            expect(DELETE_CLEAR_HANDLERS.has(clearHandler ?? "")).toBe(true);
            break;
          case "update-clear":
            expect(row!.has_update).toBe(true);
            expect(row!.has_pass).toBe(false);
            expect(clearHandler).toBeDefined();
            expect(DELETE_CLEAR_HANDLERS.has(clearHandler ?? "")).toBe(false);
            break;
          case "delete-guard":
            expect(row!.has_delete).toBe(false);
            expect(row!.has_pass).toBe(false);
            expect(clearHandler).toBeDefined();
            expect(DELETE_CLEAR_HANDLERS.has(clearHandler ?? "")).toBe(true);
            break;
          case "owner-write-guard":
            expect(row!.has_pass).toBe(false);
            expect(clearHandler).toBeDefined();
            break;
          case "policy":
            expect(row!.has_pass).toBe(false);
            expect(clearHandler).toBeUndefined();
            break;
        }
      }
    });
  },
);

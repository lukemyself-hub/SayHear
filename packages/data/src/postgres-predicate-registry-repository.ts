import type { Pool } from "pg";

import type { PredicateRegistrySnapshot } from "@sayhear/application";

/**
 * Idempotent database sync for the code-owned Predicate Registry (§7.10.1
 * 发布、演进与验证; SPEC #107 AC 8). The TypeScript snapshot is the single
 * source of truth; syncing converges the published tables to it inside one
 * advisory-locked transaction:
 *
 *  - the snapshot's registry_version slice is fully rebuilt (delete + insert),
 *    so re-running with unchanged content is a no-op by construction and any
 *    drift from earlier partial state self-heals;
 *  - other registry_versions' rows are never touched, keeping old-version
 *    replay readable;
 *
 * Private-data discipline: registry rows carry no user_id, so nothing here is
 * subject to purge or deletion propagation.
 */

export type SyncResult = {
  registryVersion: number;
  entries: number;
  localizations: number;
  relationshipProjections: number;
  relations: number;
};

/** Rejected before any write: v1 must ship zero sensitive entries (#93 §6). */
export class SensitivePredicateError extends Error {
  constructor(predicateIds: readonly string[]) {
    super(
      `Registry version would publish sensitive predicates (${predicateIds.join(", ")}); v1 ships zero and any future sensitive entry needs its own governed release.`,
    );
    this.name = "SensitivePredicateError";
  }
}

const ADVISORY_LOCK_KEY = "predicate_registry_sync";

export class PostgresPredicateRegistryRepository {
  constructor(readonly pool: Pool) {}

  async syncPredicateRegistry(
    registry: PredicateRegistrySnapshot,
    now = new Date(),
  ): Promise<SyncResult> {
    const sensitive = registry.entries.filter(
      (entry) => entry.sensitivityClass === "sensitive",
    );
    if (sensitive.length > 0) {
      throw new SensitivePredicateError(sensitive.map((e) => e.predicateId));
    }

    const client = await this.pool.connect();
    const version = registry.registryVersion;
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [
        ADVISORY_LOCK_KEY,
      ]);

      // Version-scoped rebuild of this release's whole slice.
      await client.query(
        "DELETE FROM predicate_relations WHERE registry_version = $1",
        [version],
      );
      await client.query(
        "DELETE FROM relationship_projection_localizations WHERE registry_version = $1",
        [version],
      );
      await client.query(
        "DELETE FROM predicate_localizations WHERE registry_version = $1",
        [version],
      );
      await client.query(
        "DELETE FROM predicate_registry_entries WHERE registry_version = $1",
        [version],
      );

      for (const entry of registry.entries) {
        await client.query(
          `INSERT INTO predicate_registry_entries (
             predicate_id, registry_version, definition_version, status,
             allowed_claim_kinds, sensitivity_class, allowed_subject_kind_ids,
             object_value_schema, scope_schema, value_cardinality,
             temporal_semantics, relationship_semantics,
             evidence_policy_id, review_policy_id, replaced_by_predicate_id,
             created_at, deprecated_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)`,
          [
            entry.predicateId,
            version,
            entry.definitionVersion,
            entry.status,
            JSON.stringify(entry.allowedClaimKinds),
            entry.sensitivityClass,
            JSON.stringify(entry.allowedSubjectKindIds),
            JSON.stringify(entry.objectValueSchema),
            JSON.stringify(entry.scopeSchema),
            entry.valueCardinality,
            JSON.stringify(entry.temporalSemantics),
            entry.relationshipSemantics
              ? JSON.stringify(entry.relationshipSemantics)
              : null,
            entry.evidencePolicyId,
            entry.reviewPolicyId,
            entry.replacedByPredicateId,
            now,
            null,
          ],
        );
      }

      for (const loc of registry.localizations) {
        await client.query(
          `INSERT INTO predicate_localizations (
             predicate_id, registry_version, locale, label, definition,
             positive_examples, negative_examples, lexical_surfaces,
             localization_version)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
          [
            loc.predicateId,
            version,
            loc.locale,
            loc.label,
            loc.definition,
            JSON.stringify(loc.positiveExamples),
            JSON.stringify(loc.negativeExamples),
            JSON.stringify(loc.lexicalSurfaces),
            loc.localizationVersion,
          ],
        );
      }

      for (const proj of registry.relationshipProjections) {
        await client.query(
          `INSERT INTO relationship_projection_localizations (
             predicate_id, registry_version, locale, view_direction,
             role_projection_schema, localization_version)
           VALUES ($1,$2,$3,$4,$5,$6)`,
          [
            proj.predicateId,
            version,
            proj.locale,
            proj.viewDirection,
            JSON.stringify({
              templates: proj.templates,
              formerTemplates: proj.formerTemplates,
            }),
            proj.roleProjectionVersion,
          ],
        );
      }

      for (const rel of registry.relations) {
        await client.query(
          `INSERT INTO predicate_relations
             (predicate_id, related_predicate_id, registry_version, relation_type)
           VALUES ($1,$2,$3,$4)`,
          [rel.predicateId, rel.relatedPredicateId, version, rel.relationType],
        );
      }

      await client.query("COMMIT");
      return {
        registryVersion: version,
        entries: registry.entries.length,
        localizations: registry.localizations.length,
        relationshipProjections: registry.relationshipProjections.length,
        relations: registry.relations.length,
      };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Ordered row fingerprint of one released version: identical across repeated
   * syncs of unchanged source (idempotency) and sensitive to any drift.
   */
  async readSyncChecksum(registryVersion: number): Promise<string | null> {
    const result = await this.pool.query<{ digest: string | null }>(
      `WITH payload AS (
         SELECT 'entry' kind, predicate_id k1, '' k2, status k3,
                md5(concat_ws('|',
                  definition_version::text, allowed_claim_kinds::text,
                  sensitivity_class, allowed_subject_kind_ids::text,
                  object_value_schema::text, scope_schema::text,
                  value_cardinality, temporal_semantics::text,
                  coalesce(relationship_semantics::text,''),
                  evidence_policy_id, coalesce(review_policy_id,''),
                  coalesce(replaced_by_predicate_id,''))) body
           FROM predicate_registry_entries WHERE registry_version = $1
         UNION ALL
         SELECT 'loc', predicate_id, locale, '', md5(concat_ws('|',
                  label, definition, positive_examples::text,
                  negative_examples::text, lexical_surfaces::text,
                  localization_version::text))
           FROM predicate_localizations WHERE registry_version = $1
         UNION ALL
         SELECT 'proj', predicate_id, locale || ':' || view_direction, '',
                md5(concat_ws('|', role_projection_schema::text,
                  localization_version::text))
           FROM relationship_projection_localizations WHERE registry_version = $1
         UNION ALL
         SELECT 'rel', predicate_id, related_predicate_id, relation_type, ''
           FROM predicate_relations WHERE registry_version = $1
       )
       SELECT md5(string_agg(kind || '|' || k1 || '|' || k2 || '|' || k3 ||
                             '|' || body, E'\n' ORDER BY kind, k1, k2, k3))
         AS digest
         FROM payload`,
      [registryVersion],
    );
    return result.rows[0]?.digest ?? null;
  }
}

import type {
  BioInspectionClaimLink,
  BioInspectionCoverageUnit,
  BioInspectionProposition,
  BioInspectionRead,
  BioInspectionRepository,
  BioInspectionStatement,
} from "@sayhear/application";
import {
  asBioAtomicPropositionId,
  asBioCoverageUnitId,
  asBioId,
  asBioStatementId,
  asBioVersionId,
  asMemoryClaimVersionId,
  asUserId,
  type BioId,
  type MemoryClaimVersionId,
  type UserId,
} from "@sayhear/domain";
import type { Pool } from "pg";

type BioRow = Readonly<{
  bio_id: string;
  user_id: string;
  current_version_id: string | null;
  current_source_revision: string | null;
  current_data_epoch: string | null;
  owner_status: string;
  data_epoch: string;
}>;

type VersionRow = Readonly<{
  bio_version_id: string;
  bio_id: string;
  user_id: string;
  revision: number;
  status: BioInspectionRead["status"];
  source_revision: string;
  expected_data_epoch: string;
  presentation_locale: string;
  source_manifest: unknown;
}>;

function objectValue(value: unknown): Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : {};
}

export class PostgresBioInspectionRepository implements BioInspectionRepository {
  public constructor(private readonly pool: Pool) {}

  public async readCurrentBio(input: Readonly<{ userId: UserId; bioId?: BioId }>) {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
      const bioResult = await client.query<BioRow>(
        `SELECT bio.bio_id, bio.user_id, bio.current_version_id,
                bio.current_source_revision::text AS current_source_revision,
                bio.current_data_epoch::text AS current_data_epoch,
                owner.status AS owner_status,
                owner.data_epoch::text AS data_epoch
         FROM app_users owner
         INNER JOIN bios bio ON bio.user_id = owner.user_id
         WHERE owner.user_id = $1
           AND ($2::uuid IS NULL OR bio.bio_id = $2::uuid)
         ORDER BY bio.created_at DESC, bio.bio_id
         LIMIT 1`,
        [input.userId, input.bioId ?? null],
      );
      const bio = bioResult.rows[0];
      if (!bio || !bio.current_version_id) {
        await client.query("COMMIT");
        return { outcome: "no_record" } as const;
      }

      const versionResult = await client.query<VersionRow>(
        `SELECT bio_version_id, bio_id, user_id, revision, status,
                source_revision::text AS source_revision,
                expected_data_epoch::text AS expected_data_epoch,
                presentation_locale, source_manifest
         FROM bio_versions
         WHERE bio_version_id = $1
           AND bio_id = $2
           AND user_id = $3`,
        [bio.current_version_id, bio.bio_id, input.userId],
      );
      const version = versionResult.rows[0];
      if (!version) {
        await client.query("COMMIT");
        return { outcome: "no_record" } as const;
      }

      const observedEpoch = Number(bio.data_epoch);
      const currentSourceRevision = bio.current_source_revision === null
        ? null
        : Number(bio.current_source_revision);
      const currentDataEpoch = bio.current_data_epoch === null
        ? null
        : Number(bio.current_data_epoch);
      if (
        bio.owner_status !== "active" ||
        Number(version.expected_data_epoch) !== observedEpoch ||
        currentDataEpoch !== observedEpoch ||
        currentSourceRevision !== Number(version.source_revision)
      ) {
        await client.query("COMMIT");
        return {
          outcome: "state_changed",
          bioId: asBioId(bio.bio_id),
          bioVersionId: asBioVersionId(version.bio_version_id),
          currentSourceRevision,
          currentDataEpoch,
          observedDataEpoch: observedEpoch,
        } as const;
      }

      const statements = await client.query<{
        bio_statement_id: string;
        ordinal: number;
        section_key: string;
        statement_key: string;
        statement_text: string | null;
      }>(
          `SELECT bio_statement_id, ordinal, section_key, statement_key,
                  statement_text
           FROM bio_statements
           WHERE bio_version_id = $1 AND bio_id = $2 AND user_id = $3
           ORDER BY ordinal, bio_statement_id`,
          [version.bio_version_id, version.bio_id, input.userId],
        );
      const propositions = await client.query<{
        bio_atomic_proposition_id: string;
        proposition_key: string;
        proposition_text: string | null;
      }>(
          `SELECT bio_atomic_proposition_id, proposition_key, proposition_text
           FROM bio_atomic_propositions
           WHERE bio_version_id = $1 AND bio_id = $2 AND user_id = $3
           ORDER BY proposition_key, bio_atomic_proposition_id`,
          [version.bio_version_id, version.bio_id, input.userId],
        );
      const coverage = await client.query<{
        bio_coverage_unit_id: string;
        unit_key: string;
        disposition: BioInspectionCoverageUnit["disposition"];
        coverage_policy_version: string;
        memory_claim_version_id: string | null;
      }>(
          `SELECT unit.bio_coverage_unit_id, unit.unit_key,
                  unit.disposition, unit.coverage_policy_version,
                  member.memory_claim_version_id
           FROM bio_coverage_units unit
           LEFT JOIN bio_coverage_members member
             ON member.bio_coverage_unit_id = unit.bio_coverage_unit_id
            AND member.bio_version_id = unit.bio_version_id
            AND member.user_id = unit.user_id
           WHERE unit.bio_version_id = $1 AND unit.bio_id = $2
             AND unit.user_id = $3
           ORDER BY unit.unit_key, member.memory_claim_version_id`,
          [version.bio_version_id, version.bio_id, input.userId],
        );
      const claimLinks = await client.query<{
        memory_claim_version_id: string;
        link_role: BioInspectionClaimLink["linkRole"];
        support_status: BioInspectionClaimLink["supportStatus"];
        source_revision: string;
        expected_data_epoch: string;
      }>(
          `SELECT memory_claim_version_id, link_role, support_status,
                  source_revision::text AS source_revision,
                  expected_data_epoch::text AS expected_data_epoch
           FROM bio_claim_links
           WHERE bio_version_id = $1 AND bio_id = $2 AND user_id = $3
           ORDER BY link_role, memory_claim_version_id`,
          [version.bio_version_id, version.bio_id, input.userId],
        );

      const statementRows: BioInspectionStatement[] = statements.rows.map((row) => ({
        bioStatementId: asBioStatementId(row.bio_statement_id),
        ordinal: row.ordinal,
        sectionKey: row.section_key,
        statementKey: row.statement_key,
        statementText: row.statement_text,
      }));
      const propositionRows: BioInspectionProposition[] = propositions.rows.map((row) => ({
        bioAtomicPropositionId: asBioAtomicPropositionId(
          row.bio_atomic_proposition_id,
        ),
        propositionKey: row.proposition_key,
        propositionText: row.proposition_text,
      }));
      const coverageRows: BioInspectionCoverageUnit[] = [];
      for (const row of coverage.rows) {
        let unit = coverageRows.find(
          (candidate) => candidate.bioCoverageUnitId === row.bio_coverage_unit_id,
        );
        if (!unit) {
          unit = {
            bioCoverageUnitId: asBioCoverageUnitId(row.bio_coverage_unit_id),
            unitKey: row.unit_key,
            disposition: row.disposition,
            coveragePolicyVersion: row.coverage_policy_version,
            claimVersionIds: [],
          };
          coverageRows.push(unit);
        }
        if (row.memory_claim_version_id) {
          (unit.claimVersionIds as MemoryClaimVersionId[]).push(
            asMemoryClaimVersionId(row.memory_claim_version_id),
          );
        }
      }
      const claimLinkRows: BioInspectionClaimLink[] = claimLinks.rows.map((row) => ({
        memoryClaimVersionId: asMemoryClaimVersionId(row.memory_claim_version_id),
        linkRole: row.link_role,
        supportStatus: row.support_status,
        sourceRevision: Number(row.source_revision),
        expectedDataEpoch: Number(row.expected_data_epoch),
      }));
      await client.query("COMMIT");
      return {
        outcome: "ok",
        bioId: asBioId(version.bio_id),
        bioVersionId: asBioVersionId(version.bio_version_id),
        userId: asUserId(version.user_id),
        revision: version.revision,
        status: version.status,
        sourceRevision: Number(version.source_revision),
        expectedDataEpoch: Number(version.expected_data_epoch),
        presentationLocale: version.presentation_locale,
        sourceManifest: objectValue(version.source_manifest),
        statements: statementRows,
        propositions: propositionRows,
        coverageUnits: coverageRows,
        claimLinks: claimLinkRows,
      } satisfies BioInspectionRead;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
}

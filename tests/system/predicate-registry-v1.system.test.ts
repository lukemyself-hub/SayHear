import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  buildLegacyRegistryOverlay,
  type PredicateRegistrySnapshot,
  PREDICATE_IDS,
  loadPredicateRegistrySnapshot,
  predicateRegistryFingerprint,
} from "@sayhear/application";
import {
  PostgresPredicateRegistryRepository,
  SensitivePredicateError,
  runMigrations,
} from "@sayhear/data";
import {
  createIsolatedPostgresSchema,
  type IsolatedPostgresSchema,
} from "@sayhear/test-support";

/**
 * SPEC #107 AC 8 through real PostgreSQL: the code-owned Predicate Registry v1
 * converges into the published tables idempotently, never leaks sensitive
 * predicates into the database, keeps other registry_versions untouched during
 * re-release, and self-heals any drifted rows on the next sync.
 */

const testDatabaseUrl = process.env.TEST_DATABASE_URL;
if (!testDatabaseUrl) {
  throw new Error("TEST_DATABASE_URL is required.");
}

const V1 = loadPredicateRegistrySnapshot(1);
const now = new Date();

let schema: IsolatedPostgresSchema;
let repository: PostgresPredicateRegistryRepository;

beforeAll(async () => {
  schema = await createIsolatedPostgresSchema(testDatabaseUrl!);
  await runMigrations(schema.pool);
  repository = new PostgresPredicateRegistryRepository(schema.pool);
});

afterAll(async () => {
  await schema.dispose();
});

describe("Predicate Registry v1 release over PostgreSQL", () => {
  it("syncs the code-owned snapshot with the expected row counts", async () => {
    const result = await repository.syncPredicateRegistry(V1, now);
    expect(result).toEqual({
      registryVersion: 1,
      entries: 24,
      localizations: 48,
      relationshipProjections: expect.any(Number),
      relations: expect.any(Number),
    });
    // bilingual seeds complete per entry
    expect(result.localizations).toBe(24 * 2);
    // symmetric relations were authored pairwise (a→b and b→a)
    expect(result.relations % 2).toBe(0);

    const counts = await schema.pool.query<{ kind: string; n: string }>(
      `SELECT 'entries' kind, count(*)::text n FROM predicate_registry_entries WHERE registry_version = 1
       UNION ALL SELECT 'loc', count(*)::text FROM predicate_localizations WHERE registry_version = 1
       UNION ALL SELECT 'proj', count(*)::text FROM relationship_projection_localizations WHERE registry_version = 1
       UNION ALL SELECT 'rel', count(*)::text FROM predicate_relations WHERE registry_version = 1`,
    );
    const byKind = new Map(counts.rows.map((r) => [r.kind, Number(r.n)]));
    expect(byKind.get("entries")).toBe(24);
    expect(byKind.get("loc")).toBe(48);
  });

  it("ships zero sensitive predicates into the database (SPEC AC 8)", async () => {
    const result = await schema.pool.query<{ n: string }>(
      `SELECT count(*)::text n FROM predicate_registry_entries
        WHERE sensitivity_class = 'sensitive'`,
    );
    expect(Number(result.rows[0]!.n)).toBe(0);
  });

  it("is idempotent: an unchanged second sync leaves the checksum untouched", async () => {
    const before = await repository.readSyncChecksum(1);
    const again = await repository.syncPredicateRegistry(V1, now);
    expect(again.entries).toBe(24);
    const after = await repository.readSyncChecksum(1);
    expect(after).toBe(before);
    expect(before).toMatch(/^[0-9a-f]{32}$/);
  });

  it("self-heals drifted rows back to the code snapshot", async () => {
    const baseline = await repository.readSyncChecksum(1);
    await schema.pool.query(
      `UPDATE predicate_localizations SET label = 'TAMPERED'
        WHERE predicate_id = $1 AND locale = 'zh' AND registry_version = 1`,
      [PREDICATE_IDS.partnerOf],
    );
    const drifted = await repository.readSyncChecksum(1);
    expect(drifted).not.toBe(baseline);
    await repository.syncPredicateRegistry(V1, now);
    expect(await repository.readSyncChecksum(1)).toBe(baseline);
  });

  it("keeps released versions isolated when another version is synced", async () => {
    const v1Before = await repository.readSyncChecksum(1);
    const legacy = buildLegacyRegistryOverlay(2);
    await repository.syncPredicateRegistry(legacy, now);
    expect(await repository.readSyncChecksum(2)).not.toBeNull();
    // old-version replay stays readable and untouched
    expect(await repository.readSyncChecksum(1)).toBe(v1Before);
    const fingerprintUnaffected =
      predicateRegistryFingerprint(loadPredicateRegistrySnapshot(1)) ===
      predicateRegistryFingerprint(V1);
    expect(fingerprintUnaffected).toBe(true);
    // clean the overlay so later assertions see only v1
    await schema.pool.query(
      "DELETE FROM predicate_relations WHERE registry_version = 2",
    );
    await schema.pool.query(
      "DELETE FROM predicate_localizations WHERE registry_version = 2",
    );
    await schema.pool.query(
      "DELETE FROM relationship_projection_localizations WHERE registry_version = 2",
    );
    await schema.pool.query(
      "DELETE FROM predicate_registry_entries WHERE registry_version = 2",
    );
  });

  it("rejects sensitive content fail-closed without writing anything", async () => {
    const before = await repository.readSyncChecksum(1);
    const poisoned: PredicateRegistrySnapshot = {
      ...V1,
      registryVersion: 9,
      entries: V1.entries.map((entry, index) =>
        index === 0
          ? { ...entry, sensitivityClass: "sensitive" as const }
          : entry,
      ),
    };
    await expect(repository.syncPredicateRegistry(poisoned, now)).rejects.toBeInstanceOf(
      SensitivePredicateError,
    );
    // v8/9 slice never appeared; v1 untouched
    expect(await repository.readSyncChecksum(9)).toBeNull();
    expect(await repository.readSyncChecksum(1)).toBe(before);
  });

  it("matches the code snapshot row-for-row on machine identity fields", async () => {
    const rows = await schema.pool.query<{
      predicate_id: string;
      status: string;
      allowed_claim_kinds: unknown[];
      sensitivity_class: string;
    }>(
      `SELECT predicate_id, status, allowed_claim_kinds, sensitivity_class
         FROM predicate_registry_entries WHERE registry_version = 1
        ORDER BY predicate_id`,
    );
    const codeById = new Map(V1.entries.map((e) => [e.predicateId, e]));
    expect(rows.rows.length).toBe(V1.entries.length);
    for (const row of rows.rows) {
      const entry = codeById.get(row.predicate_id)!;
      expect(row.status).toBe(entry.status);
      expect(row.allowed_claim_kinds).toEqual(entry.allowedClaimKinds);
      expect(row.sensitivity_class).toBe(entry.sensitivityClass);
    }
  });
});


import { describe, expect, it } from "vitest";

import {
  matchFrozenPrefixSchemaContract,
  registeredSchemaExtensions,
  ONE_A_3B_G1_SCHEMA_EXTENSION_REGISTRY_VERSION,
  ONE_A_3B_G1_SCHEMA_EXTENSIONS,
  type OneA3bG1SchemaMigrationPin,
} from "./schema-extension";

const FROZEN: readonly OneA3bG1SchemaMigrationPin[] = [
  { name: "0001_a.sql", sha256: "a".repeat(64) },
  { name: "0002_b.sql", sha256: "b".repeat(64) },
];

const EXTENSION_A: OneA3bG1SchemaMigrationPin = {
  name: "0003_c.sql",
  sha256: "c".repeat(64),
};
const EXTENSION_B: OneA3bG1SchemaMigrationPin = {
  name: "0004_d.sql",
  sha256: "d".repeat(64),
};

function match(
  applied: readonly OneA3bG1SchemaMigrationPin[],
  extensions: readonly OneA3bG1SchemaMigrationPin[],
) {
  return matchFrozenPrefixSchemaContract({ applied, expected: FROZEN, extensions });
}

describe("matchFrozenPrefixSchemaContract", () => {
  it("reproduces the exact-equality contract when no extension is registered", () => {
    expect(match(FROZEN, []).matches).toBe(true);
    expect(match([...FROZEN, EXTENSION_A], []).matches).toBe(false);
    expect(match([...FROZEN, EXTENSION_A], []).mismatch).toMatch(
      /is not a registered schema extension/,
    );
  });

  it("fails when a frozen prefix migration is missing or reordered", () => {
    expect(match([FROZEN[0]!], []).matches).toBe(false);
    expect(match([FROZEN[1]!, FROZEN[0]!], []).matches).toBe(false);
  });

  it("fails when a frozen prefix row hash drifts", () => {
    const drifted = [{ ...FROZEN[0]!, sha256: "e".repeat(64) }, FROZEN[1]!];
    const result = match(drifted, []);
    expect(result.matches).toBe(false);
    expect(result.mismatch).toMatch(/frozen prefix migration 0001_a\.sql/);
  });

  it("admits a registered extension after the exact prefix", () => {
    const result = match([...FROZEN, EXTENSION_A], [EXTENSION_A]);
    expect(result.matches).toBe(true);
    expect(result.appliedExtensions).toEqual([EXTENSION_A]);
  });

  it("admits registered extensions in lexicographic order", () => {
    const result = match([...FROZEN, EXTENSION_A, EXTENSION_B], [
      EXTENSION_A,
      EXTENSION_B,
    ]);
    expect(result.matches).toBe(true);
    expect(result.appliedExtensions).toEqual([EXTENSION_A, EXTENSION_B]);
  });

  it("keeps a pre-registered extension valid while its migration has not landed", () => {
    // The compat deployment registers A and B before B's file lands.
    expect(match([...FROZEN, EXTENSION_A], [EXTENSION_A, EXTENSION_B]).matches).toBe(
      true,
    );
    expect(match(FROZEN, [EXTENSION_A, EXTENSION_B]).matches).toBe(true);
  });

  it("fails on an unregistered extra, a hash-drifted extra, or a reordered extra", () => {
    expect(match([...FROZEN, EXTENSION_A], []).matches).toBe(false);
    expect(match([...FROZEN, EXTENSION_A], [EXTENSION_B]).matches).toBe(false);
    expect(
      match([...FROZEN, EXTENSION_A], [
        { name: EXTENSION_A.name, sha256: "f".repeat(64) },
      ]).matches,
    ).toBe(false);
    expect(
      match([...FROZEN, EXTENSION_B, EXTENSION_A], [EXTENSION_A, EXTENSION_B])
        .matches,
    ).toBe(false);
  });

  it("fails closed on an unsorted, duplicated, or malformed registry", () => {
    expect(match(FROZEN, [EXTENSION_B, EXTENSION_A]).matches).toBe(false);
    expect(match(FROZEN, [EXTENSION_A, EXTENSION_A]).matches).toBe(false);
    expect(match(FROZEN, [{ name: "not-a-migration", sha256: "a".repeat(64) }]).matches).toBe(
      false,
    );
  });
});

describe("registered G1 schema extensions", () => {
  it("is versioned and registers the additive recent-context and history-recall migrations", () => {
    expect(ONE_A_3B_G1_SCHEMA_EXTENSION_REGISTRY_VERSION).toBe(
      "1a3b-g1-schema-extensions:v1",
    );
    expect(ONE_A_3B_G1_SCHEMA_EXTENSIONS.map((pin) => pin.name)).toEqual([
      "0068_recent_conversation_context_refs.sql",
      "0069_recent_context_request_timezone.sql",
      "0070_recent_context_governance.sql",
      "0071_history_answer_generation_stage.sql",
      "0072_history_recall_results.sql",
      "0075_history_experience_search_refs.sql",
      "0080_conversation_request_lifecycle.sql",
      "0081_history_recall_governance.sql",
      "0082_journal_workflow_recovery.sql",
    ]);
    expect(registeredSchemaExtensions("business")).toEqual(
      ONE_A_3B_G1_SCHEMA_EXTENSIONS,
    );
    expect(registeredSchemaExtensions("business")[0]?.sha256).toBe(
      "8984556a9578c2badc662e361df62bf8607b326b9075208346d1d5f63765015d",
    );
  });

  it("registers no purge-marker extension, so that store stays exact", () => {
    expect(registeredSchemaExtensions("purge-marker")).toEqual([]);
  });

  it("is well-formed, sorted, unique and hash-pinned", () => {
    const names = ONE_A_3B_G1_SCHEMA_EXTENSIONS.map((pin) => pin.name);
    expect(new Set(names).size).toBe(names.length);
    for (const pin of ONE_A_3B_G1_SCHEMA_EXTENSIONS) {
      expect(pin.sha256).toMatch(/^[a-f0-9]{64}$/);
      expect(pin.justification.length).toBeGreaterThan(0);
    }
  });

  it("rejects a purge-marker migration name offered to the business store", () => {
    // A real purge-marker filename is not a registered business extension, so
    // it can never be admitted into the business applied list.
    const purgeMarkerName: OneA3bG1SchemaMigrationPin = {
      name: "0001_purge_marker.sql",
      sha256: "a".repeat(64),
    };
    const businessExtensions = registeredSchemaExtensions("business").map(
      (pin) => ({ name: pin.name, sha256: pin.sha256 }),
    );
    const result = matchFrozenPrefixSchemaContract({
      applied: [...FROZEN, purgeMarkerName],
      expected: FROZEN,
      extensions: businessExtensions,
    });
    expect(result.matches).toBe(false);
    expect(result.mismatch).toMatch(/not a registered schema extension/);
  });
});

describe("canonical migration-name ordering", () => {
  it("orders applied extensions by code unit across an underscore/digit boundary", () => {
    // '_' is U+005F and '0' is U+0030, so by code unit `_0...` sorts before
    // `__...`. A locale collation is free to order these differently; the
    // matcher must use the deterministic canonical order.
    const digit = { name: "0001_0a.sql", sha256: "a".repeat(64) };
    const underscore = { name: "0001__a.sql", sha256: "b".repeat(64) };

    const sorted = match([...FROZEN, digit, underscore], [digit, underscore]);
    expect(sorted.matches).toBe(true);

    const reversed = match([...FROZEN, underscore, digit], [digit, underscore]);
    expect(reversed.matches).toBe(false);
    expect(reversed.mismatch).toMatch(/not in lexicographic order/);

    // The registry must also be authored in canonical order.
    const unsortedRegistry = match(FROZEN, [underscore, digit]);
    expect(unsortedRegistry.matches).toBe(false);
    expect(unsortedRegistry.mismatch).toMatch(/not sorted by name/);
  });
});

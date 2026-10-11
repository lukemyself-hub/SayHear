/**
 * Versioned, hash-pinned schema-extension admission for the frozen G1
 * migration contract.
 *
 * The accepted G1 release manifest freezes one exact, ordered list of migration
 * pins. A later, purely additive migration (a new table, a new index, a new
 * nullable column) must not force the accepted manifest to be re-frozen or take
 * G1 admission down while the migration-carrying deployment rolls out. This
 * module admits such migrations as registered extensions of that frozen prefix:
 *
 *   - `applied[0..n)` must equal the frozen manifest prefix exactly in order and
 *     SHA-256;
 *   - `applied.length` must be at least `n`;
 *   - every applied row beyond the prefix must be a registered extension for the
 *     same store, in lexicographic name order, with the registered name and
 *     SHA-256;
 *   - an extension may be pre-registered before its migration file lands, so
 *     the compatibility deployment can precede the migration-carrying one;
 *   - an empty extension list reproduces the previous exact-equality contract
 *     byte for byte.
 *
 * This is deliberately not a generic SQL taxonomy. The protected-surface
 * deny-list lives in the CI guard (`scripts/check-schema-extensions.ts`), which
 * is the only other consumer.
 */

export const ONE_A_3B_G1_SCHEMA_EXTENSION_REGISTRY_VERSION =
  "1a3b-g1-schema-extensions:v1" as const;

/** The independent migration stores a G1 manifest freezes. */
export type OneA3bG1SchemaStore = "business" | "purge-marker";

export type OneA3bG1SchemaMigrationPin = Readonly<{
  name: string;
  sha256: string;
}>;

export type OneA3bG1SchemaExtensionPin = Readonly<{
  store: OneA3bG1SchemaStore;
  name: string;
  sha256: string;
  /**
   * Why this additive migration is admissible without touching a protected
   * surface. Recorded so the promotion/release report can state it truthfully;
   * never used to weaken a check.
   */
  justification: string;
}>;

const MIGRATION_NAME_PATTERN = /^\d{4}_[a-z0-9_]+\.sql$/;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;

/**
 * Canonical code-unit ordering for migration filenames.
 *
 * `localeCompare` is locale-sensitive, so it can order `_` against a digit or
 * letter differently from PostgreSQL's `ORDER BY`. Migration filenames are
 * ASCII, so UTF-16 code-unit comparison is the deterministic order that matches
 * the SQL sort and never disagrees with the applied list under a non-C
 * collation.
 */
function compareCanonicalNames(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

/**
 * The additive migrations admitted on top of the accepted G1 frozen prefix.
 *
 * #293/#294 (0068/0069) and #295 (0070) are business-side, purely additive:
 * one nullable request-timezone column on `generation_commands`, one owner +
 * created-at index on `conversation_events`, and one new global governance
 * table. None of them rewrites a model-role column, a provider-egress policy, a
 * workflow command row, or a Purge order/marker. The Purge Marker store needs no
 * extension.
 */
export const ONE_A_3B_G1_SCHEMA_EXTENSIONS: readonly OneA3bG1SchemaExtensionPin[] =
  Object.freeze([
    Object.freeze({
      store: "business" as const,
      name: "0068_recent_conversation_context_refs.sql",
      sha256: "8984556a9578c2badc662e361df62bf8607b326b9075208346d1d5f63765015d",
      justification:
        "Adds nullable revision-ref metadata columns, a composite owner/session foreign key and a lineage trigger on the owner-scoped compiled_context_revision_refs (migration #293). It names no protected relation.",
    }),
    Object.freeze({
      store: "business" as const,
      name: "0069_recent_context_request_timezone.sql",
      sha256: "45b9f606ad28c62e99826e635b83b8d9a16ec032a2073f14bbbb02382f9cf42b",
      justification:
        "Adds the nullable generation_commands.request_timezone TEXT column and the conversation_events_recent_context_idx index (migration #294). No protected column is rewritten.",
    }),
    Object.freeze({
      store: "business" as const,
      name: "0070_recent_context_governance.sql",
      sha256: "3468342de597d7c5151586f11bc1c2baaa454c71b0ae3ea78bf9e91542ad72f7",
      justification:
        "Creates the content-free, non-owner-scoped recent_context_policies governance table (migration #295). It carries no user_id and is outside the owner Full Purge Surface Registry.",
    }),
    Object.freeze({
      store: "business" as const,
      name: "0071_history_answer_generation_stage.sql",
      sha256: "781b17348c5ca58714e00c9f8bbb2ca1eec587e0319d45da7bd7b779a894b30f",
      justification:
        "Widens the generation_commands.generation_stage CHECK by exactly the history_answer value (issue #314, ADR-0094). The only admitted protected-surface rewrite: scripts/check-schema-extensions.ts accepts this single DROP/ADD of that named constraint when the re-added set is the frozen stages plus history_answer, and nothing else; every pre-existing stage stays valid.",
    }),
    Object.freeze({
      store: "business" as const,
      name: "0072_history_recall_results.sql",
      sha256: "fca7455ab3fbd289889f4879929f308e1f6e10c8c0c1439af060c863f71306f4",
      justification:
        "Creates the owner-scoped history_recall_results table (references and content-free coverage only, no message bodies, no foreign key to a protected relation) and extends the compiled_context_revision_refs section and metadata constraints and lineage trigger for the history_recall_context section (issue #314). It names no protected relation; the table is registered in the Purge Surface Registry.",
    }),
    Object.freeze({
      store: "business" as const,
      name: "0080_conversation_request_lifecycle.sql",
      sha256: "94b6e1da6f6c2a8fbaf383d582b41109afa3f4ff3e7cfdb3661be0a6038b616e",
      justification:
        "Adds two nullable columns to generation_commands: request_deadline_at (the end-to-end deadline frozen at acceptance) and latest_input_fence_version (the named newest-user-input freshness rule), issue #319. Additive ADD COLUMN only; freshness_policy and every existing constraint are untouched.",
    }),
  ]);

/** Registered extension pins for one store, in registry order. */
export function registeredSchemaExtensions(
  store: OneA3bG1SchemaStore,
): readonly OneA3bG1SchemaExtensionPin[] {
  return ONE_A_3B_G1_SCHEMA_EXTENSIONS.filter((entry) => entry.store === store);
}

export type SchemaContractMatch = Readonly<{
  matches: boolean;
  /** Populated only on failure; the caller keeps its existing frozen-contract error. */
  mismatch: string | null;
  /** The applied rows beyond the frozen prefix, for truthful reporting. */
  appliedExtensions: readonly OneA3bG1SchemaMigrationPin[];
}>;

function failure(
  mismatch: string,
  appliedExtensions: readonly OneA3bG1SchemaMigrationPin[] = [],
): SchemaContractMatch {
  return { matches: false, mismatch, appliedExtensions };
}

/**
 * Match an applied migration list against a frozen manifest prefix plus the
 * registered extensions for a store. Pure and synchronous so the same rule is
 * exercised by the repositories and by unit tests.
 */
export function matchFrozenPrefixSchemaContract(input: Readonly<{
  expected: readonly OneA3bG1SchemaMigrationPin[];
  applied: readonly OneA3bG1SchemaMigrationPin[];
  extensions: readonly OneA3bG1SchemaMigrationPin[];
}>): SchemaContractMatch {
  const { expected, applied, extensions } = input;

  if (applied.length < expected.length) {
    return failure("applied migration set is shorter than the frozen prefix");
  }
  for (const [index, pin] of expected.entries()) {
    const row = applied[index];
    if (!row || row.name !== pin.name || row.sha256 !== pin.sha256) {
      return failure(`frozen prefix migration ${pin.name} does not match`);
    }
  }

  // The registry itself must be well-formed: unique, sorted, hashed filenames.
  const sortedExtensions = [...extensions].sort((left, right) =>
    compareCanonicalNames(left.name, right.name),
  );
  for (const [index, pin] of extensions.entries()) {
    if (sortedExtensions[index]?.name !== pin.name) {
      return failure("registered schema extensions are not sorted by name");
    }
    if (!MIGRATION_NAME_PATTERN.test(pin.name)) {
      return failure(`registered schema extension ${pin.name} has an invalid filename`);
    }
    if (!SHA256_PATTERN.test(pin.sha256)) {
      return failure(`registered schema extension ${pin.name} has an invalid SHA-256`);
    }
    if (index > 0 && extensions[index - 1]?.name === pin.name) {
      return failure(`registered schema extension ${pin.name} is listed more than once`);
    }
  }

  const registeredByName = new Map(
    extensions.map((pin) => [pin.name, pin] as const),
  );
  const appliedExtensions: OneA3bG1SchemaMigrationPin[] = [];
  let previousName: string | null = null;
  for (const row of applied.slice(expected.length)) {
    if (
      previousName !== null &&
      compareCanonicalNames(row.name, previousName) <= 0
    ) {
      return failure("applied schema extensions are not in lexicographic order");
    }
    previousName = row.name;
    const registered = registeredByName.get(row.name);
    if (!registered || registered.sha256 !== row.sha256) {
      return failure(
        `applied migration ${row.name} is not a registered schema extension for this store`,
      );
    }
    appliedExtensions.push({ name: row.name, sha256: row.sha256 });
  }

  return { matches: true, mismatch: null, appliedExtensions };
}

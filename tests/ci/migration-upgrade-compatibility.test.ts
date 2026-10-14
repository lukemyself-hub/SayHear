/**
 * Migration upgrade-compatibility drill.
 *
 * The accepted G1 schema contract admits new migrations only as registered,
 * additive extensions of a frozen prefix. This test proves the property that
 * the registry alone cannot: a database upgraded from the base commit's
 * migrations to the head tree's migrations ends up catalog-equivalent to a
 * fresh install of the head tree.
 *
 * Why the prefix comes from the base commit, not the head tree: deriving the
 * "frozen prefix" as "every head file minus the registered extensions" would
 * silently fold a modified or unregistered migration into the prefix, and then
 * both sides of the comparison would be built from the same bytes and agree
 * trivially. There is no committed frozen manifest, so the base commit, what
 * `main` actually ships, is the only in-run source of truth for the prefix.
 *
 * This file never skips. A missing database, an unresolvable base commit, or a
 * changed migration fails the run; the controller rejects the whole report when
 * any test is skipped, so a vacuous pass is not an option.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type { Pool } from "pg";
import { describe, expect, it } from "vitest";

import {
  matchFrozenPrefixSchemaContract,
  registeredSchemaExtensions,
  type OneA3bG1SchemaMigrationPin,
  type OneA3bG1SchemaStore,
} from "@sayhear/application";
import { runMigrations } from "@sayhear/data";
import { createIsolatedPostgresSchema } from "@sayhear/test-support";

import { SCHEMA_EXTENSION_STORE_DIRECTORIES } from "../../scripts/check-schema-extensions.ts";

const REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

const STORES: readonly OneA3bG1SchemaStore[] = ["business", "purge-marker"];

/** The isolated temporary database each store's drill runs against. */
const STORE_TEST_DATABASE_URLS: Readonly<Record<OneA3bG1SchemaStore, string | undefined>> =
  {
    business: process.env.TEST_DATABASE_URL,
    "purge-marker": process.env.TEST_PURGE_MARKER_DATABASE_URL,
  };

const STORE_TEST_DATABASE_VARIABLES: Readonly<Record<OneA3bG1SchemaStore, string>> = {
  business: "TEST_DATABASE_URL",
  "purge-marker": "TEST_PURGE_MARKER_DATABASE_URL",
};

function runGitCommand(arguments_: readonly string[]): string {
  return execFileSync("git", arguments_, {
    cwd: REPOSITORY_ROOT,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function readGitBlob(arguments_: readonly string[]): Buffer {
  return execFileSync("git", arguments_, {
    cwd: REPOSITORY_ROOT,
    maxBuffer: 64 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function sha256Bytes(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function readPullRequestBaseSha(eventPath: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(eventPath, "utf8"));
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const base = (parsed as { pull_request?: { base?: { sha?: unknown } } })
    .pull_request?.base;
  const sha = base?.sha;
  return typeof sha === "string" && sha.trim().length > 0 ? sha.trim() : null;
}

function resolveMergeBase(): string | null {
  // The pull_request checkout is the merge ref, so `HEAD` contains the base
  // branch head as its first parent. `refs/remotes/origin/main` is the contract
  // reference; the short names are tried only so an operator checkout without
  // that exact ref can still run the drill.
  for (const reference of ["refs/remotes/origin/main", "origin/main", "main"]) {
    try {
      const mergeBase = runGitCommand(["merge-base", "HEAD", reference]);
      if (mergeBase.length > 0) return mergeBase;
    } catch {
      // The reference is absent in this checkout; try the next one.
    }
  }
  return null;
}

function resolveBaseCommit(): string {
  const explicit = process.env.SAYHEAR_MIGRATION_BASE_SHA?.trim();
  if (explicit !== undefined && explicit.length > 0) return explicit;

  const eventPath = process.env.GITHUB_EVENT_PATH?.trim();
  if (eventPath !== undefined && eventPath.length > 0) {
    const fromEvent = readPullRequestBaseSha(eventPath);
    if (fromEvent !== null) return fromEvent;
  }

  const mergeBase = resolveMergeBase();
  if (mergeBase !== null) return mergeBase;

  throw new Error(
    "The migration upgrade drill cannot resolve a base commit: set " +
      "SAYHEAR_MIGRATION_BASE_SHA, provide GITHUB_EVENT_PATH with " +
      "pull_request.base.sha, or check out a branch whose base is reachable " +
      "from refs/remotes/origin/main. This drill fails rather than skips.",
  );
}

type PinnedMigrationFile = Readonly<{
  pin: OneA3bG1SchemaMigrationPin;
  bytes: Buffer;
}>;

/** The `.sql` pins of one migration directory inside a commit's tree. */
function readCommitMigrationFiles(
  commit: string,
  directory: string,
): readonly PinnedMigrationFile[] {
  const names = runGitCommand(["ls-tree", "--name-only", `${commit}:${directory}`])
    .split("\n")
    .map((name) => name.trim())
    .filter((name) => name.endsWith(".sql"))
    .sort();
  return names.map((name) => {
    const bytes = readGitBlob(["cat-file", "blob", `${commit}:${directory}/${name}`]);
    return { pin: { name, sha256: sha256Bytes(bytes) }, bytes };
  });
}

/** The `.sql` pins of the head working tree, which is what `runMigrations` reads. */
async function readHeadMigrationPins(
  directory: string,
): Promise<readonly OneA3bG1SchemaMigrationPin[]> {
  const names = (await readdir(directory))
    .filter((name) => name.endsWith(".sql"))
    .sort();
  return Promise.all(
    names.map(async (name) => {
      const bytes = await readFile(join(directory, name));
      return { name, sha256: sha256Bytes(bytes) };
    }),
  );
}

async function readAppliedPins(pool: Pool): Promise<readonly OneA3bG1SchemaMigrationPin[]> {
  const result = await pool.query<{ migration_name: string; migration_sha256: string }>(
    "SELECT migration_name, migration_sha256 FROM schema_migrations ORDER BY migration_name",
  );
  return result.rows.map((row) => ({
    name: row.migration_name,
    sha256: row.migration_sha256,
  }));
}

/**
 * Every catalog category the parity claim is allowed to rest on. `information_schema`
 * cannot see CHECK rewrites or triggers, so the queries read `pg_catalog`
 * directly: relations, columns (type, nullability, default), constraints,
 * indexes, triggers, functions, types, enums and views.
 */
const CATALOG_QUERIES: Readonly<Record<string, string>> = Object.freeze({
  relations: `
    SELECT c.relname AS name, c.relkind AS kind, c.relpersistence AS persistence
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = $1 AND c.relkind IN ('r', 'p', 'v', 'm', 'S', 'f')
    ORDER BY 1, 2`,
  columns: `
    SELECT c.relname AS relation, a.attname AS name, a.attnum AS position,
           format_type(a.atttypid, a.atttypmod) AS data_type,
           a.attnotnull AS not_null, a.attidentity AS identity,
           a.attgenerated AS generated,
           COALESCE(pg_get_expr(d.adbin, d.adrelid), '') AS default_expression
    FROM pg_attribute a
    JOIN pg_class c ON c.oid = a.attrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
    WHERE n.nspname = $1 AND a.attnum > 0 AND NOT a.attisdropped
      AND c.relkind IN ('r', 'p', 'v', 'm', 'f')
    ORDER BY 1, a.attnum`,
  constraints: `
    SELECT c.relname AS relation, con.conname AS name, con.contype AS type,
           pg_get_constraintdef(con.oid) AS definition
    FROM pg_constraint con
    JOIN pg_class c ON c.oid = con.conrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = $1
    ORDER BY 1, 2`,
  indexes: `
    SELECT c.relname AS relation, i.relname AS name, x.indisprimary AS is_primary,
           x.indisunique AS is_unique, pg_get_indexdef(x.indexrelid) AS definition
    FROM pg_index x
    JOIN pg_class c ON c.oid = x.indrelid
    JOIN pg_class i ON i.oid = x.indexrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = $1
    ORDER BY 1, 2`,
  triggers: `
    SELECT c.relname AS relation, t.tgname AS name, t.tgenabled AS enabled,
           pg_get_triggerdef(t.oid) AS definition
    FROM pg_trigger t
    JOIN pg_class c ON c.oid = t.tgrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = $1 AND NOT t.tgisinternal
    ORDER BY 1, 2`,
  functions: `
    SELECT p.proname AS name,
           pg_get_function_identity_arguments(p.oid) AS arguments,
           pg_get_function_result(p.oid) AS result, l.lanname AS language,
           p.provolatile AS volatility, p.prosecdef AS security_definer,
           p.proisstrict AS is_strict,
           COALESCE(array_to_string(p.proconfig, ','), '') AS configuration,
           p.prosrc AS source
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    JOIN pg_language l ON l.oid = p.prolang
    WHERE n.nspname = $1 AND p.prokind IN ('f', 'p')
    ORDER BY 1, 2`,
  types: `
    SELECT t.typname AS name, t.typtype AS type, t.typcategory AS category,
           format_type(t.typbasetype, t.typtypmod) AS base_type,
           t.typnotnull AS not_null,
           COALESCE(t.typdefault, '') AS default_expression,
           COALESCE((SELECT coll.collname FROM pg_collation coll
                     WHERE coll.oid = t.typcollation), '') AS collation
    FROM pg_type t
    JOIN pg_namespace n ON n.oid = t.typnamespace
    WHERE n.nspname = $1 AND t.typtype IN ('e', 'd', 'c', 'm', 'r')
    ORDER BY 1, 2`,
  enums: `
    SELECT t.typname AS name, e.enumlabel AS label, e.enumsortorder AS sort_order
    FROM pg_enum e
    JOIN pg_type t ON t.oid = e.enumtypid
    JOIN pg_namespace n ON n.oid = t.typnamespace
    WHERE n.nspname = $1
    ORDER BY 1, e.enumsortorder`,
  views: `
    SELECT c.relname AS name, c.relkind AS kind,
           pg_get_viewdef(c.oid, true) AS definition
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = $1 AND c.relkind IN ('v', 'm')
    ORDER BY 1`,
});

type CatalogDigest = Readonly<{
  digest: string;
  catalog: Readonly<Record<string, readonly unknown[]>>;
}>;

/**
 * Drop the isolated schema's own name from every catalog string, so the digest
 * compares only the shape the migrations built. The name can appear in
 * deparsed defaults or definitions even when the SQL is unqualified.
 */
function normalizeSchemaName(value: unknown, schema: string): unknown {
  if (typeof value === "string") return value.split(schema).join("<schema>");
  if (Array.isArray(value)) {
    return value.map((entry) => normalizeSchemaName(entry, schema));
  }
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, entry]) => [
        key,
        normalizeSchemaName(entry, schema),
      ]),
    );
  }
  return value;
}

async function catalogDigest(pool: Pool): Promise<CatalogDigest> {
  const schemaResult = await pool.query<{ current_schema_name: string | null }>(
    "SELECT current_schema() AS current_schema_name",
  );
  const schema = schemaResult.rows[0]?.current_schema_name;
  if (schema === undefined || schema === null) {
    throw new Error("The isolated schema reported no current_schema(); no catalog to compare.");
  }
  const catalog: Record<string, readonly unknown[]> = {};
  for (const [category, sql] of Object.entries(CATALOG_QUERIES)) {
    const result = await pool.query<Record<string, unknown>>(sql, [schema]);
    catalog[category] = normalizeSchemaName(result.rows, schema) as readonly unknown[];
  }
  return {
    digest: createHash("sha256").update(JSON.stringify(catalog)).digest("hex"),
    catalog,
  };
}

async function assertUpgradeMatchesFreshInstall(
  store: OneA3bG1SchemaStore,
  baseCommit: string,
): Promise<void> {
  const connectionString = STORE_TEST_DATABASE_URLS[store];
  if (connectionString === undefined || connectionString.trim().length === 0) {
    throw new Error(
      `${STORE_TEST_DATABASE_VARIABLES[store]} is required for the migration ` +
        `upgrade drill (${store}); the drill fails rather than skips.`,
    );
  }

  const relativeDirectory = SCHEMA_EXTENSION_STORE_DIRECTORIES[store];
  const headDirectory = join(REPOSITORY_ROOT, relativeDirectory);
  const extensions = registeredSchemaExtensions(store);
  const extensionByName = new Map(
    extensions.map((extension) => [extension.name, extension] as const),
  );

  // (2) List the store's `.sql` pins at base and at head.
  const baseFiles = readCommitMigrationFiles(baseCommit, relativeDirectory);
  const headPins = await readHeadMigrationPins(headDirectory);
  expect(baseFiles.length).toBeGreaterThan(0);

  // (3) File identity: no base file may change, disappear or be renamed, and
  // every head-only file must be a registered schema extension with the exact
  // name and SHA-256 the registry records.
  const headByName = new Map(headPins.map((pin) => [pin.name, pin.sha256] as const));
  for (const { pin } of baseFiles) {
    expect({ name: pin.name, sha256: headByName.get(pin.name) ?? null }).toEqual({
      name: pin.name,
      sha256: pin.sha256,
    });
  }
  const baseNames = new Set(baseFiles.map(({ pin }) => pin.name));
  for (const pin of headPins) {
    if (baseNames.has(pin.name)) continue;
    const registered = extensionByName.get(pin.name);
    expect(
      registered === undefined ? null : { name: registered.name, sha256: registered.sha256 },
    ).toEqual({ name: pin.name, sha256: pin.sha256 });
  }

  const schemaA = await createIsolatedPostgresSchema(connectionString);
  const schemaB = await createIsolatedPostgresSchema(connectionString);
  try {
    // (4) Schema A: the base commit's bytes, applied through the real migrator.
    const baseDirectory = await mkdtemp(
      join(tmpdir(), `sayhear-migration-upgrade-${store}-`),
    );
    try {
      for (const { pin, bytes } of baseFiles) {
        await writeFile(join(baseDirectory, pin.name), bytes);
      }
      await runMigrations(schemaA.pool, { migrationsDirectory: baseDirectory });
      expect(await readAppliedPins(schemaA.pool)).toEqual(
        baseFiles.map(({ pin }) => pin),
      );
    } finally {
      await rm(baseDirectory, { recursive: true, force: true });
    }

    // (5) Schema A: apply the head migrations on top of the frozen prefix.
    await runMigrations(schemaA.pool, { migrationsDirectory: headDirectory });
    const upgraded = await readAppliedPins(schemaA.pool);
    const match = matchFrozenPrefixSchemaContract({
      expected: baseFiles.map(({ pin }) => pin),
      applied: upgraded,
      extensions: extensions.map(({ name, sha256 }) => ({ name, sha256 })),
    });
    expect({ matches: match.matches, mismatch: match.mismatch }).toEqual({
      matches: true,
      mismatch: null,
    });

    // (6) Schema B: a fresh install from the head bytes.
    await runMigrations(schemaB.pool, { migrationsDirectory: headDirectory });
    const fresh = await readAppliedPins(schemaB.pool);
    expect(upgraded).toEqual(fresh);

    const upgradedCatalog = await catalogDigest(schemaA.pool);
    const freshCatalog = await catalogDigest(schemaB.pool);
    expect({
      digest: upgradedCatalog.digest,
      catalog: upgradedCatalog.catalog,
    }).toEqual({ digest: freshCatalog.digest, catalog: freshCatalog.catalog });
  } finally {
    // (7) Dispose both isolated schemas, pass or fail.
    await schemaA.dispose();
    await schemaB.dispose();
  }
}

// Resolved once, at collection time: an unresolvable base commit must fail the
// file rather than let the assertions silently compare head against head.
const BASE_COMMIT = resolveBaseCommit();

describe("migration upgrade path equals a fresh install", () => {
  for (const store of STORES) {
    it(
      `${store}: base -> head upgrade equals a fresh install`,
      async () => {
        await assertUpgradeMatchesFreshInstall(store, BASE_COMMIT);
      },
      180_000,
    );
  }
});

/**
 * G1 schema-extension admission guard.
 *
 * The runtime matcher (`matchFrozenPrefixSchemaContract`) admits additive
 * migrations that are registered on top of the accepted frozen prefix. This CI
 * guard keeps that registry honest:
 *
 *   - file-hash check: every registered extension whose migration file is
 *     present must hash to its registered SHA-256. A pre-registered entry whose
 *     file has not landed yet (the compatibility deployment precedes the
 *     migration-carrying one) is reported `pending` and is not a failure.
 *   - protected-surface DDL deny-list: a registered extension may only add a
 *     nullable column to, or create an index on, a protected relation. Anything
 *     that drops, truncates, deletes, updates, renames, or otherwise mutates a
 *     protected relation fails closed.
 *
 * Precise scope: the guarantee covers only the registered extension files, and
 * only statements that name one of the listed relations. An unregistered
 * migration file is not inspected here; it is refused fail-closed by the
 * runtime schema-contract matcher at G1 admission.
 *
 * No database, no network and no secret: it reads the committed SQL files and
 * the registry in code.
 */
import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import {
  ONE_A_3B_G1_SCHEMA_EXTENSIONS,
  type OneA3bG1SchemaExtensionPin,
  type OneA3bG1SchemaStore,
} from "@sayhear/application";

/** The repository directory that holds each store's migration files. */
export const SCHEMA_EXTENSION_STORE_DIRECTORIES: Readonly<
  Record<OneA3bG1SchemaStore, string>
> = Object.freeze({
  business: "packages/data/migrations",
  "purge-marker": "packages/data/migrations-purge-marker",
});

/**
 * Relations whose shape the accepted G1 release already froze. A purely
 * additive extension must not rewrite them beyond a nullable column or an
 * index; the deny-list makes a destructive change fail in CI rather than at
 * G1 admission.
 */
export const PROTECTED_SCHEMA_RELATIONS: readonly string[] = Object.freeze([
  "generation_commands",
  "model_role_configurations",
  "model_role_definitions",
  "model_role_rollout_pins",
  "provider_egress_policy_versions",
  "provider_egress_consents",
  "provider_egress_dispositions",
  "workflow_commands",
  "owner_purge_orders",
  "owner_purge_receipts",
  "owner_purge_operational_metadata",
  "purge_markers",
  "schema_migrations",
]);

const DESTRUCTIVE_KEYWORDS = /\b(drop|truncate|delete|update|insert|rename)\b/i;
const ADD_COLUMN =
  /^alter\s+table\s+(?:only\s+)?([a-z_][a-z0-9_]*)\s+add\s+column\s+/i;
const CREATE_INDEX = /^create\s+(?:unique\s+)?index\b/i;
const INDEX_ON_RELATION = /\bon\s+(?:only\s+)?([a-z_][a-z0-9_]*)\b/i;
// `NOT NULL` is not the only way a column addition becomes mandatory:
// `PRIMARY KEY` and `GENERATED ... AS IDENTITY` both imply NOT NULL.
const IMPLIED_NOT_NULL = /\bprimary\s+key\b|\bgenerated\b[\s\S]*?\bas\s+identity\b/i;

function stripSqlComments(sql: string): string {
  return sql.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/--[^\n]*/g, " ");
}

/**
 * Whether a statement names a protected relation.
 *
 * Matches the relation as a whole word and as the leading segment of an
 * identifier (`<relation>_...`), so a `DROP INDEX
 * model_role_definitions_role_idx` is attributed to its protected table even
 * though PostgreSQL index names carry no `ON` clause. This is deliberately
 * fail-closed: an unrelated identifier that merely starts with a protected
 * relation name is treated as touching it.
 */
function referencesProtectedRelation(
  statement: string,
  relation: string,
): boolean {
  return new RegExp(`\\b${relation}(?![a-z0-9])`, "i").test(statement);
}

/**
 * Every protected-surface violation in one registered extension file. Empty when
 * the file only adds a nullable column or creates an index.
 */
export function protectedSurfaceDdlViolations(
  fileName: string,
  sql: string,
): readonly string[] {
  const violations: string[] = [];
  const statements = stripSqlComments(sql)
    .split(";")
    .map((statement) => statement.replace(/\s+/g, " ").trim())
    .filter((statement) => statement.length > 0);

  for (const statement of statements) {
    const touched = PROTECTED_SCHEMA_RELATIONS.filter((relation) =>
      referencesProtectedRelation(statement, relation),
    );
    if (touched.length === 0) continue;

    const targets = touched.join(", ");
    if (DESTRUCTIVE_KEYWORDS.test(statement)) {
      violations.push(
        `${fileName}: destructive or mutating DDL touches protected surface ${targets}: ${statement}`,
      );
      continue;
    }
    const alterTarget = ADD_COLUMN.exec(statement)?.[1]?.toLowerCase();
    if (alterTarget && touched.includes(alterTarget)) {
      if (
        /\bnot\s+null\b/i.test(statement) ||
        IMPLIED_NOT_NULL.test(statement)
      ) {
        violations.push(
          `${fileName}: protected-surface column addition must be nullable (${targets}): ${statement}`,
        );
      }
      continue;
    }
    if (CREATE_INDEX.test(statement)) {
      // Only an index that actually targets a protected relation is an
      // additive protected-surface change; a protected name appearing
      // elsewhere (for example as the index name) stays fail-closed.
      const indexTarget = INDEX_ON_RELATION.exec(statement)?.[1]?.toLowerCase();
      if (indexTarget && touched.includes(indexTarget)) continue;
      violations.push(
        `${fileName}: index statement touches protected surface ${targets} without targeting it: ${statement}`,
      );
      continue;
    }
    violations.push(
      `${fileName}: only an additive nullable column or an index may touch protected surface ${targets}: ${statement}`,
    );
  }
  return violations;
}

export type SchemaExtensionGuardIo = Readonly<{
  repositoryRoot: string;
  readFile: (path: string) => Promise<string>;
  fileExists: (path: string) => Promise<boolean>;
}>;

export type SchemaExtensionGuardResult = Readonly<{
  ok: boolean;
  lines: readonly string[];
  failures: readonly string[];
  appliedExtensions: readonly OneA3bG1SchemaExtensionPin[];
  pendingExtensions: readonly OneA3bG1SchemaExtensionPin[];
}>;

export function shellSchemaExtensionGuardIo(
  repositoryRoot: string,
): SchemaExtensionGuardIo {
  return {
    repositoryRoot,
    readFile: (path) => readFile(path, "utf8"),
    fileExists: async (path) => {
      try {
        await stat(path);
        return true;
      } catch {
        return false;
      }
    },
  };
}

function sha256Text(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

/**
 * Run the guard against the registry, reading the committed files through the
 * injected IO so the behavior is unit-testable without a checkout.
 */
export async function runSchemaExtensionGuard(
  io: SchemaExtensionGuardIo,
  extensions: readonly OneA3bG1SchemaExtensionPin[] = ONE_A_3B_G1_SCHEMA_EXTENSIONS,
): Promise<SchemaExtensionGuardResult> {
  const failures: string[] = [];
  const lines: string[] = [];
  const landed: OneA3bG1SchemaExtensionPin[] = [];
  const pending: OneA3bG1SchemaExtensionPin[] = [];

  for (const extension of extensions) {
    const directory = SCHEMA_EXTENSION_STORE_DIRECTORIES[extension.store];
    const path = join(io.repositoryRoot, directory, extension.name);
    if (!(await io.fileExists(path))) {
      pending.push(extension);
      lines.push(
        `pending ${extension.store} ${extension.name}: registered, migration file not landed`,
      );
      continue;
    }
    landed.push(extension);
    const sql = await io.readFile(path);
    const actual = sha256Text(sql);
    if (actual !== extension.sha256) {
      failures.push(
        `${extension.name}: registered SHA-256 ${extension.sha256} does not match the file hash ${actual}`,
      );
      continue;
    }
    lines.push(`verified ${extension.store} ${extension.name} (${extension.sha256})`);
    const violations = protectedSurfaceDdlViolations(extension.name, sql);
    failures.push(...violations);
  }

  return {
    ok: failures.length === 0,
    lines,
    failures,
    appliedExtensions: landed,
    pendingExtensions: pending,
  };
}

async function main(): Promise<void> {
  const result = await runSchemaExtensionGuard(
    shellSchemaExtensionGuardIo(resolve(process.cwd())),
  );
  for (const line of result.lines) console.log(`[schema-extensions] ${line}`);
  if (!result.ok) {
    for (const failure of result.failures) {
      console.error(`[schema-extensions] ${failure}`);
    }
    throw new Error(
      `Schema-extension guard rejected ${result.failures.length} finding(s).`,
    );
  }
  console.log(
    `[schema-extensions] ${result.appliedExtensions.length} verified, ${result.pendingExtensions.length} pending`,
  );
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main().catch((error: unknown) => {
    console.error(
      `[schema-extensions] ${error instanceof Error ? error.message : "guard failed"}`,
    );
    process.exitCode = 1;
  });
}

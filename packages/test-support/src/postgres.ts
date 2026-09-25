import { randomUUID } from "node:crypto";

import { asUserId } from "@sayhear/domain";
import { Pool } from "pg";

export const TEST_SCHEMA_PREFIX = "sayhear_test_" as const;

const TEST_SCHEMA_NAME_PATTERN = /^sayhear_test_[0-9a-f]{32}$/;
const TEST_SCHEMA_CLEANUP_BATCH_SIZE = 10;

export type IsolatedPostgresSchema = Readonly<{
  connectionString: string;
  dispose(): Promise<void>;
  pool: Pool;
}>;

export type IsolatedTestSchemaCleanupResult = Readonly<{
  listed: readonly string[];
  dropped: readonly string[];
}>;

type TestSchemaQueryClient = Readonly<{
  query(
    text: string,
    values?: unknown[],
  ): Promise<{ rows: unknown[]; rowCount: number | null }>;
}>;

export const fixedInternalOwnerPrincipal = Object.freeze({
  userId: asUserId("01984477-1f9a-7b25-a5cc-83c3b21fbc68"),
});

export function isIsolatedTestSchemaName(name: string): boolean {
  return TEST_SCHEMA_NAME_PATTERN.test(name);
}

function databaseTarget(connectionString: string): string {
  let url: URL;
  try {
    url = new URL(connectionString);
  } catch {
    throw new Error("The database connection string is not a valid URL.");
  }
  return `${url.hostname.toLowerCase()}:${url.port || "5432"}${url.pathname || "/"}`;
}

export function assertDistinctTestDatabaseUrls(
  testConnectionString: string,
  productionConnectionString: string | undefined,
): void {
  if (testConnectionString.trim() === "") {
    throw new Error("TEST_DATABASE_URL must not be empty.");
  }
  if (
    productionConnectionString === undefined ||
    productionConnectionString.trim() === ""
  ) {
    return;
  }
  if (
    databaseTarget(testConnectionString) ===
    databaseTarget(productionConnectionString)
  ) {
    throw new Error(
      "TEST_DATABASE_URL must not target the same host and database as DATABASE_URL.",
    );
  }
}

export function planIsolatedTestSchemaDrops(
  schemaNames: readonly string[],
  batchSize = TEST_SCHEMA_CLEANUP_BATCH_SIZE,
): readonly (readonly string[])[] {
  if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 50) {
    throw new Error("Test schema cleanup batch size must be between 1 and 50.");
  }
  const seen = new Set<string>();
  for (const schemaName of schemaNames) {
    if (!isIsolatedTestSchemaName(schemaName)) {
      throw new Error(`Refusing unexpected test schema name: ${schemaName}`);
    }
    if (seen.has(schemaName)) {
      throw new Error(`Duplicate test schema name: ${schemaName}`);
    }
    seen.add(schemaName);
  }
  const batches: string[][] = [];
  for (let index = 0; index < schemaNames.length; index += batchSize) {
    batches.push(schemaNames.slice(index, index + batchSize));
  }
  return batches;
}

function quoteIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

async function listIsolatedTestSchemas(
  client: TestSchemaQueryClient,
): Promise<readonly string[]> {
  const result = await client.query(
    `SELECT nspname
       FROM pg_namespace
      WHERE starts_with(nspname, $1)
      ORDER BY nspname`,
    [TEST_SCHEMA_PREFIX],
  );
  const names = result.rows.map((row) => {
    if (row === null || typeof row !== "object") {
      throw new Error("PostgreSQL returned an invalid test schema row.");
    }
    const name = (row as { nspname?: unknown }).nspname;
    if (typeof name !== "string") {
      throw new Error("PostgreSQL returned an invalid test schema name.");
    }
    return name;
  });
  const unexpected = names.filter((name) => !isIsolatedTestSchemaName(name));
  if (unexpected.length > 0) {
    throw new Error(
      `Refusing to clean unexpected schema names: ${unexpected.join(", ")}`,
    );
  }
  return names;
}

async function assertCleanupSafety(
  client: TestSchemaQueryClient,
): Promise<void> {
  const active = await client.query(
    `SELECT count(*)::int AS count
       FROM pg_stat_activity
      WHERE datname = current_database()
        AND pid <> pg_backend_pid()`,
  );
  const activeCount = Number(
    (active.rows[0] as { count?: unknown } | undefined)?.count ?? 0,
  );
  if (activeCount > 0) {
    throw new Error(
      `Refusing cleanup while ${activeCount} active database connection(s) are present.`,
    );
  }
  const prepared = await client.query(
    `SELECT count(*)::int AS count FROM pg_prepared_xacts`,
  );
  const preparedCount = Number(
    (prepared.rows[0] as { count?: unknown } | undefined)?.count ?? 0,
  );
  if (preparedCount > 0) {
    throw new Error(
      `Refusing cleanup while ${preparedCount} prepared transaction(s) are active.`,
    );
  }
  const crossSchema = await client.query(
    `SELECT count(*)::int AS count
       FROM pg_constraint constraint_row
       JOIN pg_class child_table ON child_table.oid = constraint_row.conrelid
       JOIN pg_namespace child_namespace ON child_namespace.oid = child_table.relnamespace
       JOIN pg_class parent_table ON parent_table.oid = constraint_row.confrelid
       JOIN pg_namespace parent_namespace ON parent_namespace.oid = parent_table.relnamespace
      WHERE (starts_with(child_namespace.nspname, $1)
             AND child_namespace.nspname <> parent_namespace.nspname)
         OR (starts_with(parent_namespace.nspname, $1)
             AND parent_namespace.nspname <> child_namespace.nspname)`,
    [TEST_SCHEMA_PREFIX],
  );
  const crossSchemaCount = Number(
    (crossSchema.rows[0] as { count?: unknown } | undefined)?.count ?? 0,
  );
  if (crossSchemaCount > 0) {
    throw new Error(
      `Refusing cleanup while ${crossSchemaCount} cross-schema constraint(s) involve a test schema.`,
    );
  }
}

async function cleanupIsolatedTestSchemasWithClient(
  client: TestSchemaQueryClient,
  options: Readonly<{ confirm: boolean; batchSize?: number }>,
): Promise<IsolatedTestSchemaCleanupResult> {
  const listed = await listIsolatedTestSchemas(client);
  if (!options.confirm || listed.length === 0) {
    return { listed, dropped: [] };
  }
  await assertCleanupSafety(client);
  const batches = planIsolatedTestSchemaDrops(listed, options.batchSize);
  const dropped: string[] = [];
  for (const batch of batches) {
    await client.query("BEGIN");
    try {
      await client.query(
        [
          "SET LOCAL lock_timeout = '5s';",
          "SET LOCAL statement_timeout = '120s';",
          ...batch.map(
            (schemaName) =>
              `DROP SCHEMA ${quoteIdentifier(schemaName)} CASCADE;`,
          ),
        ].join("\n"),
      );
      await client.query("COMMIT");
      dropped.push(...batch);
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    }
  }
  return { listed, dropped };
}

export async function cleanupIsolatedTestSchemas(
  connectionString: string,
  options: Readonly<{ confirm: boolean; batchSize?: number }>,
): Promise<IsolatedTestSchemaCleanupResult> {
  const pool = new Pool({
    application_name: "sayhear-test-schema-cleanup",
    connectionString,
  });
  try {
    return await cleanupIsolatedTestSchemasWithClient(
      {
        async query(text, values) {
          const result = await pool.query(text, values);
          return { rows: result.rows, rowCount: result.rowCount };
        },
      },
      options,
    );
  } finally {
    await pool.end();
  }
}

function isolatedSchemaConnectionString(
  connectionString: string,
  schema: string,
): string {
  const isolatedConnection = new URL(connectionString);
  // Neon pooled endpoints reject `options`; schema-scoped sessions need direct connections.
  isolatedConnection.hostname = isolatedConnection.hostname.replace(
    "-pooler.",
    ".",
  );
  isolatedConnection.searchParams.set("options", `-c search_path=${schema}`);
  return isolatedConnection.toString();
}

export async function createIsolatedPostgresSchema(
  connectionString: string,
): Promise<IsolatedPostgresSchema> {
  const schema = `${TEST_SCHEMA_PREFIX}${randomUUID().replaceAll("-", "")}`;
  const adminPool = new Pool({
    application_name: "sayhear-test-schema-admin",
    connectionString,
  });
  await adminPool.query(`CREATE SCHEMA ${quoteIdentifier(schema)}`);
  const isolatedConnectionString = isolatedSchemaConnectionString(
    connectionString,
    schema,
  );

  const pool = new Pool({
    application_name: "sayhear-system-test",
    connectionString: isolatedConnectionString,
  });

  return {
    connectionString: isolatedConnectionString,
    pool,
    async dispose() {
      await pool.end();
      await adminPool.query(`DROP SCHEMA ${quoteIdentifier(schema)} CASCADE`);
      await adminPool.end();
    },
  };
}

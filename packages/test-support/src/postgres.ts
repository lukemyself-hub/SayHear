import { randomUUID } from "node:crypto";

import { asUserId } from "@sayhear/domain";
import { Pool } from "pg";

export type IsolatedPostgresSchema = Readonly<{
  connectionString: string;
  dispose(): Promise<void>;
  pool: Pool;
}>;

export const fixedInternalOwnerPrincipal = Object.freeze({
  userId: asUserId("01984477-1f9a-7b25-a5cc-83c3b21fbc68"),
});

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
  const schema = `sayhear_test_${randomUUID().replaceAll("-", "")}`;
  const adminPool = new Pool({
    application_name: "sayhear-test-schema-admin",
    connectionString,
  });
  await adminPool.query(`CREATE SCHEMA ${schema}`);
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
      await adminPool.query(`DROP SCHEMA ${schema} CASCADE`);
      await adminPool.end();
    },
  };
}

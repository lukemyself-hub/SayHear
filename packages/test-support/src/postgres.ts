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

export async function createIsolatedPostgresSchema(
  connectionString: string,
): Promise<IsolatedPostgresSchema> {
  const schema = `sayhear_test_${randomUUID().replaceAll("-", "")}`;
  const adminPool = new Pool({
    application_name: "sayhear-test-schema-admin",
    connectionString,
  });
  await adminPool.query(`CREATE SCHEMA ${schema}`);
  const isolatedConnection = new URL(connectionString);
  isolatedConnection.searchParams.set("options", `-c search_path=${schema}`);
  const isolatedConnectionString = isolatedConnection.toString();

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

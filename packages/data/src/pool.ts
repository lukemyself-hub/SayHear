import { Pool } from "pg";

export function createPostgresPool(input: {
  applicationName: string;
  connectionString: string;
}): Pool {
  return new Pool({
    application_name: input.applicationName,
    connectionString: input.connectionString,
    max: 10,
    statement_timeout: 10_000,
  });
}

import {
  assertDistinctTestDatabaseUrls,
  cleanupIsolatedTestSchemas,
} from "@sayhear/test-support";

type CleanupOptions = Readonly<{
  confirm: boolean;
  help: boolean;
}>;

function usage(): string {
  return [
    "Usage: pnpm test:system:cleanup [--dry-run|--confirm]",
    "",
    "Lists and optionally drops only isolated sayhear_test_* schemas.",
    "The default mode is a dry run. Destructive cleanup requires --confirm.",
  ].join("\n");
}

function parseArguments(arguments_: readonly string[]): CleanupOptions {
  const allowed = new Set(["--", "--dry-run", "--confirm", "--help"]);
  const unknown = arguments_.filter((argument) => !allowed.has(argument));
  if (unknown.length > 0) {
    throw new Error(`Unknown argument(s): ${unknown.join(", ")}`);
  }
  const confirm = arguments_.includes("--confirm");
  if (confirm && arguments_.includes("--dry-run")) {
    throw new Error("--dry-run and --confirm cannot be used together.");
  }
  return {
    confirm,
    help: arguments_.includes("--help"),
  };
}

function displayTarget(connectionString: string): string {
  const url = new URL(connectionString);
  return `${url.hostname}${url.pathname}`;
}

async function main(): Promise<void> {
  const options = parseArguments(process.argv.slice(2));
  if (options.help) {
    console.log(usage());
    return;
  }

  const testDatabaseUrl = process.env.TEST_DATABASE_URL;
  if (testDatabaseUrl === undefined || testDatabaseUrl.trim() === "") {
    throw new Error("TEST_DATABASE_URL is required.");
  }
  assertDistinctTestDatabaseUrls(testDatabaseUrl, process.env.DATABASE_URL);

  const result = await cleanupIsolatedTestSchemas(testDatabaseUrl, {
    confirm: options.confirm,
  });
  console.log(
    `[test-schema-cleanup] target=${displayTarget(testDatabaseUrl)} listed=${result.listed.length}`,
  );
  for (const schemaName of result.listed) {
    console.log(`  ${schemaName}`);
  }
  if (!options.confirm) {
    console.log("[test-schema-cleanup] dry run only; pass --confirm to drop.");
    return;
  }
  console.log(`[test-schema-cleanup] dropped=${result.dropped.length}`);
}

void main().catch((error: unknown) => {
  console.error(
    `[test-schema-cleanup] ${error instanceof Error ? error.message : "cleanup failed"}`,
  );
  process.exitCode = 1;
});

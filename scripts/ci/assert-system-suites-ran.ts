import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import {
  discoverSystemSuites,
  expectedSystemSuiteCount,
  formatSystemSuiteExecution,
  type VitestJsonReport,
} from "./system-suite-execution.ts";

async function main(): Promise<void> {
  const reportPath = process.argv[2];
  if (!reportPath) {
    throw new Error(
      "Usage: assert-system-suites-ran.ts <vitest-json-report-path>",
    );
  }
  const report = JSON.parse(
    await readFile(resolve(reportPath), "utf8"),
  ) as VitestJsonReport;
  const discoveredSystemSuites = await discoverSystemSuites(
    resolve("tests/system"),
  );
  console.log(
    formatSystemSuiteExecution({
      discoveredSystemSuites,
      expectedCount: expectedSystemSuiteCount,
      report,
    }),
  );
}

main().catch((error: unknown) => {
  console.error(
    `::error::${error instanceof Error ? error.message : String(error)}`,
  );
  process.exitCode = 1;
});
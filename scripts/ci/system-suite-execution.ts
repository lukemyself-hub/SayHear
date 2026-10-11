import { readdir } from "node:fs/promises";

export type VitestJsonReport = Readonly<{
  success: boolean;
  testResults: readonly Readonly<{
    name: string;
    status: string;
    assertionResults: readonly Readonly<{ status: string }>[];
  }>[];
}>;

export type SystemSuiteExecutionInput = Readonly<{
  discoveredSystemSuites: readonly string[];
  expectedCount: number;
  report: VitestJsonReport;
}>;

export type SystemSuiteExecution = Readonly<{
  executedSystemSuites: number;
  skippedSystemTests: number;
  systemTests: number;
}>;

/**
 * The number of `tests/system/*.system.test.ts` suites a PR validation run is
 * expected to execute. Adding or removing a system suite is an intentional
 * change to the coverage of the two-database contract, so the pinned number
 * turns a silent deletion into a failed check instead of a green run.
 */
export const expectedSystemSuiteCount = 42;

const SYSTEM_SUITE_DIRECTORY = "tests/system";

/**
 * Repo-relative suite key. vitest reports a resolved absolute path while the
 * discovered path keeps whatever prefix the process started with, so matching on
 * the absolute string would depend on how the checkout was reached.
 */
function suiteKey(path: string): string {
  const marker = `${SYSTEM_SUITE_DIRECTORY}/`;
  const index = path.lastIndexOf(marker);
  return index === -1 ? path : path.slice(index);
}

/**
 * The AC-02 contract: the expected system suites actually ran against two
 * independent databases. Several system suites degrade to `describe.skip` when
 * a test database variable is missing, so a run that reports success can still
 * have executed no coverage at all. Missing, skipped, and failing suites are
 * therefore reported as failures instead of being counted as a pass.
 */
export function assertSystemSuitesExecuted(
  input: SystemSuiteExecutionInput,
): SystemSuiteExecution {
  const resultsByPath = new Map(
    input.report.testResults.map((result) => [suiteKey(result.name), result]),
  );
  const missing: string[] = [];
  const skipped: string[] = [];
  const failed: string[] = [];
  let executedSystemSuites = 0;
  let skippedSystemTests = 0;
  let systemTests = 0;

  for (const discovered of input.discoveredSystemSuites) {
    const suite = suiteKey(discovered);
    const result = resultsByPath.get(suite);
    if (!result) {
      missing.push(suite);
      continue;
    }
    executedSystemSuites += 1;
    const skippedHere = result.assertionResults.filter(
      (assertion) => assertion.status !== "passed",
    );
    systemTests += result.assertionResults.length;
    skippedSystemTests += skippedHere.length;
    if (skippedHere.length > 0) {
      skipped.push(suite);
    }
    if (result.status !== "passed") {
      failed.push(suite);
    }
  }

  const problems = [
    ...missing.map((suite) => `${suite} did not run`),
    ...skipped.map(
      (suite) =>
        `${suite} reported non-passing tests, most likely a missing or shared test database`,
    ),
    ...failed.map((suite) => `${suite} did not pass`),
  ];
  if (problems.length > 0) {
    throw new Error(
      `System suite execution check failed:\n${problems.join("\n")}`,
    );
  }
  if (
    input.discoveredSystemSuites.length !== input.expectedCount ||
    executedSystemSuites !== input.expectedCount
  ) {
    throw new Error(
      `System suite execution check failed: expected ${input.expectedCount} system suites in ${SYSTEM_SUITE_DIRECTORY}, discovered ${input.discoveredSystemSuites.length} and executed ${executedSystemSuites}.`,
    );
  }
  if (!input.report.success) {
    throw new Error(
      "System suite execution check failed: the test run itself reported failure.",
    );
  }

  return { executedSystemSuites, skippedSystemTests, systemTests };
}

export function formatSystemSuiteExecution(
  input: SystemSuiteExecutionInput,
): string {
  const execution = assertSystemSuitesExecuted(input);
  return `system suites ${execution.executedSystemSuites}/${input.expectedCount} executed; system tests ${execution.systemTests}; skipped ${execution.skippedSystemTests}`;
}

export async function discoverSystemSuites(
  systemSuiteDirectory: string,
): Promise<string[]> {
  const entries = await readdir(systemSuiteDirectory);
  return entries
    .filter((entry) => entry.endsWith(".system.test.ts"))
    .map((entry) => `${systemSuiteDirectory}/${entry}`)
    .sort();
}


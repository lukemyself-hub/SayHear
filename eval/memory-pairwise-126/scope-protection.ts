/**
 * Merge-time scope protection check (issue #126; SPEC #107 AC 40).
 *
 * At merge the 1A.3a slice must not carry any 1A.3b artifact: no Episode,
 * Open Loop, Proactive Follow-up state, Reflection, Profile Projection,
 * predicate-governance tooling, or vector / embedding artifact; no model
 * routing, Provider, or Conversation Text Champion change; and no backfill of
 * pre-1A.3a conversations.
 *
 * This is the mechanical proof: (1) no forbidden schema artifact exists in
 * the migration history; (2) no embedding / vector / backfill code path
 * exists outside explanatory comments; (3) the twin run's champion cluster is
 * byte-identical to the frozen 1A.2P incumbent baseline. Open Loop / Episode
 * / Reflection / Proactive mentions inside registry routing text and the
 * intentionally-null placeholder slots (`proactiveFollowupUsage`,
 * `sourceReflectionVersionId`) are expected at this stage — their absence of
 * behavior is enforced by the existing unit tests, not re-proven here.
 *
 * Usage:
 *   pnpm exec tsx eval/memory-pairwise-126/scope-protection.ts \
 *     --twin eval/memory-pairwise-126/run-twins-on/manifest.json \
 *     [--incumbent eval/incumbent-baseline/run/manifest.json] \
 *     [--out eval/memory-pairwise-126/scope-protection.json]
 */
import { readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";

const REPOSITORY_ROOT = path.resolve(import.meta.dirname, "../..");

type ScopeIssue = Readonly<{ check: string; detail: string }>;

/** Forbidden persisted artifacts (vector and projection faces; ADR-0115). */
// The 1A.3b Stage-1 Episode schema (issue #197) and the Reflection schema
// (issue #199) are accepted SPEC deliverables; Open Loop and Proactive (C
// lanes) and vector faces are not built yet and stay forbidden.
const FORBIDDEN_TABLE_PATTERN =
  /(embedding|vector|open_loop|proactive|profile_projection)/i;

const FORBIDDEN_EXTENSION_PATTERN = /create\s+extension[^;]*\bvector\b/i;

/** Code-level markers that would betray a built vector / backfill path. */
const FORBIDDEN_CODE_PATTERN = /\b(pgvector|embeddings?|backfill)\b/i;
/** Lines that only talk about the forbidden artifact (comments) are expected. */
function isCommentLine(line: string): boolean {
  const trimmed = line.trimStart();
  return (
    trimmed.startsWith("//") ||
    trimmed.startsWith("*") ||
    trimmed.startsWith("/*")
  );
}

async function listFiles(
  directory: string,
  suffix: string,
): Promise<readonly string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await listFiles(entryPath, suffix)));
    } else if (entry.name.endsWith(suffix)) {
      files.push(entryPath);
    }
  }
  return files;
}

export async function runScopeProtectionChecks(input: {
  incumbentManifest: Record<string, unknown>;
  twinManifest: Record<string, unknown>;
}): Promise<{ issues: readonly ScopeIssue[]; scanned: Record<string, number> }> {
  const issues: ScopeIssue[] = [];

  // (1) Schema artifacts: table / index / extension DDL in the full migration
  // history. These names have zero hits today; any hit is a scope breach.
  const migrationsDirectory = path.join(
    REPOSITORY_ROOT,
    "packages/data/migrations",
  );
  let migrationCount = 0;
  for (const file of await listFiles(migrationsDirectory, ".sql")) {
    migrationCount += 1;
    const text = await readFile(file, "utf8");
    const relative = path.relative(REPOSITORY_ROOT, file);
    for (const match of text.matchAll(
      /create\s+(?:table|index|unique\s+index)\s+(?:if\s+not\s+exists\s+)?([a-z_.]+)/gi,
    )) {
      const name = match[1] ?? "";
      if (FORBIDDEN_TABLE_PATTERN.test(name)) {
        issues.push({
          check: "schema-artifact",
          detail: `${relative} creates "${name}", a 1A.3b / vector face that must not exist at merge`,
        });
      }
    }
    if (FORBIDDEN_EXTENSION_PATTERN.test(text)) {
      issues.push({
        check: "schema-artifact",
        detail: `${relative} enables a vector extension (pgvector artifact; ADR-0115 keeps 1A.3a vector-free)`,
      });
    }
  }

  // (2) Code paths: embedding / vector / backfill markers outside comments in
  // production source (tests may describe the boundary they protect).
  let scannedCodeFiles = 0;
  for (const sourceRoot of [
    path.join(REPOSITORY_ROOT, "packages/application/src"),
    path.join(REPOSITORY_ROOT, "packages/ai/src"),
    path.join(REPOSITORY_ROOT, "packages/data/src"),
    path.join(REPOSITORY_ROOT, "packages/domain/src"),
    path.join(REPOSITORY_ROOT, "apps/web/src"),
    path.join(REPOSITORY_ROOT, "apps/web/app"),
    path.join(REPOSITORY_ROOT, "scripts"),
  ]) {
    for (const file of await listFiles(sourceRoot, ".ts")) {
      if (file.endsWith(".test.ts")) continue;
      scannedCodeFiles += 1;
      const text = await readFile(file, "utf8");
      const relative = path.relative(REPOSITORY_ROOT, file);
      for (const line of text.split("\n")) {
        if (isCommentLine(line)) continue;
        const match = line.match(FORBIDDEN_CODE_PATTERN);
        if (match) {
          issues.push({
            check: "code-path",
            detail: `${relative}: non-comment "${match[0]}" marker`,
          });
        }
      }
    }
  }

  // (3) Champion cluster: the twin run must ship the same Conversation Text
  // Champion / Provider / model routing as the frozen 1A.2P incumbent.
  const championOf = (manifest: Record<string, unknown>) =>
    (manifest.systemVersions as Record<string, unknown> | undefined)
      ?.champion as Record<string, unknown> | undefined;
  const incumbentChampion = championOf(input.incumbentManifest);
  const twinChampion = championOf(input.twinManifest);
  if (!incumbentChampion || !twinChampion) {
    issues.push({
      check: "champion-cluster",
      detail: "a manifest is missing its champion pin cluster",
    });
  } else {
    for (const key of [
      "configVersion",
      "model",
      "provider",
      "providerPolicyVersion",
      "snapshot",
    ]) {
      if (incumbentChampion[key] !== twinChampion[key]) {
        issues.push({
          check: "champion-cluster",
          detail: `champion.${key}: incumbent pins ${JSON.stringify(incumbentChampion[key])} but the twin run recorded ${JSON.stringify(twinChampion[key])}`,
        });
      }
    }
  }

  return {
    issues,
    scanned: {
      codeFiles: scannedCodeFiles,
      migrations: migrationCount,
    },
  };
}

async function main(): Promise<void> {
  const arguments_ = process.argv.slice(2);
  const paths: Record<string, string> = {
    incumbent: path.join(
      REPOSITORY_ROOT,
      "eval/incumbent-baseline/run/manifest.json",
    ),
  };
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    if (argument === "--twin" || argument === "--incumbent" || argument === "--out") {
      const value = arguments_[++index];
      if (!value) throw new Error(`${argument} requires a value.`);
      paths[argument.slice(2)] = path.resolve(value);
    } else {
      throw new Error(`Unknown argument: ${argument}`);
    }
  }
  const twinPath = paths.twin;
  if (!twinPath) {
    throw new Error(
      "--twin (the memory-on twin manifest) is required; run capture-twins --arm on first.",
    );
  }
  const incumbentPath = paths.incumbent!;
  const twinManifest = JSON.parse(await readFile(twinPath, "utf8"));
  if (twinManifest.arm !== "on") {
    throw new Error(
      `Scope protection needs the memory-on twin manifest (arm="${twinManifest.arm}").`,
    );
  }
  const incumbentManifest = JSON.parse(
    await readFile(incumbentPath, "utf8"),
  );
  const { issues, scanned } = await runScopeProtectionChecks({
    incumbentManifest,
    twinManifest,
  });
  const report = {
    checkedAt: new Date().toISOString(),
    incumbent: incumbentPath,
    issues,
    pass: issues.length === 0,
    scanned,
    twin: twinPath,
  };
  const output =
    paths.out ?? path.join(path.dirname(twinPath), "scope-protection.json");
  await writeFile(output, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  if (issues.length > 0) {
    console.error(`[scope-protection] FAILED — ${issues.length} issue(s):`);
    for (const issue of issues) {
      console.error(`  - [${issue.check}] ${issue.detail}`);
    }
    process.exitCode = 1;
    return;
  }
  console.log(
    `[scope-protection] clean: ${scanned.migrations} migrations + ${scanned.codeFiles} source files scanned, champion cluster unchanged; wrote ${output}`,
  );
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) ===
    path.resolve(new URL(import.meta.url).pathname)
) {
  main().catch((error: unknown) => {
    console.error("[scope-protection] check failed:", error);
    process.exitCode = 1;
  });
}

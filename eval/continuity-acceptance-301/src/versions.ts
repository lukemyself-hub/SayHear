import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import {
  CANONICAL_PERSONA_VERSION,
  CONVERSATION_DECISION_TASK_INSTRUCTION_VERSION,
  CONVERSATION_OUTPUT_FORMAT_VERSION,
  HISTORY_ANSWER_TASK_INSTRUCTION_VERSION,
  HISTORY_CONTINUATION_ANSWER_TASK_INSTRUCTION_VERSION,
  HISTORY_EXPERIENCE_SEARCH_POLICY_VERSION,
  HISTORY_READING_RULES_VERSION,
  HISTORY_RECALL_CONVERSATION_HARNESS_POLICY,
  HISTORY_RECALL_TIME_COMPILER_VERSION,
  HISTORY_RECALL_POLICY_VERSION,
  PERSONA_BEHAVIOR_ANCHORS_VERSION,
  PERSONA_CONTRACT_INVARIANT_VERSION,
  RECENT_CONTEXT_DEFAULT_POLICY,
  TIME_AWARE_CONTEXT_COMPILER_VERSION,
} from "@sayhear/application";

import { repositoryRoot } from "./app-server";
import { listCaseIds, loadFixture } from "./fixture";

/**
 * The combined version of the continuity stack (T07 #320): everything that
 * decides what the history path reads, selects, shows and stops on, in one
 * content-free record with a fingerprint. A follow-up acceptance run (T08)
 * names this fingerprint, so a result is tied to the exact stack it ran on.
 * It reads versions from the code that runs and the files that define the
 * database; it reads no user data and no secret.
 */

export const COMBINED_VERSION_SCHEMA = "continuity-combined-version:v1";

export type CombinedVersion = Readonly<{
  acceptancePack: Readonly<{ caseCount: number; fixtureDigest: string }>;
  database: Readonly<{
    migrationCount: number;
    migrationDigest: string;
    newestMigration: string;
  }>;
  fingerprint: string;
  git: Readonly<{ commit: string; dirty: boolean }>;
  path: Readonly<Record<string, string>>;
  schemaVersion: typeof COMBINED_VERSION_SCHEMA;
  switches: Readonly<Record<string, string>>;
}>;

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function git(...args: string[]): string {
  try {
    return execFileSync("git", args, { cwd: repositoryRoot, encoding: "utf8" }).trim();
  } catch {
    return "unknown";
  }
}

export function combinedVersion(): CombinedVersion {
  const migrationsDirectory = path.join(repositoryRoot, "packages/data/migrations");
  const migrations = readdirSync(migrationsDirectory)
    .filter((name) => /^\d{4}_[a-z0-9_]+\.sql$/.test(name))
    .sort();
  const migrationDigest = sha256(
    migrations
      .map((name) => `${name}:${sha256(readFileSync(path.join(migrationsDirectory, name), "utf8"))}`)
      .join("\n"),
  );
  const cases = listCaseIds();
  const fixtureDigest = sha256(
    cases.map((id) => `${id}:${loadFixture(id).sha256}`).join("\n"),
  );
  const versions = {
    canonicalPersona: CANONICAL_PERSONA_VERSION,
    contextCompilerHistoryAnswer: HISTORY_RECALL_TIME_COMPILER_VERSION,
    contextCompilerOrdinary: TIME_AWARE_CONTEXT_COMPILER_VERSION,
    conversationOutput: CONVERSATION_OUTPUT_FORMAT_VERSION,
    decisionTask: CONVERSATION_DECISION_TASK_INSTRUCTION_VERSION,
    historyAnswerTask: HISTORY_ANSWER_TASK_INSTRUCTION_VERSION,
    historyContinuationAnswerTask: HISTORY_CONTINUATION_ANSWER_TASK_INSTRUCTION_VERSION,
    historyExperienceSearch: HISTORY_EXPERIENCE_SEARCH_POLICY_VERSION,
    historyHarnessPolicy: HISTORY_RECALL_CONVERSATION_HARNESS_POLICY.version,
    historyReadingRules: HISTORY_READING_RULES_VERSION,
    historyRecallPolicy: HISTORY_RECALL_POLICY_VERSION,
    personaBehaviorAnchors: PERSONA_BEHAVIOR_ANCHORS_VERSION,
    personaContractInvariant: PERSONA_CONTRACT_INVARIANT_VERSION,
    recentContextSelection: RECENT_CONTEXT_DEFAULT_POLICY.version,
  };
  const switches = {
    deployment:
      "SAYHEAR_HISTORY_RECALL_ENABLED (explicit, default false; also selects conversation-harness policy)",
    independentGovernance:
      "history_recall_policies (versioned, one active row; operator route /api/internal/operator/history-recall enable|disable)",
    recentBackground:
      "recent_context_policies (separate switch; closing history never touches it)",
  };
  const git_ = { commit: git("rev-parse", "HEAD"), dirty: git("status", "--porcelain").length > 0 };
  const database = {
    migrationCount: migrations.length,
    migrationDigest,
    newestMigration: migrations.at(-1) ?? "none",
  };
  const acceptancePack = { caseCount: cases.length, fixtureDigest };
  const fingerprint = sha256(
    JSON.stringify({ acceptancePack, commit: git_.commit, database, switches, versions }),
  );
  return {
    acceptancePack,
    database,
    fingerprint,
    git: git_,
    path: versions,
    schemaVersion: COMBINED_VERSION_SCHEMA,
    switches,
  };
}

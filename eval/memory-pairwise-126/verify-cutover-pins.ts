/**
 * Cutover pin-list verification (issue #126; SPEC #107 "Versioning, cutover,
 * rollback" / AC "the full pin list is present in CompiledContext").
 *
 * Direct switch on the 1A.2P pattern: no feature flags, no dual-run. This
 * gate mechanically proves that (a) the recorded twin manifest carries the
 * complete SPEC pin list, (b) every pin equals the constant the production
 * code itself resolves (the manifest cannot drift from what actually ran),
 * and (c) the runtime pin evidence the CompiledContexts actually recorded —
 * the per-turn retrieval manifest's selection policy versions — matches the
 * same list.
 *
 * Usage:
 *   pnpm exec tsx eval/memory-pairwise-126/verify-cutover-pins.ts \
 *     --manifest eval/memory-pairwise-126/run-twins-on/manifest.json \
 *     --transcripts eval/memory-pairwise-126/run-twins-on/transcripts.json \
 *     --pack eval/scenario-pack-v3/scenarios.json \
 *     --out eval/memory-pairwise-126/pins-report.json
 */
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  CATALOG_V2_CONVERSATION_HARNESS_POLICY,
  CANONICAL_PERSONA_VERSION,
  CHINESE_LOCALE_PACK_VERSION,
  ENGLISH_LOCALE_PACK_VERSION,
  ENTITY_RESOLVE_GATE_POLICY_VERSION,
  ENTITY_RESOLVE_T_AUTO,
  FAST_PATH_EXTRACTION_POLICY_VERSION,
  MEMORY_BUDGETS_POLICY_VERSION,
  MEMORY_CONSOLIDATION_POLICY_VERSION,
  MEMORY_RETRIEVAL_POLICY_VERSION,
  MEMORY_TRUST_ACTIONS_CONVERSATION_ACTION_CATALOG,
  PERSONA_BEHAVIOR_ANCHORS_VERSION,
  PERSONA_CONTRACT_INVARIANT_VERSION,
  PORTRAIT_SELECTION_POLICY_VERSION,
  RECALL_EXPERIENCE_CONTRACT_VERSION,
  RECALL_FRAMING_POLICY_VERSION,
  RETRIEVAL_QUERY_CONSTRUCTION_POLICY_VERSION,
  SAFETY_RESOURCE_WHITELIST_VERSION,
  TRUST_ACTION_EXPRESSION_CONTRACT_VERSION,
  loadPredicateRegistrySnapshot,
} from "@sayhear/application";

import { TIERED_CHECKS_VERSION } from "../scenario-pack-v3/tiered-checks";

/**
 * The SPEC #107 pin list, one row per pin: where the recorded artifact must
 * carry it and which live constant it must equal.
 */
export function expectedPinList(): Record<string, unknown> {
  const registrySnapshot = loadPredicateRegistrySnapshot(1);
  return {
    conversationActionCatalog: {
      actionKinds:
        MEMORY_TRUST_ACTIONS_CONVERSATION_ACTION_CATALOG.definitions.map(
          (definition) => definition.actionKind,
        ),
      version: MEMORY_TRUST_ACTIONS_CONVERSATION_ACTION_CATALOG.version,
    },
    entityResolvePolicy: {
      policyVersion: ENTITY_RESOLVE_GATE_POLICY_VERSION,
      // The fixture-calibrated runtime constant; the manifest records the
      // t_auto its loaded policy actually enforced, so drift fails here.
      tAuto: ENTITY_RESOLVE_T_AUTO,
    },
    evalChannel: {
      // v3.2: the #126 layer-2 diagnosis (2026-08-31) moved the impression
      // en/mix day-3 recall probes onto published stated_style surfaces so
      // the deterministic query has a matchable signal; checker semantics
      // stay tiered-checks:v3.
      scenarioPack: "scenario-pack:v3.3",
      tieredChecks: TIERED_CHECKS_VERSION,
    },
    fastPathExtractionPolicyVersion: FAST_PATH_EXTRACTION_POLICY_VERSION,
    harnessPolicyVersion: CATALOG_V2_CONVERSATION_HARNESS_POLICY.version,
    localePacks: {
      chinese: CHINESE_LOCALE_PACK_VERSION,
      english: ENGLISH_LOCALE_PACK_VERSION,
    },
    memoryConsolidationPolicyVersion: MEMORY_CONSOLIDATION_POLICY_VERSION,
    memoryRetrieval: {
      memoryBudgets: MEMORY_BUDGETS_POLICY_VERSION,
      policyVersion: MEMORY_RETRIEVAL_POLICY_VERSION,
      portraitSelection: PORTRAIT_SELECTION_POLICY_VERSION,
      queryConstruction: RETRIEVAL_QUERY_CONSTRUCTION_POLICY_VERSION,
    },
    persona: {
      anchors: PERSONA_BEHAVIOR_ANCHORS_VERSION,
      canonical: CANONICAL_PERSONA_VERSION,
      invariant: PERSONA_CONTRACT_INVARIANT_VERSION,
    },
    predicateRegistry: {
      registryVersion: registrySnapshot.registryVersion,
      version: "predicate-registry:v1",
    },
    promptArtifacts: {
      groundingGuardAndOpenerPermission: RECALL_EXPERIENCE_CONTRACT_VERSION,
      trustActionExpression: TRUST_ACTION_EXPRESSION_CONTRACT_VERSION,
    },
    roleChampionConfigs: {
      entityResolve: {
        promptFingerprint: "entity-resolve:gate:v2",
      },
      memoryConsolidate: {
        promptFingerprint: "memory-consolidate:diffs:v1",
      },
      memoryExtract: {
        promptFingerprint: "memory-extract:propose:v3",
      },
    },
    safetyResources: SAFETY_RESOURCE_WHITELIST_VERSION,
  };
}

type PinIssue = Readonly<{ pin: string; problem: string }>;

function deepEqual(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (typeof left !== "object" || typeof right !== "object" || left === null || right === null) {
    return false;
  }
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right)) return false;
    return (
      left.length === right.length &&
      left.every((item, index) => deepEqual(item, right[index]))
    );
  }
  const leftKeys = Object.keys(left).sort();
  const rightKeys = Object.keys(right).sort();
  if (leftKeys.length !== rightKeys.length || !leftKeys.every((key, index) => key === rightKeys[index])) {
    return false;
  }
  return leftKeys.every((key) =>
    deepEqual(
      (left as Record<string, unknown>)[key],
      (right as Record<string, unknown>)[key],
    ),
  );
}

export function verifyManifestPins(input: {
  manifest: Record<string, unknown>;
  pack: Record<string, unknown>;
  transcripts: Record<string, unknown>;
}): { issues: readonly PinIssue[]; pinList: Record<string, unknown> } {
  const issues: PinIssue[] = [];
  const expected = expectedPinList();
  const recorded = input.manifest.cutoverPins as Record<string, unknown> | undefined;
  if (!recorded) {
    issues.push({
      pin: "cutoverPins",
      problem: "the twin manifest records no cutoverPins block",
    });
  } else {
    for (const [pin, value] of Object.entries(expected)) {
      if (pin === "evalChannel") continue; // checked against the pack file below
      if (pin === "roleChampionConfigs") {
        // The role Champion configs live on the manifest's own
        // roleConfigurations rows (role / config / prompt fingerprint).
        const roleNames: Record<string, string> = {
          entityResolve: "entity.resolve",
          memoryConsolidate: "memory.consolidate",
          memoryExtract: "memory.extract",
        };
        const roles = Array.isArray(input.manifest.roleConfigurations)
          ? (input.manifest.roleConfigurations as Record<string, string>[])
          : [];
        for (const [roleKey, shape] of Object.entries(
          value as Record<string, Record<string, string>>,
        )) {
          const roleName = roleNames[roleKey] ?? roleKey;
          const row = roles.find((entry) => entry.role === roleName);
          if (!row) {
            issues.push({
              pin: `roleChampionConfigs.${roleKey}`,
              problem: "missing from the manifest roleConfigurations",
            });
            continue;
          }
          for (const [field, expectedValue] of Object.entries(shape)) {
            if (row[field] !== expectedValue) {
              issues.push({
                pin: `roleChampionConfigs.${roleKey}.${field}`,
                problem: `manifest records ${JSON.stringify(row[field])}, expected ${JSON.stringify(expectedValue)}`,
              });
            }
          }
        }
        continue;
      }
      if (!(pin in recorded)) {
        issues.push({ pin, problem: "missing from the manifest cutoverPins" });
      } else if (!deepEqual(recorded[pin], value)) {
        issues.push({
          pin,
          problem: `manifest records ${JSON.stringify(recorded[pin])} but the production constants resolve ${JSON.stringify(value)}`,
        });
      }
    }
  }

  // Eval-channel pins: the pack file's declared version and the checker
  // version compiled into this repository.
  const packVersion = String(input.pack.version ?? "");
  if (packVersion !== (expected.evalChannel as Record<string, unknown>).scenarioPack) {
    issues.push({
      pin: "evalChannel.scenarioPack",
      problem: `pack file declares "${packVersion}"`,
    });
  }

  // CompiledContext runtime evidence: every retrieval run the on-arm
  // transcripts recorded must pin the same selection policy versions.
  const selectionVersions = new Set<string>();
  for (const scenario of (input.transcripts.scenarios ?? []) as {
    turns: { retrieval: { selectionPolicyVersions: Record<string, string> | null } }[];
  }[]) {
    for (const turn of scenario.turns ?? []) {
      const versions = turn.retrieval?.selectionPolicyVersions;
      if (versions) {
        selectionVersions.add(JSON.stringify(versions));
      }
    }
  }
  const expectedSelection = {
    memory_budgets: MEMORY_BUDGETS_POLICY_VERSION,
    portrait_selection: PORTRAIT_SELECTION_POLICY_VERSION,
    recall_framing: RECALL_FRAMING_POLICY_VERSION,
  };
  for (const observed of selectionVersions) {
    if (!deepEqual(JSON.parse(observed), expectedSelection)) {
      issues.push({
        pin: "memoryRetrieval.selectionPolicyVersions",
        problem: `a CompiledContext retrieval manifest recorded ${observed}`,
      });
    }
  }
  return { issues, pinList: expected };
}

async function main(): Promise<void> {
  const arguments_ = process.argv.slice(2);
  const paths: Record<string, string> = {};
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    if (
      argument === "--manifest" ||
      argument === "--transcripts" ||
      argument === "--pack" ||
      argument === "--out"
    ) {
      const value = arguments_[++index];
      if (!value) {
        throw new Error(`${argument} requires a value.`);
      }
      paths[argument.slice(2)] = value;
    } else {
      throw new Error(`Unknown argument: ${argument}`);
    }
  }
  const manifestPath = paths.manifest;
  const transcriptsPath = paths.transcripts;
  const packPath = paths.pack;
  if (!manifestPath || !transcriptsPath || !packPath) {
    throw new Error(
      "--manifest, --transcripts, and --pack are required (an on-arm twin run).",
    );
  }
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  const transcripts = JSON.parse(await readFile(transcriptsPath, "utf8"));
  const pack = JSON.parse(await readFile(packPath, "utf8"));
  if (manifest.arm !== "on") {
    throw new Error(
      `Pin verification needs the memory-on twin manifest (arm="${manifest.arm}").`,
    );
  }
  const { issues, pinList } = verifyManifestPins({ manifest, pack, transcripts });
  const report = {
    checkedAt: new Date().toISOString(),
    issues,
    manifest: manifestPath,
    pass: issues.length === 0,
    pinList,
  };
  const output =
    paths.out ?? path.join(path.dirname(manifestPath), "pins-report.json");
  await writeFile(output, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  if (issues.length > 0) {
    console.error(`[cutover-pins] FAILED — ${issues.length} pin issue(s):`);
    for (const issue of issues) {
      console.error(`  - ${issue.pin}: ${issue.problem}`);
    }
    process.exitCode = 1;
    return;
  }
  console.log(
    `[cutover-pins] all pins verified against the production constants; wrote ${output}`,
  );
}

const isDirectRun =
  process.argv[1] &&
  path.resolve(process.argv[1]) ===
    path.resolve(new URL(import.meta.url).pathname);
if (isDirectRun) {
  main().catch((error: unknown) => {
    console.error("[cutover-pins] verification failed:", error);
    process.exitCode = 1;
  });
}

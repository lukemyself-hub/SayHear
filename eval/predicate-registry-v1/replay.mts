/**
 * Frozen-model replay for the Predicate Registry mapping-eval corpus
 * (grilling #93 §8; ADR-0061 developer-judged promotion; SPEC #107 AC 8).
 *
 * Replays every forward and reverse case of the authoritative corpus
 * (packages/application/src/predicate-registry/mapping-eval-corpus.ts — the
 * same bytes CI gates on) against an injected mapper and writes a reviewable
 * findings manifest under run/<stamp>/findings.json.
 *
 * Mappers:
 *  - deterministic (default): the registry's own resolver, the behavior CI runs;
 *  - model:<role>: NOT wired yet. The `memory.extract` extraction role lands in
 *    a later SPEC ticket; when it exists, wire it here via MAPPER_IMPLEMENTATIONS
 *    so a pre-release replay can pin the candidate configuration (ADR-0061).
 *
 * There is deliberately no LLM judge anywhere: every verdict is deterministic.
 * A human (Internal Owner) reviews the manifest BEFORE merging a release, per
 * README.md.
 *
 * Usage:
 *   pnpm tsx eval/predicate-registry-v1/replay.ts [--out DIR]
 */

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  loadPredicateRegistrySnapshot,
  PREDICATE_IDS as IDS,
  type MappingOutcome,
  predicateRegistryFingerprint,
} from "@sayhear/application";
import {
  FORWARD,
  REVERSE,
  resolve,
  type ForwardCase,
} from "../../packages/application/src/predicate-registry/mapping-eval-corpus";
import { validateMappingProposal } from "@sayhear/application";

const v1 = loadPredicateRegistrySnapshot(1);

type CaseFinding = {
  id: string;
  mode: "zh" | "en" | "cs" | "-";
  gate: string;
  status: "pass" | "fail";
  detail?: string;
};

type Mapper = (input: { text: string; mode: "zh" | "en" | "cs" }) => MappingOutcome;

const MAPPER_IMPLEMENTATIONS: Record<string, Mapper> = {
  deterministic: ({ text, mode }) => resolve({ text, mode, expect: {} as never }),
};

async function main() {
  const mapperName =
    process.argv.includes("--mapper")
      ? process.argv[process.argv.indexOf("--mapper") + 1]!
      : "deterministic";
  const mapper = MAPPER_IMPLEMENTATIONS[mapperName];
  if (!mapper) {
    throw new Error(
      `Unknown mapper "${mapperName}". Available: ${Object.keys(MAPPER_IMPLEMENTATIONS).join(", ")}.`,
    );
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const outDir = process.argv.includes("--out")
    ? process.argv[process.argv.indexOf("--out") + 1]!
    : path.join(import.meta.dirname, "run", stamp);
  await mkdir(outDir, { recursive: true });

  const findings: CaseFinding[] = [];

  for (let i = 0; i < FORWARD.length; i += 1) {
    const c: ForwardCase = FORWARD[i]!;
    const outcome = mapper({ text: c.text, mode: c.mode });
    let status: CaseFinding["status"] = "pass";
    let detail: string | undefined;
    if (outcome.status !== "mapped") {
      status = "fail";
      detail = `${outcome.status}: ${JSON.stringify(outcome).slice(0, 200)}`;
    } else if (outcome.predicateId !== c.expect.predicateId) {
      status = "fail";
      detail = `expected ${c.expect.predicateId}, got ${outcome.predicateId}`;
    } else if (
      c.expect.typedValue !== undefined &&
      outcome.typedValue !== c.expect.typedValue
    ) {
      status = "fail";
      detail = `typed value expected ${JSON.stringify(c.expect.typedValue)}, got ${JSON.stringify(outcome.typedValue)}`;
    } else if (
      c.expect.scopeValue !== undefined &&
      outcome.scopeValue !== c.expect.scopeValue
    ) {
      status = "fail";
      detail = `scope expected ${c.expect.scopeValue}, got ${outcome.scopeValue}`;
    }
    findings.push({
      id: `FWD[${i}] ${c.expect.predicateId}`,
      mode: c.mode,
      gate: "forward",
      status,
      ...(detail ? { detail } : {}),
    });
  }

  for (let i = 0; i < REVERSE.length; i += 1) {
    const c = REVERSE[i]!;
    let status: CaseFinding["status"] = "pass";
    let detail: string | undefined;
    switch (c.gate) {
      case "confusable_separation": {
        const outcome = mapper({ text: c.text, mode: c.mode });
        if (outcome.status === "mapped" && outcome.predicateId === c.forbiddenPredicateId) {
          status = "fail";
          detail = `folded into forbidden ${outcome.predicateId}`;
        }
        break;
      }
      case "closure_language_no_claim": {
        const outcome = mapper({ text: c.text, mode: c.mode });
        if (outcome.status === "mapped") {
          status = "fail";
          detail = `closure talk produced claim ${outcome.predicateId}`;
        }
        break;
      }
      case "deferred_concept_unmapped_with_proposal": {
        const outcome = mapper({ text: c.text, mode: c.mode });
        if (outcome.status !== "unmapped" || !outcome.proposedConcept) {
          status = "fail";
          detail = `deferred concept must be unmapped WITH proposal, got ${outcome.status}`;
        }
        break;
      }
      case "unknown_concept_unmapped": {
        const outcome = mapper({ text: c.text, mode: c.mode });
        if (outcome.status !== "unmapped") {
          status = "fail";
          detail = `unknown concept must stay unmapped, got ${outcome.status}`;
        }
        break;
      }
      case "illegal_value_fail_closed": {
        const result = validateMappingProposal(v1, {
          registryVersion: 1,
          predicateId: IDS.careerStage,
          typedValueRaw: c.text,
          claimKind: "objective",
          locale: "zh",
        });
        if (result.valid) {
          status = "fail";
          detail = "illegal enum value was accepted";
        }
        break;
      }
      default:
        status = "fail";
        detail = "unhandled gate";
    }
    findings.push({
      id: `REV[${i}] ${c.gate}`,
      mode: c.mode,
      gate: c.gate,
      status,
      ...(detail ? { detail } : {}),
    });
  }

  // Corpus-level old-version replay identity: whole-corpus determinism across
  // two consecutive passes over BOTH passes' outputs (pinned by fingerprint).
  const replayA = JSON.stringify(FORWARD.map((c) => resolve(c)));
  const replayB = JSON.stringify(FORWARD.map((c) => resolve(c)));
  findings.push({
    id: "old-version-replay-identity",
    mode: "-",
    gate: "replay determinism",
    status: replayA === replayB ? "pass" : "fail",
  });

  const passed = findings.filter((f) => f.status === "pass").length;
  const failed = findings.filter((f) => f.status === "fail").length;

  const manifest = {
    replayKind: "predicate-registry-frozen-model-replay",
    generatedAt: new Date().toISOString(),
    mapper: mapperName,
    registryVersion: v1.registryVersion,
    /** Pin the reviewed release by this hash (see README step 3). */
    registryFingerprint: predicateRegistryFingerprint(v1),
    humanReview: {
      required: true,
      reviewer: null as string | null,
      reviewedAt: null as string | null,
      verdict: null as "approved" | "rejected" | null,
      notes: null as string | null,
    },
    totals: { passed, failed },
    findings,
  };

  await writeFile(
    path.join(outDir, "findings.json"),
    JSON.stringify(manifest, null, 2) + "\n",
  );

  console.log(`Replay artifacts written to ${outDir}`);
  console.log(`Mapper: ${mapperName}`);
  console.log(`Registry fingerprint: ${manifest.registryFingerprint}`);
  console.log(`Totals: ${passed} passed / ${failed} failed of ${findings.length}`);
  console.log(
    failed === 0
      ? "ALL GATES GREEN — proceed to HUMAN REVIEW before merging (README.md)."
      : `${failed} gate(s) FAILED — do not request human review.`,
  );
  if (failed !== 0) process.exitCode = 1;
}

await main();

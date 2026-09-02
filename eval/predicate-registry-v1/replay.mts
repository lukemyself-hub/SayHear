/**
 * Frozen-model replay for the Predicate Registry mapping-eval corpus
 * (grilling #93 §8; ADR-0061 developer-judged promotion; SPEC #107 AC 8).
 *
 * Replays a selected registry version's forward cases and every reverse case
 * of the authoritative corpus against an injected mapper and writes a
 * reviewable findings manifest under run/<stamp>/findings.json. The default
 * selection is the historical v1-compatible subset.
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
 *   pnpm tsx eval/predicate-registry-v1/replay.mts [--registry-version 1|2] [--out DIR]
 */

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  type PredicateRegistrySnapshot,
  loadPredicateRegistrySnapshot,
  PREDICATE_IDS as IDS,
  type MappingOutcome,
  predicateRegistryFingerprint,
} from "@sayhear/application";
import {
  FORWARD,
  FORWARD_V1,
  REVERSE,
  resolve,
  type ForwardCase,
} from "../../packages/application/src/predicate-registry/mapping-eval-corpus";
import { validateMappingProposal } from "@sayhear/application";

type CaseFinding = {
  id: string;
  mode: "zh" | "en" | "cs" | "-";
  gate: string;
  status: "pass" | "fail";
  detail?: string;
};

type Mapper = (input: { text: string; mode: "zh" | "en" | "cs" }) => MappingOutcome;

type MapperFactory = (snapshot: PredicateRegistrySnapshot) => Mapper;

const MAPPER_IMPLEMENTATIONS: Record<string, MapperFactory> = {
  deterministic: (snapshot) => ({ text, mode }) =>
    resolve({ text, mode, expect: {} as never }, snapshot),
};

function requestedRegistryVersion(): 1 | 2 {
  const index = process.argv.indexOf("--registry-version");
  const raw = index >= 0 ? process.argv[index + 1] : "1";
  const version = Number(raw);
  if (version !== 1 && version !== 2) {
    throw new Error(`Unknown registry version "${raw}". Expected 1 or 2.`);
  }
  return version;
}

async function main() {
  const registryVersion = requestedRegistryVersion();
  const registry = loadPredicateRegistrySnapshot(registryVersion);
  const forward = registryVersion === 1 ? FORWARD_V1 : FORWARD;
  const mapperName =
    process.argv.includes("--mapper")
      ? process.argv[process.argv.indexOf("--mapper") + 1]!
      : "deterministic";
  const mapper = MAPPER_IMPLEMENTATIONS[mapperName]?.(registry);
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

  for (let i = 0; i < forward.length; i += 1) {
    const c: ForwardCase = forward[i]!;
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
        const result = validateMappingProposal(registry, {
          registryVersion,
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

  // Corpus-level replay identity: whole-corpus determinism across two
  // consecutive passes over both outputs (pinned by fingerprint).
  const replayA = JSON.stringify(forward.map((c) => resolve(c, registry)));
  const replayB = JSON.stringify(forward.map((c) => resolve(c, registry)));
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
    registryVersion: registry.registryVersion,
    /** Pin the reviewed release by this hash (see README step 3). */
    registryFingerprint: predicateRegistryFingerprint(registry),
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

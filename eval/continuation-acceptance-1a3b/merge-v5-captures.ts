import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import { canonicalJson, sha256 } from "./protocol";
import type {
  V5ArmRun,
  V5BatchMergeManifest,
  V5CatalogManifest,
  V5MainRun,
  V5TreatmentLedger,
  v5RecordsMatchExactSet,
} from "./protocol-v5";

const ROOT = "eval/continuation-acceptance-1a3b";

function rawSha256(raw: string): string {
  return createHash("sha256").update(raw).digest("hex");
}

function parseBatches(): string[] {
  const args = process.argv.slice(2);
  const index = args.indexOf("--batches");
  if (index < 0 || !args[index + 1]) {
    throw new Error("usage: merge-v5-captures.ts --batches batch-1[,batch-2,batch-3]");
  }
  const batches = args[index + 1]!.split(",");
  if (batches.length < 1 || batches.length > 3 || batches.some((entry) => !/^[a-z0-9-]+$/.test(entry))) {
    throw new Error("--batches must list one to three preregistered batch IDs.");
  }
  return batches;
}

async function readRun<T>(batchId: string, leaf: string) {
  const path = `${ROOT}/run-v5/batches/${batchId}/${leaf}.json`;
  const raw = await readFile(resolve(path), "utf8");
  return {
    path,
    raw,
    value: JSON.parse(raw) as T,
    fingerprint: {
      path,
      rawSha256: rawSha256(raw),
      canonicalJsonSha256: sha256(JSON.parse(raw) as unknown),
    },
  };
}

function assertUniqueExact(actual: readonly string[], expected: readonly string[], label: string): void {
  if (!v5RecordsMatchExactSet(actual, expected)) {
    throw new Error(`${label} records do not exactly match its preregistered batch.`);
  }
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(resolve(path)), { recursive: true });
  await writeFile(resolve(path), `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function main(): Promise<void> {
  const executedBatchIds = parseBatches();
  const catalog = JSON.parse(
    await readFile(resolve(`${ROOT}/fixtures-v5.json`), "utf8"),
  ) as V5CatalogManifest;
  const declaredBatches = catalog.batches ?? [];
  if (catalog.purpose !== "formal" || executedBatchIds.some((id, index) => declaredBatches[index]?.id !== id)) {
    throw new Error("Executed batches must be a prefix of the frozen formal batch order.");
  }

  const evidence = [] as Array<{
    id: string;
    main: Awaited<ReturnType<typeof readRun<V5MainRun>>>;
    off: Awaited<ReturnType<typeof readRun<V5ArmRun>>>;
    on: Awaited<ReturnType<typeof readRun<V5ArmRun>>>;
    ledger: Awaited<ReturnType<typeof readRun<V5TreatmentLedger>>>;
  }>;
  for (const id of executedBatchIds) {
    const [mainRun, offRun, onRun, ledger] = await Promise.all([
      readRun<V5MainRun>(id, "continuation-main"),
      readRun<V5ArmRun>(id, "continuation-off"),
      readRun<V5ArmRun>(id, "continuation-on"),
      readRun<V5TreatmentLedger>(id, "treatment-ledger"),
    ]);
    for (const [label, run] of [["main", mainRun.value], ["OFF", offRun.value], ["ON", onRun.value], ["ledger", ledger.value]] as const) {
      if (canonicalJson(run.executedBatchIds) !== canonicalJson([id])) {
        throw new Error(`${id}: ${label} run does not identify exactly its own batch.`);
      }
    }
    const expectedIds = declaredBatches.find((batch) => batch.id === id)!.sceneIds;
    assertUniqueExact(mainRun.value.responses.map((entry) => entry.fixtureId).filter((id, index, all) => all.indexOf(id) === index), expectedIds, `${id} main`);
    assertUniqueExact(offRun.value.scenarios.map((entry) => entry.fixtureId), expectedIds, `${id} OFF`);
    assertUniqueExact(onRun.value.scenarios.map((entry) => entry.fixtureId), expectedIds, `${id} ON`);
    assertUniqueExact(ledger.value.scenarios.map((entry) => entry.fixtureId), expectedIds, `${id} ledger`);
    evidence.push({ id, main: mainRun, off: offRun, on: onRun, ledger });
  }

  const first = evidence[0]!;
  for (const entry of evidence.slice(1)) {
    if (entry.main.value.evaluatorCommit !== first.main.value.evaluatorCommit ||
        entry.main.value.cleanIncumbentManifestFingerprint !== first.main.value.cleanIncumbentManifestFingerprint ||
        entry.main.value.conversationConfigurationFingerprint !== first.main.value.conversationConfigurationFingerprint ||
        entry.main.value.domainTime !== first.main.value.domainTime ||
        entry.off.value.configurationFingerprint !== first.off.value.configurationFingerprint ||
        entry.on.value.configurationFingerprint !== first.on.value.configurationFingerprint ||
        entry.ledger.value.configurationFingerprint !== first.ledger.value.configurationFingerprint ||
        entry.off.value.evaluatorCommit !== first.off.value.evaluatorCommit ||
        entry.on.value.evaluatorCommit !== first.on.value.evaluatorCommit ||
        entry.ledger.value.evaluatorCommit !== first.ledger.value.evaluatorCommit) {
      throw new Error(`${entry.id}: capture metadata differs from the first executed batch.`);
    }
  }

  const mergedMain: V5MainRun = {
    ...first.main.value,
    executedBatchIds,
    responses: evidence.flatMap((entry) => entry.main.value.responses),
  };
  const mergeArm = (arm: "off" | "on"): V5ArmRun => ({
    ...first[arm].value,
    executedBatchIds,
    scenarios: evidence.flatMap((entry) => entry[arm].value.scenarios),
  });
  const mergedOff = mergeArm("off");
  const mergedOn = mergeArm("on");
  const mergedLedger: V5TreatmentLedger = {
    ...first.ledger.value,
    executedBatchIds,
    scenarios: evidence.flatMap((entry) => entry.ledger.value.scenarios),
  };
  const body = {
    version: "1a3b-g2-batch-merge:v5" as const,
    executedBatchIds,
    batches: evidence.map((entry) => ({
      id: entry.id,
      main: entry.main.fingerprint,
      off: entry.off.fingerprint,
      on: entry.on.fingerprint,
      ledger: entry.ledger.fingerprint,
    })),
  };
  const mergeManifest: V5BatchMergeManifest = {
    ...body,
    manifestSha256: sha256(body),
  };
  await Promise.all([
    writeJson(`${ROOT}/run-v5/continuation-main.json`, mergedMain),
    writeJson(`${ROOT}/run-v5/continuation-off.json`, mergedOff),
    writeJson(`${ROOT}/run-v5/continuation-on.json`, mergedOn),
    writeJson(`${ROOT}/run-v5/treatment-ledger.json`, mergedLedger),
    writeJson(`${ROOT}/run-v5/batch-merge-manifest.json`, mergeManifest),
  ]);
  console.log(JSON.stringify({
    executedBatchIds,
    sceneCount: mergedLedger.scenarios.length,
    batchMergeManifest: `${ROOT}/run-v5/batch-merge-manifest.json`,
  }, null, 2));
}

if (process.argv[1]?.endsWith("merge-v5-captures.ts")) {
  main().catch((error: unknown) => {
    console.error("[g2-v5-merge] failed:", error);
    process.exitCode = 1;
  });
}

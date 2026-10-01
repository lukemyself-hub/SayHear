import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { verifyManifest, type AcceptanceManifest } from "../eval/continuation-acceptance-1a3b/manifest";
import { sha256, type FixtureCatalog, type ValidatorAdjudicationLedger } from "../eval/continuation-acceptance-1a3b/protocol";
import { validateValidatorLedger } from "../eval/continuation-acceptance-1a3b/review-package";
import { verifyCompletionCapture, VALIDATOR_COMPLETION_VERSION } from "./validator-completion";
async function main() {
  const args = process.argv.slice(2);
  const allowed = new Set(["--capture", "--catalog", "--manifest", "--out"]);
  const values = new Map<string, string>();
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index],
      value = args[index + 1];
    if (!key || !allowed.has(key) || !value || value.startsWith("--") || values.has(key)) throw new Error("Invalid completion arguments.");
    values.set(key, value);
  }
  const root = resolve(import.meta.dirname, "..");
  const path = (key: string) => {
    const value = values.get(key);
    if (!value) throw new Error(`${key} is required.`);
    const target = resolve(root, value);
    if (relative(root, target).startsWith("..")) throw new Error(`${key} must stay inside the repository.`);
    return target;
  };
  const capturePath = path("--capture");
  const bytes = await readFile(capturePath);
  const capture = JSON.parse(bytes.toString("utf8"));
  const catalog = JSON.parse(await readFile(path("--catalog"), "utf8")) as FixtureCatalog;
  const manifest = JSON.parse(await readFile(path("--manifest"), "utf8")) as AcceptanceManifest;
  if (!verifyManifest(manifest).passed || sha256(catalog) !== manifest.catalog.sha256 || capture.manifestFingerprint !== manifest.fingerprint || !Array.isArray(capture.cases)) {
    throw new Error("Completion capture, catalog and manifest must belong to the same frozen run.");
  }
  if (
    typeof capture.gitCommit !== "string" ||
    !/^[0-9a-f]{40}$/.test(capture.gitCommit) ||
    capture.gitDirty !== false ||
    capture.gitCommit !== manifest.gitCommit ||
    capture.catalogSha256 !== manifest.catalog.sha256 ||
    capture.pinsFingerprint !== manifest.pins.sha256
  ) {
    throw new Error(
      "Completion capture was not produced by the frozen manifest's clean commit, catalog and pins.",
    );
  }
  if (typeof capture.capturedAt !== "string" || Number.isNaN(new Date(capture.capturedAt).getTime())) throw new Error("Completion capture has no valid execution timestamp.");
  const pin = manifest.pinnedConfiguration.roles["narrative.validate"];
  if (!pin || capture.provider !== pin.provider || capture.model !== pin.model || capture.modelSnapshot !== pin.snapshot || capture.promptVersion !== pin.promptVersion || capture.schemaVersion !== pin.schemaVersion || sha256(capture.parameters) !== sha256(pin.parameters) || capture.maxOutputTokens !== pin.parameters.maxOutputTokens) {
    throw new Error("Completion capture does not match the frozen narrative.validate pin.");
  }
  const ledger: ValidatorAdjudicationLedger = {
    version: VALIDATOR_COMPLETION_VERSION,
    group: "validator",
    adjudicator: "capture-verifier",
    decidedAt: capture.capturedAt,
    manifestFingerprint: manifest.fingerprint,
    capturePath: relative(root, capturePath),
    captureSha256: createHash("sha256").update(bytes).digest("hex"),
    maxRejects: 0,
    entries: capture.cases.map((entry: {
      fixtureId: string;
      verdict: string;
    }) => ({
      fixtureId: entry.fixtureId,
      verdict: entry.verdict === "accepted" ? "accepted" : "rejected"
    }))
  };
  verifyCompletionCapture({
    ledger,
    catalog,
    root,
    expected: {
      catalogSha256: manifest.catalog.sha256,
      gitCommit: manifest.gitCommit,
      pinsFingerprint: manifest.pins.sha256,
    },
  });
  validateValidatorLedger({
    ledger,
    catalog
  });
  await writeFile(path("--out"), `${JSON.stringify(ledger, null, 2)}\n`, {
    flag: "wx",
    mode: 0o600
  });
  console.log(`[g1-completion] verified ${ledger.entries.length} completed validator cases.`);
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(() => {
    console.error("Validator completion production failed; no human ledger was modified.");
    process.exitCode = 1;
  });
}

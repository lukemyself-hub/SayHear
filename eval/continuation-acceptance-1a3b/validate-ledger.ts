import { readFile } from "node:fs/promises";

import {
  sha256,
  type FixtureCatalog,
  type ValidatorAdjudicationLedger,
} from "./protocol";
import { type AcceptanceManifest, verifyManifest } from "./manifest";
import { validateValidatorLedger } from "./review-package";

function required(arguments_: readonly string[], index: number, name: string): string {
  const value = arguments_[index];
  if (!value) throw new Error(`${name} requires a value.`);
  return value;
}

function parseArguments(): { catalog: string; ledger: string; manifest: string } {
  const arguments_ = process.argv.slice(2);
  const values = { catalog: "eval/continuation-acceptance-1a3b/fixtures.json", ledger: "", manifest: "" };
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    if (argument === "--catalog") values.catalog = required(arguments_, ++index, argument);
    else if (argument === "--ledger") values.ledger = required(arguments_, ++index, argument);
    else if (argument === "--manifest") values.manifest = required(arguments_, ++index, argument);
    else throw new Error(`Unknown argument: ${argument}`);
  }
  if (!values.ledger || !values.manifest) throw new Error("--ledger and --manifest are required.");
  return values;
}

async function readJson<T>(file: string): Promise<T> {
  return JSON.parse(await readFile(file, "utf8")) as T;
}

async function main(): Promise<void> {
  const arguments_ = parseArguments();
  const catalog = await readJson<FixtureCatalog>(arguments_.catalog);
  const ledger = await readJson<ValidatorAdjudicationLedger>(arguments_.ledger);
  const manifest = await readJson<AcceptanceManifest>(arguments_.manifest);
  const manifestVerification = verifyManifest(manifest);
  if (!manifestVerification.passed) {
    throw new Error(`Manifest verification failed: ${manifestVerification.mismatches.join("; ")}`);
  }
  if (sha256(catalog) !== manifest.catalog.sha256) {
    throw new Error("Validator catalog does not match the supplied manifest.");
  }
  if (ledger.manifestFingerprint !== manifest.fingerprint) {
    throw new Error("Validator ledger does not belong to the supplied manifest.");
  }
  const summary = validateValidatorLedger({ catalog, ledger });
  console.log(`[f3-validator] ${summary.accepted} accepted / ${summary.rejected} rejected / ${summary.total} total by Luke`);
  if (summary.rejected > 0) {
    console.error(`[f3-validator] formal validator acceptance failed: ${summary.rejected} cases were rejected`);
    process.exitCode = 1;
  }
}

main().catch((error: unknown) => {
  console.error("[f3-validator] ledger validation failed:", error);
  process.exitCode = 1;
});

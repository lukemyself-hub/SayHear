import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  buildValidatorRequestBundle,
  loadValidatorCatalog,
} from "./validator-inputs";
import { verifyManifest, type AcceptanceManifest } from "./manifest";
import { F3_LEDGER_VERSION, sha256, type FixtureCatalog } from "./protocol";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

function required(arguments_: readonly string[], index: number, name: string): string {
  const value = arguments_[index];
  if (!value) throw new Error(`${name} requires a value.`);
  return value;
}

function parseArguments(): { catalog: string; manifest: string; outDir: string; verdicts: string } {
  const arguments_ = process.argv.slice(2);
  const values = {
    catalog: "eval/continuation-acceptance-1a3b/fixtures.json",
    manifest: "eval/continuation-acceptance-1a3b/run/manifest.json",
    outDir: "eval/continuation-acceptance-1a3b/run",
    verdicts: "",
  };
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    if (argument === "--catalog") values.catalog = required(arguments_, ++index, argument);
    else if (argument === "--manifest") values.manifest = required(arguments_, ++index, argument);
    else if (argument === "--out-dir") values.outDir = required(arguments_, ++index, argument);
    else if (argument === "--verdicts") values.verdicts = required(arguments_, ++index, argument);
    else throw new Error(`Unknown argument: ${argument}`);
  }
  return values;
}

/** Mirrors the system seam: the writer premise is frozen into the generator manifest. */
function findingCodeFor(validatorErrorClass: string): string {
  switch (validatorErrorClass) {
    case "unsupported":
      return "unsupported";
    case "contradiction":
      return "contradiction";
    case "epistemic_upgrade":
      return "kind_upgrade";
    case "material_absence":
      return "material_absence";
    case "manifest_mismatch":
      return "manifest_mismatch";
    case "ambiguity":
      return "ambiguous";
    default:
      throw new Error(`Unknown validator error class ${validatorErrorClass}.`);
  }
}

function markdownForBundle(bundle: {
  cases: readonly {
    artifactKind: string;
    description: string;
    draftText: string;
    expectedFindingCode: string;
    expectedOutcome: "advisory" | "blocking";
    expectedVerdict: "accepted" | "blocked";
    fixtureId: string;
    languageVariant: string;
    locale: string;
    machineVerdict: null | {
      advisoryFindingCodes: readonly string[];
      blockingFindingCodes: readonly string[];
      model: string;
      outcome: string;
      provider: string;
      verdict: string;
    };
    plannedCoverageKeys: readonly string[];
    sourceEntries: readonly { sourceKey: string; text: string }[];
    validatorErrorClass: string;
  }[];
  manifestFingerprint: string;
}): string {
  const lines = [
    "# narrative.validate 18-case human review (ADR-0137, AC-X03)",
    "",
    `Manifest fingerprint: \`${bundle.manifestFingerprint}\``,
    "",
    "For each case: read the draft against the cited sources, then check the",
    "machine verdict (filled by the real-provider capture run) against the",
    "expected finding. Record accepted/rejected per case in",
    "`validator-ledger.template.json`. Bio blocks on every class; Reflection",
    "v1 records the same classes as advisory until calibrated blocking policy",
    "promotes them.",
    "",
  ];
  bundle.cases.forEach((entry, index) => {
    lines.push(`## ${index + 1}. ${entry.fixtureId}`);
    lines.push("");
    lines.push(
      `- language: ${entry.languageVariant} (${entry.locale}) | artifact: ${entry.artifactKind}`,
    );
    lines.push(
      `- planted error: ${entry.validatorErrorClass} | expected outcome: ${entry.expectedOutcome}`,
    );
    lines.push(
      `- expected verdict: ${entry.expectedVerdict} | expected finding: \`${entry.expectedFindingCode}\``,
    );
    lines.push(`- what was planted: ${entry.description}`);
    lines.push("");
    lines.push("Draft under review:");
    lines.push("");
    lines.push(`> ${entry.draftText}`);
    lines.push("");
    lines.push("Cited sources (planned coverage):");
    lines.push("");
    for (const source of entry.sourceEntries) {
      lines.push(`- \`${source.sourceKey}\`: ${source.text}`);
    }
    lines.push("");
    lines.push("Machine verdict (real-provider capture):");
    lines.push("");
    if (!entry.machineVerdict) {
      lines.push("- _pending: run the capture before adjudicating_");
    } else {
      lines.push(
        `- ${entry.machineVerdict.provider}/${entry.machineVerdict.model}: ` +
          `outcome=${entry.machineVerdict.outcome} verdict=${entry.machineVerdict.verdict}`,
      );
      lines.push(
        `- blocking: ${JSON.stringify(entry.machineVerdict.blockingFindingCodes)}`,
      );
      lines.push(
        `- advisory: ${JSON.stringify(entry.machineVerdict.advisoryFindingCodes)}`,
      );
    }
    lines.push("");
  });
  return `${lines.join("\n")}\n`;
}

async function main(): Promise<void> {
  const arguments_ = parseArguments();
  const catalog = loadValidatorCatalog(resolve(root, arguments_.catalog));
  const manifest = JSON.parse(
    await readFile(resolve(root, arguments_.manifest), "utf8"),
  ) as AcceptanceManifest;
  const manifestVerification = verifyManifest(manifest);
  if (!manifestVerification.passed) {
    throw new Error(`Manifest verification failed: ${manifestVerification.mismatches.join("; ")}`);
  }
  if (sha256(catalog as unknown as Record<string, unknown>) !== manifest.catalog.sha256) {
    throw new Error("Validator catalog does not match the supplied manifest.");
  }
  const bundles = buildValidatorRequestBundle(catalog as FixtureCatalog, {
    generatorManifests: {},
  });
  if (bundles.length !== 18) {
    throw new Error(`Expected 18 validator fixtures, found ${bundles.length}.`);
  }
  const fixtureById = new Map(
    (catalog as FixtureCatalog).scenarios
      .filter((scenario) => scenario.group === "validator")
      .map((scenario) => [scenario.id, scenario] as const),
  );
  let machineByFixture = new Map<string, {
    advisoryFindingCodes: readonly string[];
    blockingFindingCodes: readonly string[];
    model: string;
    outcome: string;
    provider: string;
    verdict: string;
  }>();
  if (arguments_.verdicts) {
    const verdictsFile = JSON.parse(
      await readFile(resolve(root, arguments_.verdicts), "utf8"),
    ) as {
      cases: readonly {
        advisoryFindingCodes: readonly string[];
        blockingFindingCodes: readonly string[];
        fixtureId: string;
        model: string;
        outcome: string;
        provider: string;
        verdict: string;
      }[];
      manifestFingerprint: string;
    };
    if (verdictsFile.manifestFingerprint !== manifest.fingerprint) {
      throw new Error("Machine verdicts do not belong to the supplied manifest.");
    }
    machineByFixture = new Map(
      verdictsFile.cases.map((entry) => [entry.fixtureId, entry]),
    );
    const missing = bundles
      .map((bundle) => bundle.fixtureId)
      .filter((fixtureId) => !machineByFixture.has(fixtureId));
    if (missing.length > 0) {
      throw new Error(`Machine verdicts are missing fixtures: ${missing.join(", ")}.`);
    }
  }
  const cases = bundles.map((bundle) => {
    const fixture = fixtureById.get(bundle.fixtureId);
    if (!fixture || fixture.group !== "validator") {
      throw new Error(`Catalog is missing validator fixture ${bundle.fixtureId}.`);
    }
    const generatorManifest =
      bundle.validatorErrorClass === "epistemic_upgrade"
        ? [
            {
              statementKey: `${bundle.fixtureId}:statement:1`,
              text: bundle.request.draftText,
              propositionStatements: [
                {
                  propositionKey: `${bundle.fixtureId}:proposition:1`,
                  normalizedProposition: bundle.request.draftText,
                  propositionKind: "impression" as const,
                  epistemicRendering: "inferred" as const,
                  supportKeys: [...bundle.request.sourceEntries.map((entry) => entry.sourceKey)],
                },
              ],
            },
          ]
        : [];
    return {
      artifactKind: bundle.artifactKind,
      description: fixture.description,
      draftText: bundle.request.draftText,
      draftRef: bundle.draftRef,
      expectedFindingCode: findingCodeFor(bundle.validatorErrorClass),
      expectedOutcome: fixture.expectedOutcome,
      // Derived from the case's own declared severity, not from its artifact
      // kind. Keying this to the kind is what let a Reflection case carry a
      // blocking-class defect while expecting the validator to wave it through
      // (ADR-0143).
      expectedVerdict: fixture.expectedOutcome === "blocking" ? "blocked" : "accepted",
      fixtureId: bundle.fixtureId,
      generatorManifest,
      languageVariant: fixture.languageVariant,
      locale: bundle.request.draftLocale ?? "",
      machineVerdict: machineByFixture.get(bundle.fixtureId) ?? null,
      plannedCoverageKeys: bundle.request.plannedCoverageKeys,
      sourceEntries: bundle.request.sourceEntries.map((entry) => ({
        sourceKey: entry.sourceKey,
        text: entry.text,
      })),
      validatorErrorClass: bundle.validatorErrorClass,
    };
  });
  const outDir = resolve(root, arguments_.outDir);
  await mkdir(outDir, { recursive: true });
  const reviewBundle = {
    version: "1a3b-f3-validator-review:v1",
    manifestFingerprint: manifest.fingerprint,
    cases,
  };
  await writeFile(
    resolve(outDir, "validator-review-bundle.json"),
    `${JSON.stringify(reviewBundle, null, 2)}\n`,
    "utf8",
  );
  await writeFile(
    resolve(outDir, "validator-review-bundle.md"),
    markdownForBundle(reviewBundle),
    "utf8",
  );
  const template = {
    _instructions:
      "Luke fills verdict per case after reading validator-review-bundle.md. Every verdict must be accepted or rejected; empty verdicts fail validation loudly. Do not add machineVerdict fields.",
    adjudicator: "Luke",
    decidedAt: "",
    entries: cases.map((entry) => ({
      fixtureId: entry.fixtureId,
      note: "",
      verdict: "",
    })),
    group: "validator",
    manifestFingerprint: manifest.fingerprint,
    version: F3_LEDGER_VERSION,
  };
  await writeFile(
    resolve(outDir, "validator-ledger.template.json"),
    `${JSON.stringify(template, null, 2)}\n`,
    "utf8",
  );
  console.log(
    `[f3-validator-review] wrote ${cases.length} cases + ledger template bound to ${manifest.fingerprint}`,
  );
}

main().catch((error: unknown) => {
  console.error("[f3-validator-review] failed:", error);
  process.exitCode = 1;
});

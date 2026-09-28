/**
 * Builds the self-contained human adjudication page for #252.
 *
 * Follows the eval/blind-pairwise precedent: the page embeds the public review
 * bundle only, calls no server, and opens straight from the file system. It is
 * a rendering of `validator-review-bundle.json`, not a new source of truth.
 *
 * The page writes Luke's verdicts in the shape `validateValidatorLedger`
 * expects. It deliberately does not carry `machineVerdict` into the exported
 * ledger, because the validator rejects ledger entries that contain one.
 *
 * Usage:
 *   pnpm exec tsx eval/continuation-acceptance-1a3b/build-validator-review-page.ts \
 *     --bundle eval/continuation-acceptance-1a3b/run/validator-review-bundle.json
 */
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { F3_LEDGER_VERSION } from "./protocol";

type Arguments = Readonly<{ bundle: string; out: string }>;

function parseArguments(): Arguments {
  const values = process.argv.slice(2);
  const bundleIndex = values.indexOf("--bundle");
  const bundle = bundleIndex >= 0 ? values[bundleIndex + 1] : undefined;
  if (!bundle) throw new Error("--bundle <validator-review-bundle.json> is required.");
  const outIndex = values.indexOf("--out");
  return {
    bundle,
    out: outIndex >= 0 && values[outIndex + 1]
      ? values[outIndex + 1]!
      : path.join(path.dirname(bundle), "index.html"),
  };
}

/**
 * Strips the request-side payload the page does not render. Keeps the bundle
 * small and keeps anything resembling raw request internals out of the artifact
 * Luke shares.
 */
function publicView(bundle: Record<string, unknown>): Record<string, unknown> {
  const cases = Array.isArray(bundle.cases) ? bundle.cases : [];
  return {
    manifestFingerprint: bundle.manifestFingerprint ?? null,
    cases: cases.map((entry) => {
      const record = entry as Record<string, unknown>;
      return {
        artifactKind: record.artifactKind,
        description: record.description,
        draftText: record.draftText,
        expectedFindingCode: record.expectedFindingCode,
        expectedOutcome: record.expectedOutcome,
        expectedVerdict: record.expectedVerdict,
        fixtureId: record.fixtureId,
        languageVariant: record.languageVariant,
        locale: record.locale,
        machineVerdict: record.machineVerdict ?? null,
        sourceEntries: record.sourceEntries ?? [],
        validatorErrorClass: record.validatorErrorClass,
      };
    }),
  };
}

async function main(): Promise<void> {
  const { bundle, out } = parseArguments();
  const bundlePath = path.resolve(bundle);
  const parsed = JSON.parse(await readFile(bundlePath, "utf8")) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Review bundle must contain an object.");
  }
  const view = publicView(parsed as Record<string, unknown>);
  const cases = view.cases as readonly { fixtureId: string }[];
  if (cases.length === 0) throw new Error("Review bundle has no cases.");
  if (!view.manifestFingerprint) {
    throw new Error("Review bundle is missing its manifest fingerprint.");
  }

  const template = await readFile(
    path.join(import.meta.dirname, "validator-review-page.template.html"),
    "utf8",
  );
  const marker = "const BUNDLE = /*__BUNDLE__*/;";
  if (!template.includes(marker)) throw new Error("Page template marker is missing.");
  const versionMarker = "const LEDGER_VERSION = /*__LEDGER_VERSION__*/;";
  if (!template.includes(versionMarker)) {
    throw new Error("Page template ledger-version marker is missing.");
  }

  // `<` is escaped so a draft containing markup cannot break out of the script
  // block when the page is opened locally.
  const payload = JSON.stringify(view).replaceAll("<", "\\u003c");
  const page = template
    .replace(marker, `const BUNDLE = ${payload};`)
    .replace(versionMarker, `const LEDGER_VERSION = ${JSON.stringify(F3_LEDGER_VERSION)};`);

  const outPath = path.resolve(out);
  await writeFile(outPath, page, "utf8");
  console.log(
    `[f3-validator-review] wrote ${path.relative(process.cwd(), outPath)} for ${cases.length} case(s).`,
  );
}

main().catch((error: unknown) => {
  console.error("[f3-validator-review] page build failed:", error);
  process.exitCode = 1;
});

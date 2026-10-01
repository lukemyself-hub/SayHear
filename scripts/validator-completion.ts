import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import type { ModelRoleConfigurationSnapshot } from "@sayhear/application";
import type { FixtureCatalog, ValidatorAdjudicationLedger } from "../eval/continuation-acceptance-1a3b/protocol";
export const VALIDATOR_COMPLETION_VERSION = "1a3b-f3-completion:v1" as const;

/** Check actual capture bytes, not a machine-generated claim of human approval. */
export function verifyCompletionCapture(input: {
  ledger: ValidatorAdjudicationLedger;
  catalog: FixtureCatalog;
  root: string;
  configuration?: ModelRoleConfigurationSnapshot | undefined;
}): void {
  const {
    ledger,
    catalog,
    root
  } = input;
  if (ledger.version !== VALIDATOR_COMPLETION_VERSION) return;
  const capturePath = ledger.capturePath;
  if (!capturePath || isAbsolute(capturePath)) throw new Error("Completion capture path must be repository-relative.");
  const path = resolve(root, capturePath);
  if (relative(root, path).startsWith("..")) throw new Error("Completion capture must stay inside the repository.");
  const bytes = readFileSync(path);
  if (createHash("sha256").update(bytes).digest("hex") !== ledger.captureSha256) {
    throw new Error("Completion capture bytes do not match their frozen hash.");
  }
  const capture = JSON.parse(bytes.toString("utf8")) as Record<string, unknown>;
  if (capture.manifestFingerprint !== ledger.manifestFingerprint || !Array.isArray(capture.cases)) {
    throw new Error("Completion capture does not belong to the frozen manifest.");
  }
  if (input.configuration && (capture.provider !== input.configuration.provider || capture.model !== input.configuration.model || capture.modelSnapshot !== input.configuration.modelSnapshot || capture.promptVersion !== input.configuration.promptVersion || capture.schemaVersion !== input.configuration.schemaVersion || capture.maxOutputTokens !== input.configuration.parameterSnapshot.maxOutputTokens)) {
    throw new Error("Completion capture does not match the frozen role configuration.");
  }
  const expected = new Set(catalog.scenarios.filter(x => x.group === "validator").map(x => x.id));
  const entries = new Map(ledger.entries.map(x => [x.fixtureId, x]));
  const seen = new Set<string>();
  for (const value of capture.cases) {
    const entry = value as Record<string, unknown>;
    const id = typeof entry.fixtureId === "string" ? entry.fixtureId : "";
    if (!expected.has(id) || seen.has(id) || entry.outcome !== "completed" || typeof entry.generationCommandId !== "string" || !entry.generationCommandId || typeof entry.modelRunAttemptId !== "string" || !entry.modelRunAttemptId || entry.verdict !== "accepted" && entry.verdict !== "blocked" || !Array.isArray(entry.blockingFindingCodes) || !Array.isArray(entry.advisoryFindingCodes) || entries.get(id)?.verdict !== (entry.verdict === "accepted" ? "accepted" : "rejected")) {
      throw new Error("Completion capture has a missing, duplicate, incomplete or inconsistent validator case.");
    }
    seen.add(id);
  }
  if (seen.size !== expected.size) throw new Error("Completion capture does not cover the frozen validator catalog.");
}

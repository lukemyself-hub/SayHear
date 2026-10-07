import { afterEach, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FixtureCatalog, ValidatorAdjudicationLedger } from "../eval/continuation-acceptance-1a3b/protocol";
import { verifyCompletionCapture } from "../scripts/validator-completion";
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, {
    recursive: true
  });
});
function fixture(verdict = "blocked") {
  const root = mkdtempSync(join(tmpdir(), "sayhear-completion-test-"));
  roots.push(root);
  const capture = {
    manifestFingerprint: "sha256:test",
    gitCommit: "a".repeat(40),
    gitDirty: false,
    catalogSha256: "sha256:catalog",
    pinsFingerprint: "sha256:pins",
    cases: [{
      fixtureId: "case-1",
      outcome: "completed",
      verdict,
      blockingFindingCodes: [],
      advisoryFindingCodes: [],
      generationCommandId: "command-1",
      modelRunAttemptId: "attempt-1"
    }]
  };
  const bytes = Buffer.from(JSON.stringify(capture));
  writeFileSync(join(root, "capture.json"), bytes);
  const ledger: ValidatorAdjudicationLedger = {
    version: "1a3b-f3-completion:v1",
    group: "validator",
    adjudicator: "capture-verifier",
    decidedAt: "2026-09-30",
    manifestFingerprint: capture.manifestFingerprint,
    capturePath: "capture.json",
    captureSha256: createHash("sha256").update(bytes).digest("hex"),
    entries: [{
      fixtureId: "case-1",
      verdict: verdict === "accepted" ? "accepted" : "rejected"
    }]
  };
  const frozenCatalog = JSON.parse(readFileSync(new URL("../eval/continuation-acceptance-1a3b/holdout/fixtures.json", import.meta.url), "utf8")) as FixtureCatalog;
  const base = frozenCatalog.scenarios.find(entry => entry.group === "validator")!;
  const catalog: FixtureCatalog = {
    ...frozenCatalog,
    scenarios: [{
      ...base,
      id: "case-1"
    }]
  };
  return {
    root,
    ledger,
    catalog,
    capture
  };
}
describe("G1 completion evidence", () => {
  it("accepts a completed semantic rejection without claiming human adjudication", () => {
    const input = fixture();
    expect(() => verifyCompletionCapture(input)).not.toThrow();
  });
  it("rejects tampered raw capture bytes", () => {
    const input = fixture();
    writeFileSync(join(input.root, "capture.json"), "{}");
    expect(() => verifyCompletionCapture(input)).toThrow("frozen hash");
  });
  it.each(["outcome", "generationCommandId", "modelRunAttemptId"])("rejects missing %s even with a matching artifact hash", key => {
    const input = fixture();
    const entry = input.capture.cases[0]!;
    const changed = {
      ...entry,
      [key]: null
    };
    const bytes = Buffer.from(JSON.stringify({
      ...input.capture,
      cases: [changed]
    }));
    writeFileSync(join(input.root, "capture.json"), bytes);
    expect(() => verifyCompletionCapture({
      ...input,
      ledger: {
        ...input.ledger,
        captureSha256: createHash("sha256").update(bytes).digest("hex")
      }
    })).toThrow("incomplete");
  });
  it("rejects a verdict ledger inconsistent with the actual recorded verdict", () => {
    const input = fixture();
    expect(() => verifyCompletionCapture({
      ...input,
      ledger: {
        ...input.ledger,
        entries: [{
          fixtureId: "case-1",
          verdict: "accepted"
        }]
      }
    })).toThrow("inconsistent");
  });
  it("rejects a capture whose recorded execution identity is dirty or incomplete", () => {
    const input = fixture();
    const rewrite = (patch: Record<string, unknown>) => {
      const bytes = Buffer.from(JSON.stringify({ ...input.capture, ...patch }));
      writeFileSync(join(input.root, "capture.json"), bytes);
      return {
        ...input,
        ledger: {
          ...input.ledger,
          captureSha256: createHash("sha256").update(bytes).digest("hex")
        }
      };
    };
    expect(() => verifyCompletionCapture(rewrite({ gitDirty: true }))).toThrow("clean frozen");
    expect(() => verifyCompletionCapture(rewrite({ gitCommit: undefined }))).toThrow("clean frozen");
    expect(() => verifyCompletionCapture(rewrite({ pinsFingerprint: undefined }))).toThrow("clean frozen");
  });
  it("refuses a capture produced on another commit, catalog or pins", () => {
    const input = fixture();
    const expected = {
      catalogSha256: "sha256:catalog",
      gitCommit: "a".repeat(40),
      pinsFingerprint: "sha256:pins",
    };
    expect(() => verifyCompletionCapture({ ...input, expected })).not.toThrow();
    expect(() =>
      verifyCompletionCapture({
        ...input,
        expected: { ...expected, gitCommit: "b".repeat(40) },
      }),
    ).toThrow("does not match the frozen release");
    expect(() =>
      verifyCompletionCapture({
        ...input,
        expected: { ...expected, pinsFingerprint: "sha256:other" },
      }),
    ).toThrow("does not match the frozen release");
  });
});

import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import {
  DAILY_RELEASE_VALIDATION_REQUEST_VERSION,
  FIXED_PR_CI_BASELINE,
  RELEASE_CHECKS,
  classifyReleaseImpact,
  formatDailyReleaseValidationSummary,
  main as runDailyReleaseValidation,
  parseDailyReleaseValidationRequest,
  planDailyReleaseValidation,
  type CapabilityAcceptanceTrigger,
  type ReleaseImpactKind,
  type ReleaseValidationRequest,
} from "../scripts/daily-release-validation.ts";

const repositoryRoot = new URL("../", import.meta.url);

const IMPACT_CHECKS: Readonly<Record<ReleaseImpactKind, readonly string[]>> = {
  ui: ["ui:portal-smoke"],
  "server-business": ["server:deterministic-behavior"],
  "reflection-journal": [
    "reflection:lineage",
    "reflection:idempotency",
    "reflection:cas-epoch-freshness",
  ],
  "prompt-budget": [
    "prompt-budget:synthetic-samples",
    "prompt-budget:effective-config-diff",
  ],
  "owner-permission": ["permission:isolation", "permission:race"],
  "purge-coverage": ["purge:full-restore-drill"],
  "provider-migration": [
    "provider:effective-config-diff",
    "provider:affected-role-calls",
    "provider:privacy-checks",
  ],
};

const FULL_ACCEPTANCE_CHECK = "capability:full-acceptance";
const FULL_PRODUCER_COMMAND = "pnpm release:g1:produce";

function request(
  overrides: Partial<ReleaseValidationRequest["change"]> = {},
  rest: Partial<ReleaseValidationRequest> = {},
): ReleaseValidationRequest {
  return {
    version: DAILY_RELEASE_VALIDATION_REQUEST_VERSION,
    change: {
      summary: "a change",
      declaredImpacts: [],
      changedPaths: [],
      ...overrides,
    },
    ...rest,
  };
}

function selectedIds(plan: ReturnType<typeof planDailyReleaseValidation>): string[] {
  return [
    ...plan.fixedBaseline,
    ...plan.targeted,
    ...plan.reused,
  ].map((entry) => entry.check.id);
}

describe("fixed PR CI baseline", () => {
  it("is exactly the validate composition, so the daily entry cannot drop a fixed check", async () => {
    const rootPackage = JSON.parse(
      await readFile(new URL("package.json", repositoryRoot), "utf8"),
    ) as { scripts?: Record<string, string> };
    const validateSteps = (rootPackage.scripts?.validate ?? "")
      .split("&&")
      .map((step) => step.trim().replace(/^pnpm /, ""))
      .map((step) => (step === "test" ? "test:ci" : step));

    const baselineCommands = RELEASE_CHECKS.filter((check) =>
      (FIXED_PR_CI_BASELINE as readonly string[]).includes(check.id),
    ).map((check) => check.command.replace(/^pnpm /, ""));

    expect(validateSteps.length).toBeGreaterThan(1);
    expect(baselineCommands.sort()).toEqual(validateSteps.sort());
  });

  it("keeps every baseline check in every plan, including an unknown impact", () => {
    const plan = planDailyReleaseValidation(request());

    expect(plan.fixedBaseline.map((entry) => entry.check.id).sort()).toEqual(
      [...FIXED_PR_CI_BASELINE].sort(),
    );
    for (const entry of plan.fixedBaseline) {
      expect(entry.source).toBe("fixed-baseline");
      expect(entry.disposition).toBe("run");
    }
  });
});

describe("per-impact check selection", () => {
  for (const [impact, expected] of Object.entries(IMPACT_CHECKS) as [
    ReleaseImpactKind,
    readonly string[],
  ][]) {
    it(`selects the targeted checks for a ${impact} change and never the full producer`, () => {
      const plan = planDailyReleaseValidation(
        request({ declaredImpacts: [impact], summary: `${impact} change` }),
      );

      const ids = selectedIds(plan);
      for (const id of expected) expect(ids).toContain(id);
      expect(ids).not.toContain(FULL_ACCEPTANCE_CHECK);
      expect(plan.fullAcceptance.required).toBe(false);
      expect(plan.fullAcceptance.trigger).toBeNull();
      expect(plan.producerInvocations).toEqual([]);
    });
  }

  it("adds a boundary change's targeted check from a path hint so a narrow declaration cannot miss it", () => {
    const plan = planDailyReleaseValidation(
      request({
        declaredImpacts: ["ui"],
        summary: "forgot to declare the migration",
        changedPaths: ["packages/data/migrations/0071_new_private_surface.sql"],
      }),
    );

    const purge = plan.targeted.find(
      (entry) => entry.check.id === "purge:full-restore-drill",
    );
    expect(purge).toBeDefined();
    expect(purge?.source).toBe("path-hint");
    expect(plan.fullAcceptance.required).toBe(false);
  });

  it("classifies path hints without granting capability acceptance", () => {
    const impact = classifyReleaseImpact(
      ["ui"],
      ["apps/web/app/page.tsx", "packages/ai/src/provider.ts"],
    );

    expect(impact.declared).toEqual(["ui"]);
    expect(impact.hinted).toContain("provider-migration");
    expect(impact.effective).toContain("provider-migration");
  });
});

describe("unknown impact is located, never escalated", () => {
  it("asks for the impact location instead of starting the full acceptance", () => {
    const plan = planDailyReleaseValidation(
      request({ changedPaths: ["docs/notes.md"] }),
    );

    expect(plan.requiresImpactLocation).toBe(true);
    expect(plan.impact.effective).toEqual([]);
    expect(plan.fullAcceptance.required).toBe(false);
    expect(selectedIds(plan)).not.toContain(FULL_ACCEPTANCE_CHECK);
    expect(plan.producerInvocations).toEqual([]);
  });
});

describe("full capability acceptance triggers", () => {
  const triggers: readonly [
    CapabilityAcceptanceTrigger,
    NonNullable<ReleaseValidationRequest["capability"]>,
  ][] = [
    ["new-capability-enabled", { newCapabilityEnabled: true }],
    ["major-contract-change", { majorContractChange: true }],
    ["external-mvp-release", { externalMvpRelease: true }],
  ];

  for (const [trigger, capability] of triggers) {
    it(`requires the 12-item producer only for ${trigger}`, () => {
      const plan = planDailyReleaseValidation(
        request({ declaredImpacts: ["ui"] }, { capability }),
      );

      expect(plan.fullAcceptance).toEqual({ required: true, trigger });
      expect(selectedIds(plan)).toContain(FULL_ACCEPTANCE_CHECK);
      expect(plan.producerInvocations).toEqual([FULL_PRODUCER_COMMAND]);
    });
  }

  it("includes the affected specialized checks alongside the producer", () => {
    const plan = planDailyReleaseValidation(
      request(
        { declaredImpacts: ["reflection-journal"] },
        { capability: { majorContractChange: true } },
      ),
    );

    const ids = selectedIds(plan);
    expect(ids).toContain(FULL_ACCEPTANCE_CHECK);
    expect(ids).toContain("reflection:lineage");
  });
});

describe("same-configuration UI and ordinary server commits", () => {
  for (const impact of ["ui", "server-business"] as const) {
    it(`requires no F3/Provider/hosted/Purge evidence, no pin update and no label rewrite for ${impact}`, () => {
      const plan = planDailyReleaseValidation(
        request({ declaredImpacts: [impact], summary: `${impact} only` }),
      );

      expect(plan.producerInvocations).toEqual([]);
      expect(plan.fullAcceptance.required).toBe(false);
      // No evidence producer that would rebuild F3/Provider/hosted/Purge evidence.
      for (const entry of plan.targeted) {
        expect(entry.check.fullProducer).toBe(false);
        expect(entry.check.providerCalls).toBe(false);
        expect(entry.check.modelCalls).toBe(false);
      }
      const ids = selectedIds(plan);
      expect(ids).not.toContain("provider:affected-role-calls");
      expect(ids).not.toContain("purge:full-restore-drill");
      expect(ids).not.toContain(FULL_ACCEPTANCE_CHECK);
    });
  }
});

describe("specialized verification behavior", () => {
  it("checks reflection lineage, idempotency and CAS/epoch/freshness without model calls", () => {
    const plan = planDailyReleaseValidation(
      request({ declaredImpacts: ["reflection-journal"] }),
    );

    const checks = plan.targeted.map((entry) => entry.check);
    expect(checks.map((check) => check.id)).toEqual(
      expect.arrayContaining([
        "reflection:lineage",
        "reflection:idempotency",
        "reflection:cas-epoch-freshness",
      ]),
    );
    for (const check of checks) {
      expect(check.modelCalls).toBe(false);
      expect(check.providerCalls).toBe(false);
    }
  });

  it("uses small fixed synthetic prompt/budget samples with no model calls and no new hard threshold", () => {
    const plan = planDailyReleaseValidation(
      request({ declaredImpacts: ["prompt-budget"] }),
    );

    const samples = plan.targeted.find(
      (entry) => entry.check.id === "prompt-budget:synthetic-samples",
    );
    expect(samples).toBeDefined();
    expect(samples?.check.modelCalls).toBe(false);
    expect(samples?.check.providerCalls).toBe(false);
    expect(samples?.rationale).toMatch(/completion, format, safety boundaries/);
    expect(plan.targeted.some((entry) => entry.check.id === "prompt-budget:effective-config-diff"))
      .toBe(true);
  });

  it("checks owner/permission isolation and races, purge drill and provider role/privacy checks", () => {
    const permission = planDailyReleaseValidation(
      request({ declaredImpacts: ["owner-permission"] }),
    );
    expect(selectedIds(permission)).toEqual(
      expect.arrayContaining(["permission:isolation", "permission:race"]),
    );

    const purge = planDailyReleaseValidation(
      request({ declaredImpacts: ["purge-coverage"] }),
    );
    expect(selectedIds(purge)).toContain("purge:full-restore-drill");

    const provider = planDailyReleaseValidation(
      request({ declaredImpacts: ["provider-migration"] }),
    );
    expect(selectedIds(provider)).toEqual(
      expect.arrayContaining([
        "provider:affected-role-calls",
        "provider:privacy-checks",
      ]),
    );
  });
});

describe("content identity, retention and affected-only rerun", () => {
  it("reuses a same-byte passing artifact instead of re-parsing it", () => {
    const plan = planDailyReleaseValidation(
      request(
        { declaredImpacts: ["ui"] },
        {
          previousArtifacts: [
            { checkId: "baseline:typecheck", contentSha256: "a".repeat(64), result: "passed" },
          ],
          currentInputs: [
            { checkId: "baseline:typecheck", contentSha256: "a".repeat(64) },
          ],
        },
      ),
    );

    const reused = plan.reused.find((entry) => entry.check.id === "baseline:typecheck");
    expect(reused?.disposition).toBe("reused");
    expect(plan.fixedBaseline.some((entry) => entry.check.id === "baseline:typecheck")).toBe(false);
  });

  it("retains a failed result and reruns only the affected check rather than resampling", () => {
    const plan = planDailyReleaseValidation(
      request(
        { declaredImpacts: ["ui"] },
        {
          previousArtifacts: [
            {
              checkId: "ui:portal-smoke",
              contentSha256: "b".repeat(64),
              result: "failed",
              evidencePath: "artifacts/portal-smoke-failure.log",
            },
            { checkId: "baseline:build", contentSha256: "c".repeat(64), result: "failed" },
          ],
          currentInputs: [
            { checkId: "baseline:build", contentSha256: "c".repeat(64) },
          ],
        },
      ),
    );

    const rerun = plan.targeted.find((entry) => entry.check.id === "ui:portal-smoke");
    expect(rerun?.disposition).toBe("rerun-retained-failure");
    const build = plan.fixedBaseline.find((entry) => entry.check.id === "baseline:build");
    expect(build?.disposition).toBe("rerun-retained-failure");
    expect(plan.reused.some((entry) => entry.check.id === "baseline:build")).toBe(false);
  });

  it("reuses the effective-config module from #278 and reports its digest and blockers", async () => {
    const baseline = JSON.parse(
      await readFile(
        new URL("tests/fixtures/daily-release-validation/baseline.json", repositoryRoot),
        "utf8",
      ),
    ) as unknown;
    const candidate = JSON.parse(
      await readFile(
        new URL("tests/fixtures/daily-release-validation/candidate.json", repositoryRoot),
        "utf8",
      ),
    ) as unknown;

    const plan = planDailyReleaseValidation(
      request(
        { declaredImpacts: ["prompt-budget"] },
        { effectiveConfig: { baseline, candidate } },
      ),
    );

    expect(plan.effectiveConfig).toBeDefined();
    expect(plan.effectiveConfig?.configDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(plan.effectiveConfig?.configDigest).not.toBe("d".repeat(64));
    expect(typeof plan.effectiveConfig?.compatible).toBe("boolean");
  });
});

describe("summary output", () => {
  it("shows the selection, disposition, content identity and on-demand evidence locations", () => {
    const plan = planDailyReleaseValidation(
      request(
        { declaredImpacts: ["ui"] },
        {
          previousArtifacts: [
            { checkId: "baseline:check-runtime", contentSha256: "e".repeat(64), result: "passed" },
            {
              checkId: "ui:portal-smoke",
              contentSha256: "f".repeat(64),
              result: "failed",
              evidencePath: "artifacts/portal-smoke-failure.log",
            },
          ],
          currentInputs: [
            { checkId: "baseline:check-runtime", contentSha256: "e".repeat(64) },
          ],
        },
      ),
    );
    const summary = formatDailyReleaseValidationSummary(plan);

    expect(summary).toContain("daily release validation");
    expect(summary).toContain("fixed_baseline=");
    expect(summary).toContain("targeted=ui:portal-smoke");
    expect(summary).toContain("producer_invocations=none");
    expect(summary).toContain("reused=");
    expect(summary).toContain("skipped=");
    expect(summary).toContain("disposition=rerun-retained-failure");
    expect(summary).toContain("evidence=artifacts/portal-smoke-failure.log");
  });
});

describe("CLI entry", () => {
  it("prints the fixed baseline plus targeted plan for an ordinary server commit, with no producer", async () => {
    const lines: string[] = [];
    const code = await runDailyReleaseValidation(
      [
        "--request",
        "tests/fixtures/daily-release-validation/requests/server-business.json",
      ],
      { stdout: (line) => lines.push(line) },
    );
    const output = lines.join("\n");

    expect(code).toBe(0);
    expect(output).toContain("fixed_baseline=baseline:check-runtime");
    expect(output).toContain("targeted=server:deterministic-behavior");
    expect(output).toContain("producer_invocations=none");
  });

  it("does not miss the purge drill for a boundary change declared only as UI", async () => {
    const lines: string[] = [];
    await runDailyReleaseValidation(
      [
        "--request",
        "tests/fixtures/daily-release-validation/requests/boundary-missed.json",
      ],
      { stdout: (line) => lines.push(line) },
    );
    const output = lines.join("\n");

    expect(output).toContain("purge:full-restore-drill");
    expect(output).toContain("producer_invocations=none");
  });
});

describe("request parsing", () => {
  it("rejects an unknown request version", () => {
    expect(() =>
      parseDailyReleaseValidationRequest({
        version: "nope",
        change: { summary: "x", declaredImpacts: [], changedPaths: [] },
      }),
    ).toThrow(/version/);
  });

  it("rejects an unknown declared impact", () => {
    expect(() =>
      parseDailyReleaseValidationRequest({
        version: DAILY_RELEASE_VALIDATION_REQUEST_VERSION,
        change: { summary: "x", declaredImpacts: ["magic"], changedPaths: [] },
      }),
    ).toThrow(/impact/);
  });
});

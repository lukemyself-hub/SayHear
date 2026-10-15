import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import {
  DAILY_RELEASE_VALIDATION_REQUEST_VERSION,
  FIXED_PR_CI_BASELINE,
  RELEASE_CHECKS,
  classifyReleaseImpact,
  dailyReleaseValidationExitCode,
  formatDailyReleaseValidationSummary,
  main as runDailyReleaseValidation,
  parseDailyReleaseValidationRequest,
  planDailyReleaseValidation,
  preMergeDeferralFor,
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
      .map((step) => step.trim().replace(/^pnpm /, ""));

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
    expect(selectedIds(plan)).toContain("migration:upgrade-compatibility");
    expect(plan.fullAcceptance.required).toBe(false);
  });

  it.each(["migrations", "migrations-purge-marker"])(
    "requires upgrade compatibility and retains Purge evidence for %s",
    (directory) => {
      const plan = planDailyReleaseValidation(
        request({
          declaredImpacts: ["ui"],
          changedPaths: [`packages/data/${directory}/0099_add_column.sql`],
        }),
      );
      const migration = plan.targeted.find(
        (entry) => entry.check.id === "migration:upgrade-compatibility",
      );

      expect(migration?.source).toBe("path-hint");
      expect(migration?.check.command).toBe(
        "pnpm exec vitest run tests/ci/migration-upgrade-compatibility.test.ts",
      );
      expect(migration?.check.providerCalls).toBe(false);
      expect(migration?.check.modelCalls).toBe(false);
      expect(selectedIds(plan)).toContain("purge:full-restore-drill");
      expect(plan.producerInvocations).toEqual([]);
    },
  );

  it("does not require an upgrade drill for unrelated server behavior", () => {
    const plan = planDailyReleaseValidation(
      request({
        declaredImpacts: ["server-business"],
        changedPaths: ["packages/application/src/server/fix.ts"],
      }),
    );

    expect(selectedIds(plan)).not.toContain("migration:upgrade-compatibility");
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

describe("migration upgrade compatibility", () => {
  const MIGRATION_UPGRADE_CHECK = "migration:upgrade-compatibility";
  const MIGRATION_UPGRADE_COMMAND =
    "pnpm exec vitest run tests/ci/migration-upgrade-compatibility.test.ts";
  const MIGRATION_PATHS = [
    "packages/data/migrations/0099_add_column.sql",
    "packages/data/migrations-purge-marker/0007_new_purge_table.sql",
  ];

  it.each(MIGRATION_PATHS)(
    "selects the upgrade drill exactly once from the %s path hint",
    (changedPath) => {
      const plan = planDailyReleaseValidation(
        request({ declaredImpacts: [], changedPaths: [changedPath] }),
      );
      const selected = plan.targeted.filter(
        (entry) => entry.check.id === MIGRATION_UPGRADE_CHECK,
      );

      expect(selected).toHaveLength(1);
      expect(selected[0]?.source).toBe("path-hint");
      expect(selected[0]?.check.command).toBe(MIGRATION_UPGRADE_COMMAND);
      expect(selected[0]?.check.evidenceLocation).toBe(
        "artifacts/vitest-report.json",
      );
      expect(plan.fullAcceptance.required).toBe(false);
    },
  );

  it("does not add the upgrade drill for a migration-free change", () => {
    const plan = planDailyReleaseValidation(
      request({ declaredImpacts: ["server-business"] }),
    );

    expect(selectedIds(plan)).not.toContain(MIGRATION_UPGRADE_CHECK);
  });

  it("keeps exactly the three registry-owned pre-merge deferrals", () => {
    const DEPLOYED_EFFECTIVE_CONFIGURATION = {
      reason: "requires-deployed-effective-configuration",
      followUp: { stage: "acceptance", command: "pnpm release:config:compare" },
    } as const;
    const expected = new Map<string, unknown>([
      ["prompt-budget:effective-config-diff", DEPLOYED_EFFECTIVE_CONFIGURATION],
      ["provider:effective-config-diff", DEPLOYED_EFFECTIVE_CONFIGURATION],
      [
        "provider:affected-role-calls",
        {
          reason: "requires-paid-live-provider-calls",
          followUp: {
            stage: "acceptance",
            command: "pnpm exec tsx scripts/capture-g1-role-provider-calls.ts",
          },
        },
      ],
    ]);

    expect(
      RELEASE_CHECKS.filter((check) => check.preMergeDeferral !== undefined)
        .map((check) => check.id)
        .sort(),
    ).toEqual([...expected.keys()].sort());

    for (const check of RELEASE_CHECKS) {
      if (expected.has(check.id)) {
        expect(preMergeDeferralFor(check.id)).toEqual(expected.get(check.id));
      } else {
        expect(preMergeDeferralFor(check.id)).toBeNull();
      }
    }
    expect(preMergeDeferralFor("no:such-check")).toBeNull();
  });
});

describe("unknown impact is located, never escalated", () => {
  it("keeps known evaluation tools on baseline while preserving runtime and declared migration gates", () => {
    const paths = [
      "eval/continuation-acceptance-1a3b/pins.json",
      "eval/continuation-acceptance-1a3b/role-provider-provisioning.ts",
      "eval/memory-pairwise-126/shared.ts",
      "scripts/capture-g1-role-provider-calls.ts",
      "tests/g1-capture-provider-adapters.test.ts",
    ];
    const tools = planDailyReleaseValidation(request({ changedPaths: paths }));
    expect(tools.requiresImpactLocation).toBe(false);
    expect(selectedIds(tools)).toEqual(FIXED_PR_CI_BASELINE);
    expect(classifyReleaseImpact([], [...paths, "packages/ai/src/provider.ts"]).effective)
      .toContain("provider-migration");
    expect(classifyReleaseImpact(["provider-migration"], paths).effective)
      .toContain("provider-migration");
    expect(classifyReleaseImpact([], [...paths, "unknown/tool.ts"]).located).toBe(false);
    expect(classifyReleaseImpact([], ["eval/unknown-provider.ts"]).effective)
      .toContain("provider-migration");
  });

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

  it("treats the PR approval apparatus as located without a behavior impact", () => {
    const paths = [
      "docs/agents/pr-auto-approval.md",
      "scripts/daily-release-validation.ts",
      "scripts/pr-approval-controller.ts",
      "scripts/pr-approval/integration-refresh.ts",
      "tests/pr-approval-integration-refresh.test.ts",
      "scripts/pr-review-gate.ts",
      "tests/pr-review-gate.test.ts",
    ];
    const plan = planDailyReleaseValidation(request({ changedPaths: paths }));

    expect(plan.requiresImpactLocation).toBe(false);
    expect(selectedIds(plan)).toEqual(FIXED_PR_CI_BASELINE);
    expect(classifyReleaseImpact([], [...paths, "unknown/tool.ts"]).located).toBe(false);
    expect(classifyReleaseImpact([], [...paths, "packages/ai/src/provider.ts"]).effective)
      .toContain("provider-migration");
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

  it("exits non-zero and asks for the impact location instead of a green plan", async () => {
    const lines: string[] = [];
    const code = await runDailyReleaseValidation(
      [
        "--request",
        "tests/fixtures/daily-release-validation/requests/unknown.json",
      ],
      { stdout: (line) => lines.push(line) },
    );

    expect(code).not.toBe(0);
    expect(lines.join("\n")).toContain("requires_impact_location=true");
  });

  it("does not claim results without --execute, then records executed checks honestly", async () => {
    const planned: string[] = [];
    const plannedCode = await runDailyReleaseValidation(
      [
        "--request",
        "tests/fixtures/daily-release-validation/requests/server-business.json",
      ],
      { stdout: (line) => planned.push(line) },
    );
    expect(plannedCode).toBe(0);
    expect(planned.join("\n")).toContain(
      "check server:deterministic-behavior disposition=run execution=planned",
    );

    const calls: string[] = [];
    const lines: string[] = [];
    const code = await runDailyReleaseValidation(
      [
        "--request",
        "tests/fixtures/daily-release-validation/requests/server-business.json",
        "--execute",
      ],
      {
        stdout: (line) => lines.push(line),
        runner: async (command, args) => {
          calls.push([command, ...args].join(" "));
          return { stdout: "", stderr: "", exitCode: 0 };
        },
      },
    );
    const output = lines.join("\n");

    expect(code).toBe(0);
    expect(calls).toContain(
      "pnpm exec vitest run tests/private-write-gate.test.ts tests/startup-validation-runtime.test.ts",
    );
    expect(output).toContain(
      "check server:deterministic-behavior disposition=run execution=executed",
    );
    // The full `pnpm test:ci` baseline is never auto-run recursively.
    expect(calls.some((call) => call.startsWith("pnpm test:ci"))).toBe(false);
    expect(output).toContain("check baseline:test disposition=run execution=planned");
  });

  it("reports a failed executed check instead of a green plan", async () => {
    const lines: string[] = [];
    const code = await runDailyReleaseValidation(
      [
        "--request",
        "tests/fixtures/daily-release-validation/requests/server-business.json",
        "--execute",
      ],
      {
        stdout: (line) => lines.push(line),
        runner: async () => ({ stdout: "", stderr: "boom", exitCode: 1 }),
      },
    );

    expect(code).not.toBe(0);
    expect(lines.join("\n")).toContain(
      "check server:deterministic-behavior disposition=run execution=failed",
    );
  });
});

describe("promotion stage integration", () => {
  const snapshot = (commit: string, deploymentId: string, items: unknown[]) => ({
    version: "1a3b-g1-effective-runtime-config:v1",
    commit,
    deploymentId,
    collectedAt: "2026-10-07T20:00:00.000Z",
    items,
  });
  const deadline = (value: number) => ({
    category: "deadline-budgets",
    critical: true,
    inManifestFingerprint: true,
    key: "deadline.provider_ms",
    source: "override",
    value,
  });
  const sharedProvider = [
    {
      category: "provider",
      critical: true,
      inManifestFingerprint: true,
      key: "provider.adapter",
      source: "override",
      value: "opencode-go",
    },
  ];
  const isolated = snapshot("a".repeat(40), "dpl_isolated", [
    ...sharedProvider,
    deadline(300_000),
  ]);
  const production = snapshot("b".repeat(40), "dpl_production", [
    ...sharedProvider,
    deadline(300_000),
  ]);
  const blockedCandidate = snapshot("c".repeat(40), "dpl_candidate", [
    ...sharedProvider,
    deadline(120_000),
  ]);

  it("selects the promotion config report only at the promotion stage", () => {
    const acceptance = planDailyReleaseValidation(
      request({ declaredImpacts: ["ui"] }),
    );
    expect(selectedIds(acceptance)).not.toContain("promotion:effective-config-diff");

    const promotion = planDailyReleaseValidation({
      ...request({ declaredImpacts: ["ui"] }),
      releaseStage: "promotion",
    });
    expect(promotion.releaseStage).toBe("promotion");
    expect(selectedIds(promotion)).toContain("promotion:effective-config-diff");
    expect(promotion.producerInvocations).toEqual([]);
  });

  it("surfaces a blocked promotion report in the plan and summary", () => {
    const plan = planDailyReleaseValidation({
      ...request({ declaredImpacts: ["ui"] }),
      releaseStage: "promotion",
      promotionConfig: {
        isolatedAcceptance: isolated,
        currentProduction: production,
        candidateDeployment: blockedCandidate,
      },
    });

    expect(plan.promotion).toBeDefined();
    expect(plan.promotion?.promotionAllowed).toBe(false);
    expect(plan.promotion?.blockers).toEqual([
      expect.objectContaining({ key: "deadline.provider_ms" }),
    ]);
    const summary = formatDailyReleaseValidationSummary(plan);
    expect(summary).toContain("release_stage=promotion");
    expect(summary).toContain("promotion_allowed=false");
  });

  it("reports a clean promotion when the candidate matches production", () => {
    const plan = planDailyReleaseValidation({
      ...request({ declaredImpacts: ["ui"] }),
      releaseStage: "promotion",
      promotionConfig: {
        isolatedAcceptance: isolated,
        currentProduction: production,
        candidateDeployment: production,
      },
    });

    expect(plan.promotion?.promotionAllowed).toBe(true);
    expect(plan.promotion?.blockers).toEqual([]);
    expect(dailyReleaseValidationExitCode(plan)).toBe(0);
  });

  it("exits non-zero while the promotion is blocked", () => {
    const plan = planDailyReleaseValidation({
      ...request({ declaredImpacts: ["ui"] }),
      releaseStage: "promotion",
      promotionConfig: {
        isolatedAcceptance: isolated,
        currentProduction: production,
        candidateDeployment: blockedCandidate,
      },
    });

    expect(plan.promotion?.promotionAllowed).toBe(false);
    expect(dailyReleaseValidationExitCode(plan)).not.toBe(0);
  });

  it("exits non-zero when the effective configuration is incompatible", () => {
    const plan = planDailyReleaseValidation(
      request(
        { declaredImpacts: ["prompt-budget"] },
        {
          effectiveConfig: {
            baseline: snapshot("a".repeat(40), "dpl_baseline", [...sharedProvider]),
            candidate: snapshot("b".repeat(40), "dpl_candidate", [
              { ...sharedProvider[0], value: "openai" },
            ]),
          },
        },
      ),
    );

    expect(plan.effectiveConfig?.compatible).toBe(false);
    expect(dailyReleaseValidationExitCode(plan)).not.toBe(0);
  });

  it("rejects an unknown release stage", () => {
    expect(() =>
      parseDailyReleaseValidationRequest({
        version: DAILY_RELEASE_VALIDATION_REQUEST_VERSION,
        change: { summary: "x", declaredImpacts: [], changedPaths: [] },
        releaseStage: "deploy",
      }),
    ).toThrow(/releaseStage/);
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

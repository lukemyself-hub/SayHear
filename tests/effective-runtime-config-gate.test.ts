import { createServer, type Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  EFFECTIVE_RUNTIME_CONFIG_CATEGORIES,
  EFFECTIVE_RUNTIME_CONFIG_VERSION,
  compareEffectiveRuntimeConfiguration,
  evaluateAcceptanceDeadlineBudget,
  formatEffectiveRuntimeConfigurationComparison,
  parseEffectiveConfigurationSnapshot,
  readEffectiveRuntimeConfiguration,
  type AcceptanceDeadlineBudget,
  type EffectiveConfigurationItem,
  type EffectiveConfigurationSnapshot,
} from "../scripts/effective-runtime-config-gate.ts";

function item(
  overrides: Partial<EffectiveConfigurationItem> &
    Pick<EffectiveConfigurationItem, "category" | "key">,
): EffectiveConfigurationItem {
  return {
    critical: true,
    inManifestFingerprint: true,
    source: "default",
    value: "value",
    ...overrides,
  };
}

function snapshot(
  items: readonly EffectiveConfigurationItem[],
  overrides: Partial<EffectiveConfigurationSnapshot> = {},
): EffectiveConfigurationSnapshot {
  return {
    version: EFFECTIVE_RUNTIME_CONFIG_VERSION,
    commit: "a".repeat(40),
    deploymentId: "dpl_isolated_acceptance",
    collectedAt: "2026-10-07T20:00:00.000Z",
    items,
    ...overrides,
  };
}

// Non-isolation keys both environments must agree on for the compared behavior.
const sharedItems = [
  item({ category: "provider", key: "provider.adapter", value: "opencode-go", source: "override" }),
  item({ category: "provider", key: "provider.model", value: "deepseek-v4.1-flash", source: "override" }),
  item({ category: "deadline-budgets", key: "deadline.provider_ms", value: 300_000, defaultValue: 60_000 }),
];

// Every category SPEC #275 decision 6 requires, including the two that sit
// outside the release manifest fingerprint.
const isolatedItems = [
  item({ category: "prompt-schema-policy", key: "prompt.policy_bundle_version", value: "1a3b-model-role-policy:v1" }),
  item({ category: "parameters-budget", key: "parameters.weekly_max_output_tokens", value: 48_000 }),
  item({ category: "roles-switches", key: "switch.reflection_enabled", value: true, source: "override" }),
  item({ category: "runtime", key: "hosted.project_id", value: "prj_isolated" }),
  item({ category: "migrations-registry", key: "migrations.purge_surface_registry_version", value: "purge-surface-registry:v1" }),
  item({ category: "schedule-targets", key: "schedule.recovery_scan_target", value: null, source: "unverified", critical: false }),
  item({ category: "owner-auth", key: "owner.subject", value: "1001" }),
  item({ category: "database-identity", key: "database.business_target", value: "sha256:isolated-business" }),
  item({ category: "database-identity", key: "database.purge_marker_target", value: "sha256:isolated-marker" }),
  item({ category: "backup-retention", key: "backup.policy_version", value: "neon-free-6h-pitr-1gb-limit" }),
  item({ category: "credentials", key: "credentials.provider_key", value: "present" }),
  item({ category: "deadline-budgets", key: "deadline.gateway_limit_ms", value: null, source: "unverified", critical: false, inManifestFingerprint: false }),
];

const healthyBaseline = snapshot([...sharedItems, ...isolatedItems]);

const productionItems = [
  ...sharedItems,
  item({ category: "prompt-schema-policy", key: "prompt.policy_bundle_version", value: "1a3b-model-role-policy:v1" }),
  item({ category: "parameters-budget", key: "parameters.weekly_max_output_tokens", value: 48_000 }),
  item({ category: "roles-switches", key: "switch.reflection_enabled", value: true, source: "override" }),
  item({ category: "runtime", key: "hosted.project_id", value: "prj_current" }),
  item({ category: "migrations-registry", key: "migrations.purge_surface_registry_version", value: "purge-surface-registry:v1" }),
  item({ category: "schedule-targets", key: "schedule.recovery_scan_target", value: null, source: "unverified", critical: false }),
  item({ category: "owner-auth", key: "owner.subject", value: "2002" }),
  item({ category: "database-identity", key: "database.business_target", value: "sha256:current-business" }),
  item({ category: "database-identity", key: "database.purge_marker_target", value: "sha256:current-marker" }),
  item({ category: "backup-retention", key: "backup.policy_version", value: "neon-free-6h-pitr-1gb-limit" }),
  item({ category: "credentials", key: "credentials.provider_key", value: "present" }),
  item({ category: "deadline-budgets", key: "deadline.gateway_limit_ms", value: null, source: "unverified", critical: false, inManifestFingerprint: false }),
];

const productionSnapshot = snapshot(productionItems, {
  commit: "b".repeat(40),
  deploymentId: "dpl_current_production",
});

describe("effective runtime configuration comparison", () => {
  it("reports a matching deployment as compatible and binds commit, deployment, time and digest", () => {
    const comparison = compareEffectiveRuntimeConfiguration({
      baseline: healthyBaseline,
      candidate: productionSnapshot,
    });

    expect(comparison.compatible).toBe(true);
    expect(comparison.blocking).toEqual([]);
    expect(comparison.commit).toBe("b".repeat(40));
    expect(comparison.baseline.deploymentId).toBe("dpl_isolated_acceptance");
    expect(comparison.candidate.deploymentId).toBe("dpl_current_production");
    expect(comparison.baseline.collectedAt).toBe("2026-10-07T20:00:00.000Z");
    expect(comparison.candidate.configDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(comparison.baseline.configDigest).toMatch(/^[0-9a-f]{64}$/);
    // Commit identity alone does not make two snapshots identical.
    expect(comparison.baseline.configDigest).not.toBe(comparison.candidate.configDigest);
  });

  it("labels the isolated project, synthetic owner, database targets and credentials as expected separations", () => {
    const comparison = compareEffectiveRuntimeConfiguration({
      baseline: healthyBaseline,
      candidate: productionSnapshot,
    });

    for (const isolation of [
      "isolated-project",
      "synthetic-owner",
      "two-database-target",
      "credentials",
    ]) {
      expect(comparison.isolations.map((entry) => entry.isolation)).toContain(isolation);
    }
    const expectedIsolations = comparison.changes.filter(
      (change) => change.status === "expected-isolated-difference",
    );
    expect(expectedIsolations.length).toBeGreaterThanOrEqual(4);
    for (const change of comparison.changes) {
      expect(change.reason).not.toBe("");
      expect(change.impact).not.toBe("");
      expect(change.verification).not.toBe("");
      expect(change.rollback).not.toBe("");
    }
  });

  it("refuses to report an unreadable key item as equal", () => {
    const comparison = compareEffectiveRuntimeConfiguration({
      baseline: healthyBaseline,
      candidate: snapshot([
        ...productionItems.filter((entry) => entry.key !== "deadline.provider_ms"),
        item({
          category: "deadline-budgets",
          key: "deadline.provider_ms",
          source: "unverified",
          value: null,
        }),
      ], { deploymentId: "dpl_current_production" }),
    });

    expect(comparison.compatible).toBe(false);
    const providerDeadline = comparison.items.find(
      (entry) => entry.key === "deadline.provider_ms",
    );
    expect(providerDeadline?.status).toBe("unknown");
    expect(comparison.blocking.map((entry) => entry.key)).toContain(
      "deadline.provider_ms",
    );
  });

  it("blocks only the operation a critical incompatibility affects", () => {
    const comparison = compareEffectiveRuntimeConfiguration({
      baseline: healthyBaseline,
      candidate: snapshot(
        productionItems.map((entry) =>
          entry.key === "deadline.provider_ms" ? { ...entry, value: 120_000 } : entry,
        ),
        { deploymentId: "dpl_current_production" },
      ),
    });

    expect(comparison.compatible).toBe(false);
    expect(comparison.blocking).toHaveLength(1);
    expect(comparison.blocking[0]).toMatchObject({
      key: "deadline.provider_ms",
      operation: "acceptance",
      status: "incompatible",
    });
  });

  it("does not block acceptance on a non-critical unknown or non-critical difference", () => {
    const baseline = snapshot([
      ...sharedItems,
      ...isolatedItems.map((entry) =>
        entry.key === "schedule.recovery_scan_target"
          ? { ...entry, source: "platform" as const, value: "scheduled-scan" }
          : entry.key === "deadline.gateway_limit_ms"
            ? { ...entry, source: "platform" as const, value: 900_000 }
            : entry,
      ),
    ]);
    const candidate = snapshot(
      productionItems.map((entry) =>
        entry.key === "deadline.gateway_limit_ms"
          ? { ...entry, source: "platform" as const, value: 600_000 }
          : entry,
      ),
      { deploymentId: "dpl_current_production" },
    );
    const comparison = compareEffectiveRuntimeConfiguration({ baseline, candidate });

    const schedule = comparison.items.find(
      (entry) => entry.key === "schedule.recovery_scan_target",
    );
    const gateway = comparison.items.find(
      (entry) => entry.key === "deadline.gateway_limit_ms",
    );
    expect(schedule?.status).toBe("unknown");
    expect(gateway?.status).toBe("incompatible");
    expect(comparison.blocking).toEqual([]);
    expect(comparison.compatible).toBe(true);
    expect(comparison.changes.map((entry) => entry.key)).toContain(
      "schedule.recovery_scan_target",
    );
  });

  it("blocks when the two environments fail to prove database or project separation", () => {
    const notSeparated = compareEffectiveRuntimeConfiguration({
      baseline: healthyBaseline,
      candidate: snapshot(
        productionItems.map((entry) => {
          if (entry.key === "database.business_target") {
            return { ...entry, value: "sha256:isolated-business" };
          }
          if (entry.key === "hosted.project_id") {
            return { ...entry, value: "prj_isolated" };
          }
          return entry;
        }),
        { deploymentId: "dpl_current_production" },
      ),
    });

    expect(notSeparated.compatible).toBe(false);
    expect(notSeparated.blocking.map((entry) => entry.key)).toEqual(
      expect.arrayContaining([
        "database.business_target",
        "hosted.project_id",
      ]),
    );
  });

  it("never records a secret value or connection string in the comparison", () => {
    const comparison = compareEffectiveRuntimeConfiguration({
      baseline: healthyBaseline,
      candidate: productionSnapshot,
    });

    const serialized = JSON.stringify(comparison) + formatEffectiveRuntimeConfigurationComparison(comparison);
    expect(serialized).not.toContain("postgres://");
    expect(serialized).not.toContain("postgresql://");
    expect(serialized).not.toContain("sk-");
    expect(serialized).not.toContain("Bearer ");
  });

  it("includes key items that are outside the manifest fingerprint", () => {
    const comparison = compareEffectiveRuntimeConfiguration({
      baseline: snapshot([
        ...sharedItems,
        item({
          category: "deadline-budgets",
          key: "deadline.gateway_limit_ms",
          value: 900_000,
          inManifestFingerprint: false,
        }),
      ]),
      candidate: snapshot([
        ...sharedItems,
        item({
          category: "deadline-budgets",
          key: "deadline.gateway_limit_ms",
          value: 600_000,
          inManifestFingerprint: false,
        }),
      ]),
    });

    const gateway = comparison.items.find(
      (entry) => entry.key === "deadline.gateway_limit_ms",
    );
    expect(gateway?.inManifestFingerprint).toBe(false);
    expect(gateway?.status).toBe("incompatible");
  });

  it("names every category the release report must cover and surfaces it in the summary", () => {
    const categories = EFFECTIVE_RUNTIME_CONFIG_CATEGORIES.map((category) =>
      item({ category, key: `${category}.value`, value: `${category}-baseline` }),
    );
    const comparison = compareEffectiveRuntimeConfiguration({
      baseline: snapshot(categories),
      candidate: snapshot(
        categories.map((entry) =>
          entry.category === "deadline-budgets"
            ? { ...entry, value: "deadline-budgets-candidate" }
            : entry,
        ),
      ),
    });

    expect(comparison.compatible).toBe(false);
    expect(new Set(comparison.items.map((entry) => entry.category))).toEqual(
      new Set(EFFECTIVE_RUNTIME_CONFIG_CATEGORIES),
    );
    expect(
      formatEffectiveRuntimeConfigurationComparison(comparison),
    ).toContain("deadline-budgets.value");
  });
});

describe("parsing a deployed effective configuration snapshot", () => {
  it("round-trips a well-formed content-free snapshot", () => {
    const parsed = parseEffectiveConfigurationSnapshot(
      JSON.parse(JSON.stringify(productionSnapshot)),
    );
    expect(parsed.commit).toBe("b".repeat(40));
    expect(parsed.deploymentId).toBe("dpl_current_production");
    expect(parsed.items).toHaveLength(productionItems.length);
    expect(
      parsed.items.find((entry) => entry.key === "deadline.provider_ms")?.critical,
    ).toBe(true);
  });

  it("refuses malformed, duplicate-key and secret-bearing payloads", () => {
    expect(() => parseEffectiveConfigurationSnapshot(null)).toThrow();
    expect(() =>
      parseEffectiveConfigurationSnapshot({ ...productionSnapshot, commit: "short" }),
    ).toThrow();
    expect(() =>
      parseEffectiveConfigurationSnapshot({
        ...productionSnapshot,
        items: [
          item({ category: "provider", key: "provider.model", value: "x" }),
          item({ category: "provider", key: "provider.model", value: "x" }),
        ],
      }),
    ).toThrow(/duplicate/i);
    expect(() =>
      parseEffectiveConfigurationSnapshot({
        ...productionSnapshot,
        items: [
          item({
            category: "credentials",
            key: "credentials.provider_key",
            value: "sk-live-secret-value",
          }),
        ],
      }),
    ).toThrow(/secret|content-free|connection/i);
  });
});

describe("collecting the snapshot from the deployed side", () => {
  let server: Server;
  let baseUrl: string;
  let observedAuthorization: string | undefined;

  beforeAll(async () => {
    server = createServer((request, response) => {
      observedAuthorization = request.headers.authorization;
      if (request.url === "/unavailable") {
        response.writeHead(503, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: "unavailable" }));
        return;
      }
      if (request.url === "/leaky") {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(
          JSON.stringify({
            ...productionSnapshot,
            items: [
              item({
                category: "credentials",
                key: "credentials.provider_key",
                value: "postgres://user:pass@host/db",
              }),
            ],
          }),
        );
        return;
      }
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(productionSnapshot));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (address === null || typeof address === "string") {
      throw new Error("test server did not bind a port");
    }
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  });

  it("reads the deployed snapshot over bounded HTTP with the operator bearer", async () => {
    const collected = await readEffectiveRuntimeConfiguration({
      url: `${baseUrl}/effective-runtime-config`,
      token: "test-only-cron-secret",
      deploymentId: "dpl_isolated_acceptance",
    });

    expect(observedAuthorization).toBe("Bearer test-only-cron-secret");
    expect(collected.deploymentId).toBe("dpl_isolated_acceptance");
    expect(collected.commit).toBe("b".repeat(40));
    expect(collected.items.length).toBe(productionItems.length);
  });

  it("fails closed on a non-success response rather than falling back to local configuration", async () => {
    await expect(
      readEffectiveRuntimeConfiguration({
        url: `${baseUrl}/unavailable`,
        token: "test-only-cron-secret",
        deploymentId: "dpl_isolated_acceptance",
      }),
    ).rejects.toThrow(/unavailable|503/i);
  });

  it("refuses a deployed payload that contains a secret or connection string", async () => {
    await expect(
      readEffectiveRuntimeConfiguration({
        url: `${baseUrl}/leaky`,
        token: "test-only-cron-secret",
        deploymentId: "dpl_isolated_acceptance",
      }),
    ).rejects.toThrow(/secret|content-free|connection/i);
  });
});

const insufficientBudget: AcceptanceDeadlineBudget = {
  providerDeadlineMs: 120_000,
  workflowStepBudgetMs: 120_000,
  scanHttpDispatchBudgetMs: 120_000,
  scanDispatchAsyncOnly: true,
  acceptanceWaitWindowMs: 120_000,
  technicalRetryBudget: 2,
  interAttemptIntervalMs: 250,
  persistenceAllowanceMs: 5_000,
  schedulingAllowanceMs: 5_000,
  requiredBehaviorMs: 226_000,
};

describe("layered acceptance deadline budget", () => {
  it("detects a ~120s budget that cannot hold the observed ~226s Weekly behavior", () => {
    const result = evaluateAcceptanceDeadlineBudget(insufficientBudget);

    expect(result.compatible).toBe(false);
    const codes = result.findings.map((finding) => finding.code);
    expect(codes).toContain("workflow_step_budget_below_provider_deadline");
    expect(codes).toContain("acceptance_wait_window_below_required_budget");
    expect(codes).toContain("acceptance_wait_window_below_observed_behavior");
    expect(result.requiredWaitWindowMs).toBe(
      2 * (120_000 + 5_000) + 250 + 5_000,
    );
    for (const finding of result.findings) {
      expect(finding.layer).not.toBe("");
      expect(finding.operation).not.toBe("");
      expect(finding.rollback).not.toBe("");
    }
  });

  it("accepts a legitimate layered budget covering attempts, intervals, persistence and scheduling", () => {
    const result = evaluateAcceptanceDeadlineBudget({
      ...insufficientBudget,
      providerDeadlineMs: 300_000,
      workflowStepBudgetMs: 330_000,
      acceptanceWaitWindowMs: 900_000,
    });

    expect(result.compatible).toBe(true);
    expect(result.findings).toEqual([]);
    expect(result.requiredWaitWindowMs).toBe(
      2 * (330_000 + 5_000) + 250 + 5_000,
    );
  });

  it("detects a wait window that covers one attempt but not the allowed retries", () => {
    const result = evaluateAcceptanceDeadlineBudget({
      ...insufficientBudget,
      providerDeadlineMs: 300_000,
      workflowStepBudgetMs: 330_000,
      acceptanceWaitWindowMs: 340_000,
    });

    expect(result.compatible).toBe(false);
    expect(result.findings.map((finding) => finding.code)).toContain(
      "acceptance_wait_window_below_required_budget",
    );
  });

  it("detects a per-attempt layer that cannot reach the observed behavior even with an unbounded-wait-free window", () => {
    const result = evaluateAcceptanceDeadlineBudget({
      ...insufficientBudget,
      providerDeadlineMs: 110_000,
      workflowStepBudgetMs: 120_000,
      acceptanceWaitWindowMs: 900_000,
      technicalRetryBudget: 1,
    });

    expect(result.compatible).toBe(false);
    expect(result.findings.map((finding) => finding.code)).toContain(
      "layers_cannot_cover_observed_behavior",
    );
  });

  it("refuses to treat an async scan dispatch as the model terminal wait", () => {
    const result = evaluateAcceptanceDeadlineBudget({
      ...insufficientBudget,
      providerDeadlineMs: 300_000,
      workflowStepBudgetMs: 330_000,
      acceptanceWaitWindowMs: 900_000,
      scanDispatchAsyncOnly: false,
    });

    expect(result.compatible).toBe(false);
    expect(result.findings.map((finding) => finding.code)).toContain(
      "scan_dispatch_coupled_to_terminal_wait",
    );
  });

  it("rejects an unbounded or non-positive deadline instead of waiting forever", () => {
    for (const patch of [
      { acceptanceWaitWindowMs: Number.POSITIVE_INFINITY },
      { providerDeadlineMs: 0 },
      { technicalRetryBudget: 0 },
      { workflowStepBudgetMs: Number.NaN },
      { persistenceAllowanceMs: -1 },
    ]) {
      const result = evaluateAcceptanceDeadlineBudget({
        ...insufficientBudget,
        ...patch,
      });
      expect(result.compatible).toBe(false);
      expect(result.findings.map((finding) => finding.code)).toContain(
        "unbounded_or_invalid_budget",
      );
    }
  });
});

import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  buildG1PromotionConfigReport,
  collectG1PromotionSnapshots,
  formatG1PromotionConfigReport,
  main as runPromotionConfigReport,
  resolveScheduleTargetItems,
  scheduleTargetValue,
  type G1PromotionConfigReport,
  type ScheduleTargetReader,
} from "../scripts/g1-promotion-config-report.ts";
import type {
  EffectiveConfigurationItem,
  EffectiveConfigurationSnapshot,
} from "../scripts/effective-runtime-config-gate.ts";

const ACCEPTANCE_COMMIT = "a".repeat(40);
const PRODUCTION_COMMIT = "b".repeat(40);
const CANDIDATE_COMMIT = "c".repeat(40);

function item(
  overrides: Partial<EffectiveConfigurationItem> &
    Pick<EffectiveConfigurationItem, "category" | "key" | "value">,
): EffectiveConfigurationItem {
  return {
    critical: true,
    inManifestFingerprint: true,
    source: "override",
    ...overrides,
  };
}

function snapshot(
  items: readonly EffectiveConfigurationItem[],
  overrides: Partial<EffectiveConfigurationSnapshot> = {},
): EffectiveConfigurationSnapshot {
  return {
    version: "1a3b-g1-effective-runtime-config:v1",
    commit: PRODUCTION_COMMIT,
    deploymentId: "dpl_production",
    collectedAt: "2026-10-07T20:00:00.000Z",
    items,
    ...overrides,
  };
}

/** Behavioral keys both production and the candidate must agree on. */
const sharedBehavior = [
  item({ category: "provider", key: "provider.adapter", value: "opencode-go" }),
  item({ category: "provider", key: "provider.model", value: "deepseek-v4.1-flash" }),
  item({ category: "provider", key: "provider.snapshot", value: "deepseek-v4.1-flash" }),
  item({
    category: "deadline-budgets",
    key: "deadline.provider_ms",
    value: 300_000,
    defaultValue: 60_000,
  }),
  item({
    category: "deadline-budgets",
    key: "deadline.gateway_limit_ms",
    value: null,
    source: "unverified",
    critical: false,
    inManifestFingerprint: false,
  }),
  item({
    category: "parameters-budget",
    key: "parameters.episode.build.config_version",
    value: "episode.build:g1-release:v7",
  }),
  item({
    category: "parameters-budget",
    key: "parameters.episode.build.prompt_version",
    value: "episode-prompt:v1",
  }),
  item({
    category: "schedule-targets",
    key: "schedule.recovery_scan_target",
    value: "platform:recovery-scan",
    source: "platform",
    critical: false,
    inManifestFingerprint: false,
  }),
  item({
    category: "schedule-targets",
    key: "schedule.backup_renewal_target",
    value: "platform:backup-renewal",
    source: "platform",
    critical: false,
    inManifestFingerprint: false,
  }),
  item({
    category: "backup-retention",
    key: "backup.policy_version",
    value: "neon-free-6h-pitr-1gb-limit",
  }),
];

/** A valid isolated acceptance environment: expected separation only. */
const isolatedItems = [
  ...sharedBehavior,
  item({ category: "runtime", key: "hosted.project_id", value: "prj_isolated", source: "platform" }),
  item({ category: "owner-auth", key: "owner.subject", value: "synthetic-owner" }),
  item({
    category: "database-identity",
    key: "database.business_target",
    value: "sha256:isolated-business",
  }),
  item({
    category: "database-identity",
    key: "database.purge_marker_target",
    value: "sha256:isolated-marker",
  }),
  item({ category: "credentials", key: "credentials.provider_key", value: "present" }),
];

const productionItems = [
  ...sharedBehavior,
  item({ category: "runtime", key: "hosted.project_id", value: "prj_production", source: "platform" }),
  item({ category: "owner-auth", key: "owner.subject", value: "real-owner" }),
  item({
    category: "database-identity",
    key: "database.business_target",
    value: "sha256:production-business",
  }),
  item({
    category: "database-identity",
    key: "database.purge_marker_target",
    value: "sha256:production-marker",
  }),
  item({ category: "credentials", key: "credentials.provider_key", value: "present" }),
];

const isolatedAcceptance = snapshot(isolatedItems, {
  commit: ACCEPTANCE_COMMIT,
  deploymentId: "dpl_isolated_acceptance",
  collectedAt: "2026-10-07T10:00:00.000Z",
});

const currentProduction = snapshot(productionItems, {
  commit: PRODUCTION_COMMIT,
  deploymentId: "dpl_current_production",
  collectedAt: "2026-10-07T20:00:00.000Z",
});

const candidateDeployment = snapshot(productionItems, {
  commit: CANDIDATE_COMMIT,
  deploymentId: "dpl_candidate",
  collectedAt: "2026-10-07T21:00:00.000Z",
});

function build(
  overrides: Partial<Parameters<typeof buildG1PromotionConfigReport>[0]> = {},
): G1PromotionConfigReport {
  return buildG1PromotionConfigReport({
    isolatedAcceptance,
    currentProduction,
    candidateDeployment,
    ...overrides,
  });
}

function candidateWith(
  patch: (entry: EffectiveConfigurationItem) => EffectiveConfigurationItem,
): EffectiveConfigurationSnapshot {
  return snapshot(productionItems.map(patch), {
    commit: CANDIDATE_COMMIT,
    deploymentId: "dpl_candidate",
    collectedAt: "2026-10-07T21:00:00.000Z",
  });
}

function productionWith(
  patch: (entry: EffectiveConfigurationItem) => EffectiveConfigurationItem,
): EffectiveConfigurationSnapshot {
  return snapshot(productionItems.map(patch), {
    commit: PRODUCTION_COMMIT,
    deploymentId: "dpl_current_production",
    collectedAt: "2026-10-07T20:00:00.000Z",
  });
}

describe("repo-level schedule targets", () => {
  it("derives cron plus target selection from the workflow, and null when either is missing", () => {
    const recovery = [
      "on:",
      "  schedule:",
      '    - cron: "13 * * * *"',
      "          url=\"${OVERRIDE_URL:-$CONFIGURED_URL}\"",
      "          $url RECOVERY_SCAN_URL api/internal/recovery/scan",
    ].join("\n");
    const recoveryValue = scheduleTargetValue(recovery, "recovery");
    expect(recoveryValue).toContain("13 * * * *");
    expect(recoveryValue).toContain("/api/internal/recovery/scan");

    const backup = [
      "on:",
      "  schedule:",
      '    - cron: "13 4 1 * *"',
      "      - name: Record renewed backup evidence",
      "        run: pnpm db:record-backup",
    ].join("\n");
    const backupValue = scheduleTargetValue(backup, "backup");
    expect(backupValue).toContain("13 4 1 * *");
    expect(backupValue).toContain("db:record-backup");

    // A removed schedule or a removed target is null, never an assumed equal.
    expect(
      scheduleTargetValue("on:\n  workflow_dispatch:\n", "recovery"),
    ).toBeNull();
    expect(
      scheduleTargetValue('on:\n  schedule:\n    - cron: "13 * * * *"\n', "backup"),
    ).toBeNull();
  });

  it("resolves the two items through an injected ref reader and reports unreadable refs", async () => {
    const reader: ScheduleTargetReader = async (path) =>
      path.includes("recovery")
        ? 'on:\n  schedule:\n    - cron: "13 * * * *"\nRECOVERY_SCAN_URL api/internal/recovery/scan'
        : null;

    const resolution = await resolveScheduleTargetItems("b".repeat(40), reader);

    expect(resolution.items.map((entry) => entry.key)).toEqual([
      "schedule.recovery_scan_target",
    ]);
    expect(resolution.items[0]?.source).toBe("platform");
    expect(resolution.items[0]?.value).toContain("13 * * * *");
    expect(resolution.unreadable).toEqual(["schedule.backup_renewal_target"]);
  });
});

describe("promotion config report identity", () => {
  it("binds the actual candidate SHA, deployment, collection time and config digest", () => {
    const report = build();

    expect(report.version).toBe("1a3b-g1-promotion-config-report:v1");
    expect(report.commit).toBe(CANDIDATE_COMMIT);
    expect(report.deploymentId).toBe("dpl_candidate");
    expect(report.collectedAt).toBe("2026-10-07T21:00:00.000Z");
    expect(report.configDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(report.configDigest).toBe(report.promotionComparison.candidate.configDigest);
  });

  it("reports isolated, current-production and candidate effective values with sources", () => {
    const report = build();

    expect(report.environments.map((entry) => entry.role)).toEqual([
      "isolated-acceptance",
      "current-production",
      "candidate-deployment",
    ]);
    const candidate = report.environments.find(
      (entry) => entry.role === "candidate-deployment",
    );
    expect(candidate?.commit).toBe(CANDIDATE_COMMIT);
    expect(candidate?.deploymentId).toBe("dpl_candidate");
    expect(candidate?.configDigest).toBe(report.configDigest);

    const providerDeadline = candidate?.values.find(
      (entry) => entry.key === "deadline.provider_ms",
    );
    expect(providerDeadline).toMatchObject({
      source: "override",
      value: 300_000,
      defaultValue: 60_000,
    });
    const scheduleTarget = candidate?.values.find(
      (entry) => entry.key === "schedule.recovery_scan_target",
    );
    expect(scheduleTarget).toMatchObject({ source: "platform" });
    const outsideFingerprint = candidate?.values.find(
      (entry) => entry.key === "deadline.gateway_limit_ms",
    );
    expect(outsideFingerprint?.inManifestFingerprint).toBe(false);
  });

  it("compares isolated vs current production and candidate vs current production", () => {
    const report = build();

    expect(report.acceptanceComparison.baseline.deploymentId).toBe(
      "dpl_isolated_acceptance",
    );
    expect(report.acceptanceComparison.candidate.deploymentId).toBe(
      "dpl_current_production",
    );
    expect(report.promotionComparison.baseline.deploymentId).toBe(
      "dpl_current_production",
    );
    expect(report.promotionComparison.candidate.deploymentId).toBe("dpl_candidate");
  });

  it("states expected/unexpected, reason, behavior impact, verification, rollback value and action per difference", () => {
    const report = build();

    const isolation = report.differences.find(
      (entry) => entry.key === "hosted.project_id",
    );
    expect(isolation).toMatchObject({
      stage: "acceptance",
      expected: true,
      status: "expected-isolated-difference",
      rollbackValue: "prj_isolated",
    });
    for (const difference of report.differences) {
      expect(difference.reason).not.toBe("");
      expect(difference.behaviorImpact).not.toBe("");
      expect(difference.verification).not.toBe("");
      expect(difference.rollbackAction).not.toBe("");
      expect(difference.rollbackValue).not.toBeUndefined();
    }
  });
});

describe("promotion blocking and disclosure", () => {
  it("allows promotion when the candidate matches current production", () => {
    const report = build();

    expect(report.promotionAllowed).toBe(true);
    expect(report.blockers).toEqual([]);
  });

  it("does not treat expected isolation as a new human approval round", () => {
    const report = build();

    for (const key of [
      "hosted.project_id",
      "owner.subject",
      "database.business_target",
      "database.purge_marker_target",
      "credentials.provider_key",
    ]) {
      const difference = report.differences.find((entry) => entry.key === key);
      expect(difference?.expected).toBe(true);
      expect(difference?.stage).toBe("acceptance");
    }
    expect(report.blockers).toEqual([]);
  });

  it("blocks only the affected operation on a critical behavioral incompatibility", () => {
    const report = build({
      candidateDeployment: candidateWith((entry) =>
        entry.key === "deadline.provider_ms" ? { ...entry, value: 120_000 } : entry,
      ),
    });

    expect(report.promotionAllowed).toBe(false);
    expect(report.blockers).toHaveLength(1);
    expect(report.blockers[0]).toMatchObject({
      stage: "promotion",
      key: "deadline.provider_ms",
      operation: "acceptance",
      status: "incompatible",
    });
  });

  it("blocks the scheduled scan when current production had a trigger the candidate lost", () => {
    const report = build({
      candidateDeployment: candidateWith((entry) =>
        entry.key === "schedule.recovery_scan_target"
          ? { ...entry, value: null, source: "unverified" as const }
          : entry,
      ),
    });

    expect(report.promotionAllowed).toBe(false);
    expect(report.blockers[0]).toMatchObject({
      operation: "scheduled-scan",
      key: "schedule.recovery_scan_target",
    });
  });

  it("fires the lost-trigger blocker from repo-derived schedule targets over unverified deployment items", () => {
    const unverified = (snapshotWithItems: EffectiveConfigurationSnapshot) =>
      snapshot(
        snapshotWithItems.items.map((entry) =>
          entry.category === "schedule-targets"
            ? { ...entry, source: "unverified" as const, value: null }
            : entry,
        ),
        {
          commit: snapshotWithItems.commit,
          deploymentId: snapshotWithItems.deploymentId,
          collectedAt: snapshotWithItems.collectedAt,
        },
      );

    const report = build({
      currentProduction: unverified(currentProduction),
      candidateDeployment: unverified(candidateDeployment),
      scheduleTargets: {
        currentProduction: [
          item({
            category: "schedule-targets",
            key: "schedule.recovery_scan_target",
            value: "13 * * * * -> vars.RECOVERY_SCAN_URL -> /api/internal/recovery/scan",
            source: "platform",
            critical: false,
            inManifestFingerprint: false,
          }),
        ],
        candidateDeployment: [
          item({
            category: "schedule-targets",
            key: "schedule.recovery_scan_target",
            // A candidate whose workflow no longer has a schedule resolves to
            // null, so the comparison sees a real lost trigger.
            value: null,
            source: "platform",
            critical: false,
            inManifestFingerprint: false,
          }),
        ],
      },
    });

    expect(report.promotionAllowed).toBe(false);
    expect(
      report.blockers.some(
        (entry) =>
          entry.operation === "scheduled-scan" &&
          entry.key === "schedule.recovery_scan_target",
      ),
    ).toBe(true);
  });

  it("discloses but does not block on a non-critical difference outside the fingerprint", () => {
    const report = build({
      currentProduction: productionWith((entry) =>
        entry.key === "deadline.gateway_limit_ms"
          ? { ...entry, value: 900_000, source: "platform" as const }
          : entry,
      ),
      candidateDeployment: candidateWith((entry) =>
        entry.key === "deadline.gateway_limit_ms"
          ? { ...entry, value: 600_000, source: "platform" as const }
          : entry,
      ),
    });

    const gateway = report.differences.find(
      (entry) =>
        entry.key === "deadline.gateway_limit_ms" && entry.stage === "promotion",
    );
    expect(gateway?.status).toBe("incompatible");
    expect(gateway?.expected).toBe(false);
    expect(report.blockers.map((entry) => entry.key)).not.toContain(
      "deadline.gateway_limit_ms",
    );
    expect(report.promotionAllowed).toBe(true);
  });

  it("invalidates promotion when current production no longer matches the isolated acceptance", () => {
    const report = build({
      currentProduction: productionWith((entry) =>
        entry.key === "provider.model" ? { ...entry, value: "other-model" } : entry,
      ),
    });

    expect(report.promotionAllowed).toBe(false);
    expect(report.blockers[0]).toMatchObject({ stage: "acceptance" });
  });

  it("records a platform read blocker instead of claiming the comparison ran", () => {
    const report = build({
      platformReadBlockers: [
        { role: "current-production", reason: "status 503" },
      ],
    });

    expect(report.promotionAllowed).toBe(false);
    expect(report.platformReadBlockers).toEqual([
      { role: "current-production", reason: "status 503" },
    ]);
  });
});

describe("promotion rollback plan", () => {
  it("restores environment variables, redeploys and verifies authorization rather than merely reverting a commit", () => {
    const report = build({
      candidateDeployment: candidateWith((entry) =>
        entry.key === "deadline.provider_ms"
          ? { ...entry, value: 120_000 }
          : entry.key === "parameters.episode.build.config_version"
            ? { ...entry, value: "episode.build:g1-release:v8" }
            : entry,
      ),
    });

    const steps = report.rollback.steps.map((step) => step.action);
    expect(report.rollback.steps.map((step) => step.order)).toEqual([1, 2, 3, 4, 5]);
    expect(steps[0]).toMatch(/deadline\.provider_ms/);
    expect(steps[0]).toMatch(/variables/);
    expect(steps[1]).toMatch(/[Rr]edeploy/);
    expect(steps[2]).toMatch(/Revoke/);
    expect(steps[3]).toMatch(/Re-read the effective configuration/);
    expect(steps.join(" ")).not.toMatch(/revert commit/i);
  });

  it("reauthorizes only roles whose immutable configuration changed and reuses the rest", () => {
    const changed = build({
      candidateDeployment: candidateWith((entry) =>
        entry.key === "parameters.episode.build.config_version"
          ? { ...entry, value: "episode.build:g1-release:v8" }
          : entry.key === "parameters.episode.build.prompt_version"
            ? { ...entry, value: "episode-prompt:v2" }
            : entry,
      ),
    });

    expect(changed.rollback.authorization.reauthorizedRoles).toEqual([
      "episode.build",
    ]);
    expect([...changed.rollback.authorization.reusedRoles].sort()).toEqual(
      ["narrative.validate", "reflection.daily", "reflection.weekly"].sort(),
    );
    expect(changed.rollback.steps[2]?.action).toMatch(/episode\.build/);
    expect(changed.rollback.steps[2]?.action).toMatch(/rollout_pin_changed/);
    expect(changed.rollback.steps[2]?.action).toMatch(/never becomes current/);
  });

  it("accepts the single-role transition result from the caller", () => {
    const report = build({
      authorization: {
        reauthorizedRoles: ["reflection.weekly"],
        reusedRoles: ["episode.build", "reflection.daily", "narrative.validate"],
      },
    });

    expect(report.rollback.authorization.reauthorizedRoles).toEqual([
      "reflection.weekly",
    ]);
    expect(report.rollback.authorization.reusedRoles).toEqual([
      "episode.build",
      "narrative.validate",
      "reflection.daily",
    ]);
  });

  it("keeps historical acceptance evidence at its original commit and content identity", () => {
    const report = build();

    expect(report.rollback.historicalEvidence).toMatchObject({
      acceptanceCommit: ACCEPTANCE_COMMIT,
      acceptanceDeploymentId: "dpl_isolated_acceptance",
      contentIdentityPreserved: true,
    });
    expect(report.rollback.historicalEvidence.note).toMatch(/original commit/);
  });
});

function validSnapshot(commit: string, deploymentId: string) {
  return {
    version: "1a3b-g1-effective-runtime-config:v1",
    commit,
    deploymentId,
    collectedAt: "2026-10-07T20:00:00.000Z",
    items: [
      {
        category: "provider",
        critical: true,
        inManifestFingerprint: true,
        key: "provider.adapter",
        source: "override",
        value: "opencode-go",
      },
      {
        category: "credentials",
        critical: true,
        inManifestFingerprint: false,
        key: "credentials.provider_key",
        source: "override",
        value: "present",
      },
    ],
  };
}

describe("safe deployed-side collection", () => {
  let server: Server;
  let baseUrl: string;

  beforeAll(async () => {
    server = createServer((request, response) => {
      response.setHeader("content-type", "application/json");
      if (request.url === "/bad") {
        response.writeHead(503);
        response.end(JSON.stringify({ error: "unavailable" }));
        return;
      }
      const role = request.url === "/iso" ? "isolated-acceptance" : "current-production";
      const commit = request.url === "/cand" ? "c".repeat(40) : "b".repeat(40);
      response.writeHead(200);
      response.end(JSON.stringify(validSnapshot(commit, `dpl_${role}`)));
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

  it("collects all three snapshots through the shared reader", async () => {
    const collected = await collectG1PromotionSnapshots({
      targets: [
        { role: "isolated-acceptance", token: "t", url: `${baseUrl}/iso` },
        { role: "current-production", token: "t", url: `${baseUrl}/prod` },
        { role: "candidate-deployment", token: "t", url: `${baseUrl}/cand` },
      ],
    });

    expect(collected.status).toBe("collected");
    if (collected.status !== "collected") throw new Error("not collected");
    expect(collected.snapshots.candidateDeployment.commit).toBe("c".repeat(40));
  });

  it("fails closed when a required environment target is missing", async () => {
    const collected = await collectG1PromotionSnapshots({
      targets: [
        { role: "isolated-acceptance", token: "t", url: `${baseUrl}/iso` },
        { role: "current-production", token: "t", url: `${baseUrl}/prod` },
      ],
    });

    expect(collected.status).toBe("blocked");
    if (collected.status !== "blocked") throw new Error("not blocked");
    expect(collected.blockers.map((blocker) => blocker.role)).toContain(
      "candidate-deployment",
    );
  });

  it("records a blocker and does not claim a comparison when a deployment is unreadable", async () => {
    const collected = await collectG1PromotionSnapshots({
      targets: [
        { role: "isolated-acceptance", token: "t", url: `${baseUrl}/iso` },
        { role: "current-production", token: "t", url: `${baseUrl}/bad` },
        { role: "candidate-deployment", token: "t", url: `${baseUrl}/cand` },
      ],
    });

    expect(collected.status).toBe("blocked");
    if (collected.status !== "blocked") throw new Error("not blocked");
    expect(collected.blockers).toEqual([
      { role: "current-production", reason: expect.stringMatching(/503/) },
    ]);
  });
});

describe("content-free report", () => {
  it("never records a secret, connection string or private body", () => {
    const report = build();
    const serialized = JSON.stringify(report) + formatG1PromotionConfigReport(report);

    for (const forbidden of [
      "postgres://",
      "postgresql://",
      "sk-",
      "Bearer ",
      "-----BEGIN",
    ]) {
      expect(serialized).not.toContain(forbidden);
    }
  });

  it("marks an unreadable critical key unknown and blocks its operation instead of assuming equality", () => {
    const report = build({
      candidateDeployment: candidateWith((entry) =>
        entry.key === "backup.policy_version"
          ? { ...entry, value: null, source: "unverified" as const }
          : entry,
      ),
    });

    expect(report.promotionAllowed).toBe(false);
    expect(report.blockers[0]).toMatchObject({
      key: "backup.policy_version",
      operation: "backup-restore-drill",
      status: "unknown",
    });
  });
});

describe("promotion config report CLI", () => {
  async function withSnapshots<T>(
    candidate: EffectiveConfigurationSnapshot,
    run: (paths: { candidate: string; isolated: string; production: string; report: string }) => Promise<T>,
  ): Promise<T> {
    const directory = await mkdtemp(join(tmpdir(), "sayhear-282-promotion-"));
    const paths = {
      isolated: join(directory, "isolated.json"),
      production: join(directory, "production.json"),
      candidate: join(directory, "candidate.json"),
      report: join(directory, "report.json"),
    };
    await writeFile(paths.isolated, JSON.stringify(isolatedAcceptance));
    await writeFile(paths.production, JSON.stringify(currentProduction));
    await writeFile(paths.candidate, JSON.stringify(candidate));
    try {
      return await run(paths);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }

  it("writes the report and exits non-zero when a candidate change blocks promotion", async () => {
    const blocked = candidateWith((entry) =>
      entry.key === "deadline.provider_ms" ? { ...entry, value: 120_000 } : entry,
    );
    const lines: string[] = [];
    const result = await withSnapshots(blocked, async (paths) => {
      const code = await runPromotionConfigReport(
        [
          "--isolated",
          paths.isolated,
          "--production",
          paths.production,
          "--candidate",
          paths.candidate,
          "--report",
          paths.report,
        ],
        { stdout: (line) => lines.push(line) },
      );
      const report = JSON.parse(await readFile(paths.report, "utf8")) as {
        promotionAllowed?: boolean;
        blockers?: unknown[];
      };
      return { code, report };
    });

    expect(result.code).toBe(1);
    const output = lines.join("\n");
    expect(output).toContain("promotion_allowed=false");
    expect(output).toContain("blocker promotion acceptance deadline.provider_ms");
    expect(result.report.promotionAllowed).toBe(false);
    expect(result.report.blockers).toHaveLength(1);
  });

  it("exits zero and allows promotion for a candidate that matches current production", async () => {
    const lines: string[] = [];
    const code = await withSnapshots(candidateDeployment, (paths) =>
      runPromotionConfigReport(
        [
          "--isolated",
          paths.isolated,
          "--production",
          paths.production,
          "--candidate",
          paths.candidate,
        ],
        { stdout: (line) => lines.push(line) },
      ),
    );

    expect(code).toBe(0);
    expect(lines.join("\n")).toContain("promotion_allowed=true");
  });

  it("walks the synthetic promotion path: change blocks, lost trigger blocks, recovery verifies", async () => {
    const fixture = (name: string) =>
      new URL(`./fixtures/g1-promotion-config-report/${name}`, import.meta.url).pathname;
    const run = async (candidate: string) => {
      const lines: string[] = [];
      const code = await runPromotionConfigReport(
        [
          "--isolated",
          fixture("isolated.json"),
          "--production",
          fixture("production.json"),
          "--candidate",
          fixture(candidate),
        ],
        { stdout: (line) => lines.push(line) },
      );
      return { code, output: lines.join("\n") };
    };

    const blocked = await run("candidate-change.json");
    expect(blocked.code).toBe(1);
    expect(blocked.output).toContain("promotion_allowed=false");
    expect(blocked.output).toContain("blocker promotion acceptance deadline.provider_ms");

    const lostTrigger = await run("candidate-lost-trigger.json");
    expect(lostTrigger.code).toBe(1);
    expect(lostTrigger.output).toContain("blocker promotion scheduled-scan schedule.recovery_scan_target");

    // Recovery restores the candidate's variables to the current-production
    // values and redeploys; the comparison then verifies promotion is safe.
    const recovered = await run("candidate-recovered.json");
    expect(recovered.code).toBe(0);
    expect(recovered.output).toContain("promotion_allowed=true");
  });

  it("refuses a candidate snapshot that leaks a secret", async () => {
    const leaky = {
      ...candidateDeployment,
      items: [
        ...candidateDeployment.items,
        item({
          category: "credentials",
          key: "credentials.extra",
          value: "sk-live-leaked-secret-value",
        }),
      ],
    } as unknown as EffectiveConfigurationSnapshot;
    await expect(
      withSnapshots(leaky, (paths) =>
        runPromotionConfigReport(
          [
            "--isolated",
            paths.isolated,
            "--production",
            paths.production,
            "--candidate",
            paths.candidate,
          ],
          { stdout: () => {} },
        ),
      ),
    ).rejects.toThrow(/secret|content-free|connection/i);
  });
});

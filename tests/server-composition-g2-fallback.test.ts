import { afterEach, describe, expect, it } from "vitest";

import { OPEN_LOOP_EXTRACTION_POLICY_VERSION } from "@sayhear/application";
import { asUserId } from "@sayhear/domain";

import { createServerComposition } from "../apps/web/src/server-composition";

const BASE_ENV: Record<string, string> = {
  CRON_SECRET: "cron",
  DATABASE_URL: "postgres://localhost:1/sayhear",
  GITHUB_CLIENT_ID: "id",
  GITHUB_CLIENT_SECRET: "secret",
  NEXTAUTH_SECRET: "auth",
  PURGE_MARKER_DATABASE_URL: "postgres://localhost:1/sayhear-markers",
  SAYHEAR_BACKUP_CONFIGURATION_FINGERPRINT: "fingerprint",
  SAYHEAR_BACKUP_POLICY_VERSION: "backup:v1",
  SAYHEAR_CONTEXT_HMAC_SECRET: "context",
  SAYHEAR_DEPLOYMENT: "test",
  SAYHEAR_PROVIDER_ADAPTER: "deterministic",
  SAYHEAR_TEST_PROVIDER_CHUNKS: '["ok"]',
};

function withEnv(overrides: Record<string, string>): void {
  const next: Record<string, string | undefined> = { ...BASE_ENV, ...overrides };
  for (const key of Object.keys(process.env)) {
    if (
      key.startsWith("SAYHEAR_") ||
      key === "DATABASE_URL" ||
      key === "PURGE_MARKER_DATABASE_URL" ||
      key === "NEXTAUTH_SECRET" ||
      key === "GITHUB_CLIENT_ID" ||
      key === "GITHUB_CLIENT_SECRET" ||
      key === "CRON_SECRET" ||
      key === "OPENAI_API_KEY" ||
      key === "DEEPSEEK_API_KEY" ||
      key === "VERCEL_GIT_COMMIT_SHA"
    ) {
      delete process.env[key];
    }
  }
  for (const [key, value] of Object.entries(next)) {
    process.env[key] = value;
  }
}

const savedEnv = { ...process.env };

afterEach(() => {
  for (const key of Object.keys(process.env)) {
    if (!(key in savedEnv)) {
      delete process.env[key];
    }
  }
  for (const [key, value] of Object.entries(savedEnv)) {
    process.env[key] = value;
  }
});

describe("server composition G2 fallback (issue #207 layer 2b)", () => {
  it("keeps the G1-or-empty registry and a closed extract lane without G2 switches", async () => {
    withEnv({});
    const composition = createServerComposition();

    expect(composition.oneA3bG2ReleaseManifest).toBeNull();
    expect(
      composition.modelRoleCommandService.configuration("open_loop.extract"),
    ).toBeNull();
    expect(composition.openLoopExtractionPolicyVersion).toBe(
      OPEN_LOOP_EXTRACTION_POLICY_VERSION,
    );
    // Disabled short-circuits before any database read.
    await expect(
      composition.openLoopExtractionScanService.scanPending(),
    ).resolves.toEqual({ extractionsQueued: 0 });
    // Layer 2c: the proactive bundle lane stays closed without the G2
    // regime — the stub producer refuses instead of calling a model.
    await expect(
      composition.proactiveFollowupProvider.generateSegment({
        userId: asUserId("01984477-1f9a-7b25-a5cc-83c3b21fbc68"),
        locale: "en-US",
        mainText: "That sounds like a full week already.",
        currentUserText: "It was a quiet evening.",
        currentTime: "2026-09-20T10:00:00.000Z",
        sessionTimeZone: "America/Denver",
        targetKind: "open_loop",
        targetId: "loop-1",
        targetVersionId: "loop-version-1",
        targetRef: {
          targetKind: "open_loop",
          targetId: "loop-1",
          targetVersionId: "loop-version-1",
        },
        targetSummary: null,
        sourceUserText: null,
        targetContext: {
          source: "open_loop",
          evidenceAt: "2026-09-10T10:00:00.000Z",
          expectedStartAt: "2026-09-20T10:00:00.000Z",
          expectedEndAt: null,
          expectedTimePrecision: "date",
          expectedTimeZone: "Europe/Berlin",
          expiresAt: "2026-10-04T10:00:00.000Z",
          openLoopKind: "awaited_outcome",
          subjectRole: "unknown",
        },
        targetSensitive: false,
        opportunity: "natural_gap",
      }),
    ).rejects.toThrow("no runtime provider");
    await expect(
      composition.proactiveFollowupProvider.classifyDisposition({
        userId: asUserId("01984477-1f9a-7b25-a5cc-83c3b21fbc68"),
        locale: "en-US",
        userText: "Yeah.",
        segmentText: "How did it go?",
        use: {
          useId: "use-1",
          assistantEventRevisionId: "assistant-revision-1",
          targetKind: "open_loop",
          targetId: "loop-1",
          targetVersionId: "loop-version-1",
        },
        finalTextLocator: {
          kind: "assistant_event_revision",
          assistantEventRevisionId: "assistant-revision-1",
          segment: "proactive_followup",
          ordinal: 0,
        },
      }),
    ).rejects.toThrow("no runtime provider");
  });

  it("exposes the proactive stage wiring without touching the database", async () => {
    withEnv({});
    const composition = createServerComposition();

    expect(composition.proactiveFollowupRepository).toBeDefined();
    expect(typeof composition.proactiveFollowupStage.prepare).toBe("function");
    expect(typeof composition.proactiveFollowupStage.generate).toBe("function");
    expect(typeof composition.proactiveFollowupStage.abandon).toBe("function");
    expect(typeof composition.proactiveFollowupMaintenanceService.scan).toBe(
      "function",
    );
  });

  it("fails startup closed when a G2 switch opens without the bundle manifest", () => {
    withEnv({
      SAYHEAR_OPEN_LOOP_EXTRACTION_ENABLED: "true",
      SAYHEAR_PROACTIVE_FOLLOWUP_ENABLED: "true",
    });

    expect(() => createServerComposition()).toThrow(
      "SAYHEAR_1A_3B_G2_RELEASE_MANIFEST is required",
    );
  });
});

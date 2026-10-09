import { describe, expect, it } from "vitest";

import type { EffectiveConfigurationItem } from "../apps/web/src/effective-runtime-config";
import {
  classifyReleaseOperationsResponse,
  lastAcceptedBusinessMigrationName,
  releaseOperationsOutcomeLabel,
  safeRuntimeConfigItems,
} from "../apps/web/app/internal/release-operations-data";

function configItem(
  overrides: Partial<EffectiveConfigurationItem>,
): EffectiveConfigurationItem {
  return {
    category: "runtime",
    critical: false,
    inManifestFingerprint: false,
    key: "runtime.deployment",
    source: "override",
    value: "test",
    ...overrides,
  };
}

describe("lastAcceptedBusinessMigrationName", () => {
  it("returns null when there is no manifest or no migration", () => {
    expect(lastAcceptedBusinessMigrationName(null)).toBeNull();
    expect(
      lastAcceptedBusinessMigrationName({ schema: { migrations: [] } } as never),
    ).toBeNull();
  });

  it("returns only the final accepted business migration name", () => {
    const manifest = {
      schema: {
        migrations: [
          { name: "0067_g1_opencode_go_conversation_text_egress_policy.sql", sha256: "a".repeat(64) },
          { name: "0068_recent_conversation_context_refs.sql", sha256: "b".repeat(64) },
        ],
        fingerprint: "sha256:secret-fingerprint",
        purgeMarkerMigrations: [],
        purgeMarkerFingerprint: "sha256:marker-secret",
      },
    };
    const name = lastAcceptedBusinessMigrationName(manifest as never);
    expect(name).toBe("0068_recent_conversation_context_refs.sql");
    // Only the migration name is returned; pins and fingerprints never leave.
    expect(JSON.stringify(name)).not.toContain("secret");
  });
});

describe("safeRuntimeConfigItems", () => {
  it("drops the Internal Owner identity values and keeps other metadata", () => {
    const items = [
      configItem({ key: "owner.subject", value: "github|123456" }),
      configItem({ key: "owner.user_id", value: "11111111-1111-7111-8111-111111111111" }),
      configItem({ key: "owner.issuer", value: "https://github.com" }),
      configItem({ key: "migrations.business_fingerprint", value: "sha256:abc" }),
      configItem({ key: "switch.reflection_enabled", value: true }),
    ];
    const safe = safeRuntimeConfigItems(items);
    expect(safe.map((item) => item.key)).toEqual([
      "migrations.business_fingerprint",
      "switch.reflection_enabled",
    ]);
    const serialized = JSON.stringify(safe);
    expect(serialized).not.toContain("11111111-1111-7111-8111-111111111111");
    expect(serialized).not.toContain("github.com");
  });
});

describe("classifyReleaseOperationsResponse", () => {
  it("classifies an authorized read as ok with its payload", () => {
    const result = classifyReleaseOperationsResponse<{ enabled: boolean }>(200, {
      enabled: true,
    });
    expect(result.kind).toBe("ok");
    expect(result.data).toEqual({ enabled: true });
  });

  it("treats the missing compatibility endpoint as unavailable, not a crash", () => {
    // Next returns HTML for a missing route, so the payload is null at 404.
    const result = classifyReleaseOperationsResponse(404, null);
    expect(result.kind).toBe("unavailable");
    expect(result.data).toBeNull();
    expect(releaseOperationsOutcomeLabel(result)).toContain("404");
  });

  it("fails closed on unauthorized and forbidden", () => {
    expect(classifyReleaseOperationsResponse(401, { error: "unauthorized" }).kind).toBe(
      "unauthorized",
    );
    expect(classifyReleaseOperationsResponse(403, { error: "forbidden" }).kind).toBe(
      "forbidden",
    );
  });

  it("reports an already-applied action as a conflict", () => {
    const result = classifyReleaseOperationsResponse(409, {
      error: "already_enabled",
    });
    expect(result.kind).toBe("conflict");
    expect(result.detail).toBe("already_enabled");
  });

  it("keeps the error code or HTTP status as the only failure detail", () => {
    expect(
      classifyReleaseOperationsResponse(500, { error: "boom" }).detail,
    ).toBe("boom");
    expect(classifyReleaseOperationsResponse(502, "<html>bad gateway</html>").detail).toBe(
      "http_502",
    );
  });
});

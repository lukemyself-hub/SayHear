import { describe, expect, it } from "vitest";

import {
  buildHostedReleaseIdentity,
  isReleaseIdentityOperatorRequest,
  HOSTED_RELEASE_IDENTITY_VERSION,
  normalizeDatabaseIdentity,
} from "../apps/web/src/release-identity";

const environment = {
  DATABASE_URL: "postgres://user:secret@business-pooler.db.example.com:5432/sayhear",
  PURGE_MARKER_DATABASE_URL: "postgres://user:secret@marker.db.example.com:5432/sayhear",
  VERCEL_ENV: "preview",
  VERCEL_GIT_COMMIT_SHA: "a".repeat(40),
  VERCEL_ORG_ID: "team_h4sAgEsoM7MeGcGoLdbuIyH1",
  VERCEL_PROJECT_ID: "prj_nNj1vzuYjj7oeiwzqfsV3iMb3THs",
};

describe("hosted release identity", () => {
  it("authorizes only the existing operator credential, with missing and mismatched values closed", () => {
    expect(isReleaseIdentityOperatorRequest(new Request("https://acceptance.example"), "test-only-secret")).toBe(false);
    expect(isReleaseIdentityOperatorRequest(new Request("https://acceptance.example", { headers: { authorization: "Bearer wrong" } }), "test-only-secret")).toBe(false);
    expect(isReleaseIdentityOperatorRequest(new Request("https://acceptance.example", { headers: { authorization: "Bearer test-only-secret" } }), undefined)).toBe(false);
    expect(isReleaseIdentityOperatorRequest(new Request("https://acceptance.example", { headers: { authorization: "Bearer test-only-secret" } }), "test-only-secret")).toBe(true);
  });
  it("normalizes pooler hosts and keeps the credential-free target", () => {
    expect(normalizeDatabaseIdentity(environment.DATABASE_URL)).toBe(
      "business.db.example.com:5432/sayhear",
    );
  });

  it("reports a content-free identity with hashed database targets", () => {
    const identity = buildHostedReleaseIdentity(environment);
    expect(identity.version).toBe(HOSTED_RELEASE_IDENTITY_VERSION);
    expect(identity.projectId).toBe("prj_nNj1vzuYjj7oeiwzqfsV3iMb3THs");
    expect(identity.teamId).toBe("team_h4sAgEsoM7MeGcGoLdbuIyH1");
    expect(identity.commit).toBe("a".repeat(40));
    expect(identity.environment).toBe("preview");
    expect(identity.businessTargetHash).toMatch(/^[0-9a-f]{64}$/);
    expect(identity.purgeMarkerTargetHash).toMatch(/^[0-9a-f]{64}$/);
    expect(identity.businessTargetHash).not.toBe(identity.purgeMarkerTargetHash);
    const serialized = JSON.stringify(identity);
    expect(serialized).not.toContain("postgres://");
    expect(serialized).not.toContain("secret");
  });

  it("fails closed when a target, commit or project id is missing", () => {
    expect(() =>
      buildHostedReleaseIdentity({ ...environment, DATABASE_URL: undefined }),
    ).toThrow("both business and purge-marker databases");
    expect(() =>
      buildHostedReleaseIdentity({ ...environment, PURGE_MARKER_DATABASE_URL: environment.DATABASE_URL }),
    ).toThrow("distinct");
    expect(() =>
      buildHostedReleaseIdentity({ ...environment, VERCEL_GIT_COMMIT_SHA: undefined }),
    ).toThrow("deployed commit");
    expect(() =>
      buildHostedReleaseIdentity({ ...environment, VERCEL_PROJECT_ID: undefined }),
    ).toThrow("project id");
  });
});

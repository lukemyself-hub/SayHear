import { describe, expect, it } from "vitest";

import type { ModelRoleConfigurationSnapshot } from "@sayhear/application";

import { assertResumeIdentity } from "../eval/continuation-acceptance-1a3b/run-validator-capture";

const configuration: ModelRoleConfigurationSnapshot = {
  role: "narrative.validate",
  configVersion: "narrative.validate:g1-release:1",
  provider: "deepseek",
  model: "deepseek-chat",
  modelSnapshot: "snapshot",
  promptVersion: "prompt",
  schemaVersion: "schema",
  rolePolicyVersion: "policy",
  providerPolicyVersion: "provider-policy",
  rolloutPin: "pin",
  freshnessPolicy: "exact_head:v1",
  fallbackMode: "disabled",
  maxTechnicalRetries: 0,
  maxSemanticRepairs: 0,
  parameterSnapshot: { maxOutputTokens: 8000, temperature: 0 },
};

const parameters = { maxOutputTokens: 8000, temperature: 0 };

const previousHeader = {
  catalogSha256: "sha256:catalog",
  configVersion: configuration.configVersion,
  gitCommit: "a".repeat(40),
  gitDirty: false,
  maxOutputTokens: 8000,
  model: configuration.model,
  modelSnapshot: configuration.modelSnapshot,
  parameters,
  pinsFingerprint: "sha256:pins",
  promptVersion: configuration.promptVersion,
  provider: configuration.provider,
  providerCallBudget: 1,
  schemaVersion: configuration.schemaVersion,
};

const current = {
  catalogSha256: "sha256:catalog",
  configuration,
  gitCommit: "a".repeat(40),
  gitDirty: false,
  parameters,
  pinsFingerprint: "sha256:pins",
};

describe("validator capture resume identity", () => {
  it("keeps completed cases only when code, catalog and pins all match", () => {
    expect(() => assertResumeIdentity(previousHeader, current)).not.toThrow();
  });

  it("refuses to relabel cases completed under a different pin set", () => {
    expect(() =>
      assertResumeIdentity(
        { ...previousHeader, pinsFingerprint: "sha256:other" },
        current,
      ),
    ).toThrow("pinsFingerprint");
    expect(() =>
      assertResumeIdentity({ ...previousHeader, parameters: { maxOutputTokens: 4000 } }, current),
    ).toThrow("parameters");
  });

  it("refuses to relabel cases completed under a different commit or catalog", () => {
    expect(() =>
      assertResumeIdentity({ ...previousHeader, gitCommit: "b".repeat(40) }, current),
    ).toThrow("gitCommit");
    expect(() =>
      assertResumeIdentity({ ...previousHeader, catalogSha256: "sha256:other" }, current),
    ).toThrow("catalogSha256");
  });

  it("refuses a previous report that does not record a clean execution", () => {
    expect(() =>
      assertResumeIdentity({ ...previousHeader, gitDirty: true }, current),
    ).toThrow("gitDirty");
    expect(() =>
      assertResumeIdentity({ ...previousHeader, gitCommit: undefined }, current),
    ).toThrow("gitCommit");
  });
});

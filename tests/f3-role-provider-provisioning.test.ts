import { describe, expect, it } from "vitest";

import {
  F3_ROLE_TIMEOUT_MS,
  resolveF3RoleAdapter,
} from "../eval/continuation-acceptance-1a3b/role-provider-provisioning";

describe("F3 role provider provisioning", () => {
  it("ignores the legacy DEEPSEEK_BASE_URL and falls back to the canonical endpoint", () => {
    const adapter = resolveF3RoleAdapter("deepseek", {
      DEEPSEEK_API_KEY: "test-key",
      DEEPSEEK_BASE_URL: "https://legacy.example",
    });
    expect(adapter).toEqual({
      provider: "deepseek",
      apiKey: "test-key",
      baseUrl: "https://api.deepseek.com",
      timeoutMs: F3_ROLE_TIMEOUT_MS,
    });
  });

  it("sources the deepseek baseUrl from SAYHEAR_DEEPSEEK_BASE_URL", () => {
    const adapter = resolveF3RoleAdapter("deepseek", {
      DEEPSEEK_API_KEY: "test-key",
      SAYHEAR_DEEPSEEK_BASE_URL: "https://canonical.example",
      DEEPSEEK_BASE_URL: "https://legacy.example",
    });
    expect(adapter.provider).toBe("deepseek");
    if (adapter.provider === "deepseek") {
      expect(adapter.baseUrl).toBe("https://canonical.example");
    }
  });

  it("provisions opencode-go without a caller-selectable baseUrl", () => {
    const adapter = resolveF3RoleAdapter("opencode-go", {
      OPENCODE_GO_API_KEY: "test-key",
    });
    expect(adapter).toEqual({
      provider: "opencode-go",
      apiKey: "test-key",
      timeoutMs: F3_ROLE_TIMEOUT_MS,
    });
    expect(adapter).not.toHaveProperty("baseUrl");
  });

  it("fails closed on a provider the capture surface does not support", () => {
    expect(() =>
      resolveF3RoleAdapter("openai", { OPENAI_API_KEY: "test-key" }),
    ).toThrow(/does not support the pinned provider openai/);
  });

  it("fails closed when the selected provider has no credential", () => {
    expect(() => resolveF3RoleAdapter("deepseek", {})).toThrow(
      /DEEPSEEK_API_KEY is required/,
    );
    expect(() => resolveF3RoleAdapter("opencode-go", {})).toThrow(
      /OPENCODE_GO_API_KEY is required/,
    );
  });
});

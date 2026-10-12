import { describe, expect, it } from "vitest";

import {
  buildChampionAssembly,
  toJournalRegistryAdapter,
} from "../eval/memory-pairwise-126/shared";
import {
  toProviderAdapterConfig,
  type TwinConversationAdapter,
} from "../eval/memory-pairwise-126/twin-harness";

const MANAGED_KEYS = [
  "SAYHEAR_PROVIDER_ADAPTER",
  "DEEPSEEK_API_KEY",
  "DEEPSEEK_BASE_URL",
  "OPENAI_API_KEY",
  "OPENCODE_GO_API_KEY",
  "SAYHEAR_DEEPSEEK_BASE_URL",
  "SAYHEAR_CONVERSATION_TEXT_MODEL",
  "SAYHEAR_CONVERSATION_TEXT_MODEL_SNAPSHOT",
  "SAYHEAR_PROVIDER_TIMEOUT_MS",
] as const;

/** Run `body` with a scoped environment, restoring the previous values after. */
function withEnvironment(
  values: Readonly<Partial<Record<(typeof MANAGED_KEYS)[number], string>>>,
  body: () => void,
): void {
  const previous = new Map<string, string | undefined>();
  for (const key of MANAGED_KEYS) previous.set(key, process.env[key]);
  try {
    for (const key of MANAGED_KEYS) delete process.env[key];
    for (const [key, value] of Object.entries(values)) {
      if (value !== undefined) process.env[key] = value;
    }
    body();
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

describe("G1 capture provider adapters", () => {
  it("selects the opencode-go champion identity and adapter from the environment", () => {
    withEnvironment(
      { SAYHEAR_PROVIDER_ADAPTER: "opencode-go", OPENCODE_GO_API_KEY: "test-key" },
      () => {
        const { champion, conversationAdapter } = buildChampionAssembly(process.env);
        expect(champion.provider).toBe("opencode-go");
        expect(champion.model).toBe("deepseek-v4.1-flash");
        expect(champion.providerPolicyVersion).toBe(
          "opencode-go-conversation-text:v1",
        );
        expect(champion.dataRegion).toBe("provider-managed");
        expect(conversationAdapter.type).toBe("opencode-go");
        expect(conversationAdapter).not.toHaveProperty("baseUrl");
        if (conversationAdapter.type === "opencode-go") {
          expect(conversationAdapter.apiKey).toBe("test-key");
        }
      },
    );
  });

  it("passes an opencode-go adapter through to the provider-egress config unchanged", () => {
    const adapter: TwinConversationAdapter = {
      apiKey: "test-key",
      timeoutMs: 120_000,
      type: "opencode-go",
    };
    expect(toProviderAdapterConfig(adapter)).toEqual({
      apiKey: "test-key",
      timeoutMs: 120_000,
      type: "opencode-go",
    });
  });

  it("keeps the deterministic adapter behavior", () => {
    expect(toProviderAdapterConfig({ type: "deterministic" })).toEqual({
      chunks: ["(deterministic twin reply)"],
      type: "deterministic",
    });
    expect(
      toProviderAdapterConfig({ chunks: ["ok"], type: "deterministic" }),
    ).toEqual({ chunks: ["ok"], type: "deterministic" });
  });

  it("keeps the responses-api adapter behavior", () => {
    const adapter: TwinConversationAdapter = {
      apiKey: "test-key",
      baseUrl: "https://api.deepseek.com",
      timeoutMs: 120_000,
      type: "responses-api",
    };
    expect(toProviderAdapterConfig(adapter)).toEqual({
      apiKey: "test-key",
      baseUrl: "https://api.deepseek.com",
      timeoutMs: 120_000,
      type: "responses-api",
    });
  });

  it("sources the deepseek champion baseUrl from SAYHEAR_DEEPSEEK_BASE_URL", () => {
    withEnvironment(
      {
        DEEPSEEK_API_KEY: "test-key",
        SAYHEAR_DEEPSEEK_BASE_URL: "https://proxy.example",
        SAYHEAR_PROVIDER_ADAPTER: "deepseek",
      },
      () => {
        const { champion, conversationAdapter } = buildChampionAssembly(process.env);
        expect(champion.provider).toBe("deepseek");
        expect(conversationAdapter.type).toBe("responses-api");
        if (conversationAdapter.type === "responses-api") {
          expect(conversationAdapter.baseUrl).toBe("https://proxy.example");
        }
      },
    );
  });

  it("ignores the legacy DEEPSEEK_BASE_URL on the champion side", () => {
    withEnvironment(
      {
        DEEPSEEK_API_KEY: "test-key",
        DEEPSEEK_BASE_URL: "https://legacy.example",
        SAYHEAR_PROVIDER_ADAPTER: "deepseek",
      },
      () => {
        const { conversationAdapter } = buildChampionAssembly(process.env);
        expect(conversationAdapter.type).toBe("responses-api");
        if (conversationAdapter.type === "responses-api") {
          expect(conversationAdapter.baseUrl).toBe("https://api.deepseek.com");
        }
      },
    );
  });

  it("fails closed on the retired openai adapter and on unknown values", () => {
    withEnvironment(
      { OPENAI_API_KEY: "test-key", SAYHEAR_PROVIDER_ADAPTER: "openai" },
      () => {
        expect(() => buildChampionAssembly(process.env)).toThrow(
          /Unsupported SAYHEAR_PROVIDER_ADAPTER: openai/,
        );
      },
    );
    withEnvironment(
      { DEEPSEEK_API_KEY: "test-key", SAYHEAR_PROVIDER_ADAPTER: "not-a-provider" },
      () => {
        expect(() => buildChampionAssembly(process.env)).toThrow(
          /Unsupported SAYHEAR_PROVIDER_ADAPTER: not-a-provider/,
        );
      },
    );
  });
});

describe("journal role registry adapters", () => {
  it("passes a responses-api adapter through unchanged", () => {
    expect(
      toJournalRegistryAdapter({
        apiKey: "test-key",
        baseUrl: "https://api.deepseek.com",
        timeoutMs: 120_000,
        type: "responses-api",
      }),
    ).toEqual({
      apiKey: "test-key",
      baseUrl: "https://api.deepseek.com",
      timeoutMs: 120_000,
      type: "responses-api",
    });
  });

  it("passes an opencode-go adapter through without a baseUrl", () => {
    const adapter: TwinConversationAdapter = {
      apiKey: "test-key",
      timeoutMs: 120_000,
      type: "opencode-go",
    };
    const config = toJournalRegistryAdapter(adapter);
    expect(config).toEqual({
      apiKey: "test-key",
      timeoutMs: 120_000,
      type: "opencode-go",
    });
    expect(config).not.toHaveProperty("baseUrl");
  });

  it("maps a deterministic adapter to the deterministic stub", () => {
    expect(toJournalRegistryAdapter({ type: "deterministic" })).toEqual({
      type: "deterministic",
    });
  });

  it("fails closed on an unknown adapter type", () => {
    expect(() =>
      toJournalRegistryAdapter({
        type: "not-a-provider",
      } as unknown as TwinConversationAdapter),
    ).toThrow(/Unsupported journal role adapter type/);
  });
});

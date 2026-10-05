/**
 * Shared plumbing for the #126 CLI tools (capture-twins, rollback-demo):
 * env loading, git provenance, NDJSON helpers, and the two assemblies every
 * tool needs — the Conversation Text Champion and the memory role registry
 * (the same role cluster server-composition resolves).
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import { createRuntimeJournalRoleProviderRegistry } from "@sayhear/ai";
import type { ConversationTextChampion } from "@sayhear/application";

import type { TwinConversationAdapter, TwinRoleRegistry } from "./twin-harness";

export const REPOSITORY_ROOT = path.resolve(import.meta.dirname, "../..");

/** Load repo-root .env without overriding already-set process.env values. */
export function loadDotEnv(): void {
  const envPath = path.join(REPOSITORY_ROOT, ".env");
  if (!existsSync(envPath)) return;
  for (const line of readFileSync(envPath, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length === 0 || trimmed.startsWith("#")) continue;
    const separator = trimmed.indexOf("=");
    if (separator <= 0) continue;
    const key = trimmed.slice(0, separator).trim();
    const value = trimmed
      .slice(separator + 1)
      .trim()
      .replace(/^["']|["']$/g, "");
    if (process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
}

export function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is required.`);
  }
  return value;
}

export function gitCommit(): string {
  try {
    return execFileSync("git", ["-C", REPOSITORY_ROOT, "rev-parse", "HEAD"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return "unknown";
  }
}

export async function readNdjson(
  response: Response,
): Promise<readonly Record<string, unknown>[]> {
  const text = await response.text();
  return text
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

export function joinDeltas(events: readonly Record<string, unknown>[]): string {
  return events
    .filter((event) => event.type === "assistant_delta")
    .map((event) => String(event.delta ?? ""))
    .join("");
}

export function buildChampionAssembly(environment: NodeJS.ProcessEnv): {
  champion: ConversationTextChampion;
  conversationAdapter: TwinConversationAdapter;
} {
  const adapter =
    environment.SAYHEAR_PROVIDER_ADAPTER === "openai" ? "openai" : "deepseek";
  const profile =
    adapter === "deepseek"
      ? {
          apiKey: requiredEnvironment("DEEPSEEK_API_KEY"),
          baseUrl:
            environment.SAYHEAR_DEEPSEEK_BASE_URL ?? "https://api.deepseek.com",
          defaultModel: "deepseek-v4-flash",
          provider: "deepseek" as const,
          providerPolicyVersion: "deepseek-conversation-text:v1",
        }
      : {
          apiKey: requiredEnvironment("OPENAI_API_KEY"),
          baseUrl: "https://api.openai.com/v1",
          defaultModel: "gpt-5.4",
          provider: "openai" as const,
          providerPolicyVersion: "openai-conversation-text:v1",
        };
  const model =
    environment.SAYHEAR_CONVERSATION_TEXT_MODEL ?? profile.defaultModel;
  const champion: ConversationTextChampion = Object.freeze({
    configVersion: "conversation-text-champion:v1",
    consentPolicyVersion: null,
    contextLimit: 1_000_000,
    dataRegion: "provider-configured",
    model,
    provider: profile.provider,
    providerPolicyVersion: profile.providerPolicyVersion,
    retentionMode: "store-disabled",
    snapshot: environment.SAYHEAR_CONVERSATION_TEXT_MODEL_SNAPSHOT ?? model,
    streaming: true,
    supportedLocales: Object.freeze(["en", "zh"]),
    trainingPolicy: "api-data-controls",
  });
  return {
    champion,
    conversationAdapter: {
      apiKey: profile.apiKey,
      baseUrl: profile.baseUrl,
      timeoutMs: Number(environment.SAYHEAR_PROVIDER_TIMEOUT_MS ?? "60000"),
      type: "responses-api",
    },
  };
}

export type MemoryRoleSpec = Readonly<{
  provider: "deepseek" | "openai" | "opencode-go" | "deterministic";
  model: string;
  championConfigVersion: string;
}>;

/**
 * The memory role cluster (issue #113 / #114): each role carries its own
 * Champion config under the same ADR-0060 / ADR-0061 discipline — no implicit
 * cross-role fallback. The registry validates the full role set, so the
 * non-memory roles are included with their production versions.
 */
export function buildMemoryRoleRegistry(
  conversationAdapter: TwinConversationAdapter,
  spec: MemoryRoleSpec,
): TwinRoleRegistry {
  return createRuntimeJournalRoleProviderRegistry({
    adapter:
      conversationAdapter.type === "responses-api"
        ? {
            apiKey: conversationAdapter.apiKey,
            baseUrl: conversationAdapter.baseUrl,
            timeoutMs: conversationAdapter.timeoutMs,
            type: "responses-api",
          }
        : { type: "deterministic" },
    roles: [
      {
        role: "memory.extract",
        provider: spec.provider,
        model: spec.model,
        configVersion: `${spec.championConfigVersion}:memory-extract`,
        policyVersion: "memory-extraction:v1",
        promptFingerprint: "memory-extract:propose:v3",
      },
      {
        role: "entity.resolve",
        provider: spec.provider,
        model: spec.model,
        configVersion: `${spec.championConfigVersion}:entity-resolve`,
        policyVersion: "entity-resolve-gate:v1",
        promptFingerprint: "entity-resolve:gate:v2",
      },
      {
        role: "memory.consolidate",
        provider: spec.provider,
        model: spec.model,
        configVersion: `${spec.championConfigVersion}:memory-consolidate`,
        policyVersion: "memory-consolidation:v1",
        promptFingerprint: "memory-consolidate:diffs:v1",
      },
      {
        role: "evidence.extract",
        provider: spec.provider,
        model: spec.model,
        configVersion: `${spec.championConfigVersion}:evidence`,
        policyVersion: "evidence-extraction:v2",
        promptFingerprint: "evidence-extract:spans:v2",
      },
      {
        role: "journal.draft",
        provider: spec.provider,
        model: spec.model,
        configVersion: `${spec.championConfigVersion}:journal-draft`,
        policyVersion: "journal-generation:v2",
        promptFingerprint: "journal-draft:evidence-only:v2",
      },
      {
        role: "journal.validate",
        provider: spec.provider,
        model: spec.model,
        configVersion: `${spec.championConfigVersion}:journal-validate`,
        policyVersion: "journal-validator:v3",
        promptFingerprint: "journal-validate:diagnostic:v3",
      },
      {
        role: "dialogue.state",
        provider: spec.provider,
        model: spec.model,
        configVersion: "dialogue-state-model:v1",
        policyVersion: "dialogue-state:v2",
        promptFingerprint: "dialogue-state-prompt:v2",
      },
      {
        role: "summary.compress",
        provider: spec.provider,
        model: spec.model,
        configVersion: `${spec.championConfigVersion}:summary`,
        policyVersion: "rolling-summary:v1",
        promptFingerprint: "rolling-summary:neutral-structured:v1",
      },
    ],
  }) as unknown as TwinRoleRegistry;
}

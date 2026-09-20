/**
 * Fixture-authoring probe for the pinned `open_loop.extract` role.
 *
 * Issue #207 v2 fixtures need utterances the real pinned Provider both
 * proposes and schema-validates. This script runs the exact candidate
 * configuration from `pins-v2.json` over a list of candidate utterances and
 * prints the validated proposal (or the failure code), so fixture text is
 * authored against observed Provider behavior instead of guesses.
 *
 * Usage: pnpm exec tsx eval/continuation-acceptance-1a3b/probe-extract-utterances.ts
 */
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import { createRuntimeOneA3bRoleProviders } from "@sayhear/ai";
import {
  ONE_A_3B_ROLE_POLICIES,
  type ModelRoleConfigurationSnapshot,
  type OneA3bModelRole,
} from "@sayhear/application";
import { asEvidenceItemId, asUserId } from "@sayhear/domain";

import { loadDotEnv } from "../memory-pairwise-126/shared";

type PinsRole = Readonly<{
  provider: string;
  model: string;
  snapshot: string;
  promptVersion: string;
  schemaVersion: string;
  policyVersion: string;
  parameters: Readonly<{
    temperature: number;
    maxOutputTokens: number;
    reasoningEffort: string;
    responseFormat: string;
  }>;
  maxTechnicalRetries: number;
  fallback: string;
}>;

const CANDIDATES: readonly { locale: string; text: string; timeZone: string }[] = [
  { locale: "zh-CN", timeZone: "Asia/Shanghai", text: "我在等学校那边的录取结果，说这两周就出。" },
];

function snapshotFor(
  role: OneA3bModelRole,
  pins: Readonly<Record<string, PinsRole>>,
): ModelRoleConfigurationSnapshot {
  const pin = pins[role];
  if (!pin) throw new Error(`Pins file has no ${role} role.`);
  const policy = ONE_A_3B_ROLE_POLICIES[role];
  return {
    role,
    configVersion: role === "open_loop.extract" ? "open_loop.extract:eval-candidate:v1" : `${role}:probe:v1`,
    provider: pin.provider,
    model: pin.model,
    modelSnapshot: pin.snapshot,
    promptVersion: pin.promptVersion,
    schemaVersion: pin.schemaVersion,
    rolePolicyVersion: "" as never,
    providerPolicyVersion: role === "open_loop.extract" ? "deepseek-open_loop.extract-egress:candidate:v1" : `deepseek-${role}-egress:probe:v1`,
    rolloutPin: `${role}-probe-pin:v1`,
    freshnessPolicy: policy.freshnessPolicy,
    fallbackMode: "disabled",
    maxTechnicalRetries: pin.maxTechnicalRetries,
    maxSemanticRepairs: policy.maxSemanticRepairs,
    parameterSnapshot: {
      budgetPolicyVersion: "probe-budget:v1",
      providerCallBudget: 4,
      temperature: pin.parameters.temperature,
      maxOutputTokens: pin.parameters.maxOutputTokens,
      reasoningEffort: pin.parameters.reasoningEffort,
      responseFormat: pin.parameters.responseFormat,
    },
  } as unknown as ModelRoleConfigurationSnapshot;
}

function uuidFrom(seed: string): string {
  const hash = createHash("sha256").update(seed).digest("hex").slice(0, 32);
  const characters = hash.split("");
  characters[12] = "7";
  characters[16] = "8";
  return [
    characters.slice(0, 8).join(""),
    characters.slice(8, 12).join(""),
    characters.slice(12, 16).join(""),
    characters.slice(16, 20).join(""),
    characters.slice(20, 32).join(""),
  ].join("-");
}

async function main(): Promise<void> {
  loadDotEnv({ path: ".env.neon" });
  const root = process.cwd();
  const pinsFile = JSON.parse(
    await readFile(resolve(root, "eval/continuation-acceptance-1a3b/pins-v2.json"), "utf8"),
  ) as { roles: Record<string, PinsRole> };
  const roles = pinsFile.roles;
  const rolesToBuild: OneA3bModelRole[] = [
    "episode.build",
    "reflection.daily",
    "reflection.weekly",
    "narrative.validate",
    "open_loop.extract",
    "proactive.followup",
  ];
  const configurations = rolesToBuild.map((role) => snapshotFor(role, roles));
  const providers = createRuntimeOneA3bRoleProviders({
    adapters: [
      {
        provider: "deepseek",
        baseUrl: process.env.DEEPSEEK_BASE_URL ?? "https://api.deepseek.com",
        apiKey: process.env.DEEPSEEK_API_KEY ?? "",
        timeoutMs: 120_000,
        fetchImplementation: (async (url: unknown, init?: { body?: unknown }) => {
          await writeFile(
            "/tmp/probe-body-sent.json",
            String(init?.body),
          );
          return fetch(url as string, init as RequestInit);
        }) as typeof fetch,
      },
    ],
    configurations,
  });
  const extract = providers.openLoopExtractProvider;
  if (!extract) throw new Error("No open_loop.extract provider.");
  for (const candidate of CANDIDATES) {
    const label = `${candidate.locale} ${candidate.text}`;
    const tally: string[] = [];
    for (let repeat = 0; repeat < 3; repeat += 1) {
      try {
        const output = await extract.extractProposals({
        userId: asUserId(uuidFrom("probe-user")),
        eventRevisionId: "probe-revision",
        locale: candidate.locale,
        timeZone: candidate.timeZone,
        userText: candidate.text,
        evidenceCommittedAt: "2026-09-12T00:00:00.000Z",
        evidence: [
          {
            evidenceItemId: asEvidenceItemId(uuidFrom("probe-evidence")),
            revisionId: "probe-revision",
            locatorType: "conversation_event_revision",
            locatorKey: "probe-revision",
            committedAt: "2026-09-12T00:00:00.000Z",
          },
        ],
          openLoops: [],
        });
        if (output.proposals.length === 0) {
          tally.push("empty");
        } else {
          const formable = output.proposals.some(
            (proposal) => proposal.hasRealAnchor && !proposal.isTaskLike,
          );
          const first = output.proposals[0]!;
          tally.push(
            formable
              ? "FORMABLE"
              : `reject(anchor=${first.hasRealAnchor},task=${first.isTaskLike})`,
          );
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        tally.push(message.includes("invalid output schema") ? "schema" : "fail");
      }
    }
    console.log(`${tally.join(",").padEnd(14)} ${label}`);
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});

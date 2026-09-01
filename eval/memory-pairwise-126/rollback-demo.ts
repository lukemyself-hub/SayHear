/**
 * 1A.3a rollback demonstration (issue #126; SPEC #107 "Versioning, cutover,
 * rollback").
 *
 * Rollback = code revert plus re-pinning the previous prompt / strategy
 * versions. Entity / Claim data written after cutover is frozen in place, not
 * deleted — dormant without a code path. This demo proves the three halves
 * mechanically on one isolated schema:
 *
 *   Phase A (post-cutover): the memory-on twin assembly runs a cross-day
 *   scenario; claims are written by the real fast-path machinery and the
 *   cross-day turn injects memory (the runTwinCapture harness, arm=on).
 *
 *   Phase B (rollback): the code-reverted assembly — the pre-1A.3a incumbent
 *   stack with the journal-regeneration catalog, no fast-path enqueue, no
 *   retrieval port — answers a follow-up turn over the SAME database.
 *
 *   Proofs recorded: the follow-up CompiledContext carries no memory section
 *   (revert removed the only code path that reads the face), the memory data
 *   face is byte-frozen (identical claim / version counts before and after),
 *   and the owner's data epoch is untouched (no purge, no deletion).
 *
 * Usage (real champion, same environment as capture-twins):
 *   pnpm exec tsx eval/memory-pairwise-126/rollback-demo.ts \
 *     --out eval/memory-pairwise-126/rollback-demo [--force]
 */
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  CATALOG_V2_CONVERSATION_HARNESS_POLICY,
  CANONICAL_PERSONA_VERSION,
  CHINESE_LOCALE_PACK_VERSION,
  ENGLISH_LOCALE_PACK_VERSION,
  JOURNAL_REGENERATION_CONVERSATION_ACTION_CATALOG,
  PERSONA_BEHAVIOR_ANCHORS_VERSION,
  PERSONA_CONTRACT_INVARIANT_VERSION,
  CONVERSATION_DECISION_TASK_INSTRUCTION_VERSION,
  createConversationActionGateway,
  createConversationAgentHarness,
  createConversationResponseService,
  createContextCompiler,
  createJournalRegenerationActionHandler,
  createUserTextConversationService,
  type ConversationTextChampion,
  type GenerationPolicy,
} from "@sayhear/application";
import { createRuntimeProviderEgressPort } from "@sayhear/ai";
import {
  PostgresConversationResponseRepository,
  PostgresJournalRegenerationActionRepository,
  PostgresUserTextConversationRepository,
  runMigrations,
} from "@sayhear/data";
import { createIsolatedPostgresSchema, fixedInternalOwnerPrincipal } from "@sayhear/test-support";
import type { Pool } from "pg";

import { createConversationResponseHandler } from "../../apps/web/src/conversation-response-handler";
import {
  buildChampionAssembly,
  buildMemoryRoleRegistry,
  gitCommit,
  loadDotEnv,
  REPOSITORY_ROOT,
} from "./shared";
import {
  runTwinCapture,
  toProviderAdapterConfig,
  type TwinConversationAdapter,
  type TwinRoleRegistry,
  type TwinScenario,
} from "./twin-harness";

/**
 * The demo scenario: a day-1 statement the fast path can extract, a cross-day
 * probe that must inject (the corpus-proven employer shapes), and (phase B) a
 * follow-up that the reverted code must answer from raw events only.
 */
export const ROLLBACK_DEMO_SCENARIOS: readonly TwinScenario[] = [
  {
    category: "memory_objective",
    description:
      "rollback demo: cross-day objective recall before the revert, then a post-revert follow-up on the same database",
    id: "rollback-demo-scenario",
    languageVariant: "zh",
    locale: "zh-CN",
    timezone: "Asia/Shanghai",
    turns: [
      { text: "跟你分享一下，我最近入职了蓝湾科技，做后端工程师。" },
      { gapMs: 90_000, text: "新同事都挺不错的，还在适应节奏。" },
      {
        gapMs: 2 * 24 * 60 * 60 * 1_000,
        text: "我在哪家公司上班来着？突然想不起来跟家里人怎么说的。",
      },
    ],
  },
];

type DemoTurn = Readonly<{
  assistantText: string;
  domainClockIso: string;
  finalEventType: string;
  injectedMemories: number;
  input: Readonly<{ locale: string; text: string; timezone: string }>;
  sequenceInScenario: number;
  wallMs: number;
}>;

async function readNdjson(
  response: Response,
): Promise<readonly Record<string, unknown>[]> {
  const text = await response.text();
  return text
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

function joinDeltas(events: readonly Record<string, unknown>[]): string {
  return events
    .filter((event) => event.type === "assistant_delta")
    .map((event) => String(event.delta ?? ""))
    .join("");
}

/**
 * Phase B: the code-reverted (pre-1A.3a incumbent) assembly answering one
 * follow-up turn over the same database — journal-regeneration catalog, no
 * fast-path enqueue, no consolidation scan, no retrieval port.
 */
async function runRevertedTurn(input: {
  champion: ConversationTextChampion;
  conversationAdapter: TwinConversationAdapter;
  domainNowIso: string;
  pool: Pool;
  text: string;
}): Promise<{ turn: DemoTurn; memorySectionsInContext: number }> {
  let domainNow = new Date(input.domainNowIso);
  const clock = () => domainNow;
  const generationPolicy: GenerationPolicy = {
    consentPolicyVersion: input.champion.consentPolicyVersion,
    freshnessPolicy: "source_valid:v1" as const,
    chineseLocalePackVersion: CHINESE_LOCALE_PACK_VERSION,
    englishLocalePackVersion: ENGLISH_LOCALE_PACK_VERSION,
    harnessPolicyVersion: CATALOG_V2_CONVERSATION_HARNESS_POLICY.version,
    conversationActionCatalogVersion:
      JOURNAL_REGENERATION_CONVERSATION_ACTION_CATALOG.version,
    model: input.champion.model,
    modelConfigVersion: input.champion.configVersion,
    modelSnapshot: input.champion.snapshot,
    outputFormatVersion: "conversation-output:v1",
    canonicalPersonaVersion: CANONICAL_PERSONA_VERSION,
    personaBehaviorAnchorsVersion: PERSONA_BEHAVIOR_ANCHORS_VERSION,
    personaContractInvariantVersion: PERSONA_CONTRACT_INVARIANT_VERSION,
    productPolicyVersion: "product-policy:v1",
    taskInstructionVersion: CONVERSATION_DECISION_TASK_INSTRUCTION_VERSION,
    provider: input.champion.provider,
    providerPolicyVersion: input.champion.providerPolicyVersion,
    relationshipPolicyVersion: "relationship-boundary:v1",
    safetyPolicyVersion: "minimum-high-risk-response:v1",
  };
  const responseRepository = new PostgresConversationResponseRepository(
    input.pool,
  );
  const contextCompiler = createContextCompiler({
    clock,
    compilerVersion: "context-compiler:v1",
    contentHmacSecret: "baseline-context-integrity-secret",
    rawEventTokenBudget: 4_000,
    repository: responseRepository,
  });
  const egressPort = createRuntimeProviderEgressPort({
    adapter: toProviderAdapterConfig(input.conversationAdapter),
    champion: input.champion,
    clock,
    contextCompiler,
    repository: responseRepository,
  });
  const actionGateway = createConversationActionGateway({
    handlers: [
      createJournalRegenerationActionHandler({
        generationPolicyVersion: "journal-generation:v2",
      }),
    ],
    repository: new PostgresJournalRegenerationActionRepository(
      input.pool,
      "baseline-context-integrity-secret",
    ),
  });
  const harness = createConversationAgentHarness({
    actionGateway,
    clock,
    contextCompiler,
    egressPort,
    repository: responseRepository,
  });
  const service = createConversationResponseService({
    actionGateway,
    catalog: JOURNAL_REGENERATION_CONVERSATION_ACTION_CATALOG,
    clock,
    contextCompiler,
    conversationService: createUserTextConversationService({
      clock,
      expectedBackupPolicyVersion: "baseline-synthetic:v1",
      expectedConfigurationFingerprint: "sha256:baseline-synthetic",
      generationPolicy,
      inactivityPolicy: {
        timeoutMs: 30 * 60 * 1_000,
        version: "continuous-exchange-inactivity:v1",
      },
      repository: new PostgresUserTextConversationRepository(input.pool),
    }),
    harness,
    harnessPolicy: CATALOG_V2_CONVERSATION_HARNESS_POLICY,
    repository: responseRepository,
  });
  const handler = createConversationResponseHandler({
    authenticate: async () => fixedInternalOwnerPrincipal,
    service,
  });
  const wallStartedAt = performance.now();
  const response = await handler(
    new Request("http://localhost/api/internal/conversation/responses", {
      body: JSON.stringify({
        clientEventId: "rollback-demo-post-revert-event",
        clientTurnId: "rollback-demo-post-revert-turn",
        locale: "zh-CN",
        text: input.text,
        timezone: "Asia/Shanghai",
      }),
      headers: { "content-type": "application/json" },
      method: "POST",
    }),
  );
  const events = await readNdjson(response);
  const wallMs = Math.round(performance.now() - wallStartedAt);
  const assistantText = joinDeltas(events);
  const context = await input.pool.query(
    `SELECT sections::text AS sections FROM compiled_contexts
     WHERE user_id = $1 ORDER BY created_at DESC, compiled_context_id DESC LIMIT 1`,
    [fixedInternalOwnerPrincipal.userId],
  );
  const sections = (context.rows[0] as { sections?: unknown } | undefined)
    ?.sections;
  const sectionsRecord =
    typeof sections === "object" && sections !== null
      ? (sections as Record<string, unknown>)
      : {};
  const memorySectionsInContext = (
    ["person_portrait", "objective_memory", "ai_impression"] as const
  ).filter(
    (section) =>
      Array.isArray(sectionsRecord[section]) &&
      sectionsRecord[section]!.length > 0,
  ).length;
  return {
    memorySectionsInContext,
    turn: {
      assistantText,
      domainClockIso: domainNow.toISOString(),
      finalEventType: String(events.at(-1)?.type ?? "none"),
      injectedMemories: 0,
      input: {
        locale: "zh-CN",
        text: input.text,
        timezone: "Asia/Shanghai",
      },
      sequenceInScenario: 4,
      wallMs,
    },
  };
}

/** A content digest of the memory data face — proves "frozen" beyond counts. */
async function memoryFaceDigest(
  pool: Pool,
): Promise<{ claims: number; claimVersions: number; digest: string }> {
  const rows = await pool.query<{ claim_id: string; version_id: string }>(
    `SELECT claim.memory_claim_id::text AS claim_id, claim.current_version_id::text AS version_id
     FROM memory_claims claim
     ORDER BY claim.memory_claim_id`,
  );
  const versions = await pool.query<{ count: string }>(
    `SELECT COUNT(*)::text AS count FROM memory_claim_versions`,
  );
  const digest = createHash("sha256")
    .update(rows.rows.map((row) => `${row.claim_id}:${row.version_id}`).join("\n"))
    .digest("hex");
  return {
    claims: rows.rows.length,
    claimVersions: Number(versions.rows[0]!.count),
    digest,
  };
}

export async function runRollbackDemo(input: {
  champion: ConversationTextChampion;
  conversationAdapter: TwinConversationAdapter;
  log?: (line: string) => void;
  pool: Pool;
  roleRegistry: TwinRoleRegistry;
  scenarios?: readonly TwinScenario[];
}): Promise<{
  manifest: Record<string, unknown>;
  ok: boolean;
  phaseATurns: readonly DemoTurn[];
  phaseBTurn: DemoTurn | null;
}> {
  const log = input.log ?? (() => {});
  const scenarios = input.scenarios ?? ROLLBACK_DEMO_SCENARIOS;
  const runStartedAt = new Date().toISOString();

  // ── Phase A: post-cutover, memory on ──────────────────────────────────────
  const phaseA = await runTwinCapture({
    arm: "on",
    champion: input.champion,
    conversationAdapter: input.conversationAdapter,
    log,
    pool: input.pool,
    roleRegistry: input.roleRegistry,
    scenarioFile: {
      path: "eval/memory-pairwise-126/rollback-demo (inline scenario)",
      scenarioCount: scenarios.length,
    },
    scenarios,
  });
  const phaseATurns: DemoTurn[] = phaseA.transcripts.scenarios.flatMap((scenario) =>
    scenario.turns.map((turn) => ({
      assistantText: turn.assistantText,
      domainClockIso: turn.domainClockIso,
      finalEventType: turn.finalEventType,
      injectedMemories: turn.injectedMemories.length,
      input: turn.input,
      sequenceInScenario: turn.sequenceInScenario,
      wallMs: turn.wallMs,
    })),
  );
  const faceBefore = await memoryFaceDigest(input.pool);
  const epochBefore = await input.pool.query(
    `SELECT data_epoch::text AS epoch FROM app_users WHERE user_id = $1`,
    [fixedInternalOwnerPrincipal.userId],
  );
  const injectedDuringCutover = phaseATurns.reduce(
    (sum, turn) => sum + turn.injectedMemories,
    0,
  );
  log(
    `[rollback-demo] phase A: ${faceBefore.claims} claims, ${injectedDuringCutover} injected memory item(s) across turns`,
  );

  // ── Phase B: code revert + re-pin over the same database ─────────────────
  const lastClockIso =
    phaseA.transcripts.scenarios.at(-1)?.turns.at(-1)?.domainClockIso ??
    new Date().toISOString();
  const postRevert = await runRevertedTurn({
    champion: input.champion,
    conversationAdapter: input.conversationAdapter,
    domainNowIso: new Date(
      new Date(lastClockIso).getTime() + 24 * 60 * 60 * 1_000,
    ).toISOString(),
    pool: input.pool,
    text: "对了，我最近入职的这家公司叫什么来着？想跟朋友提一下。",
  });
  const faceAfter = await memoryFaceDigest(input.pool);
  const epochAfter = await input.pool.query(
    `SELECT data_epoch::text AS epoch FROM app_users WHERE user_id = $1`,
    [fixedInternalOwnerPrincipal.userId],
  );

  // ── Proofs ────────────────────────────────────────────────────────────────
  const claimsFrozen =
    faceBefore.digest === faceAfter.digest &&
    faceBefore.claimVersions === faceAfter.claimVersions;
  const epochFrozen =
    epochBefore.rows[0]?.epoch === epochAfter.rows[0]?.epoch;
  const noMemoryAfterRevert = postRevert.memorySectionsInContext === 0;
  const ok = claimsFrozen && epochFrozen && noMemoryAfterRevert;
  log(
    `[rollback-demo] phase B: memory sections=${postRevert.memorySectionsInContext}, claims frozen=${claimsFrozen}, epoch frozen=${epochFrozen} → ${ok ? "OK" : "FAILED"}`,
  );

  const manifest = {
    artifactClass: "non_authoritative_eval_output",
    capturedAt: runStartedAt,
    completedAt: new Date().toISOString(),
    cutoverPins: phaseA.manifest.cutoverPins,
    dataSourceDeclaration:
      "Fully synthetic scenario material; no real private conversation is read (ADR-0020, ADR-0073).",
    databaseIsolation:
      "disposable isolated PostgreSQL schema on the DATABASE_URL server; dropped after the run",
    phaseA: {
      arm: "on",
      claims: faceBefore.claims,
      claimVersions: faceBefore.claimVersions,
      injectedMemoryItems: injectedDuringCutover,
      memoryFaceDigest: faceBefore.digest,
      turns: phaseATurns.length,
    },
    phaseB: {
      assembly:
        "code-reverted incumbent stack: journal-regeneration catalog, no fast-path enqueue, no consolidation, no retrieval port",
      catalogVersion: JOURNAL_REGENERATION_CONVERSATION_ACTION_CATALOG.version,
      claimsAfter: faceAfter.claims,
      claimVersionsAfter: faceAfter.claimVersions,
      epochAfter: epochAfter.rows[0]?.epoch ?? null,
      memoryFaceDigestAfter: faceAfter.digest,
      memorySectionsInContext: postRevert.memorySectionsInContext,
      turn: postRevert.turn,
    },
    proofs: {
      claimsFrozenInPlace: claimsFrozen,
      dataEpochUntouched: epochFrozen,
      noMemoryPathAfterRevert: noMemoryAfterRevert,
      rollbackFormula:
        "code revert + re-pin of the pre-1A.3a strategy versions; post-cutover Entity / Claim data frozen in place (dormant without a code path; sha256 over claim ids + current version ids is unchanged), never silently deleted",
    },
    scenarioIsolation: "single inline synthetic scenario; the schema is dropped after the run",
    seam: phaseA.manifest.seam,
  };
  return { manifest, ok, phaseATurns, phaseBTurn: postRevert.turn };
}

async function main(): Promise<void> {
  loadDotEnv();
  const arguments_ = process.argv.slice(2);
  let force = false;
  let outDir = path.join(REPOSITORY_ROOT, "eval/memory-pairwise-126/rollback-demo");
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    if (argument === "--force") force = true;
    else if (argument === "--out") outDir = path.resolve(arguments_[++index]!);
    else throw new Error(`Unknown argument: ${argument}`);
  }
  if (!force && existsSync(path.join(outDir, "manifest.json"))) {
    throw new Error(`${outDir} already contains a rollback demo; pass --force to overwrite.`);
  }
  await mkdir(outDir, { recursive: true });

  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error("DATABASE_URL is required.");
  const { champion, conversationAdapter } = buildChampionAssembly(process.env);
  const roleRegistry = buildMemoryRoleRegistry(conversationAdapter, {
    championConfigVersion: champion.configVersion,
    model: champion.model,
    provider: champion.provider,
  });

  const database = await createIsolatedPostgresSchema(databaseUrl);
  console.log("[rollback-demo] isolated schema created");
  try {
    await runMigrations(database.pool);
    const result = await runRollbackDemo({
      champion,
      conversationAdapter,
      log: (line) => console.log(line),
      pool: database.pool,
      roleRegistry,
    });
    await writeFile(
      path.join(outDir, "manifest.json"),
      `${JSON.stringify({ ...result.manifest, gitCommit: gitCommit() }, null, 2)}\n`,
      "utf8",
    );
    await writeFile(
      path.join(outDir, "transcripts.json"),
      `${JSON.stringify(
        {
          capturedAt: result.manifest.capturedAt,
          phaseA: { scenarioId: "rollback-demo-scenario", turns: result.phaseATurns },
          phaseB: result.phaseBTurn,
        },
        null,
        2,
      )}\n`,
      "utf8",
    );
    console.log(
      `[rollback-demo] wrote ${path.relative(process.cwd(), outDir)} (ok=${result.ok})`,
    );
    if (!result.ok) process.exitCode = 1;
  } finally {
    await database.dispose();
    console.log("[rollback-demo] isolated schema dropped; no product state written.");
  }
}

const isDirectRun =
  process.argv[1] &&
  path.resolve(process.argv[1]) ===
    path.resolve(new URL(import.meta.url).pathname);
if (isDirectRun) {
  main().catch((error: unknown) => {
    console.error("[rollback-demo] failed:", error);
    process.exitCode = 1;
  });
}

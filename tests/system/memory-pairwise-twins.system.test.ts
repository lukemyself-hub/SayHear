import { readFile } from "node:fs/promises";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Pool } from "pg";

import {
  CATALOG_V2_CONVERSATION_HARNESS_POLICY,
  CANONICAL_PERSONA_VERSION,
  CHINESE_LOCALE_PACK_VERSION,
  ENGLISH_LOCALE_PACK_VERSION,
  FAST_PATH_EXTRACTION_POLICY_VERSION,
  MEMORY_CONSOLIDATION_POLICY_VERSION,
  PERSONA_BEHAVIOR_ANCHORS_VERSION,
  PERSONA_CONTRACT_INVARIANT_VERSION,
  type ConversationTextChampion,
} from "@sayhear/application";
import { createRuntimeJournalRoleProviderRegistry } from "@sayhear/ai";
import { runMigrations } from "@sayhear/data";
import {
  createIsolatedPostgresSchema,
  fixedInternalOwnerPrincipal,
  type IsolatedPostgresSchema,
} from "@sayhear/test-support";

import {
  runTwinCapture,
  type TwinConversationAdapter,
  type TwinRoleRegistry,
  type TwinScenario,
} from "../../eval/memory-pairwise-126/twin-harness";
import {
  buildMemoryPairs,
  selectMemorySample,
} from "../../eval/memory-pairwise-126/build-memory-pairs";
import { verifyManifestPins } from "../../eval/memory-pairwise-126/verify-cutover-pins";
import { runScopeProtectionChecks } from "../../eval/memory-pairwise-126/scope-protection";
import { runRollbackDemo } from "../../eval/memory-pairwise-126/rollback-demo";

/**
 * Issue #126 — the twin capture harness, proven end-to-end through the real
 * authenticated Text seam with deterministic providers (SPEC #107 Testing
 * Decisions: the scriptable adapter scripts the memory roles per Event
 * revision):
 *
 * - Memory-on writes Claims through the real outbox fast-path machinery and
 *   injects memory into the cross-day probe's CompiledContext (AC 35
 *   precondition), recording the retrieval manifest pins.
 * - Memory-off — the same seam with the production write switches off —
 *   writes no Claims, records no retrieval runs, and injects nothing: the
 *   Replay twin is exactly the incumbent behavior under the same persona.
 * - The cutover pin list is recorded in the manifest and equals the
 *   production constants the code resolves.
 * - The memory pair build yields the shared blind-pairwise:v2 protocol shape
 *   the existing review-page / unblind tooling consumes.
 * - The rollback demo freezes the memory data face across the code revert.
 * - Scope protection stays clean against the repo and the frozen incumbent.
 */

const testDatabaseUrl = process.env.TEST_DATABASE_URL;
if (!testDatabaseUrl) {
  throw new Error("TEST_DATABASE_URL is required.");
}

const repositoryRoot = path.resolve(import.meta.dirname, "../..");

const CHAMPION: ConversationTextChampion = Object.freeze({
  configVersion: "conversation-text-champion:v1",
  consentPolicyVersion: null,
  contextLimit: 1_000_000,
  dataRegion: "provider-configured",
  model: "deterministic-test-model",
  provider: "deepseek",
  providerPolicyVersion: "deepseek-conversation-text:v1",
  retentionMode: "store-disabled",
  snapshot: "deterministic-test-model",
  streaming: true,
  supportedLocales: Object.freeze(["en", "zh"]),
  trainingPolicy: "api-data-controls",
});

const CONVERSATION_ADAPTER: TwinConversationAdapter = { type: "deterministic" };

const SCENARIOS: readonly TwinScenario[] = [
  {
    category: "memory_objective",
    description:
      "twin test: cross-day employment recall (zh) — the corpus-proven lexical shapes",
    id: "twin-test-zh",
    languageVariant: "zh",
    locale: "zh-CN",
    timezone: "Asia/Shanghai",
    turns: [
      { text: "跟你分享一下，我最近入职了蓝湾科技，做后端工程师。" },
      { gapMs: 90_000, text: "新同事都挺不错的。" },
      {
        gapMs: 2 * 24 * 60 * 60 * 1_000,
        text: "我在哪家公司上班来着？突然想不起来跟家里人怎么说的。",
      },
    ],
  },
  {
    category: "memory_objective",
    description: "twin test: cross-day employment recall (en, corpus-proven probe)",
    id: "twin-test-en",
    languageVariant: "en",
    locale: "en-US",
    timezone: "America/Los_Angeles",
    turns: [
      { text: "Quick update — I recently joined Nordwave as a backend engineer." },
      { gapMs: 90_000, text: "The team has been great so far, still settling in." },
      {
        gapMs: 2 * 24 * 60 * 60 * 1_000,
        text: "Which company do I work at again? Someone asked me today.",
      },
    ],
  },
];

/** The scripted memory.extract: one objective proposal per marker statement. */
function scriptedRoleRegistry(): TwinRoleRegistry {
  const registry = createRuntimeJournalRoleProviderRegistry({
    adapter: { type: "deterministic" },
    roles: [
      {
        role: "memory.extract",
        provider: "deterministic",
        model: "deterministic-test-model",
        configVersion: "conversation-text-champion:v1:memory-extract",
        policyVersion: "memory-extraction:v1",
        promptFingerprint: "memory-extract:propose:v1",
      },
      {
        role: "entity.resolve",
        provider: "deterministic",
        model: "deterministic-test-model",
        configVersion: "conversation-text-champion:v1:entity-resolve",
        policyVersion: "entity-resolve-gate:v1",
        promptFingerprint: "entity-resolve:gate:v1",
      },
      {
        role: "memory.consolidate",
        provider: "deterministic",
        model: "deterministic-test-model",
        configVersion: "conversation-text-champion:v1:memory-consolidate",
        policyVersion: "memory-consolidation:v1",
        promptFingerprint: "memory-consolidate:diffs:v1",
      },
      {
        role: "evidence.extract",
        provider: "deterministic",
        model: "deterministic-test-model",
        configVersion: "conversation-text-champion:v1:evidence",
        policyVersion: "evidence-extraction:v2",
        promptFingerprint: "evidence-extract:spans:v2",
      },
      {
        role: "journal.draft",
        provider: "deterministic",
        model: "deterministic-test-model",
        configVersion: "conversation-text-champion:v1:journal-draft",
        policyVersion: "journal-generation:v2",
        promptFingerprint: "journal-draft:evidence-only:v2",
      },
      {
        role: "journal.validate",
        provider: "deterministic",
        model: "deterministic-test-model",
        configVersion: "conversation-text-champion:v1:journal-validate",
        policyVersion: "journal-validator:v3",
        promptFingerprint: "journal-validate:diagnostic:v3",
      },
      {
        role: "dialogue.state",
        provider: "deterministic",
        model: "deterministic-test-model",
        configVersion: "dialogue-state-model:v1",
        policyVersion: "dialogue-state:v2",
        promptFingerprint: "dialogue-state-prompt:v2",
      },
      {
        role: "summary.compress",
        provider: "deterministic",
        model: "deterministic-test-model",
        configVersion: "conversation-text-champion:v1:summary",
        policyVersion: "rolling-summary:v1",
        promptFingerprint: "rolling-summary:neutral-structured:v1",
      },
    ],
  });
  return {
    ...registry,
    memoryExtractor: {
      role: "memory.extract",
      async extract(request: {
        revisions: readonly { revisionId: string; text: string }[];
      }) {
        return request.revisions.map((revision) => {
          const text = revision.text;
          const span = `0:${text.length}`;
          const employerBluebay = text.includes("蓝湾科技");
          const employerNordwave = text.includes("Nordwave");
          const employer = employerBluebay || employerNordwave;
          return {
            revisionId: revision.revisionId,
            evidence: [{ locatorKey: span, role: "factual_support" }],
            mentions: [],
            candidates:
              employer
                ? [
                    {
                      basis: "directly_stated",
                      candidateKind: "objective",
                      predicateId: "sh.work.employer",
                      proposedConcept: null,
                      typedValue: employerBluebay ? "蓝湾科技" : "Nordwave",
                      scopeKey: "",
                      subjectMentionIndex: null,
                      objectMentionIndex: null,
                      evidenceLocatorKeys: [span],
                      qualifiers: [],
                      temporal: {
                        temporalStatus: "current",
                        validFrom: null,
                        validFromPrecision: "unknown",
                        validTo: null,
                        validToPrecision: "unknown",
                      },
                      itemClass: employer ? "person" : "event",
                      itemSummary: `stated: ${text.slice(0, 40)}`,
                    },
                  ]
                : [],
            clarifications: [],
          };
        });
      },
    },
    // The slow path admits Claims from pending candidates: propose_new over
    // every candidate the fast path recorded (the deterministic validators
    // still own the admission decision).
    memoryConsolidator: {
      role: "memory.consolidate",
      async consolidate(request: {
        candidates: readonly {
          candidateId: string;
          evidence: readonly { evidenceItemId: string }[];
        }[];
      }) {
        return {
          diffs: request.candidates.map((candidate) => ({
            kind: "propose_new" as const,
            candidateId: candidate.candidateId,
            proposal: null,
            evidenceItemIds: candidate.evidence.map(
              (item) => item.evidenceItemId,
            ),
          })),
        };
      },
    },
  } as unknown as TwinRoleRegistry;
}

async function countClaims(pool: Pool): Promise<number> {
  const result = await pool.query(
    `SELECT COUNT(*)::text AS count FROM memory_claims WHERE user_id = $1`,
    [fixedInternalOwnerPrincipal.userId],
  );
  return Number(result.rows[0]!.count);
}

describe("Memory-on / Memory-off twin capture (issue #126)", () => {
  let database: IsolatedPostgresSchema;

  beforeAll(async () => {
    database = await createIsolatedPostgresSchema(testDatabaseUrl!);
    await runMigrations(database.pool);
  }, 120_000);

  afterAll(async () => {
    await database?.dispose();
  });

  it(
    "memory-on: fast-path Claims commit and the cross-day probe injects memory with pinned manifests",
    async () => {
      const { manifest, transcripts } = await runTwinCapture({
        arm: "on",
        champion: CHAMPION,
        conversationAdapter: CONVERSATION_ADAPTER,
        pool: database.pool,
        roleRegistry: scriptedRoleRegistry(),
        scenarioFile: {
          path: "tests/system/memory-pairwise-twins (inline scenarios)",
          scenarioCount: SCENARIOS.length,
        },
        scenarios: SCENARIOS,
      });

      // The real outbox fast-path machinery committed the Claims. Scenario
      // isolation truncates the memory face between scenarios, so exactly the
      // last scenario's Claim remains at the end (its probe injected below
      // proves the zh scenario's Claim existed before its reset).
      await expect(countClaims(database.pool)).resolves.toBe(1);

      // The cross-day probes injected memory (one of the three memory
      // sections; the selector owns the exact placement).
      const zhProbe = transcripts.scenarios[0]!.turns.at(-1)!;
      const enProbe = transcripts.scenarios[1]!.turns.at(-1)!;
      expect(zhProbe.injectedMemories.length).toBeGreaterThan(0);
      expect(enProbe.injectedMemories.length).toBeGreaterThan(0);
      expect(
        zhProbe.injectedMemories.every((item) =>
          ["person_portrait", "objective_memory", "ai_impression"].includes(
            item.section,
          ),
        ),
      ).toBe(true);
      expect(zhProbe.retrieval.runId).toBeTruthy();
      expect(zhProbe.retrieval.selectionPolicyVersions).toEqual({
        memory_budgets: "memory-budgets:v1",
        portrait_selection: "portrait-selection:v1",
        recall_framing: "recall-framing:v1",
      });
      // The within-day turns before the claims existed inject nothing.
      expect(transcripts.scenarios[0]!.turns[0]!.injectedMemories).toEqual([]);

      // The manifest carries the cutover pin cluster the code resolves.
      expect(manifest.arm).toBe("on");
      expect(manifest.memoryWriteSwitches).toEqual({
        fastPathExtraction: true,
        memoryConsolidation: true,
        memoryRetrieval: true,
      });
      expect(manifest.cutoverPins).toMatchObject({
        fastPathExtractionPolicyVersion: FAST_PATH_EXTRACTION_POLICY_VERSION,
        memoryConsolidationPolicyVersion: MEMORY_CONSOLIDATION_POLICY_VERSION,
        promptArtifacts: {
          groundingGuardAndOpenerPermission: "recall-experience-contract:v1",
          trustActionExpression: "trust-action-expression-contract:v1",
        },
        harnessPolicyVersion: CATALOG_V2_CONVERSATION_HARNESS_POLICY.version,
        persona: {
          anchors: PERSONA_BEHAVIOR_ANCHORS_VERSION,
          canonical: CANONICAL_PERSONA_VERSION,
          invariant: PERSONA_CONTRACT_INVARIANT_VERSION,
        },
        localePacks: {
          chinese: CHINESE_LOCALE_PACK_VERSION,
          english: ENGLISH_LOCALE_PACK_VERSION,
        },
      });
      const catalogPins = manifest.cutoverPins
        .conversationActionCatalog as { actionKinds: string[] };
      expect(catalogPins.actionKinds).toEqual(
        expect.arrayContaining([
          "memory_correction",
          "explain_memory_source",
          "memory_forget_request",
          "memory_forget_reversal",
          "entity_identity_correction",
        ]),
      );

      // The full pin-list gate passes on this run.
      const pack = JSON.parse(
        await readFile(
          path.join(repositoryRoot, "eval/scenario-pack-v3/scenarios.json"),
          "utf8",
        ),
      );
      const verification = verifyManifestPins({
        manifest: manifest as unknown as Record<string, unknown>,
        pack,
        transcripts: transcripts as unknown as Record<string, unknown>,
      });
      expect(verification.issues).toEqual([]);
    },
    120_000,
  );

  it(
    "memory-off: the same frozen input writes no Claims, runs no retrieval, injects nothing",
    async () => {
      const { manifest, transcripts } = await runTwinCapture({
        arm: "off",
        champion: CHAMPION,
        conversationAdapter: CONVERSATION_ADAPTER,
        pool: database.pool,
        roleRegistry: scriptedRoleRegistry(),
        scenarioFile: {
          path: "tests/system/memory-pairwise-twins (inline scenarios)",
          scenarioCount: SCENARIOS.length,
        },
        scenarios: SCENARIOS,
      });

      await expect(countClaims(database.pool)).resolves.toBe(0);
      for (const scenario of transcripts.scenarios) {
        for (const turn of scenario.turns) {
          expect(turn.injectedMemories).toEqual([]);
          expect(turn.retrieval.runId).toBeNull();
          expect(turn.assistantText.length).toBeGreaterThan(0);
        }
      }
      expect(manifest.memoryWriteSwitches).toEqual({
        fastPathExtraction: false,
        memoryConsolidation: false,
        memoryRetrieval: false,
      });
    },
    120_000,
  );

  it(
    "the memory pair build yields the shared blind-pairwise:v2 protocol shape",
    async () => {
      // Re-run both arms over a fresh reset so the pair build sees stable
      // transcripts (the previous assertions already reset the schema state).
      const onRun = await runTwinCapture({
        arm: "on",
        champion: CHAMPION,
        conversationAdapter: CONVERSATION_ADAPTER,
        pool: database.pool,
        roleRegistry: scriptedRoleRegistry(),
        scenarioFile: {
          path: "inline",
          scenarioCount: SCENARIOS.length,
        },
        scenarios: SCENARIOS,
      });
      const offRun = await runTwinCapture({
        arm: "off",
        champion: CHAMPION,
        conversationAdapter: CONVERSATION_ADAPTER,
        pool: database.pool,
        roleRegistry: scriptedRoleRegistry(),
        scenarioFile: { path: "inline", scenarioCount: SCENARIOS.length },
        scenarios: SCENARIOS,
      });

      const { excludedTurns, pairs, sealed } = buildMemoryPairs({
        full: true,
        memoryOff: offRun.transcripts as never,
        memoryOn: onRun.transcripts as never,
        pack: { scenarios: [] },
        sampleSeed: 1260,
        seed: 126,
      });
      expect(excludedTurns).toEqual([]);
      expect(pairs.protocol).toBe("blind-pairwise:v2");
      expect(pairs.scenarios).toHaveLength(2);
      expect(pairs.sampling).toBeUndefined();
      for (const scenario of pairs.scenarios) {
        expect(scenario.turns).toHaveLength(3);
        for (const turn of scenario.turns) {
          expect(turn.responseA.length).toBeGreaterThan(0);
          expect(turn.responseB.length).toBeGreaterThan(0);
        }
      }
      // Blinding: for every scenario the sealed map assigns swapped or kept
      // identities, and the blinded responses match the sealed assignment.
      for (const [scenarioId, assignment] of Object.entries(sealed.mapping)) {
        const pair = pairs.scenarios.find(
          (candidate) => candidate.scenarioId === scenarioId,
        )!;
        const offScenario = offRun.transcripts.scenarios.find(
          (candidate) => candidate.id === scenarioId,
        )!;
        const onScenario = onRun.transcripts.scenarios.find(
          (candidate) => candidate.id === scenarioId,
        )!;
        const firstOff = offScenario.turns[0]!.assistantText;
        const firstOn = onScenario.turns[0]!.assistantText;
        if (assignment.A === "baseline") {
          expect(pair.turns[0]!.responseA).toBe(firstOff);
          expect(pair.turns[0]!.responseB).toBe(firstOn);
        } else {
          expect(pair.turns[0]!.responseA).toBe(firstOn);
          expect(pair.turns[0]!.responseB).toBe(firstOff);
        }
      }
    },
    180_000,
  );

  it(
    "rollback demo: the code revert freezes the memory data face in place",
    async () => {
      const result = await runRollbackDemo({
        champion: CHAMPION,
        conversationAdapter: CONVERSATION_ADAPTER,
        pool: database.pool,
        roleRegistry: scriptedRoleRegistry(),
      });
      expect(result.ok).toBe(true);
      // Phase A really wrote claims through the fast path and injected at the
      // probe; phase B answered with zero memory sections over the same DB.
      const manifest = result.manifest as {
        phaseA: { claims: number; injectedMemoryItems: number };
        phaseB: { memorySectionsInContext: number; claimsAfter: number };
        proofs: Record<string, boolean>;
      };
      expect(manifest.phaseA.claims).toBeGreaterThan(0);
      expect(manifest.phaseA.injectedMemoryItems).toBeGreaterThan(0);
      expect(manifest.phaseB.memorySectionsInContext).toBe(0);
      expect(manifest.phaseB.claimsAfter).toBe(manifest.phaseA.claims);
      expect(manifest.proofs.claimsFrozenInPlace).toBe(true);
      expect(manifest.proofs.dataEpochUntouched).toBe(true);
      expect(manifest.proofs.noMemoryPathAfterRevert).toBe(true);
    },
    120_000,
  );

  it("scope protection: no 1A.3b artifact, champion cluster unchanged", async () => {
    const incumbent = JSON.parse(
      await readFile(
        path.join(repositoryRoot, "eval/incumbent-baseline/run/manifest.json"),
        "utf8",
      ),
    );
    const twin = {
      arm: "on",
      systemVersions: incumbent.systemVersions,
    };
    const { issues } = await runScopeProtectionChecks({
      incumbentManifest: incumbent,
      twinManifest: twin,
    });
    expect(issues).toEqual([]);
  });

  it("the ADR-0114 memory sample satisfies quotas and forced coverage deterministically", () => {
    // A miniature pool mirroring the pack's memory distribution plus general
    // filler, exercising the same constraint structure as the real run.
    const candidates = [
      { id: "mo-en", categories: ["memory_objective"], languageVariant: "en" as const },
      { id: "mo-zh", categories: ["memory_objective"], languageVariant: "zh" as const },
      { id: "mo-mix", categories: ["memory_objective"], languageVariant: "code_switch" as const },
      { id: "mi-en", categories: ["memory_impression"], languageVariant: "en" as const },
      { id: "mi-zh", categories: ["memory_impression"], languageVariant: "zh" as const },
      { id: "mi-mix", categories: ["memory_impression"], languageVariant: "code_switch" as const },
      { id: "mc-en", categories: ["memory_continuity"], languageVariant: "en" as const },
      { id: "mc-zh", categories: ["memory_continuity"], languageVariant: "zh" as const },
      { id: "mc-mix", categories: ["memory_continuity"], languageVariant: "code_switch" as const },
      { id: "mt-en", categories: ["memory_temporal", "post_correction"], languageVariant: "en" as const },
      { id: "mt-zh", categories: ["memory_temporal", "post_correction"], languageVariant: "zh" as const },
      { id: "mt-mix", categories: ["memory_temporal", "post_forget"], languageVariant: "code_switch" as const },
      ...Array.from({ length: 42 }, (_, index) => ({
        id: `general-${index}`,
        categories: ["ordinary_sharing"],
        languageVariant: (["en", "zh", "code_switch"] as const)[index % 3]!,
      })),
    ];
    const selection = selectMemorySample({ candidates, sampleSeed: 1260 });
    expect(selection.scenarioIds).toHaveLength(15);
    expect(selection.selectedCounts).toEqual({ en: 8, zh: 5, code_switch: 2 });
    for (const [forced, scenarioId] of Object.entries(selection.forcedCoverage)) {
      const selected = candidates.find(
        (candidate) => candidate.id === scenarioId,
      )!;
      expect(selected.categories).toContain(forced);
    }
    // The post_forget bearer (only in code_switch, capped at 2) must survive
    // the quota pressure — ADR-0114's "cannot lose the forced categories".
    expect(selection.scenarioIds).toContain("mt-mix");
    // Determinism: the same seed reproduces the sample byte-for-byte.
    expect(selectMemorySample({ candidates, sampleSeed: 1260 })).toEqual(
      selection,
    );
    // A pool that cannot cover a forced category fails loudly.
    expect(() =>
      selectMemorySample({
        candidates: candidates.filter(
          (candidate) => !candidate.categories.includes("post_forget"),
        ),
        sampleSeed: 1260,
      }),
    ).toThrow(/post_forget/);
  });
});

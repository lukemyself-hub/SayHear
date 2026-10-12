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
  TRUST_ACTION_EXPRESSION_CONTRACT_VERSION,
  type ConversationTextChampion,
} from "@sayhear/application";
import { buildMemoryRoleRegistry } from "../../eval/memory-pairwise-126/shared";
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

/** The scripted memory roles over the shared deterministic registry. */
function scriptedRoleRegistry(): TwinRoleRegistry {
  const registry = buildMemoryRoleRegistry(
    { type: "deterministic" },
    {
      championConfigVersion: "conversation-text-champion:v1",
      model: "deterministic-test-model",
      provider: "deterministic",
    },
  );
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
        retrievalMonotonicNow: () => 0,
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
        recall_framing: "recall-framing:v2",
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
          trustActionExpression: TRUST_ACTION_EXPRESSION_CONTRACT_VERSION,
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
        retrievalMonotonicNow: () => 0,
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
        retrievalMonotonicNow: () => 0,
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
        retrievalMonotonicNow: () => 0,
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
      // The forced-coverage tags travel with each pair (fence reasons are
      // not pack categories).
      for (const scenario of pairs.scenarios) {
        expect(scenario.coverageTags).toContain("memory_objective");
      }
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
        retrievalMonotonicNow: () => 0,
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

  it("scope protection: no unplanned vector artifact, champion cluster unchanged", async () => {
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

  it("the shared unblind gates compute over the memory coverage keys (issue #126 gate mechanics)", async () => {
    // A synthetic pairs file in exactly the shape build-memory-pairs emits
    // (sampling.protectedCoverage over ADR-0114 memory keys; fence-reason
    // coverage tags instead of pack categories), scored completely, then run
    // through the REAL unblind CLI. This pins the fix for the gate that used
    // to demand the #79 general categories on a memory run.
    const { execFileSync } = await import("node:child_process");
    const { mkdtemp, writeFile, readFile } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const runUnblind = async (
      dir: string,
    ): Promise<{ exit: number; results: Record<string, unknown> }> => {
      try {
        execFileSync(
          "pnpm",
          [
            "exec",
            "tsx",
            "eval/blind-pairwise/unblind.ts",
            "--dir",
            dir,
          ],
          { cwd: repositoryRoot, encoding: "utf8", stdio: "pipe" },
        );
      } catch (error) {
        const failure = error as { status?: number };
        // A gate failure exits non-zero; parse results either way below.
        return {
          exit: failure.status ?? 1,
          results: JSON.parse(await readFile(path.join(dir, "results.json"), "utf8")),
        };
      }
      return {
        exit: 0,
        results: JSON.parse(await readFile(path.join(dir, "results.json"), "utf8")),
      };
    };
    const makeRun = async (scoreScenario: (ordinal: number) => "A" | "B") => {
      const dir = await mkdtemp(path.join(tmpdir(), "memory-unblind-"));
      const scenarioSpecs = [
        {
          category: "memory_objective",
          coverageTags: ["memory_objective"],
          id: "s-objective",
          languageVariant: "en",
        },
        {
          category: "memory_temporal",
          coverageTags: ["memory_temporal", "post_forget"],
          id: "s-temporal",
          languageVariant: "code_switch",
        },
      ];
      const mapping: Record<string, { A: string; B: string }> = {};
      const scenarios = scenarioSpecs.map((spec, ordinal) => {
        // Seed 0: identityAssignmentForScenario(0, 0) draws < 0.5 → A=baseline
        // (memory-off), B=candidate (memory-on); ordinal 1 swaps.
        mapping[spec.id] =
          ordinal % 2 === 0
            ? { A: "baseline", B: "candidate" }
            : { A: "candidate", B: "baseline" };
        return {
          category: spec.category,
          coverageTags: spec.coverageTags,
          description: "synthetic memory pair",
          languageVariant: spec.languageVariant,
          scenarioId: spec.id,
          turns: [1, 2].map((sequence) => ({
            responseA: `arm A reply ${sequence}`,
            responseB: `arm B reply ${sequence}`,
            sequenceInScenario: sequence,
            userInput: {
              locale: "en-US",
              text: `turn ${sequence}`,
              timezone: "UTC",
            },
          })),
        };
      });
      const pairs = {
        baselineSource: "memory-off twin",
        candidateSource: "memory-on twin",
        excludedScenarios: [],
        excludedTurns: [],
        generatedAt: new Date().toISOString(),
        protocol: "blind-pairwise:v2",
        scenarios,
        sampling: {
          eligibleCounts: { en: 4, zh: 4, code_switch: 4 },
          protectedCoverage: {
            memory_objective: "s-objective",
            memory_temporal: "s-temporal",
            post_forget: "s-temporal",
          },
          quotas: { en: 1, zh: 0, code_switch: 1 },
          sampleSeed: 1260,
          selectedCounts: { en: 1, zh: 0, code_switch: 1 },
          strategy: "stratified-random-v1",
        },
        seed: 126,
      };
      const scores = {
        protocol: "blind-pairwise:v2",
        scenarios: scenarioSpecs.map((spec, ordinal) => ({
          overallChoice: scoreScenario(ordinal),
          scenarioId: spec.id,
          turns: [1, 2].map((sequence) => ({
            choice: scoreScenario(ordinal),
            sequenceInScenario: sequence,
          })),
        })),
        scoredAt: new Date().toISOString(),
        scorer: "gate-mechanics-test",
      };
      await writeFile(path.join(dir, "pairs.json"), JSON.stringify(pairs), "utf8");
      await writeFile(
        path.join(dir, "sealed-identities.json"),
        JSON.stringify({ generatedAt: new Date().toISOString(), mapping, protocol: "blind-pairwise:v2", seed: 126 }),
        "utf8",
      );
      await writeFile(path.join(dir, "scores.json"), JSON.stringify(scores), "utf8");
      return dir;
    };
    const candidateSide = (ordinal: number) => (ordinal % 2 === 0 ? "B" : "A");

    // All-candidate scoring: every gate passes, including the memory
    // coverage keys resolved through categories and tags.
    const passDir = await makeRun(candidateSide);
    const passed = await runUnblind(passDir);
    expect(passed.exit).toBe(0);
    const passGate = (
      (passed.results as { gate?: Record<string, { passed?: boolean }> }).gate ??
      {}
    );
    expect(passGate.candidateStrictlyPreferredOverall?.passed).toBe(true);
    expect(passGate.localeNoRegression?.passed).toBe(true);
    expect(passGate.protectedCategoryNoRegression?.passed).toBe(true);
    const protectedCategories = (
      passed.results as {
        pairwise?: {
          protectedCategories?: Record<string, { sampledScenarios: number }>;
        };
      }
    ).pairwise?.protectedCategories;
    expect(protectedCategories?.memory_objective?.sampledScenarios).toBe(1);
    expect(protectedCategories?.post_forget?.sampledScenarios).toBe(1);

    // One forced-category bearer scored for the baseline arm fails the
    // protected-coverage gate (net regression is not offsettable). The tool
    // records gate verdicts in results.json; only reverse-check failures
    // exit non-zero, so the merge decision reads the gate block.
    const failDir = await makeRun((ordinal) =>
      ordinal === 1 ? (candidateSide(ordinal) === "B" ? "A" : "B") : candidateSide(ordinal),
    );
    const failed = await runUnblind(failDir);
    expect(failed.exit).toBe(0);
    const failGate = (
      (failed.results as { gate?: Record<string, { passed?: boolean; regressions?: string[] }> }).gate ?? {}
    );
    expect(failGate.protectedCategoryNoRegression?.passed).toBe(false);
    expect(failGate.protectedCategoryNoRegression?.regressions).toEqual(
      expect.arrayContaining([expect.stringContaining("post_forget")]),
    );
  }, 120_000);

  it("the ADR-0114 memory sample satisfies quotas and forced coverage deterministically", () => {    // A miniature pool mirroring the pack's memory distribution plus general
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

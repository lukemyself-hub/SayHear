import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { mkdir } from "node:fs/promises";

export const V5_REVIEW_PROTOCOL = "blind-pairwise:g2-v5" as const;
export const V5_REVIEW_PACKAGE = "1a3b-g2-review-package:v5" as const;
export const V5_SCORE_VERSION = "1a3b-g2-scores:v5" as const;

type Choice = "A" | "B" | "tie";
type OmissionChoice = "silence_appropriate" | "should_follow_up" | "cannot_judge";

type ReviewPackage = Readonly<{
  packageFingerprint: string;
  fingerprintKind: "rawSha256 of payload bytes";
  payload: Readonly<{
    protocolVersion: typeof V5_REVIEW_PROTOCOL;
    packageVersion: typeof V5_REVIEW_PACKAGE;
    capturedDate: string;
    pairwiseCases: readonly Readonly<{
      caseId: string;
      languageVariant: "en" | "zh" | "code_switch";
      turns: readonly Readonly<{
        sequence: number;
        responseA: string | null;
        responseB: string | null;
      }>[];
    }>[];
    omissionCases: readonly Readonly<{
      caseId: string;
      languageVariant: "en" | "zh" | "code_switch";
    }>[];
  }>;
}>;

type Scores = Readonly<{
  scoreVersion: typeof V5_SCORE_VERSION;
  protocolVersion: typeof V5_REVIEW_PROTOCOL;
  packageVersion: typeof V5_REVIEW_PACKAGE;
  packageFingerprint: string;
  scorer: string;
  scoredAt: string;
  pairwiseDecisions: readonly Readonly<{
    caseId: string;
    turnDecisions: readonly Readonly<{ sequence: number; choice: Choice }>[];
    sceneDecision: Choice;
  }>[];
  omissionDecisions: readonly Readonly<{ caseId: string; choice: OmissionChoice }>[];
}>;

type SealedMapping = Readonly<{
  caseId: string;
  fixtureId: string;
  family: string;
  topic?: string;
  targetKind?: "open_loop" | "memory_claim";
  completeStatefulTrajectory?: boolean;
  protectedCategories: readonly string[];
  protectedEvidenceSequences?: Readonly<Record<string, number>>;
  languageVariant: "en" | "zh" | "code_switch";
  offIsA?: boolean;
  candidateIsA?: boolean;
  expectedOmissionReason?: string;
}>;

type SealedFile = Readonly<{
  packageFingerprint: string;
  mappings: readonly SealedMapping[];
}>;

export type V5ReviewInput = Readonly<{
  reviewPackage: ReviewPackage;
  scores: Scores;
  sealed: SealedFile;
}>;

export type V5UnblindResult = Readonly<{
  scoreVersion: typeof V5_SCORE_VERSION;
  protocolVersion: typeof V5_REVIEW_PROTOCOL;
  packageVersion: typeof V5_REVIEW_PACKAGE;
  packageFingerprint: string;
  scorer: string;
  scoredAt: string;
  metrics: Readonly<{
    candidateWins: number;
    candidateLosses: number;
    sceneTies: number;
    overallNet: number;
    turnCandidateWins: number;
    turnCandidateLosses: number;
    turnTies: number;
    byLanguage: Readonly<Record<string, Readonly<{ wins: number; losses: number; net: number }>>>;
    byProtectedCategory: Readonly<Record<string, Readonly<{ wins: number; losses: number; net: number }>>>;
    omissionSilenceAppropriate: number;
    omissionShouldFollowUp: number;
    omissionCannotJudge: number;
  }>;
  gates: Readonly<Record<string, boolean>>;
  failures: readonly string[];
  passed: boolean;
}>;

function rawSha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function assertUniqueIds(ids: readonly string[], name: string): void {
  if (new Set(ids).size !== ids.length) throw new Error(`${name} contains duplicate case IDs.`);
}

export function fingerprintReviewPayload(payload: ReviewPackage["payload"]): string {
  return rawSha256(`${JSON.stringify(payload, null, 2)}\n`);
}

export function unblindV5(input: V5ReviewInput): V5UnblindResult {
  const { reviewPackage, scores, sealed } = input;
  const payload = reviewPackage.payload;
  if (
    payload.protocolVersion !== V5_REVIEW_PROTOCOL ||
    payload.packageVersion !== V5_REVIEW_PACKAGE ||
    scores.scoreVersion !== V5_SCORE_VERSION ||
    scores.protocolVersion !== V5_REVIEW_PROTOCOL ||
    scores.packageVersion !== V5_REVIEW_PACKAGE
  ) {
    throw new Error("The v5 unblinder only accepts the v5 review and score protocols.");
  }
  const fingerprint = fingerprintReviewPayload(payload);
  if (
    reviewPackage.packageFingerprint !== fingerprint ||
    scores.packageFingerprint !== fingerprint ||
    sealed.packageFingerprint !== fingerprint
  ) {
    throw new Error("The review payload, score file, and sealed identities do not share the exact package fingerprint.");
  }
  if (!scores.scorer.trim() || !Number.isFinite(Date.parse(scores.scoredAt))) {
    throw new Error("Scores require a scorer and valid scoredAt timestamp.");
  }
  if (payload.pairwiseCases.length !== 10 || payload.omissionCases.length !== 8) {
    throw new Error("The v5 review package must contain exactly 10 pairwise and 8 omission cases.");
  }

  const pairCases = new Map(payload.pairwiseCases.map((item) => [item.caseId, item]));
  const pairScores = new Map(scores.pairwiseDecisions.map((item) => [item.caseId, item]));
  const omissions = new Map(payload.omissionCases.map((item) => [item.caseId, item]));
  const omissionScores = new Map(scores.omissionDecisions.map((item) => [item.caseId, item]));
  const mappingById = new Map(sealed.mappings.map((item) => [item.caseId, item]));
  assertUniqueIds([...pairCases.keys()], "Review pairwise cases");
  assertUniqueIds([...pairScores.keys()], "Pairwise scores");
  assertUniqueIds([...omissions.keys()], "Review omission cases");
  assertUniqueIds([...omissionScores.keys()], "Omission scores");
  assertUniqueIds([...mappingById.keys()], "Sealed mappings");
  if (
    pairScores.size !== pairCases.size ||
    omissions.size !== omissionScores.size ||
    mappingById.size !== pairCases.size + omissions.size
  ) {
    throw new Error("Scores or sealed mappings have missing or extra cases.");
  }

  let candidateWins = 0;
  let candidateLosses = 0;
  let sceneTies = 0;
  let turnCandidateWins = 0;
  let turnCandidateLosses = 0;
  let turnTies = 0;
  const byLanguage: Record<string, { wins: number; losses: number; net: number }> = {};
  const byProtectedCategory: Record<string, { wins: number; losses: number; net: number }> = {};
  const familyCounts = new Map<string, number>();
  const topicCounts = new Map<string, number>();
  const targetKindCounts = new Map<string, number>();
  const completeStatefulCount = { value: 0 };
  const offSideCounts = { A: 0, B: 0 };
  for (const [caseId, item] of pairCases) {
    const decision = pairScores.get(caseId);
    const mapping = mappingById.get(caseId);
    if (!decision || !mapping || mapping.offIsA === undefined || mapping.candidateIsA === undefined) {
      throw new Error(`${caseId} has no complete pairwise score or sealed identity.`);
    }
    if (mapping.candidateIsA === mapping.offIsA || mapping.languageVariant !== item.languageVariant) {
      throw new Error(`${caseId} sealed identity is inconsistent with the public case.`);
    }
    if (!["A", "B", "tie"].includes(decision.sceneDecision)) {
      throw new Error(`${caseId} has an invalid or incomplete scene decision.`);
    }
    if (!mapping.topic || !mapping.targetKind) {
      throw new Error(`${caseId} sealed identity is missing sampling metadata.`);
    }
    for (const category of mapping.protectedCategories) {
      const sequence = mapping.protectedEvidenceSequences?.[category];
      if (!Number.isInteger(sequence) || !item.turns.some((turn) => turn.sequence === sequence)) {
        throw new Error(`${caseId} protected category ${category} lacks a visible real-turn reference.`);
      }
    }
    if (mapping.family === "stateful_suppression" && mapping.completeStatefulTrajectory === true) {
      completeStatefulCount.value += 1;
    }
    familyCounts.set(mapping.family, (familyCounts.get(mapping.family) ?? 0) + 1);
    topicCounts.set(mapping.topic, (topicCounts.get(mapping.topic) ?? 0) + 1);
    targetKindCounts.set(mapping.targetKind, (targetKindCounts.get(mapping.targetKind) ?? 0) + 1);
    offSideCounts[mapping.offIsA ? "A" : "B"] += 1;
    byLanguage[item.languageVariant] ??= { wins: 0, losses: 0, net: 0 };
    for (const category of mapping.protectedCategories) {
      byProtectedCategory[category] ??= { wins: 0, losses: 0, net: 0 };
    }
    const expectedSequences = item.turns.filter((turn) => turn.responseA !== null || turn.responseB !== null).map((turn) => turn.sequence);
    const turnChoices = new Map(decision.turnDecisions.map((turn) => [turn.sequence, turn.choice]));
    assertUniqueIds(decision.turnDecisions.map((turn) => String(turn.sequence)), `${caseId} turn scores`);
    if (
      turnChoices.size !== expectedSequences.length ||
      expectedSequences.some((sequence) => !turnChoices.has(sequence))
    ) {
      throw new Error(`${caseId} must score every visible difference turn exactly once.`);
    }
    if ([...turnChoices.values()].some((choice) => !["A", "B", "tie"].includes(choice))) {
      throw new Error(`${caseId} has an invalid or incomplete turn decision.`);
    }
    const countTurn = (choice: Choice): void => {
      if (choice === "tie") {
        turnTies += 1;
        return;
      }
      const candidatePicked = (choice === "A") === mapping.candidateIsA;
      if (candidatePicked) turnCandidateWins += 1;
      else turnCandidateLosses += 1;
    };
    for (const choice of turnChoices.values()) countTurn(choice);
    if (decision.sceneDecision === "tie") sceneTies += 1;
    else {
      const candidatePicked = (decision.sceneDecision === "A") === mapping.candidateIsA;
      const language = byLanguage[item.languageVariant]!;
      if (candidatePicked) {
        candidateWins += 1;
        language.wins += 1;
      } else {
        candidateLosses += 1;
        language.losses += 1;
      }
      language.net = language.wins - language.losses;
      for (const category of mapping.protectedCategories) {
        const metrics = byProtectedCategory[category]!;
        if (candidatePicked) metrics.wins += 1;
        else metrics.losses += 1;
        metrics.net = metrics.wins - metrics.losses;
      }
    }
  }

  let omissionSilenceAppropriate = 0;
  let omissionShouldFollowUp = 0;
  let omissionCannotJudge = 0;
  const omissionReasons = new Set<string>();
  const omissionLanguages = new Set<string>();
  const omissionTargetKinds = new Set<string>();
  for (const [caseId, item] of omissions) {
    const decision = omissionScores.get(caseId);
    const mapping = mappingById.get(caseId);
    if (!decision || !mapping || mapping.offIsA !== undefined || mapping.candidateIsA !== undefined) {
      throw new Error(`${caseId} is not a typed omission case.`);
    }
    if (!["silence_appropriate", "should_follow_up", "cannot_judge"].includes(decision.choice)) {
      throw new Error(`${caseId} has an invalid or incomplete omission decision.`);
    }
    if (!mapping.expectedOmissionReason || !mapping.targetKind || mapping.languageVariant !== item.languageVariant) {
      throw new Error(`${caseId} sealed omission audit metadata is incomplete.`);
    }
    omissionReasons.add(mapping.expectedOmissionReason);
    omissionLanguages.add(mapping.languageVariant);
    omissionTargetKinds.add(mapping.targetKind);
    if (decision.choice === "silence_appropriate") omissionSilenceAppropriate += 1;
    else if (decision.choice === "should_follow_up") omissionShouldFollowUp += 1;
    else omissionCannotJudge += 1;
  }

  const omissionReasonCounts = new Map<string, number>();
  for (const mapping of mappingById.values()) {
    if (mapping.expectedOmissionReason) omissionReasonCounts.set(mapping.expectedOmissionReason, (omissionReasonCounts.get(mapping.expectedOmissionReason) ?? 0) + 1);
  }
  if (
    pairCases.size !== 10 ||
    [...pairCases.values()].filter((item) => item.languageVariant === "en").length !== 5 ||
    [...pairCases.values()].filter((item) => item.languageVariant === "zh").length !== 3 ||
    [...pairCases.values()].filter((item) => item.languageVariant === "code_switch").length !== 2 ||
    (familyCounts.get("positive_open_loop") ?? 0) < 3 ||
    (familyCounts.get("positive_memory") ?? 0) < 3 ||
    (familyCounts.get("stateful_suppression") ?? 0) < 2 ||
    completeStatefulCount.value < 2 ||
    (familyCounts.get("competing_pool") ?? 0) < 1 ||
    [...topicCounts.values()].some((count) => count > 3) ||
    (targetKindCounts.get("open_loop") ?? 0) < 4 ||
    (targetKindCounts.get("memory_claim") ?? 0) < 4 ||
    !["refusal", "short_answer", "topic_change", "direct_task"].every((category) => byProtectedCategory[category] !== undefined) ||
    offSideCounts.A !== 5 ||
    offSideCounts.B !== 5 ||
    omissionReasons.size !== 4 ||
    !["no_genuine_opportunity", "duplicates_main_response", "insufficient_grounding", "timing_not_natural"].every((reason) => omissionReasons.has(reason) && omissionReasonCounts.get(reason) === 2) ||
    omissionLanguages.size !== 3 ||
    omissionTargetKinds.size !== 2
  ) {
    throw new Error("Sealed identities do not satisfy the frozen v5 sample and omission coverage contract.");
  }

  const failures: string[] = [];
  const languageGate = Object.values(byLanguage).every((metrics) => metrics.net >= 0);
  const protectedGate = Object.values(byProtectedCategory).length > 0 &&
    Object.values(byProtectedCategory).every((metrics) => metrics.net >= 0);
  const gates = {
    strictPositiveOverallNet: candidateWins - candidateLosses > 0,
    noLanguageNetRegression: languageGate,
    noProtectedCategoryNetRegression: protectedGate,
    sceneTiesAtMostThree: sceneTies <= 3,
    noOmissionShouldFollowUp: omissionShouldFollowUp === 0,
    noOmissionCannotJudge: omissionCannotJudge === 0,
  };
  for (const [gate, passed] of Object.entries(gates)) if (!passed) failures.push(gate);
  return {
    scoreVersion: V5_SCORE_VERSION,
    protocolVersion: V5_REVIEW_PROTOCOL,
    packageVersion: V5_REVIEW_PACKAGE,
    packageFingerprint: fingerprint,
    scorer: scores.scorer,
    scoredAt: scores.scoredAt,
    metrics: {
      candidateWins,
      candidateLosses,
      sceneTies,
      overallNet: candidateWins - candidateLosses,
      turnCandidateWins,
      turnCandidateLosses,
      turnTies,
      byLanguage,
      byProtectedCategory,
      omissionSilenceAppropriate,
      omissionShouldFollowUp,
      omissionCannotJudge,
    },
    gates,
    failures,
    passed: failures.length === 0,
  };
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const readArgument = (name: string): string => {
    const index = args.indexOf(name);
    const value = index < 0 ? undefined : args[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`${name} requires a file path.`);
    return value;
  };
  const publicPath = readArgument("--public");
  const scoresPath = readArgument("--scores");
  const sealedPath = readArgument("--sealed");
  const outPath = readArgument("--out");
  const reviewPackage = JSON.parse(await readFile(resolve(publicPath), "utf8")) as ReviewPackage;
  const scores = JSON.parse(await readFile(resolve(scoresPath), "utf8")) as Scores;
  // Verify the public artifact and completed score file before opening the
  // operator-only mapping.
  const fingerprint = fingerprintReviewPayload(reviewPackage.payload);
  if (
    reviewPackage.packageFingerprint !== fingerprint ||
    scores.packageFingerprint !== fingerprint
  ) {
    throw new Error("Public package or scores fingerprint mismatch; sealed identities were not read.");
  }
  const sealed = JSON.parse(await readFile(resolve(sealedPath), "utf8")) as SealedFile;
  const result = unblindV5({ reviewPackage, scores, sealed });
  await mkdir(dirname(resolve(outPath)), { recursive: true });
  await writeFile(resolve(outPath), `${JSON.stringify(result, null, 2)}\n`, "utf8");
  console.log(JSON.stringify({ output: outPath, passed: result.passed, failures: result.failures }, null, 2));
  if (!result.passed) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
}

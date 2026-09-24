import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import { sha256, shuffled } from "./protocol";
import {
  selectV5PairwiseSample,
  V5_PAIRWISE_SIZE,
  V5_SAMPLE_SEED,
} from "./sampling-v5";
import {
  matchesV5TargetRef,
  type V5ArmRun,
  type V5CatalogManifest,
  type V5LedgerScenario,
  type V5MainRun,
  type V5Scene,
  type V5SceneFile,
  type V5TargetRef,
  type V5TreatmentLedger,
  type V5TreatmentVerification,
} from "./protocol-v5";

const ROOT = "eval/continuation-acceptance-1a3b";
const RUN = `${ROOT}/run-v5`;
const REVIEW = `${RUN}/review`;
const OPERATOR = `${RUN}/operator`;
const CATALOG_PATH = `${ROOT}/fixtures-v5.json`;
const PINS_PATH = `${ROOT}/pins-v5.json`;
const SELECTION_PATH = `${OPERATOR}/expression-selection.json`;
const MAIN_PATH = `${RUN}/continuation-main.json`;
const OFF_PATH = `${RUN}/continuation-off.json`;
const ON_PATH = `${RUN}/continuation-on.json`;
const LEDGER_PATH = `${RUN}/treatment-ledger.json`;
const VERIFICATION_PATH = `${RUN}/verification.json`;
const SAMPLE_SEED_PATH = `${ROOT}/review-seed-v5.json`;
const PREREGISTRATION_PATH = `${ROOT}/preregistration-v5.json`;
const POSITIVE_COUNTS_PATH = `${ROOT}/formal-positive-counts-v5.json`;

type PublicDate = Readonly<{ currentDate: string; elapsedDays: number }>;
type PublicContext = Readonly<{ label: string; text: string }>;
type PublicPairTurn = Readonly<{
  sequence: number;
  userText: string;
  date: PublicDate;
  sharedResponse: string | null;
  responseA: string | null;
  responseB: string | null;
}>;
type PublicPairCase = Readonly<{
  caseId: string;
  languageVariant: V5Scene["languageVariant"];
  context: readonly PublicContext[];
  turns: readonly PublicPairTurn[];
}>;
type PublicOmissionTurn = Readonly<{
  sequence: number;
  userText: string;
  mainResponse: string;
  date: PublicDate;
}>;
type PublicOmissionCase = Readonly<{
  caseId: string;
  languageVariant: V5Scene["languageVariant"];
  context: readonly PublicContext[];
  targetGrounding: string;
  turns: readonly PublicOmissionTurn[];
}>;
type PublicPayload = Readonly<{
  protocolVersion: "blind-pairwise:g2-v5";
  packageVersion: "1a3b-g2-review-package:v5";
  capturedDate: string;
  pairwiseCases: readonly PublicPairCase[];
  omissionCases: readonly PublicOmissionCase[];
}>;

function rawSha256(raw: string): string {
  return createHash("sha256").update(raw).digest("hex");
}

function jsonRaw(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

async function readJson<T>(path: string): Promise<{ raw: string; value: T }> {
  const raw = await readFile(resolve(path), "utf8");
  return { raw, value: JSON.parse(raw) as T };
}

function isSameInputFingerprint(
  raw: string,
  expected: V5TreatmentVerification["inputFingerprints"][number],
): boolean {
  return (
    rawSha256(raw) === expected.rawSha256 &&
    sha256(JSON.parse(raw) as unknown) === expected.canonicalJsonSha256
  );
}

function turnDate(turn: V5Scene["turns"][number], domainTime: string): PublicDate {
  const date = new Intl.DateTimeFormat("en-CA", {
    timeZone: turn.userInput.timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(Date.parse(domainTime) + (turn.clockAdvanceDays ?? 0) * 86_400_000));
  return { currentDate: date, elapsedDays: turn.clockAdvanceDays ?? 0 };
}

function findSelectedTarget(
  scene: V5Scene,
  ledger: V5LedgerScenario,
  sequence: number,
): V5TargetRef | null {
  const selected = ledger.turns.find((turn) => turn.sequenceInScenario === sequence)?.on.selectedTargetRef;
  if (!selected) return null;
  if (selected.startsWith("memory_claim:")) {
    const memoryId = selected.slice("memory_claim:".length);
    return { kind: "memory_claim", memoryId };
  }
  if (!selected.startsWith("open_loop:")) return null;
  const targetId = selected.slice("open_loop:".length);
  return ledger.formedTargetRefs.find((entry) => entry.targetId === targetId)?.ref ?? null;
}

function groundingFor(
  scene: V5Scene,
  ledger: V5LedgerScenario,
  targetRef: V5TargetRef | null,
): PublicContext[] {
  if (!targetRef) return [];
  if (targetRef.kind === "memory_claim") {
    const memory = scene.memory.find((entry) => entry.id === targetRef.memoryId);
    if (memory) return [{ label: "Earlier context", text: memory.text }];
    const portrait = scene.portrait.find((entry) => entry.id === targetRef.memoryId);
    return portrait ? [{ label: "Earlier context", text: portrait.text }] : [];
  }
  const formed = ledger.formedTargetRefs.find((entry) => matchesV5TargetRef(entry.ref, targetRef));
  if (!formed) return [];
  const sourceText =
    targetRef.sourceTurn === 0
      ? scene.historicalEvents[0]?.text
      : scene.turns[targetRef.sourceTurn - 1]?.userInput.text;
  return sourceText ? [{ label: "Earlier context", text: `Earlier you said: ${sourceText}` }] : [];
}

function scoreTemplate(payload: PublicPayload, packageFingerprint: string) {
  return {
    scoreVersion: "1a3b-g2-scores:v5",
    protocolVersion: payload.protocolVersion,
    packageVersion: payload.packageVersion,
    packageFingerprint,
    scorer: "",
    scoredAt: "",
    pairwiseDecisions: payload.pairwiseCases.map((item) => ({
      caseId: item.caseId,
      turnDecisions: item.turns
        .filter((turn) => turn.responseA !== null || turn.responseB !== null)
        .map((turn) => ({ sequence: turn.sequence, choice: "" })),
      sceneDecision: "",
    })),
    omissionDecisions: payload.omissionCases.map((item) => ({
      caseId: item.caseId,
      choice: "",
    })),
  };
}

async function main(): Promise<void> {
  const [catalogFile, pinsFile, selectionFile, mainFile, offFile, onFile, ledgerFile, verificationFile, seedFile, preregistrationFile, countsFile] =
    await Promise.all([
      readJson<V5CatalogManifest>(CATALOG_PATH),
      readJson<unknown>(PINS_PATH),
      readJson<unknown>(SELECTION_PATH),
      readJson<V5MainRun>(MAIN_PATH),
      readJson<V5ArmRun>(OFF_PATH),
      readJson<V5ArmRun>(ON_PATH),
      readJson<V5TreatmentLedger>(LEDGER_PATH),
      readJson<V5TreatmentVerification>(VERIFICATION_PATH),
      readJson<{
        version: string;
        sampleSeed: number;
        armAssignmentSeedOffset: number;
        pairwiseSize: number;
        languageQuotas: Readonly<Record<string, number>>;
        armPositions: Readonly<Record<string, number>>;
      }>(SAMPLE_SEED_PATH),
      readJson<unknown>(PREREGISTRATION_PATH),
      readJson<unknown>(POSITIVE_COUNTS_PATH),
    ]);
  const verification = verificationFile.value;
  if (!verification.passed || verification.failureCount !== 0 || !verification.reviewReady) {
    throw new Error("The v5 full-pool verification failed; no review package was written.");
  }
  if (seedFile.value.version !== "1a3b-g2-review-seed:v5" || seedFile.value.sampleSeed !== V5_SAMPLE_SEED ||
      seedFile.value.pairwiseSize !== V5_PAIRWISE_SIZE || seedFile.value.armAssignmentSeedOffset !== 73 ||
      seedFile.value.armPositions.A !== 5 || seedFile.value.armPositions.B !== 5 ||
      seedFile.value.languageQuotas.en !== 5 || seedFile.value.languageQuotas.zh !== 3 ||
      seedFile.value.languageQuotas.code_switch !== 2) {
    throw new Error("The v5 frozen sample seed or quotas drifted from the review builder.");
  }
  const inputFiles = [
    [CATALOG_PATH, catalogFile.raw],
    [PINS_PATH, pinsFile.raw],
    [SELECTION_PATH, selectionFile.raw],
    [MAIN_PATH, mainFile.raw],
    [OFF_PATH, offFile.raw],
    [ON_PATH, onFile.raw],
    [LEDGER_PATH, ledgerFile.raw],
    [SAMPLE_SEED_PATH, seedFile.raw],
    [PREREGISTRATION_PATH, preregistrationFile.raw],
    [POSITIVE_COUNTS_PATH, countsFile.raw],
    ...catalogFile.value.sceneFiles.map((entry, index) => [entry.path, ""] as const),
  ];
  const fingerprints = new Map(verification.inputFingerprints.map((entry) => [entry.path, entry]));
  for (const [path, capturedRaw] of inputFiles) {
    const raw = capturedRaw || (await readFile(resolve(path), "utf8"));
    const expected = fingerprints.get(path);
    if (!expected || !isSameInputFingerprint(raw, expected)) {
      throw new Error(`v5 input fingerprint changed since verification: ${path}`);
    }
  }
  for (const expected of verification.inputFingerprints) {
    const raw = await readFile(resolve(expected.path), "utf8");
    if (!isSameInputFingerprint(raw, expected)) {
      throw new Error(`v5 captured evidence changed since verification: ${expected.path}`);
    }
  }
  const scenes = (
    await Promise.all(
      catalogFile.value.sceneFiles.map(async (entry) =>
        JSON.parse(await readFile(resolve(entry.path), "utf8")) as V5SceneFile,
      ),
    )
  ).flatMap((file) => file.scenes);
  const ledgerById = new Map(ledgerFile.value.scenarios.map((scene) => [scene.fixtureId, scene]));
  const offById = new Map(offFile.value.scenarios.map((scene) => [scene.fixtureId, scene]));
  const onById = new Map(onFile.value.scenarios.map((scene) => [scene.fixtureId, scene]));
  const mainByScene = new Map<string, Map<number, string>>();
  for (const response of mainFile.value.responses) {
    const turns = mainByScene.get(response.fixtureId) ?? new Map<number, string>();
    turns.set(response.sequenceInScenario, response.text);
    mainByScene.set(response.fixtureId, turns);
  }
  const actualEmits = new Set(verification.actualEmitScenarioIds);
  const candidateScenes = scenes.filter(
    (scene) => scene.reviewIntent === "pairwise_candidate" && actualEmits.has(scene.id),
  );
  const completeStatefulSceneIds = new Set(candidateScenes.filter((scene) => {
    if (scene.family !== "stateful_suppression") return false;
    const turns = ledgerById.get(scene.id)?.turns ?? [];
    const emit = turns.find((turn) => turn.on.segmentOutcome === "committed");
    return !!emit && turns.some((turn) => turn.sequenceInScenario > emit.sequenceInScenario &&
      turn.on.dispositionOutcome?.startsWith("recorded:") &&
      turn.on.suppressionStateAfterTurn.some((state) => state.eligibilityStatus === "suppressed"));
  }).map((scene) => scene.id));
  const sampledScenes = selectV5PairwiseSample({
    candidates: candidateScenes,
    completeStatefulSceneIds,
  });
  if (!sampledScenes) throw new Error("The actual emit pool cannot satisfy the frozen v5 10-case sample.");
  const assignmentDeck = shuffled(
    [...Array.from({ length: V5_PAIRWISE_SIZE / 2 }, () => true), ...Array.from({ length: V5_PAIRWISE_SIZE / 2 }, () => false)],
    V5_SAMPLE_SEED + seedFile.value.armAssignmentSeedOffset,
  );
  const sealedMappings: Array<Record<string, unknown>> = [];
  const pairwiseCases: PublicPairCase[] = sampledScenes.map((scene, index) => {
    const fixtureId = scene.id;
    const ledger = ledgerById.get(fixtureId);
    const off = offById.get(fixtureId);
    const on = onById.get(fixtureId);
    const mainTurns = mainByScene.get(fixtureId);
    if (!ledger || !off || !on || !mainTurns) throw new Error(`${fixtureId}: sample evidence is incomplete.`);
    const offIsA = assignmentDeck[index]!;
    const bySequence = new Map(ledger.turns.map((turn) => [turn.sequenceInScenario, turn]));
    const emitted = scene.turns.filter((turn) =>
      bySequence.get(turn.sequenceInScenario)?.on.segmentOutcome === "committed",
    );
    if (emitted.length === 0) throw new Error(`${fixtureId}: sampled case has no actual emit.`);
    const targetTurn = emitted[0]!;
    const targetRef = findSelectedTarget(scene, ledger, targetTurn.sequenceInScenario);
    if (!targetRef) throw new Error(`${fixtureId}: committed emit has no selected target reference.`);
    const context = groundingFor(scene, ledger, targetRef);
    const offTurns = new Map(off.turns.map((turn) => [turn.sequenceInScenario, turn]));
    const onTurns = new Map(on.turns.map((turn) => [turn.sequenceInScenario, turn]));
    const turns: PublicPairTurn[] = scene.turns.map((turn) => {
      const offTurn = offTurns.get(turn.sequenceInScenario);
      const onTurn = onTurns.get(turn.sequenceInScenario);
      const mainText = mainTurns.get(turn.sequenceInScenario);
      if (!offTurn || !onTurn || mainText === undefined) throw new Error(`${fixtureId}: turn evidence is missing.`);
      const differs = offTurn.assistantText !== onTurn.assistantText;
      const targetEvidence = bySequence.get(turn.sequenceInScenario)?.on;
      const segment = targetEvidence?.segmentOutcome === "committed" ? targetEvidence.segmentText : null;
      if (differs && segment === null) {
        throw new Error(`${fixtureId} t${turn.sequenceInScenario}: visible difference has no committed segment.`);
      }
      const responseA = differs ? (offIsA ? null : segment) : null;
      const responseB = differs ? (offIsA ? segment : null) : null;
      return {
        sequence: turn.sequenceInScenario,
        userText: turn.userInput.text,
        date: turnDate(turn, mainFile.value.domainTime),
        sharedResponse: differs ? mainText : offTurn.assistantText,
        responseA,
        responseB,
      };
    });
    if (!turns.some((turn) => turn.responseA !== null || turn.responseB !== null)) {
      throw new Error(`${fixtureId}: sampled emit scene has no visible A/B difference.`);
    }
    const caseId = `case-${String(index + 1).padStart(2, "0")}`;
    sealedMappings.push({
      caseId,
      fixtureId,
      family: scene.family,
      completeStatefulTrajectory: completeStatefulSceneIds.has(scene.id),
      protectedEvidenceSequences: { ...(scene.protectedTurnSequences ?? {}) },
      topic: scene.topic,
      targetKind: targetRef?.kind,
      protectedCategories: [...scene.protectedCategories],
      languageVariant: scene.languageVariant,
      offIsA,
      candidateIsA: !offIsA,
    });
    return { caseId, languageVariant: scene.languageVariant, context, turns };
  });
  const omissionScenes = scenes.filter((scene) => scene.reviewIntent === "omission_audit");
  const actualOmissions = new Set(verification.actualOmissionAuditScenarioIds);
  if (
    omissionScenes.length !== 8 ||
    actualOmissions.size !== 8 ||
    verification.actualOmissionAuditScenarioIds.some(
      (fixtureId) => !omissionScenes.some((scene) => scene.id === fixtureId),
    ) ||
    omissionScenes.some((scene) => !actualOmissions.has(scene.id))
  ) {
    throw new Error("The predeclared omission audit must contain exactly eight actual typed omissions.");
  }
  const omissionCases: PublicOmissionCase[] = omissionScenes.map((scene, index) => {
    const ledger = ledgerById.get(scene.id);
    const mainTurns = mainByScene.get(scene.id);
    if (!ledger || !mainTurns) throw new Error(`${scene.id}: omission evidence is incomplete.`);
    const selectedTurn = scene.turns.find((turn) => turn.expect.selection === "segment");
    if (!selectedTurn) throw new Error(`${scene.id}: omission target is missing.`);
    const targetRef = findSelectedTarget(scene, ledger, selectedTurn.sequenceInScenario);
    if (!targetRef) throw new Error(`${scene.id}: typed omission has no selected target reference.`);
    const grounding = groundingFor(scene, ledger, targetRef);
    const targetGrounding = grounding.map((entry) => entry.text).join("\n");
    if (!targetGrounding) throw new Error(`${scene.id}: neutral target grounding is missing.`);
    const turns = scene.turns.map((turn) => {
      const mainText = mainTurns.get(turn.sequenceInScenario);
      if (mainText === undefined) throw new Error(`${scene.id}: frozen main response is missing.`);
      return {
        sequence: turn.sequenceInScenario,
        userText: turn.userInput.text,
        mainResponse: mainText,
        date: turnDate(turn, mainFile.value.domainTime),
      };
    });
    const caseId = `omit-${String(index + 1).padStart(2, "0")}`;
    sealedMappings.push({
      caseId,
      fixtureId: scene.id,
      family: scene.family,
      targetKind: targetRef?.kind,
      expectedOmissionReason: scene.expectedOmissionReason,
      protectedCategories: [...scene.protectedCategories],
      languageVariant: scene.languageVariant,
    });
    return {
      caseId,
      languageVariant: scene.languageVariant,
      // The dialogue turns are the shared context; show target grounding once.
      context: [],
      targetGrounding,
      turns,
    };
  });
  const payload: PublicPayload = {
    protocolVersion: "blind-pairwise:g2-v5",
    packageVersion: "1a3b-g2-review-package:v5",
    capturedDate: new Intl.DateTimeFormat("en-CA", {
      timeZone: "UTC",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(new Date(mainFile.value.domainTime)),
    pairwiseCases,
    omissionCases,
  };
  const payloadRaw = jsonRaw(payload);
  const packageFingerprint = rawSha256(payloadRaw);
  const packageFile = {
    packageFingerprint,
    fingerprintKind: "rawSha256 of payload bytes",
    payload,
  };
  const sealedFile = {
    packageFingerprint,
    mappings: sealedMappings,
  };
  const scores = scoreTemplate(payload, packageFingerprint);
  await mkdir(REVIEW, { recursive: true });
  await mkdir(OPERATOR, { recursive: true });
  await writeFile(`${REVIEW}/public-package.json`, `${JSON.stringify(packageFile, null, 2)}\n`, "utf8");
  await writeFile(`${REVIEW}/scores.json`, `${JSON.stringify(scores, null, 2)}\n`, "utf8");
  await writeFile(`${OPERATOR}/sealed-identities.json`, `${JSON.stringify(sealedFile, null, 2)}\n`, "utf8");
  await writeFile(`${OPERATOR}/unblind-input.json`, `${JSON.stringify({
    protocolVersion: payload.protocolVersion,
    packageVersion: payload.packageVersion,
    packageFingerprint,
    publicPackagePath: `${REVIEW}/public-package.json`,
    scorePath: `${REVIEW}/scores.json`,
    sealedIdentitiesPath: `${OPERATOR}/sealed-identities.json`,
  }, null, 2)}\n`, "utf8");
  const fingerprintEscapedPayload = JSON.stringify(payload).replaceAll("<", "\\u003c");
  const html = createReviewHtml(packageFingerprint, fingerprintEscapedPayload);
  await writeFile(`${REVIEW}/index.html`, html, "utf8");
  console.log(JSON.stringify({
    packageFingerprint,
    pairwiseCases: pairwiseCases.length,
    omissionCases: omissionCases.length,
    reviewPage: `${REVIEW}/index.html`,
  }, null, 2));
}

function createReviewHtml(packageFingerprint: string, embeddedPayload: string): string {
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>SayHear G2 人工评审</title>
  <style>
    :root{color-scheme:light;--ink:#202321;--muted:#626a64;--line:#d9dfd9;--paper:#f7f8f4;--card:#fff;--accent:#2b624a;--soft:#e8eee8;--focus:#ad5d27;font-family:system-ui,-apple-system,"Segoe UI",sans-serif}*{box-sizing:border-box}body{margin:0;background:var(--paper);color:var(--ink);line-height:1.55}main{max-width:920px;margin:0 auto;padding:24px 18px 64px}header{padding:22px 0 18px;border-bottom:1px solid var(--line)}h1{font-size:clamp(1.55rem,4vw,2.25rem);line-height:1.15;margin:0 0 8px}h2{font-size:1.25rem;margin:34px 0 12px}h3{font-size:1.05rem;margin:0 0 10px}.muted{color:var(--muted)}.intro{max-width:68ch}.toolbar{display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin-top:16px}.toolbar button,.choice{font:inherit;border:1px solid var(--line);border-radius:10px;background:var(--card);color:var(--ink);padding:9px 13px;cursor:pointer}.toolbar button.primary{background:var(--accent);color:white;border-color:var(--accent)}button:focus-visible{outline:3px solid var(--focus);outline-offset:2px}.progress{font-variant-numeric:tabular-nums}.notice{margin:14px 0;padding:12px 14px;border-radius:10px;background:#fff4e6;border:1px solid #e6c39a}.case{background:var(--card);border:1px solid var(--line);border-radius:16px;padding:18px;margin:14px 0;box-shadow:0 2px 8px #25372b0b}.context{background:var(--soft);border-radius:10px;padding:12px 14px;margin:12px 0}.context p,.bubble p{margin:0;white-space:pre-wrap}.label{font-size:.78rem;text-transform:uppercase;letter-spacing:.04em;color:var(--muted);margin-bottom:4px}.turn{border-top:1px solid var(--line);padding:14px 0 2px}.bubble{margin:9px 0;padding:12px 14px;border-radius:10px;background:#f4f5f1;white-space:pre-wrap}.bubble.user{background:#f2eee6}.choices{display:grid;grid-template-columns:1fr 1fr;gap:12px;margin:10px 0}.choice-card{border:1px solid var(--line);border-radius:12px;padding:12px}.choice-card h4{margin:0 0 7px;font-size:.92rem}.choice-buttons{display:flex;gap:8px;flex-wrap:wrap;margin-top:10px}.choice[aria-pressed=true]{background:var(--accent);border-color:var(--accent);color:white}.turn-rating{display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin:10px 0 14px}.scene-rating{display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin-top:14px;padding-top:12px;border-top:1px dashed var(--line)}.rest{margin:22px 0;padding:14px;border-left:4px solid var(--accent);background:var(--soft);border-radius:8px}.status{min-height:1.5em;color:var(--muted)}.empty{color:var(--muted);font-style:italic}.omission-choice{display:flex;gap:8px;flex-wrap:wrap;margin-top:12px}.footer{margin-top:36px;padding-top:16px;border-top:1px solid var(--line);color:var(--muted);font-size:.9rem}@media(max-width:560px){main{padding:16px 12px 48px}.case{padding:14px}.choices{grid-template-columns:1fr}.choice-buttons{display:grid;grid-template-columns:repeat(3,1fr)}.choice{padding:10px 8px}.toolbar>*{flex:1 1 auto}}
  </style>
</head>
<body>
<main>
  <header>
    <h1>SayHear 主动跟进人工评审</h1>
    <p class="intro muted">先看共享上下文和主回应，再判断新增片段是否自然。每个不同回合和每个完整场景各选一次。Omission 审核只判断当时沉默是否合适。</p>
    <div class="toolbar"><span class="progress" id="progress"></span><button class="primary" id="export">导出评分</button><button id="clear">清空草稿</button></div>
    <p class="status" id="status" aria-live="polite"></p>
    <div class="notice" id="fileNotice" hidden>当前通过本地文件打开。草稿不会持久保存；请使用仓库内本地服务命令打开此页面。</div>
  </header>
  <section><h2>差异回合比较</h2><p class="muted">相同的主回应只显示一次。请按完整表达体验选择 A、持平或 B；每五个场景后可以休息。</p><div id="pairs"></div></section>
  <section><h2>沉默合理性审核</h2><p class="muted">阅读共享对话、冻结主回应和中立目标背景，再判断没有新增跟进是否合适。</p><div id="omissions"></div></section>
  <div class="footer">评审编号只用于保存决定。页面不显示运行配置、场景来源或候选身份。</div>
</main>
<script>
const packageFingerprint=${JSON.stringify(packageFingerprint)};
const payload=${embeddedPayload};
const storageKey="sayhear-g2-review:"+packageFingerprint;
const score={scoreVersion:"1a3b-g2-scores:v5",protocolVersion:payload.protocolVersion,packageVersion:payload.packageVersion,packageFingerprint,scorer:"",scoredAt:"",pairwiseDecisions:payload.pairwiseCases.map(item=>({caseId:item.caseId,turnDecisions:item.turns.filter(turn=>turn.responseA!==null||turn.responseB!==null).map(turn=>({sequence:turn.sequence,choice:""})),sceneDecision:""})),omissionDecisions:payload.omissionCases.map(item=>({caseId:item.caseId,choice:""}))};
const byId=(id)=>document.getElementById(id);
const safe=(value)=>String(value??"");
function node(tag,className,text){const element=document.createElement(tag);if(className)element.className=className;if(text!==undefined)element.textContent=safe(text);return element;}
function pressedButton(label,value,group,caseId,sequence){const button=node("button","choice",label);button.type="button";button.dataset.group=group;button.dataset.case=caseId;if(sequence!==undefined)button.dataset.sequence=String(sequence);button.dataset.choice=value;button.setAttribute("aria-pressed","false");return button;}
function contextBox(items,title){const box=node("div","context");box.append(node("div","label",title));for(const item of items){const line=node("p",null,item.text);box.append(line);}return box;}
function dateText(date){return "当前日期："+date.currentDate+" · 距上一轮："+date.elapsedDays+" 天";}
function renderPairs(){const root=byId("pairs");payload.pairwiseCases.forEach((item,index)=>{if(index>0&&index%5===0)root.append(node("div","rest","可以休息一下，再继续后面的场景。"));const card=node("article","case");card.append(node("h3",null,"场景 "+String(index+1)));if(item.context.length)card.append(contextBox(item.context,"共享背景"));for(const turn of item.turns){const section=node("div","turn");section.append(node("div","label",dateText(turn.date)));section.append(contextBox([{text:turn.userText}],"用户"));if(turn.sharedResponse!==null)section.append(contextBox([{text:turn.sharedResponse}],"主回应或共享回应"));if(turn.responseA!==null||turn.responseB!==null){const grid=node("div","choices");for(const side of ["A","B"]){const text=side==="A"?turn.responseA:turn.responseB;const sideCard=node("div","choice-card");sideCard.append(node("h4",null,side));sideCard.append(node("p",text===null?"empty":"bubble",text??"没有新增片段"));grid.append(sideCard);}section.append(grid);const rating=node("div","turn-rating");rating.append(node("span","label","比较这一回合"));for(const option of [["A","A"],["持平","tie"],["B","B"]])rating.append(pressedButton(option[0],option[1],"turn",item.caseId,turn.sequence));section.append(rating);}card.append(section);}const scene=node("div","scene-rating");scene.append(node("strong",null,"完整场景"));for(const option of [["A","A"],["持平","tie"],["B","B"]])scene.append(pressedButton(option[0],option[1],"scene",item.caseId));card.append(scene);root.append(card);});}
function renderOmissions(){const root=byId("omissions");payload.omissionCases.forEach((item,index)=>{if(index>0&&index%5===0)root.append(node("div","rest","可以休息一下，再继续后面的审核。"));const card=node("article","case");card.append(node("h3",null,"审核 "+String(index+1)));if(item.context.length)card.append(contextBox(item.context,"共享背景"));card.append(contextBox([{text:item.targetGrounding}],"相关背景"));for(const turn of item.turns){const section=node("div","turn");section.append(node("div","label",dateText(turn.date)));section.append(contextBox([{text:turn.userText}],"用户"));section.append(contextBox([{text:turn.mainResponse}],"冻结主回应"));card.append(section);}const options=node("div","omission-choice");for(const choice of [["沉默合适","silence_appropriate"],["本应跟进","should_follow_up"],["无法判断","cannot_judge"]])options.append(pressedButton(choice[0],choice[1],"omission",item.caseId));card.append(options);root.append(card);});}
function decisionFor(group,caseId,sequence){if(group==="turn")return score.pairwiseDecisions.find(x=>x.caseId===caseId)?.turnDecisions.find(x=>x.sequence===Number(sequence));if(group==="scene")return score.pairwiseDecisions.find(x=>x.caseId===caseId);return score.omissionDecisions.find(x=>x.caseId===caseId);}
function restore(){if(location.protocol==="file:"){byId("fileNotice").hidden=false;return;}try{const saved=localStorage.getItem(storageKey);if(!saved)return;const parsed=JSON.parse(saved);if(parsed.packageFingerprint!==packageFingerprint)return;if(parsed.score?.packageFingerprint!==packageFingerprint)return;for(const section of ["pairwiseDecisions","omissionDecisions"]){const target=section==="pairwiseDecisions"?score.pairwiseDecisions:score.omissionDecisions;for(const item of target){const source=parsed.score[section]?.find(x=>x.caseId===item.caseId);if(!source)continue;Object.assign(item,source);}}}catch{localStorage.removeItem(storageKey);}}
function save(){if(location.protocol!=="file:"){try{localStorage.setItem(storageKey,JSON.stringify({packageFingerprint,score}));}catch{byId("status").textContent="浏览器无法保存草稿；请导出评分文件。";}}updateButtons();}
function updateButtons(){document.querySelectorAll("button[data-choice]").forEach(button=>{const record=decisionFor(button.dataset.group,button.dataset.case,button.dataset.sequence);const key=button.dataset.group==="turn"?"choice":button.dataset.group==="scene"?"sceneDecision":"choice";button.setAttribute("aria-pressed",String(record?.[key]===button.dataset.choice));});const turnTotal=score.pairwiseDecisions.reduce((n,item)=>n+item.turnDecisions.filter(x=>x.choice!=="").length,0);const sceneTotal=score.pairwiseDecisions.filter(x=>x.sceneDecision!=="").length;const omitTotal=score.omissionDecisions.filter(x=>x.choice!=="").length;byId("progress").textContent="差异回合 "+turnTotal+" · 场景 "+sceneTotal+"/10 · 沉默审核 "+omitTotal+"/8";}
document.addEventListener("click",event=>{const button=event.target.closest("button[data-choice]");if(!button)return;const record=decisionFor(button.dataset.group,button.dataset.case,button.dataset.sequence);if(!record)return;const key=button.dataset.group==="turn"?"choice":button.dataset.group==="scene"?"sceneDecision":"choice";record[key]=button.dataset.choice;save();});
byId("clear").addEventListener("click",()=>{for(const item of score.pairwiseDecisions){item.sceneDecision="";for(const turn of item.turnDecisions)turn.choice="";}for(const item of score.omissionDecisions)item.choice="";if(location.protocol!=="file:")localStorage.removeItem(storageKey);save();byId("status").textContent="当前草稿已清空。";});
byId("export").addEventListener("click",()=>{const complete=score.pairwiseDecisions.every(x=>x.sceneDecision!==""&&x.turnDecisions.every(t=>t.choice!==""))&&score.omissionDecisions.every(x=>x.choice!=="");if(!complete){byId("status").textContent="请完成所有差异回合、完整场景和沉默审核后再导出。";return;}const scorer=window.prompt("评审者姓名或代号：");if(!scorer)return;score.scorer=scorer;score.scoredAt=new Date().toISOString();const blob=new Blob([JSON.stringify(score,null,2)+"\\n"],{type:"application/json"});const link=document.createElement("a");link.href=URL.createObjectURL(blob);link.download="scores-v5.json";link.click();setTimeout(()=>URL.revokeObjectURL(link.href),1000);byId("status").textContent="评分文件已导出。";});
restore();renderPairs();renderOmissions();updateButtons();
</script>
</body>
</html>\n`;
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});

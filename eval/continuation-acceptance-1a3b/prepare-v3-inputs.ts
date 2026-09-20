import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename } from "node:path";

import { sha256 } from "./protocol";

const ROOT = "eval/continuation-acceptance-1a3b";

const memoryText: Readonly<Record<string, string>> = {
  "g2-mem-en-ines": "You are learning Portuguese guitar this year.",
  "g2-mem-en-tomas": "Your friend Tomas is opening a small record shop next month.",
  "g2-mem-en-marta": "Your friend Marta is finishing her thesis this semester.",
  "g2-mem-zh-he": "你在准备注册会计师考试。",
  "g2-mem-cs-lena": "You are preparing for a dance recital in June.",
  "g2-mem-en-ari": "You signed up for a climbing course this fall.",
  "g2-mem-zh-yu": "你下个月要参加一场半程马拉松。",
  "g2-mem-cs-noor": "You started a ceramics class on weekends.",
  "g2-mem-en-jordan": "You are training for a half marathon in the spring.",
  "g2-mem-en-priya": "Your friend Priya's bakery opens its first storefront in November.",
  "g2-mem-en-sam": "You are preparing for a nursing exam in the fall.",
  "g2-mem-zh-linlan": "你在准备十二月的婚礼。",
  "g2-mem-zh-zhou": "你的朋友老周最近在换工作，面试了好几家公司。",
  "g2-mem-cs-maya": "Your friend Maya is moving to Berlin for her new job.",
};

async function json(path: string): Promise<any> {
  return JSON.parse(await readFile(path, "utf8"));
}

async function main(): Promise<void> {
  const catalog = await json(`${ROOT}/fixtures-v2.json`);
  await mkdir(`${ROOT}/fixtures-v3`, { recursive: true });
  for (const entry of catalog.sceneFiles) {
    const sceneFile = await json(entry.path);
    for (const scene of sceneFile.scenes) {
      for (const turn of scene.turns) {
        if (turn.userInput.timezone === "America/Seattle") {
          turn.userInput.timezone = "America/Los_Angeles";
        }
      }
      for (const item of [...scene.memory, ...scene.portrait]) {
        item.text = memoryText[item.id] ?? item.text;
      }
    }
    const content = `${JSON.stringify(sceneFile, null, 2)}\n`;
    entry.path = `${ROOT}/fixtures-v3/${basename(entry.path)}`;
    entry.sha256 = createHash("sha256").update(content).digest("hex");
    await writeFile(entry.path, content);
  }
  await writeFile(`${ROOT}/fixtures-v3.json`, `${JSON.stringify(catalog, null, 2)}\n`);

  const pins = await json(`${ROOT}/pins-v2.json`);
  const proactive = {
    ...pins.roles["proactive.followup"],
    promptVersion: "proactive-followup-prompt:v3",
    schemaVersion: "proactive-segment:v2",
    policyVersion: "proactive-followup-policy-bundle:v3",
  };
  pins.version = "1a3b-g2-pins:v3";
  pins.roles["proactive.followup"] = proactive;
  pins.continuation.arms.on.id = "continuation-candidate-1a3b-v3";
  pins.continuation.arms.on.proactive = {
    configVersion: "proactive-followup:v3",
    promptVersion: proactive.promptVersion,
    schemaVersion: proactive.schemaVersion,
    policyVersion: proactive.policyVersion,
  };
  pins.expression.selectedConfigId = "proactive-expression-v3";
  pins.expression.configurations = [
    {
      id: "proactive-expression-v3",
      pin: proactive,
    },
  ];
  await writeFile(`${ROOT}/pins-v3.json`, `${JSON.stringify(pins, null, 2)}\n`);

  const expressionSelection = await json(`${ROOT}/run-v2/expression-selection.json`);
  expressionSelection.generatedAt = new Date().toISOString();
  expressionSelection.winnerConfigId = "proactive-expression-v3";
  expressionSelection.winnerRolePinSha256 = sha256(proactive);
  expressionSelection.decision = {
    kind: "luke-approved-bounded-exception",
    decidedAt: "2026-09-20",
    reason:
      "After the frozen v2 candidate lost 3-12, Luke authorized the emit-or-omit, grounding, identity, timing, and non-duplication iteration as the sole configuration for the next ON-vs-OFF acceptance round.",
  };
  expressionSelection.decisionSha256 = sha256(expressionSelection.decision);
  expressionSelection.waiver = {
    approvedBy: "luke",
    approvedAt: "2026-09-20",
    reason:
      "ADR-0136 failed-candidate iteration: proactive-expression-v3 is the sole candidate authorized for the next ON-vs-OFF acceptance round after v2 lost 3-12; this is not a winner claim.",
    adrAmendment:
      "docs/adr/0136-1a3b-model-pins-are-evidence-outputs.md#amendment-2026-09-20-luke-approved-failed-candidate-iteration",
  };
  expressionSelection.authorizationSha256 = sha256({
    decision: expressionSelection.decision,
    waiver: expressionSelection.waiver,
  });
  await mkdir(`${ROOT}/run-v3`, { recursive: true });
  await writeFile(
    `${ROOT}/run-v3/expression-selection.json`,
    `${JSON.stringify(expressionSelection, null, 2)}\n`,
  );
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});

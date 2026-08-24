/**
 * PROTOTYPE — builds the single-file blind review page for issue #94 from
 * run/comparison.json. The page embeds only letter-keyed day-2 responses
 * (W/X/Y/Z shuffled per scenario at generation time); the true mapping and
 * arm names are embedded but hidden until the rater completes every scenario
 * and confirms reveal (#62 先评后揭 discipline). Exports run/ratings.json.
 *
 * Run: pnpm exec tsx eval/recall-presentation-94/build-review-page.ts
 * Then open run/index.html by double-click.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { BLIND_SEED, DIMENSIONS, PROTOCOL_VERSION } from "./protocol";

type ComparisonFile = {
  arms: readonly Readonly<{ key: ArmKey; name: string; oneLiner: string }>[];
  scenarios: readonly Readonly<{
    id: string;
    languageVariant: string;
    description: string;
    day1: { turns: readonly { userText: string; assistantText: string }[] };
    day2: {
      turns: readonly Readonly<{
        userText: string;
        gapMs: number | null;
        responses: Readonly<
          Record<string, Readonly<{ text: string; flags?: Record<string, unknown>; error?: string }>>
        >;
      }>;
    };
    letterMap: Record<ArmLetter, ArmKey>;
    fixtureSummary: Readonly<{
      expectedRecall: string;
      forbiddenMentions: readonly string[];
      timeGrounding: string;
    }>;
  }>[];
};

const outDir = path.join(import.meta.dirname, "run");

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

const LANGUAGE_LABEL: Readonly<Record<string, string>> = {
  en: "EN",
  zh: "ZH",
  code_switch: "MIX",
};

async function main() {
  const comparison = JSON.parse(
    await readFile(path.join(outDir, "comparison.json"), "utf8"),
  ) as ComparisonFile;
  await mkdir(outDir, { recursive: true });

  const armNames: Record<string, string> = {};
  for (const arm of comparison.arms) armNames[arm.key] = arm.name;

  // Blinded view: day-2 responses re-keyed by letter, letterMap kept for reveal.
  const blinded = comparison.scenarios.map((scenario) => ({
    description: scenario.description,
    day1: scenario.day1,
    day2: {
      turns: scenario.day2.turns.map((turn, index) => {
        const byLetter: Record<string, unknown> = {};
        for (const [letter, key] of Object.entries(scenario.letterMap)) {
          byLetter[letter] = turn.responses[key];
        }
        return { index: index + 3, userText: turn.userText, gapMs: turn.gapMs, byLetter };
      }),
    },
    fixtureSummary: scenario.fixtureSummary,
    id: scenario.id,
    languageLabel: LANGUAGE_LABEL[scenario.languageVariant] ?? scenario.languageVariant,
  }));
  const revealData = comparison.scenarios.map((scenario) => ({
    id: scenario.id,
    letterMap: scenario.letterMap,
  }));

  const pageData = JSON.stringify({
    armNames,
    dimensions: DIMENSIONS,
    protocol: PROTOCOL_VERSION,
    scenarios: blinded,
    seed: BLIND_SEED,
  }).replace(/</g, "\\u003c");
  const revealJson = JSON.stringify(revealData).replace(/</g, "\\u003c");

  const html = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>SayHear · #94 recall 呈现策略盲评</title>
<style>
  :root { --ink:#1c1917; --muted:#78716c; --paper:#faf9f7; --card:#ffffff; --line:#e7e5e4; --accent:#0f766e; --accent-soft:#ccfbf1; --warn:#9a3412; }
  * { box-sizing:border-box; }
  body { margin:0; font-family:-apple-system,"PingFang SC","Hiragino Sans GB","Segoe UI",sans-serif; color:var(--ink); background:var(--paper); line-height:1.65; }
  .wrap { max-width:1020px; margin:0 auto; padding:32px 20px 140px; }
  h1 { font-size:23px; margin:0 0 6px; }
  .sub { color:var(--muted); font-size:13.5px; margin-bottom:18px; }
  .howto { background:var(--card); border:1px solid var(--line); border-radius:12px; padding:16px 20px; margin-bottom:22px; font-size:14px; }
  .howto ol { margin:6px 0 0; padding-left:20px; }
  .howto b { font-weight:600; }
  .tabs { display:flex; flex-wrap:wrap; gap:8px; margin-bottom:18px; }
  .tab { border:1px solid var(--line); background:var(--card); border-radius:999px; padding:6px 16px; font-size:13.5px; cursor:pointer; }
  .tab.active { background:var(--ink); color:#fff; border-color:var(--ink); }
  .tab .done { color:#16a34a; font-weight:700; }
  .tab.active .done { color:#86efac; }
  .scenario { display:none; }
  .scenario.active { display:block; }
  .card { background:var(--card); border:1px solid var(--line); border-radius:12px; padding:16px 20px; margin-bottom:14px; }
  .desc { font-size:14px; color:#44403c; }
  .watch { background:#fef7ed; border:1px solid #fde3c0; font-size:13.5px; }
  .watch .row { margin-top:6px; }
  .watch .k { font-weight:600; color:var(--warn); }
  .day1card { background:#f5f5f4; }
  .day1card h3, .rate-panel h3 { font-size:15px; margin:0 0 10px; }
  .msg { display:flex; gap:10px; margin:8px 0; }
  .who { flex:none; font-size:11.5px; font-weight:700; border-radius:999px; padding:2px 9px; height:fit-content; margin-top:3px; }
  .who.user { background:var(--accent-soft); color:var(--accent); }
  .who.ai { background:#ede9e6; color:#57534e; }
  .bubble { white-space:pre-wrap; font-size:14.5px; }
  .gapline { text-align:center; font-size:12.5px; color:var(--warn); font-weight:600; margin:14px 0 10px; }
  .turn { margin-top:22px; }
  .turn h4 { font-size:14px; margin:0 0 10px; color:var(--muted); }
  .armgrid { display:grid; grid-template-columns:repeat(auto-fit,minmax(220px,1fr)); gap:10px; }
  .armcard { background:var(--card); border:1px solid var(--line); border-radius:12px; padding:12px 14px; }
  .armcard .head { display:flex; align-items:center; gap:8px; margin-bottom:8px; }
  .letter { width:26px; height:26px; border-radius:50%; background:var(--ink); color:#fff; display:inline-flex; align-items:center; justify-content:center; font-size:13px; font-weight:700; flex:none; }
  .pname { font-size:12.5px; font-weight:600; color:#6d28d9; display:none; }
  body.revealed .pname { display:inline; }
  .resp { white-space:pre-wrap; font-size:14.5px; min-height:40px; }
  .resp.err { color:#b91c1c; font-size:13px; }
  .flags { display:none; margin-top:8px; font-size:12px; }
  body.revealed .flags { display:block; }
  .flags .f { background:#fef2f2; border:1px solid #fecaca; border-radius:8px; padding:4px 8px; margin-top:4px; color:#991b1b; }
  .flags .ok { background:#f0fdf4; border-color:#bbf7d0; color:#166534; }
  .note { width:100%; margin-top:8px; border:1px solid var(--line); border-radius:8px; padding:6px 10px; font-size:12.5px; font-family:inherit; resize:vertical; min-height:32px; }
  .rate-panel { margin-top:24px; }
  .rategrid { display:grid; grid-template-columns:repeat(auto-fit,minmax(300px,1fr)); gap:10px; }
  .ratecard { background:var(--card); border:1px solid var(--line); border-radius:12px; padding:14px 16px; }
  .dimrow { display:flex; align-items:center; gap:8px; margin:10px 0; flex-wrap:wrap; }
  .dimrow .dl { flex:none; width:3.2em; font-weight:600; font-size:13.5px; }
  .scale { display:flex; gap:4px; }
  .scale input { display:none; }
  .scale label { width:30px; height:30px; border:1px solid var(--line); border-radius:8px; display:inline-flex; align-items:center; justify-content:center; font-size:13px; cursor:pointer; background:#fff; }
  .scale input:checked + label { background:var(--ink); color:#fff; border-color:var(--ink); }
  .pole { font-size:11.5px; color:var(--muted); width:100%; margin-top:-4px; }
  .bestrow { margin-top:14px; display:flex; flex-wrap:wrap; gap:12px; align-items:center; font-size:14px; }
  .bestrow select, .scennote { border:1px solid var(--line); border-radius:8px; padding:7px 10px; font-size:13.5px; font-family:inherit; }
  .scennote { width:100%; margin-top:8px; resize:vertical; }
  .bar { position:fixed; bottom:0; left:0; right:0; background:#1c1917ee; color:#fff; display:flex; gap:10px; align-items:center; justify-content:center; padding:10px 16px; flex-wrap:wrap; font-size:13.5px; }
  .bar button { border:0; border-radius:8px; padding:8px 16px; font-size:13.5px; cursor:pointer; font-family:inherit; }
  .btn-accent { background:var(--accent); color:#fff; }
  .btn-ghost { background:#ffffff22; color:#fff; border:1px solid #ffffff55 !important; }
  .btn-ghost:disabled { opacity:.4; cursor:not-allowed; }
  #progress { font-weight:600; }
  #saved { color:#a7f3d0; font-size:12px; }
  .revealbox { display:none; margin-top:18px; }
  body.revealed .revealbox { display:block; }
  .revealbox table { border-collapse:collapse; font-size:13px; background:#fff; border-radius:8px; overflow:hidden; }
  .revealbox td, .revealbox th { border:1px solid var(--line); padding:5px 12px; text-align:left; }
  dialog { border:1px solid var(--line); border-radius:14px; padding:22px 26px; max-width:480px; font-size:14px; }
  dialog::backdrop { background:#0007; }
</style>
</head>
<body>
<div class="wrap">
  <h1>SayHear · recall 呈现策略盲评(#94)</h1>
  <div class="sub">同一批 memory-fixture 场景 · 冻结 persona v2 + ${escapeHtml("deepseek-v4-flash")} · 只变记忆注入方式 · seed ${BLIND_SEED} · ${escapeHtml(PROTOCOL_VERSION)}</div>
  <div class="howto">
    <b>怎么评</b>
    <ol>
      <li>每个场景先读「场景期望」,再看第一天共同对话(所有变体共享),然后逐轮读 W/X/Y/Z 四个回应,随时在卡片下方批注。</li>
      <li>评完后在「变体整体评分」给四个变体各打四维 1–5 分(准确 / 自然 / 克制 / 连续,正极在高分,不加分求和),并选一个本场景最佳。</li>
      <li>三个场景全部完成(含最佳选择)后,底栏可以导出 <b>ratings.json</b>,也可以选择<b>揭示</b>(显示变体真名与机械候选标记)。</li>
      <li>草稿自动存在浏览器本地;不联网、不写任何产品状态。</li>
    </ol>
  </div>
  <div class="tabs" id="tabs"></div>
  <div id="scenarios"></div>
</div>
<div class="bar">
  <span id="progress"></span>
  <span id="saved"></span>
  <button class="btn-accent" id="export">导出 ratings.json</button>
  <button class="btn-ghost" id="reveal">揭示</button>
  <button class="btn-ghost" id="reset">清空草稿</button>
</div>
<dialog id="revealConfirm">
  <p><b>揭示后就不能再改盲评了。</b>确定所有场景都已评完并导出?</p>
  <p style="font-size:13px;color:#78716c">揭示会显示每个字母对应的变体真名和机械候选标记(报警≠定罪,最终以你的判断为准)。</p>
  <div style="display:flex;gap:10px;justify-content:flex-end">
    <button class="btn-ghost" style="color:#1c1917;border:1px solid #e7e5e4" id="revealCancel">再看看</button>
    <button class="btn-accent" id="revealGo">揭示</button>
  </div>
</dialog>
<script>
const DATA = ${pageData};
const REVEAL = ${revealJson};
const LETTERS = ["W","X","Y","Z"];
const STORE_KEY = "sayhear-recall-94-" + DATA.seed;
const state = { revealed: false, ratings: {} };

function loadDraft() {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (raw) state.ratings = JSON.parse(raw);
  } catch (e) { /* fresh start */ }
}
function saveDraft() {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(state.ratings));
    const el = document.getElementById("saved");
    el.textContent = "草稿已保存 " + new Date().toLocaleTimeString();
    setTimeout(() => { el.textContent = ""; }, 2500);
  } catch (e) { /* storage full — page still works in-memory */ }
}
function ratingFor(scenarioId) {
  if (!state.ratings[scenarioId]) {
    state.ratings[scenarioId] = { best: "", scenarioNote: "", arms: {}, turnNotes: {} };
  }
  const r = state.ratings[scenarioId];
  if (!r.arms) r.arms = {};
  if (!r.turnNotes) r.turnNotes = {};
  for (const letter of LETTERS) if (!r.arms[letter]) r.arms[letter] = { dimensions: {}, note: "" };
  return r;
}
function scenarioComplete(scenarioId) {
  const r = state.ratings[scenarioId];
  if (!r || !r.best) return false;
  for (const letter of LETTERS) {
    const arm = r.arms[letter];
    if (!arm) return false;
    for (const dim of DATA.dimensions) if (!arm.dimensions[dim.key]) return false;
  }
  return true;
}
function allComplete() { return DATA.scenarios.every(s => scenarioComplete(s.id)); }
function refreshProgress() {
  const done = DATA.scenarios.filter(s => scenarioComplete(s.id)).length;
  document.getElementById("progress").textContent = "完成度 " + done + "/" + DATA.scenarios.length;
  document.getElementById("reveal").disabled = done < DATA.scenarios.length || state.revealed;
  for (const s of DATA.scenarios) {
    const tab = document.querySelector('[data-tab="' + s.id + '"] .done');
    if (tab) tab.textContent = scenarioComplete(s.id) ? " ✓" : "";
  }
}

function flagsHtml(flags) {
  if (!flags) return "";
  const rows = [];
  const forbidden = (flags.forbiddenTokenHits || []);
  rows.push(forbidden.length === 0
    ? '<div class="f ok">禁提 token:无命中</div>'
    : '<div class="f">禁提 token 命中: ' + forbidden.join(" · ") + "</div>");
  if ((flags.timeGroundingFlags || []).length)
    rows.push('<div class="f">时间锚候选: ' + flags.timeGroundingFlags.join(" · ") + "</div>");
  if ((flags.recallPhraseFlags || []).length)
    rows.push('<div class="f">召回措辞候选(人工判断): ' + flags.recallPhraseFlags.join(" · ") + "</div>");
  rows.push('<div class="f ok">记忆话题词: ' + ((flags.memoryTopicTokens || []).join(" · ") || "无") + " · 问句 " + flags.questionCount + " · " + flags.charCount + " 字</div>");
  return '<div class="flags">' + rows.join("") + "</div>";
}

function el(tag, className, html) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (html !== undefined) node.innerHTML = html;
  return node;
}
const esc = (s) => String(s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");

function render() {
  const tabs = document.getElementById("tabs");
  const host = document.getElementById("scenarios");
  DATA.scenarios.forEach((scenario, index) => {
    const label = scenario.languageLabel + " · " + scenario.id.replace("memory-continuity-", "");
    const tab = el("button", "tab", esc(label) + '<span class="done"></span>');
    tab.dataset.tab = scenario.id;
    tab.onclick = () => {
      document.querySelectorAll(".tab").forEach(t => t.classList.remove("active"));
      document.querySelectorAll(".scenario").forEach(s => s.classList.remove("active"));
      tab.classList.add("active");
      section.classList.add("active");
    };
    tabs.appendChild(tab);

    const section = el("div", "scenario");
    section.id = "sc-" + scenario.id;

    section.appendChild(el("div", "card desc", "<b>" + esc(scenario.id) + "</b><br>" + esc(scenario.description)));
    const fx = scenario.fixtureSummary;
    section.appendChild(el("div", "card watch",
      "<b>场景期望(fixture)</b>" +
      '<div class="row"><span class="k">期望召回:</span>' + esc(fx.expectedRecall) + "</div>" +
      '<div class="row"><span class="k">禁止提及:</span>' + esc(fx.forbiddenMentions.join(" · ")) + "</div>" +
      '<div class="row"><span class="k">时间锚:</span>' + esc(fx.timeGrounding) + "</div>"));

    const day1 = el("div", "card day1card");
    day1.appendChild(el("h3", "", "第一天(共同上下文 · 所有变体共享,不参与评分)"));
    for (const turn of scenario.day1.turns) {
      day1.appendChild(el("div", "msg", '<span class="who user">用户</span><span class="bubble">' + esc(turn.userText) + "</span>"));
      day1.appendChild(el("div", "msg", '<span class="who ai">SayHear</span><span class="bubble">' + esc(turn.assistantText) + "</span>"));
    }
    section.appendChild(day1);

    for (const turn of scenario.day2.turns) {
      const block = el("div", "turn");
      block.appendChild(el("h4", "", "第 " + turn.index + " 轮(day-2)"));
      if (turn.gapMs) block.appendChild(el("div", "gapline", "↕ 距上一轮 " + Math.round(turn.gapMs / 3600000) + " 小时 · 新的一天、新的 session"));
      block.appendChild(el("div", "msg", '<span class="who user">用户</span><span class="bubble">' + esc(turn.userText) + "</span>"));
      const grid = el("div", "armgrid");
      for (const letter of LETTERS) {
        const record = turn.byLetter[letter] || {};
        const card = el("div", "armcard");
        const head = el("div", "head");
        head.appendChild(el("span", "letter", letter));
        head.appendChild(el("span", "pname", esc(DATA.armNames[REVEAL.find(r => r.id === scenario.id).letterMap[letter]] || "?")));
        card.appendChild(head);
        card.appendChild(el("div", "resp" + (record.error ? " err" : ""), record.error ? ("生成失败: " + esc(record.error)) : esc(record.text)));
        card.appendChild(el("div", "", flagsHtml(record.flags)));
        const note = el("textarea", "note");
        note.placeholder = "这一轮这个变体的批注(可选)";
        note.value = (ratingFor(scenario.id).turnNotes[turn.index + ":" + letter]) || "";
        note.oninput = () => {
          const value = note.value.trim();
          const r = ratingFor(scenario.id);
          if (value) r.turnNotes[turn.index + ":" + letter] = value;
          else delete r.turnNotes[turn.index + ":" + letter];
          saveDraft();
        };
        card.appendChild(note);
        grid.appendChild(card);
      }
      block.appendChild(grid);
      section.appendChild(block);
    }

    const panel = el("div", "card rate-panel");
    panel.appendChild(el("h3", "", "变体整体评分(本场景 · 1–5,正极在高分,不求和)"));
    const rategrid = el("div", "rategrid");
    for (const letter of LETTERS) {
      const rc = el("div", "ratecard");
      const head = el("div", "head");
      head.appendChild(el("span", "letter", letter));
      head.appendChild(el("span", "pname", "→ " + esc(DATA.armNames[REVEAL.find(r => r.id === scenario.id).letterMap[letter] || "?"] || "")));
      rc.appendChild(head);
      for (const dim of DATA.dimensions) {
        const row = el("div", "dimrow");
        row.appendChild(el("span", "dl", dim.label));
        const scale = el("div", "scale");
        for (let value = 1; value <= 5; value++) {
          const input = document.createElement("input");
          input.type = "radio";
          input.name = scenario.id + ":" + letter + ":" + dim.key;
          input.id = scenario.id + ":" + letter + ":" + dim.key + ":" + value;
          input.value = value;
          input.checked = ratingFor(scenario.id).arms[letter].dimensions[dim.key] === value;
          input.onchange = () => {
            ratingFor(scenario.id).arms[letter].dimensions[dim.key] = value;
            saveDraft(); refreshProgress();
          };
          const label = el("label", "", String(value));
          label.htmlFor = input.id;
          label.title = value >= 4 ? dim.high : (value <= 2 ? dim.low : "");
          scale.appendChild(input); scale.appendChild(label);
        }
        row.appendChild(scale);
        rc.appendChild(row);
      }
      const pole = el("div", "pole", "准确: 编造/归因错 = 1 → 忠实给过信息 = 5 · 自然: 档案腔 = 1 → 顺口织入 = 5 · 克制: 查岗感 = 1 → 分寸刚好 = 5 · 连续: 初次见面 = 1 → 稳稳接住 = 5");
      rc.appendChild(pole);
      const note = el("textarea", "note");
      note.placeholder = "这个变体在本场景的整体批注(可选)";
      note.value = ratingFor(scenario.id).arms[letter].note || "";
      note.oninput = () => { ratingFor(scenario.id).arms[letter].note = note.value.trim(); saveDraft(); };
      rc.appendChild(note);
      rategrid.appendChild(rc);
    }
    panel.appendChild(rategrid);
    const bestrow = el("div", "bestrow");
    bestrow.appendChild(el("span", "", "<b>本场景最佳:</b>"));
    const select = document.createElement("select");
    select.appendChild(new Option("— 选择 —", ""));
    for (const letter of LETTERS) select.appendChild(new Option(letter, letter));
    select.value = ratingFor(scenario.id).best || "";
    select.onchange = () => { ratingFor(scenario.id).best = select.value; saveDraft(); refreshProgress(); };
    bestrow.appendChild(select);
    panel.appendChild(bestrow);
    const scenarioNote = el("textarea", "scennote");
    scenarioNote.placeholder = "本场景整体观察(可选)";
    scenarioNote.value = ratingFor(scenario.id).scenarioNote || "";
    scenarioNote.oninput = () => { ratingFor(scenario.id).scenarioNote = scenarioNote.value.trim(); saveDraft(); };
    panel.appendChild(scenarioNote);
    section.appendChild(panel);

    const revealbox = el("div", "card revealbox");
    const mapping = REVEAL.find(r => r.id === scenario.id).letterMap;
    let table = "<table><tr><th>字母</th><th>变体</th></tr>";
    for (const letter of LETTERS) table += "<tr><td>" + letter + "</td><td>" + esc(DATA.armNames[mapping[letter]] || mapping[letter]) + "</td></tr>";
    revealbox.appendChild(el("div", "", table + "</table>"));
    section.appendChild(revealbox);

    host.appendChild(section);
    if (index === 0) { tab.classList.add("active"); section.classList.add("active"); }
  });
  refreshProgress();
}

document.getElementById("export").onclick = () => {
  if (!allComplete()) { alert("还有场景没评完(每维度 1–5 + 场景最佳)。"); return; }
  const out = {
    protocol: DATA.protocol,
    scorer: "Luke",
    ratedAt: new Date().toISOString(),
    seed: DATA.seed,
    scenarios: DATA.scenarios.map(s => {
      const r = ratingFor(s.id);
      return {
        scenarioId: s.id,
        best: r.best,
        scenarioNote: r.scenarioNote || undefined,
        arms: LETTERS.map(letter => ({
          letter,
          dimensions: r.arms[letter].dimensions,
          note: r.arms[letter].note || undefined,
        })),
        turnNotes: Object.entries(r.turnNotes).map(([key, note]) => {
          const [turnIndex, letter] = key.split(":");
          return { turnIndex: Number(turnIndex), letter, note };
        }),
      };
    }),
  };
  const blob = new Blob([JSON.stringify(out, null, 2)], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = "ratings.json";
  a.click();
  URL.revokeObjectURL(a.href);
};
document.getElementById("reveal").onclick = () => {
  if (!allComplete()) { alert("先完成全部场景的盲评再揭示。"); return; }
  document.getElementById("revealConfirm").showModal();
};
document.getElementById("revealCancel").onclick = () => document.getElementById("revealConfirm").close();
document.getElementById("revealGo").onclick = () => {
  document.getElementById("revealConfirm").close();
  state.revealed = true;
  document.body.classList.add("revealed");
  document.getElementById("reveal").disabled = true;
};
document.getElementById("reset").onclick = () => {
  if (!confirm("清空本地草稿?不可恢复。")) return;
  localStorage.removeItem(STORE_KEY);
  state.ratings = {};
  location.reload();
};

loadDraft();
render();
</script>
</body>
</html>
`;

  await writeFile(path.join(outDir, "index.html"), html);
  process.stdout.write(`wrote ${outDir}/index.html — double-click to open\n`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

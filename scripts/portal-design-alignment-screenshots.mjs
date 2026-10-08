#!/usr/bin/env node
/**
 * Synthetic screenshots for the Portal design-alignment work.
 *
 * The real Portal needs a signed-in GitHub-OAuth owner session, which a
 * headless browser cannot obtain. This harness mirrors the DOM class structure
 * that the shipped components render, loads the real
 * `apps/web/app/styles.css`, and screenshots each reference screen at the
 * calibrated viewport. It uses only synthetic, non-user content.
 *
 * Run explicitly (not part of `pnpm validate`):
 *
 *   node scripts/portal-design-alignment-screenshots.mjs
 *   SAYHEAR_CHROME=/path/to/chrome node scripts/portal-design-alignment-screenshots.mjs
 *
 * PNG files and a metrics JSON are written to
 * `artifacts/portal-design-alignment/` (gitignored).
 */
import { execFile } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const stylesPath = resolve(repositoryRoot, "apps/web/app/styles.css");
const outputDir = resolve(repositoryRoot, "artifacts/portal-design-alignment");

function findBrowser() {
  const explicit = process.env.SAYHEAR_CHROME ?? process.env.CHROME_PATH;
  if (explicit && existsSync(explicit)) return explicit;

  const candidates = [];
  const playwrightCache = join(homedir(), "Library/Caches/ms-playwright");
  if (existsSync(playwrightCache)) {
    for (const entry of readdirSync(playwrightCache)) {
      if (!entry.startsWith("chromium_headless_shell-")) continue;
      for (const platform of readdirSync(join(playwrightCache, entry))) {
        const candidate = join(
          playwrightCache,
          entry,
          platform,
          "chrome-headless-shell",
        );
        if (existsSync(candidate)) candidates.push(candidate);
      }
    }
  }
  candidates.push(
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
  );
  return candidates.find((candidate) => existsSync(candidate)) ?? null;
}

/** Synthetic rail and date list; no real dates or private content. */
const CHAT_DATES = ["今天", "10月5日", "10月4日", "10月2日"];
const JOURNAL_DATES = [
  { label: "10月5日", state: "current", selected: true },
  { label: "10月4日", state: "current" },
  { label: "10月2日", state: "current" },
  { label: "10月1日", state: "current" },
  { label: "9月30日", state: "no_journal" },
];

function railMarkup(module) {
  const active = { chat: "chat", journal: "journal", tools: "tools" }[module];
  const states = { chat: "chat", journal: "journal", tools: "tools" };
  const icons = {
    chat: '<path d="M5.5 5.2h13a1.8 1.8 0 0 1 1.8 1.8v7.2a1.8 1.8 0 0 1-1.8 1.8H9.2l-4.4 3.3V7a1.8 1.8 0 0 1 .7-1.8z" fill="none" stroke="currentColor" stroke-linejoin="round" stroke-width="1.6"/>',
    journal:
      '<path d="M6 4.2h11.5a1.4 1.4 0 0 1 1.4 1.4v12.8a1.4 1.4 0 0 1-1.4 1.4H6a1.4 1.4 0 0 1-1.4-1.4V5.6A1.4 1.4 0 0 1 6 4.2z" fill="none" stroke="currentColor" stroke-linejoin="round" stroke-width="1.6"/><path d="M9.1 4.2v15.6M4.6 8.4h3.1M4.6 12h3.1M4.6 15.6h3.1" fill="none" stroke="currentColor" stroke-linecap="round" stroke-width="1.4"/>',
    tools:
      '<path d="M14.4 6.2a3.6 3.6 0 0 0-4.7 4.3l-5.9 5.9a1.9 1.9 0 1 0 2.7 2.7l5.9-5.9a3.6 3.6 0 0 0 4.3-4.7l-2.3 2.3-2.2-.6-.6-2.2 2.8-1.8z" fill="none" stroke="currentColor" stroke-linejoin="round" stroke-width="1.6"/>',
  };
  return Object.keys(states)
    .map(
      (key) =>
        `<a class="moduleRailLink${key === active ? " isActive" : ""}" href="#"><svg aria-hidden="true" height="24" width="24" viewBox="0 0 24 24">${icons[key]}</svg></a>`,
    )
    .join("\n");
}

function chatListMarkup() {
  const entries = CHAT_DATES.map(
    (label, index) =>
      `<li><a class="moduleListEntry" href="#"${
        index === 0 ? ' aria-current="page"' : ""
      }>${label}</a></li>`,
  ).join("\n");
  return `<div class="moduleList">
  <p class="moduleListHeading">聊天</p>
  <ul>${entries}</ul>
  <button class="moduleListMore" type="button">更早记录</button>
</div>`;
}

function journalListMarkup() {
  const entries = JOURNAL_DATES.map((entry) => {
    const stateMarkup =
      entry.state === "current"
        ? ""
        : entry.state === "no_journal"
          ? '<span class="journalDateNote">交流内容较少，无日记</span>'
          : `<span aria-hidden="true" class="journalStateDot journalStateDot-${entry.state}"></span><span class="journalDateState">更新中</span>`;
    return `<li><a class="moduleListEntry journalDateEntry${
      entry.state === "no_journal" ? " is-no-journal" : ""
    }" href="#"${entry.selected ? ' aria-current="page"' : ""}>
    <span class="journalDateLabel">${entry.label}</span>${stateMarkup}</a></li>`;
  }).join("\n");
  return `<div class="moduleList">
  <p class="moduleListHeading">日记</p>
  <ul>${entries}</ul>
  <button class="moduleListMore" type="button">更早记录</button>
</div>`;
}

function footerMarkup() {
  return `<div class="portalFooter">
  <span class="portalFooterOwner">Internal Owner</span>
  <span class="portalFooterState">内部自用 · 可写入</span>
</div>`;
}

function shellMarkup(module, content, { navOpen }) {
  const list = module === "journal" ? journalListMarkup() : chatListMarkup();
  return `<div class="portalShell" data-nav-open="${navOpen}">
  <header class="portalHeader">
    <button class="portalHamburger" type="button" aria-expanded="${navOpen}" aria-label="${
      navOpen ? "收起导航" : "展开导航"
    }"><span aria-hidden="true">${navOpen ? "×" : "☰"}</span></button>
    <a class="portalBrand" href="#">SayHear</a>
  </header>
  <div class="portalBody">
    ${
      navOpen
        ? '<button class="portalOverlay" type="button" aria-label="关闭导航"></button>'
        : ""
    }
    <nav class="portalNav" id="portal-navigation" aria-label="模块导航">
      <div class="portalRailColumn"><div class="moduleRail">${railMarkup(module)}</div></div>
      <div class="portalModuleColumn">${list}${footerMarkup()}</div>
    </nav>
    <div class="portalContent">${content}</div>
  </div>
</div>`;
}

const contextIcon = `<a class="contextInspectIcon" href="#" aria-label="Context"><svg aria-hidden="true" fill="none" height="16" width="16" viewBox="0 0 16 16" stroke="currentColor" stroke-linejoin="round" stroke-width="1.3"><path d="M4.3 2.6h4.9l2.5 2.5v8.3H4.3z"/><path d="M9.2 2.6v2.5h2.5M6.4 8h3.2M6.4 10.4h3.2"/></svg></a>`;

function composerMarkup({ writable }) {
  return `<form class="composer">
  <div class="composerInputRow">
    <label class="visuallyHidden" for="user-text">想聊些什么？</label>
    <textarea class="composerInput" id="user-text" placeholder="想聊些什么？" rows="1"></textarea>
    <button class="composerSend" type="submit" aria-label="发送" disabled><svg aria-hidden="true" fill="none" height="20" width="20" viewBox="0 0 24 24"><path d="M12 18V6M6.5 11.5 12 6l5.5 5.5" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="1.8"/></svg></button>
  </div>
  <p class="composerHint">Enter 发送 · Shift+Enter 换行</p>
</form>`;
}

function chatScreen({ history, navOpen }) {
  const messages = history
    ? `<div class="userMessage"><div class="messageBody"><p>今晚散步时，发现树叶已经开始变黄了。</p></div></div>
<div class="assistantMessage"><p>原来季节已经悄悄换了。那一刻，你终于慢下来了。</p><div class="messageMeta">${contextIcon}<span class="messageTime">20:13</span></div></div>`
    : `<div class="userMessage"><div class="messageBody"><p>今天下午终于把方案讲清楚了，回来之后整个人都轻松了一点。</p></div></div>
<div class="assistantMessage"><p>那种反复解释的疲惫，好像终于松开了。最让你放松的，是对方终于理解了你在坚持什么。</p><div class="messageMeta">${contextIcon}<span class="messageTime">14:32</span></div></div>
<div class="userMessage"><div class="messageBody"><p>是的，我不用再一遍遍解释了。</p></div></div>
<div class="assistantMessage waitingMessage" aria-hidden="true"><span class="waitingDots"><span class="waitingDot"></span><span class="waitingDot"></span><span class="waitingDot"></span></span></div>`;
  const footer = history
    ? `<footer class="historyFooter"><a class="historyReturn" href="#">返回今天</a></footer>`
    : composerMarkup({ writable: true });
  const status = history
    ? "2026年10月5日 · 历史记录"
    : "2026年10月6日 · 今天";
  return shellMarkup(
    "chat",
    `<section class="conversation${history ? " historyConversation" : ""}">
  <p class="conversationStatus">${status}</p>
  <div class="conversationStream"><div class="messageList">${messages}</div></div>
  ${footer}
</section>`,
    { navOpen },
  );
}

function journalScreen({ navOpen }) {
  return shellMarkup(
    "journal",
    `<div class="portalPage"><section class="journalView">
  <div class="journalHeading">
    <div class="journalHeadingTitle">
      <h1 class="journalViewTitle">2026年10月5日</h1>
      <span class="journalState journalState-current" data-state="current">已发布</span>
    </div>
    <div class="journalActions">
      <button type="button"><svg aria-hidden="true" fill="none" height="16" width="16" viewBox="0 0 16 16" stroke="currentColor" stroke-linejoin="round" stroke-width="1.5"><path d="M5.6 3.1h5.8a1.5 1.5 0 0 1 1.5 1.5v5.8"/><path d="M3.1 5.6h5.8a1.5 1.5 0 0 1 1.5 1.5v5.8H4.6a1.5 1.5 0 0 1-1.5-1.5z"/></svg>复制</button>
      <button type="button"><svg aria-hidden="true" fill="none" height="16" width="16" viewBox="0 0 16 16" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5"><path d="M8 2.6v7.2M5.2 7.2 8 10l2.8-2.8"/><path d="M3.1 11.1v1.3a1.5 1.5 0 0 0 1.5 1.5h6.8a1.5 1.5 0 0 0 1.5-1.5v-1.3"/></svg>导出</button>
    </div>
  </div>
  <div class="journalBody">
    <div class="journalStatements">
      <div class="journalStatementBlock"><p class="journalStatement">这一天，Luke 终于把一直反复修改的方案讲清楚了。让他轻松下来的，是对方理解了他为什么坚持那个方向。</p></div>
      <div class="journalStatementBlock">
        <p class="journalStatement">傍晚，他出去走了一段路。路边的树叶开始变黄，他在一棵树下停了一会儿，才发现自己已经很久没有这样慢慢看过周围。</p>
        <p class="journalFinding">诊断提示：此处的情绪判断建议回看原始表达。</p>
      </div>
      <div class="journalStatementBlock"><p class="journalStatement">工作仍有没完成的部分，但今晚他没有急着回去继续。他想给这一天留一点空白。</p></div>
    </div>
    <a class="journalChatLink" href="#">查看当天聊天<span aria-hidden="true">→</span></a>
    <details class="journalRawDiagnostics"><summary>诊断详情</summary><ul></ul></details>
  </div>
</section></div>`,
    { navOpen },
  );
}

const SCREENS = [
  { name: "chat-desktop", width: 1440, height: 1000, html: chatScreen({ history: false, navOpen: true }) },
  { name: "chat-mobile", width: 390, height: 844, html: chatScreen({ history: false, navOpen: false }) },
  { name: "history-mobile", width: 390, height: 844, html: chatScreen({ history: true, navOpen: false }) },
  { name: "nav-drawer-mobile", width: 390, height: 844, html: chatScreen({ history: false, navOpen: true }) },
  { name: "journal-desktop", width: 1440, height: 1000, html: journalScreen({ navOpen: true }) },
  { name: "journal-mobile", width: 390, height: 844, html: journalScreen({ navOpen: false }) },
];

function page(html) {
  return `<!doctype html>
<html lang="zh"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="stylesheet" href="file://${stylesPath}">
<title>portal-design-alignment</title></head>
<body>${html}
<pre id="metrics"></pre>
<script>
window.addEventListener("load", () => {
  const round = (value) => Math.round(value * 100) / 100;
  const box = (selector) => {
    const element = document.querySelector(selector);
    if (!element) return null;
    const rect = element.getBoundingClientRect();
    return {
      bottom: round(rect.bottom), height: round(rect.height), left: round(rect.left),
      right: round(rect.right), top: round(rect.top), width: round(rect.width),
    };
  };
  document.getElementById("metrics").textContent = JSON.stringify({
    viewport: { height: window.innerHeight, width: window.innerWidth },
    nav: box(".portalNav"),
    railColumn: box(".portalRailColumn"),
    content: box(".portalContent"),
    dateLine: box(".conversationStatus"),
    firstMessage: box(".userMessage"),
    composerRow: box(".composerInputRow"),
    sendButton: box(".composerSend"),
    sendIcon: box(".composerSend svg"),
    historyReturn: box(".historyReturn"),
    journalTitle: box(".journalViewTitle"),
    journalState: box(".journalState"),
    journalActions: box(".journalActions"),
    firstStatement: box(".journalStatement"),
    chatLink: box(".journalChatLink"),
    diagnostics: box(".journalRawDiagnostics"),
    documentScrollWidth: document.documentElement.scrollWidth,
  });
});
</script>
</body></html>`;
}

async function capture(browser, screen, htmlPath, pngPath) {
  await execFileAsync(
    browser,
    [
      "--headless",
      "--disable-gpu",
      "--no-sandbox",
      "--hide-scrollbars",
      "--force-device-scale-factor=1",
      `--window-size=${screen.width},${screen.height}`,
      "--virtual-time-budget=2000",
      `--screenshot=${pngPath}`,
      `file://${htmlPath}`,
    ],
    { maxBuffer: 64 * 1024 * 1024, timeout: 60_000 },
  );
  const { stdout } = await execFileAsync(
    browser,
    [
      "--headless",
      "--disable-gpu",
      "--no-sandbox",
      "--force-device-scale-factor=1",
      `--window-size=${screen.width},${screen.height}`,
      "--virtual-time-budget=2000",
      "--dump-dom",
      `file://${htmlPath}`,
    ],
    { maxBuffer: 64 * 1024 * 1024, timeout: 60_000 },
  );
  const match = /<pre id="metrics">([\s\S]*?)<\/pre>/.exec(stdout);
  if (!match) {
    throw new Error(`no metrics found for ${screen.name}`);
  }
  return JSON.parse(match[1]);
}

async function main() {
  const browser = findBrowser();
  if (browser === null) {
    process.stderr.write(
      "No browser binary found. Set SAYHEAR_CHROME=/path/to/chrome and rerun.\n",
    );
    return 1;
  }
  mkdirSync(outputDir, { recursive: true });

  const metrics = {};
  for (const screen of SCREENS) {
    const htmlPath = join(outputDir, `${screen.name}.html`);
    writeFileSync(htmlPath, page(screen.html));
    const pngPath = join(outputDir, `${screen.name}.png`);
    metrics[screen.name] = await capture(browser, screen, htmlPath, pngPath);
    process.stdout.write(
      `${screen.name}: ${screen.width}x${screen.height} -> ${pngPath}\n`,
    );
  }
  writeFileSync(
    join(outputDir, "metrics.json"),
    `${JSON.stringify(metrics, null, 2)}\n`,
  );
  process.stdout.write(`metrics: ${join(outputDir, "metrics.json")}\n`);
  return 0;
}

process.exit(await main());

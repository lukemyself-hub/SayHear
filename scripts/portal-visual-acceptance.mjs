#!/usr/bin/env node
/**
 * Repeatable local visual acceptance for the Portal sidebar layout
 * (SPEC #260 US 6–7, aligned with the high-fidelity Portal reference).
 *
 * The real Portal requires a signed-in GitHub-OAuth owner session, which a
 * headless browser cannot obtain. Instead this harness renders the same DOM
 * class structure the shell produces, loads the real
 * `apps/web/app/styles.css`, and measures the layout in a real browser engine
 * at 320 / 390 / 1024 / 1280 / 1440 px. It uses only synthetic, non-user data.
 *
 * It is intentionally NOT part of `pnpm validate` (it needs a browser binary
 * and is not a fixed CI check). Run it explicitly:
 *
 *   node scripts/portal-visual-acceptance.mjs
 *   SAYHEAR_CHROME=/path/to/chrome node scripts/portal-visual-acceptance.mjs
 *
 * Exit 0 = every assertion passed in a real browser; exit 1 = a failed
 * assertion or no browser could be found (the manual recipe is printed).
 */
import { execFile } from "node:child_process";
import { existsSync, readdirSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const stylesPath = resolve(
  process.env.SAYHEAR_STYLES ?? join(repositoryRoot, "apps/web/app/styles.css"),
);

const VIEWPORTS = [
  { label: "320", width: 320, height: 720 },
  { label: "390", width: 390, height: 844 },
  { label: "1024", width: 1024, height: 768 },
  { label: "1280", width: 1280, height: 800 },
  { label: "1440", width: 1440, height: 900 },
];
const MODULES = ["chat", "journal", "tools"];
const ENTRY_COUNT = 60;

function findBrowser() {
  const explicit = process.env.SAYHEAR_CHROME ?? process.env.CHROME_PATH;
  if (explicit && existsSync(explicit)) return explicit;

  const candidates = [];
  const playwrightCache = join(homedir(), "Library/Caches/ms-playwright");
  if (existsSync(playwrightCache)) {
    for (const entry of readdirSync(playwrightCache)) {
      if (!entry.startsWith("chromium_headless_shell-")) continue;
      for (const platform of readdirSync(join(playwrightCache, entry))) {
        const candidate = join(playwrightCache, entry, platform, "chrome-headless-shell");
        if (existsSync(candidate)) candidates.push(candidate);
      }
    }
  }
  candidates.push(
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
  );
  return candidates.find((candidate) => existsSync(candidate)) ?? null;
}

function escapeHtml(value) {
  return value.replace(/[&<>"]/g, (character) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[character],
  );
}

/** Synthetic long content: no real dates, tools or user text. */
function syntheticEntries(module) {
  const entries = [];
  for (let index = 0; index < ENTRY_COUNT; index += 1) {
    const day = String((index % 28) + 1).padStart(2, "0");
    const month = String((index % 12) + 1).padStart(2, "0");
    if (module === "tools") {
      const labels = [
        "Context Inspector",
        `Reflection Inspector — extended diagnostics and provenance view n°${index}`,
        `CandidateReview_${index}_very_long_unbroken_tool_identifier_name`,
      ];
      entries.push({ label: labels[index % labels.length] });
    } else if (module === "journal") {
      const labels = [
        `${Number(month)}月${Number(day)}日`,
        `${Number(month)}月${Number(day)}日 · 已更新至v12（长日期示例）`,
        `2026年${month}月${day}日T23:59:59.999_unbroken_journal_logical_date`,
      ];
      entries.push({
        label: labels[index % labels.length],
        state: ["current", "outdated", "updating", "no_journal"][index % 4],
      });
    } else {
      const labels = [
        `${Number(month)}月${Number(day)}日`,
        `${month}月${day}日 · 跨夜连续交流（长日期示例）`,
        `2026-${month}-${day}T23:59:59_unbroken_chat_logical_date`,
      ];
      entries.push({ label: labels[index % labels.length] });
    }
  }
  return entries;
}

function listMarkup(module) {
  const entries = syntheticEntries(module);
  const heading = { chat: "聊天", journal: "日记", tools: "检查工具" }[module];
  const items = entries
    .map((entry) => {
      if (module === "journal") {
        const stateLabel = {
          current: "已发布",
          outdated: "过期",
          updating: "更新中",
          no_journal: "交流内容较少，无日记",
        }[entry.state];
        const stateMarkup =
          entry.state === "current"
            ? ""
            : entry.state === "no_journal"
              ? `<span class="journalDateNote">${stateLabel}</span>`
              : `<span aria-hidden="true" class="journalStateDot journalStateDot-${entry.state}"></span><span class="journalDateState">${stateLabel}</span>`;
        return `<li><a class="moduleListEntry journalDateEntry${
          entry.state === "no_journal" ? " is-no-journal" : ""
        }" href="#" aria-current="${
          entry.state === "current" ? "page" : "false"
        }"><span class="journalDateLabel">${escapeHtml(
          entry.label,
        )}</span>${stateMarkup}</a></li>`;
      }
      const current = entry.label.startsWith("2026年10月") && !entry.label.includes("·");
      return `<li><a class="moduleListEntry" href="#" aria-current="${
        current ? "page" : "false"
      }">${escapeHtml(entry.label)}</a></li>`;
    })
    .join("\n");
  return `<div class="moduleList">
    <p class="moduleListHeading">${heading}</p>
    <ul>${items}</ul>
    <button class="moduleListMore" type="button">更早记录</button>
  </div>`;
}

function harnessHtml(module) {
  return `<!doctype html>
<html lang="zh"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="stylesheet" href="file://${stylesPath}">
<title>portal-sidebar-${module}</title></head>
<body>
<div class="portalShell" data-nav-open="true">
  <header class="portalHeader">
    <button class="portalHamburger" type="button">☰</button>
    <a class="portalBrand" href="#">SayHear</a>
  </header>
  <div class="portalBody">
    <nav class="portalNav" id="portal-navigation" aria-label="模块导航">
      <div class="portalRailColumn">
        <div class="moduleRail">
          <a class="moduleRailLink isActive" href="#">聊</a>
          <a class="moduleRailLink" href="#">记</a>
          <a class="moduleRailLink" href="#">具</a>
        </div>
      </div>
      <div class="portalModuleColumn">
        ${listMarkup(module)}
        <div class="portalFooter">
          <span class="portalFooterOwner">Internal Owner</span>
          <span class="portalFooterState">内部自用 · 写入已阻断：recovery_gate_closed</span>
        </div>
      </div>
    </nav>
    <div class="portalContent"><div class="portalPage"><h1>内容区</h1></div></div>
  </div>
</div>
<pre id="metrics"></pre>
<script>
window.addEventListener("load", () => {
  const round = (value) => Math.round(value * 100) / 100;
  const rect = (element) => {
    const box = element.getBoundingClientRect();
    return { bottom: round(box.bottom), left: round(box.left), right: round(box.right), top: round(box.top), width: round(box.width) };
  };
  const nav = document.querySelector(".portalNav");
  const railColumn = document.querySelector(".portalRailColumn");
  const rail = document.querySelector(".moduleRail");
  const moduleColumn = document.querySelector(".portalModuleColumn");
  const list = document.querySelector(".moduleList");
  const footer = document.querySelector(".portalFooter");
  const state = document.querySelector(".portalFooterState");
  const entries = [...document.querySelectorAll(".moduleListEntry")];
  const dateLabels = [...document.querySelectorAll(".journalDateLabel")];
  document.getElementById("metrics").textContent = JSON.stringify({
    viewport: { width: window.innerWidth, height: window.innerHeight },
    documentScrollWidth: document.documentElement.scrollWidth,
    bodyScrollWidth: document.body.scrollWidth,
    nav: rect(nav),
    railColumn: rect(railColumn),
    rail: { ...rect(rail), flexDirection: getComputedStyle(rail).flexDirection },
    moduleColumn: rect(moduleColumn),
    list: {
      ...rect(list),
      canScroll: list.scrollHeight > list.clientHeight + 1,
      clientHeight: list.clientHeight,
      scrollHeight: list.scrollHeight,
    },
    footer: {
      ...rect(footer),
      stateClientWidth: state.clientWidth,
      stateScrollWidth: state.scrollWidth,
      stateText: state.textContent,
    },
    entries: entries.map((entry) => ({
      ...rect(entry),
      clientWidth: entry.clientWidth,
      scrollWidth: entry.scrollWidth,
      minHeight: getComputedStyle(entry).minHeight,
      textOverflow: getComputedStyle(entry).textOverflow,
      whiteSpace: getComputedStyle(entry).whiteSpace,
    })),
    clippedDateLabels: dateLabels.filter((label) => label.scrollWidth > label.clientWidth + 1).length,
  });
});
</script>
</body></html>`;
}

function evaluate(module, viewport, metrics) {
  const failures = [];
  const near = (a, b, tolerance = 1) => Math.abs(a - b) <= tolerance;
  const label = `${module}@${viewport.width}px`;
  const drawer = viewport.width < 1024;
  const expectedRailWidth = drawer ? 64 : 72;
  const expectedNavWidth = drawer
    ? Math.min(320, viewport.width * 0.86)
    : 320;

  if (metrics.documentScrollWidth > metrics.viewport.width + 1) {
    failures.push(
      `${label}: full-page horizontal overflow (scrollWidth=${metrics.documentScrollWidth} > width=${metrics.viewport.width})`,
    );
  }
  if (!near(metrics.nav.width, expectedNavWidth, 1)) {
    failures.push(
      `${label}: nav width is ${metrics.nav.width}, expected ${expectedNavWidth}`,
    );
  }
  if (!near(metrics.railColumn.width, expectedRailWidth, 1)) {
    failures.push(
      `${label}: module rail column is ${metrics.railColumn.width}px wide, expected ${expectedRailWidth}px`,
    );
  }
  if (metrics.rail.flexDirection !== "column") {
    failures.push(
      `${label}: module rail is ${metrics.rail.flexDirection}, expected column`,
    );
  }
  if (!near(metrics.railColumn.left, metrics.nav.left, 1)) {
    failures.push(`${label}: module rail column is not flush with the nav left`);
  }
  if (!near(metrics.moduleColumn.left, metrics.railColumn.right, 1)) {
    failures.push(
      `${label}: date column does not start at the rail column edge (${metrics.moduleColumn.left} vs ${metrics.railColumn.right})`,
    );
  }
  if (!near(metrics.moduleColumn.right, metrics.nav.right, 1)) {
    failures.push(`${label}: date column does not reach the nav right edge`);
  }
  if (!metrics.list.canScroll) {
    failures.push(
      `${label}: long list does not scroll locally (scrollHeight=${metrics.list.scrollHeight} <= clientHeight=${metrics.list.clientHeight})`,
    );
  }
  if (!near(metrics.footer.bottom, metrics.nav.bottom, 1)) {
    failures.push(
      `${label}: footer is not bottom-anchored (footer.bottom=${metrics.footer.bottom}, nav.bottom=${metrics.nav.bottom})`,
    );
  }
  if (metrics.footer.left < metrics.moduleColumn.left - 1) {
    failures.push(`${label}: footer is not contained by the date column`);
  }
  if (metrics.footer.top < metrics.list.bottom - 1) {
    failures.push(`${label}: footer overlaps the module list`);
  }
  if (metrics.footer.stateScrollWidth > metrics.footer.stateClientWidth + 1) {
    failures.push(
      `${label}: blocked-state footer text is clipped or overflows (${metrics.footer.stateScrollWidth} > ${metrics.footer.stateClientWidth})`,
    );
  }
  if (!metrics.footer.stateText.includes("写入已阻断")) {
    failures.push(`${label}: blocked write state is not visible in the footer`);
  }
  const clippedEntries = metrics.entries.filter((entry) => entry.scrollWidth > entry.clientWidth + 1);
  if (clippedEntries.length > 0) {
    failures.push(`${label}: ${clippedEntries.length} module entries overflow horizontally`);
  }
  const nowrap = metrics.entries.filter(
    (entry) => entry.whiteSpace === "nowrap" || entry.textOverflow === "ellipsis",
  );
  if (nowrap.length > 0) {
    failures.push(`${label}: ${nowrap.length} module entries still clip with nowrap/ellipsis`);
  }
  if (metrics.clippedDateLabels > 0) {
    failures.push(`${label}: ${metrics.clippedDateLabels} journal date labels overflow horizontally`);
  }
  const shortEntries = metrics.entries.filter(
    (entry) => Number.parseFloat(entry.minHeight) < 48,
  );
  if (shortEntries.length > 0) {
    failures.push(
      `${label}: ${shortEntries.length} module entries are shorter than 48px`,
    );
  }
  return failures;
}

async function measure(browser, htmlPath, viewport) {
  const headlessFlag = browser.includes("headless-shell") ? "--headless" : "--headless=new";
  const { stdout } = await execFileAsync(
    browser,
    [
      headlessFlag,
      "--disable-gpu",
      "--no-sandbox",
      "--force-device-scale-factor=1",
      `--window-size=${viewport.width},${viewport.height}`,
      "--virtual-time-budget=3000",
      "--dump-dom",
      `file://${htmlPath}`,
    ],
    { maxBuffer: 64 * 1024 * 1024 },
  );
  const match = /<pre id="metrics">([\s\S]*?)<\/pre>/.exec(stdout);
  if (!match) {
    throw new Error(`no metrics found for ${htmlPath} @ ${viewport.width}px`);
  }
  return JSON.parse(match[1]);
}

function manualRecipe() {
  return [
    "Could not find a browser binary.",
    "Manual recipe:",
    "  1. Generate a harness: node scripts/portal-visual-acceptance.mjs --print-harness chat",
    "     (or open the real Portal with `pnpm --filter @sayhear/web dev` after signing in).",
    "  2. Open it in Chrome DevTools responsive mode at 320 / 390 / 1024 / 1280 / 1440 px.",
    "  3. Check: no page-level horizontal scroll; footer sits below the scrolling module list;",
    "     long dates/tool names wrap; a blocked write still shows its reason in the footer.",
    "  Or set SAYHEAR_CHROME=/path/to/chrome and rerun.",
  ].join("\n");
}

async function main() {
  if (process.argv.includes("--print-harness")) {
    const module = process.argv[process.argv.indexOf("--print-harness") + 1] ?? "chat";
    process.stdout.write(harnessHtml(MODULES.includes(module) ? module : "chat"));
    return 0;
  }

  const browser = findBrowser();
  if (browser === null) {
    process.stdout.write(`${manualRecipe()}\n`);
    return 1;
  }
  if (!existsSync(stylesPath)) {
    process.stderr.write(`missing stylesheet: ${stylesPath}\n`);
    return 1;
  }

  const outputDir = join(tmpdir(), `sayhear-portal-visual-${process.pid}`);
  mkdirSync(outputDir, { recursive: true });

  const failures = [];
  const rows = [];
  try {
    for (const viewport of VIEWPORTS) {
      for (const module of MODULES) {
        const htmlPath = join(outputDir, `${module}-${viewport.width}.html`);
        writeFileSync(htmlPath, harnessHtml(module));
        const metrics = await measure(browser, htmlPath, viewport);
        const moduleFailures = evaluate(module, viewport, metrics);
        failures.push(...moduleFailures);
        rows.push({
          module,
          viewport: viewport.width,
          navWidth: metrics.nav.width,
          docScrollWidth: metrics.documentScrollWidth,
          listScrolls: metrics.list.canScroll,
          footerAtBottom: Math.abs(metrics.footer.bottom - metrics.nav.bottom) <= 1,
          overflowEntries: metrics.entries.filter(
            (entry) => entry.scrollWidth > entry.clientWidth + 1,
          ).length,
          clippedDateLabels: metrics.clippedDateLabels,
          ok: moduleFailures.length === 0,
        });
      }
    }
  } finally {
    rmSync(outputDir, { recursive: true, force: true });
  }

  process.stdout.write(`browser: ${browser}\n`);
  process.stdout.write(
    "module  viewport  navWidth  docScrollWidth  listScrolls  footerAtBottom  overflowEntries  clippedDateLabels  ok\n",
  );
  for (const row of rows) {
    process.stdout.write(
      `${row.module.padEnd(7)} ${String(row.viewport).padEnd(8)} ${row.navWidth.toFixed(1).padEnd(9)} ${String(
        row.docScrollWidth,
      ).padEnd(15)} ${String(row.listScrolls).padEnd(12)} ${String(row.footerAtBottom).padEnd(15)} ${String(
        row.overflowEntries,
      ).padEnd(16)} ${String(row.clippedDateLabels).padEnd(18)} ${row.ok ? "PASS" : "FAIL"}\n`,
    );
  }

  if (failures.length > 0) {
    process.stderr.write(`\n${failures.length} failure(s):\n`);
    for (const failure of failures) process.stderr.write(` - ${failure}\n`);
    return 1;
  }
  process.stdout.write(`\nall ${rows.length} viewport/module combinations passed\n`);
  return 0;
}

process.exit(await main());

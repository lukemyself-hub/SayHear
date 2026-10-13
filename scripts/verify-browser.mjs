#!/usr/bin/env node
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const [statePath, feature = "text"] = process.argv.slice(2);
const state = JSON.parse(readFileSync(statePath, "utf8"));
assert(!state.cleaned);
assert(["access", "text", "journal", "context", "reflection"].includes(feature), "Unknown feature.");
const evidence = dirname(resolve(statePath));
const modulePath = process.env.SAYHEAR_VERIFY_PLAYWRIGHT ?? "/opt/homebrew/lib/node_modules/openclaw/node_modules/playwright-core/index.mjs";
assert(existsSync(modulePath), "Set SAYHEAR_VERIFY_PLAYWRIGHT to an installed playwright-core/index.mjs; no repository dependency is added.");
const { chromium } = await import(pathToFileURL(resolve(modulePath)).href);
const browser = await chromium.launch({ headless: true, ...(process.env.SAYHEAR_CHROME ? { executablePath: process.env.SAYHEAR_CHROME } : {}) });
const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, timezoneId: "America/Los_Angeles", locale: "en-US" });
const actions = [];
const network = [];
const external = [];
const bodies = [];
const errors = [];
const action = (description) => actions.push({ at: new Date().toISOString(), description });
const save = (name, value) => writeFileSync(join(evidence, `${feature}-${name}.json`), JSON.stringify(value, null, 2) + "\n");
const sql = (query) => execFileSync(join(state.pgBin, "psql"), ["-X", "-A", "-t", "-v", "ON_ERROR_STOP=1", "-h", "127.0.0.1", "-p", String(state.pgPort), "-U", "verify", "-d", "business", "-c", query], { encoding: "utf8", timeout: 10_000 });
await context.tracing.start({ screenshots: true, snapshots: true });
await context.route("**/*", async (route) => {
  const url = route.request().url();
  if (new URL(url).origin === state.origin) await route.continue();
  else { external.push(url); await route.abort(); }
});
const page = await context.newPage();
page.on("pageerror", (error) => errors.push(error.message));
page.on("request", (request) => {
  if (request.url().includes("/api/internal/")) network.push({ kind: "request", path: new URL(request.url()).pathname, method: request.method(), body: request.postData() });
});
page.on("response", (response) => {
  if (response.url().includes("/api/internal/")) bodies.push((async () => {
    network.push({ kind: "response", path: new URL(response.url()).pathname, status: response.status(), body: await response.text().catch(() => "response body unavailable") });
  })());
});
async function snapshot(name) {
  writeFileSync(join(evidence, `${feature}-${name}.aria.txt`), await page.locator("body").ariaSnapshot());
  await page.screenshot({ path: join(evidence, `${feature}-${name}.png`), fullPage: true });
}
let result;
try {
  if (feature === "access") {
    action("Visit / without a session through the real redirect chain.");
    await page.goto(state.origin + "/", { waitUntil: "networkidle" });
    assert.equal(new URL(page.url()).pathname, "/api/auth/signin");
    await page.getByRole("button", { name: "Sign in with GitHub" }).waitFor();
    await snapshot("anonymous");
    const response = await context.request.get(state.origin + "/api/internal/access");
    assert.equal(response.status(), 401);
    result = { passed: true, entries: ["/", "/api/internal/access"], oauth: "not exercised" };
  } else {
    action("Install synthetic database-session fixture; OAuth is outside this local proof.");
    await context.addCookies([{ name: "sayhear.session-token", value: state.sessionToken, url: state.origin, httpOnly: true, sameSite: "Lax" }]);
    await page.goto(state.origin + "/internal", { waitUntil: "networkidle" });
    await page.getByRole("textbox", { name: "想聊些什么？" }).waitFor();
    await snapshot("before");
    if (feature === "text") {
      const text = `Synthetic verification ${state.runId}: I went for a walk today and felt calmer afterwards.`;
      assert.equal(Number(sql("SELECT count(*) FROM conversation_events")), 0, "Text proof needs a fresh launch; use a new run ID.");
      const input = page.getByRole("textbox", { name: "想聊些什么？" });
      action(`Fill the composer: ${text}`);
      await input.fill(text);
      await snapshot("draft");
      const response = page.waitForResponse((r) => r.url().endsWith("/api/internal/conversation/responses") && r.status() === 200);
      action("Choose 发送; wait for the real NDJSON response and visible assistant reply.");
      await page.getByRole("button", { name: "发送", exact: true }).click();
      await response;
      await page.locator(".assistantMessage").filter({ hasText: "Synthetic verification reply. Your message was received." }).waitFor({ timeout: 30_000 });
      assert.equal(await input.inputValue(), "");
      await snapshot("sent");
      action("Reload /internal to prove canonical persistence rather than temporary stream state.");
      await page.reload({ waitUntil: "networkidle" });
      assert.equal(await page.locator(".userMessage").filter({ hasText: text }).count(), 1);
      assert.equal(await page.locator(".assistantMessage").filter({ hasText: "Synthetic verification reply. Your message was received." }).count(), 1);
      const rows = JSON.parse(sql("SELECT coalesce(json_agg(row_to_json(t)), '[]'::json) FROM (SELECT e.actor, r.canonical_text, e.daily_session_id, e.created_at FROM conversation_events e JOIN conversation_event_revisions r ON r.conversation_event_revision_id=e.current_revision_id ORDER BY e.sequence_no) t"));
      assert.deepEqual(rows.map((r) => r.actor), ["user", "assistant"]);
      assert.equal(rows[0].canonical_text, text);
      assert.equal(rows[1].canonical_text, "Synthetic verification reply. Your message was received.");
      const logicalDate = sql("SELECT logical_date::text FROM daily_sessions").trim();
      action(`Visit the read-only date URL /internal?date=${logicalDate}; current date has only 今天 in navigation.`);
      await page.goto(`${state.origin}/internal?date=${logicalDate}`, { waitUntil: "networkidle" });
      await page.getByRole("region", { name: "历史聊天记录" }).waitFor();
      assert.equal(await page.getByRole("textbox", { name: "想聊些什么？" }).count(), 0);
      assert((await page.getByRole("region", { name: "历史聊天记录" }).innerText()).includes(text));
      await snapshot("history");
      action("Choose 返回今天 to return to the current composer.");
      await page.getByRole("link", { name: "返回今天", exact: true }).click();
      await page.getByRole("textbox", { name: "想聊些什么？" }).waitFor();
      save("stored", rows);
      result = { passed: true, entries: ["/internal", `/internal?date=${logicalDate}`], events: rows.length, provider: "deterministic", oauth: "fixture only", unverified: ["past-date navigation requires a past-date fixture", "Enter, Shift+Enter and IME", "older-message pagination", "interruption/retry", "cross-midnight exchange", "live Provider"] };
    } else if (feature === "journal") {
      action("Choose 日记 from module navigation; inspect the real empty state.");
      await page.getByRole("link", { name: "日记", exact: true }).click();
      await page.getByRole("region", { name: "日记" }).waitFor();
      assert((await page.getByRole("region", { name: "日记" }).innerText()).includes("还没有可读的日记"));
      result = { passed: true, entries: ["/internal/journals"], coverage: "empty state only", unverified: ["automatic delivery", "date selection with published entries", "copy", "PNG export", "Conversation backlink"] };
    } else if (feature === "context") {
      action("Choose 检查工具 to reach Context Inspector.");
      await page.getByRole("link", { name: "检查工具", exact: true }).click();
      await page.getByRole("heading", { name: "Context Inspector", exact: true }).waitFor();
      await page.getByRole("textbox", { name: "GenerationCommand ID" }).waitFor();
      result = { passed: true, entries: ["/internal/context-inspector"], coverage: "entry only", unverified: ["real compiled Context inspection", "message 查看 context link", "capability and step-up denial", "exact Evidence and audit"] };
    } else {
      action("Visit /internal/reflection-inspector and inspect the real page.");
      await page.goto(state.origin + "/internal/reflection-inspector", { waitUntil: "networkidle" });
      await page.getByRole("heading", { name: "Reflection Inspector", exact: true }).waitFor();
      await page.getByRole("button", { name: "Verify again to view original Evidence", exact: true }).waitFor();
      result = { passed: true, entries: ["/internal/reflection-inspector"], coverage: "entry only", unverified: ["Daily/Weekly trace", "source expansion and audit", "GitHub step-up"] };
    }
    await snapshot("after");
  }
  await Promise.all(bodies);
  // Auth.js's default sign-in page references a public provider icon. It stays
  // blocked like every external request; it is not an OAuth navigation.
  const unexpectedExternal = external.filter((url) => !(feature === "access" && url === "https://authjs.dev/img/providers/github.svg"));
  assert.equal(unexpectedExternal.length, 0, "The browser attempted unexpected external traffic; inspect the captured URLs.");
  assert.equal(errors.length, 0, "Browser runtime errors detected.");
  save("result", { feature, ...result, externalBrowserRequests: external, pageErrors: errors });
  console.log(JSON.stringify({ feature, ...result, evidence }, null, 2));
} catch (error) {
  await snapshot("failure").catch(() => {});
  save("result", { feature, passed: false, error: error.message, externalBrowserRequests: external, pageErrors: errors });
  throw error;
} finally {
  save("actions", actions);
  save("network", network);
  await context.tracing.stop({ path: join(evidence, `${feature}-trace.zip`) });
  await browser.close();
}

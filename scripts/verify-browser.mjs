#!/usr/bin/env node
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const [statePath, feature = "text"] = process.argv.slice(2);
const state = JSON.parse(readFileSync(statePath, "utf8"));
assert(!state.cleaned);
// Each journey names the stand-ins it depends on. A profile that lacks them is
// an unmet precondition, never a pass.
const JOURNEYS = {
  access: { requires: {}, run: accessJourney },
  text: { requires: { session: "fixture" }, run: textJourney },
  journal: { requires: { session: "fixture" }, run: journalEmptyJourney },
  context: { requires: { session: "fixture" }, run: contextEntryJourney },
  "context-trace": { requires: { session: "fixture" }, run: contextTraceJourney },
  reflection: { requires: { session: "fixture" }, run: reflectionEntryJourney },
  delivery: { requires: { session: "fixture", clock: "real" }, run: deliveryJourney },
  signout: { requires: { session: "fixture" }, run: signOutJourney },
  oauth: { requires: { oauth: "github" }, run: oauthJourney },
  "oauth-manual": { requires: { oauth: "github" }, run: oauthManualJourney },
};
const journey = JOURNEYS[feature];
assert(journey, `Unknown journey. Use ${Object.keys(JOURNEYS).join(", ")}.`);
for (const [standIn, value] of Object.entries(journey.requires)) {
  assert.equal(state.standIns[standIn], value, `The ${feature} journey needs a launch profile with ${standIn}=${value}; this run is ${state.profile}.`);
}
const evidence = dirname(resolve(statePath));
const modulePath = process.env.SAYHEAR_VERIFY_PLAYWRIGHT ?? "/opt/homebrew/lib/node_modules/openclaw/node_modules/playwright-core/index.mjs";
assert(existsSync(modulePath), "Set SAYHEAR_VERIFY_PLAYWRIGHT to an installed playwright-core/index.mjs; no repository dependency is added.");
const { chromium } = await import(pathToFileURL(resolve(modulePath)).href);
const DETERMINISTIC_REPLY = "Synthetic verification reply. Your message was received.";
const SIGN_IN_WAIT_MS = 600_000;
// The Evidence verification intent expires five minutes after the click.
const STEP_UP_WAIT_MS = 240_000;
// A person completes GitHub's own pages in a visible window. The profile keeps
// that GitHub session outside the repository, and no trace is recorded because
// a trace would capture GitHub's sign-in form.
const interactive = feature === "oauth";
// Google's sign-in refuses any automated browser, so an account that reaches
// GitHub through Google needs this journey: a person acts in their own browser
// and the driver verifies each step from the database and the server log.
const manual = feature === "oauth-manual";
const launchOptions = { ...(process.env.SAYHEAR_CHROME ? { executablePath: process.env.SAYHEAR_CHROME } : {}) };
const contextOptions = { viewport: { width: 1440, height: 900 }, timezoneId: "America/Los_Angeles", locale: "en-US" };
let browser = null;
let context = null;
if (interactive) {
  const profile = process.env.SAYHEAR_VERIFY_BROWSER_PROFILE ?? join(homedir(), ".sayhear-verify", "github-browser-profile");
  mkdirSync(profile, { recursive: true, mode: 0o700 });
  context = await chromium.launchPersistentContext(profile, { headless: false, ...launchOptions, ...contextOptions });
} else if (!manual) {
  browser = await chromium.launch({ headless: true, ...launchOptions });
  context = await browser.newContext(contextOptions);
}
const actions = [];
const network = [];
const external = [];
const bodies = [];
const errors = [];
const action = (description) => { actions.push({ at: new Date().toISOString(), description }); if (interactive || manual) console.error(`[verify] ${description}`); };
const save = (name, value) => writeFileSync(join(evidence, `${feature}-${name}.json`), JSON.stringify(value, null, 2) + "\n");
const sql = (query) => execFileSync(join(state.pgBin, "psql"), ["-X", "-A", "-t", "-v", "ON_ERROR_STOP=1", "-h", "127.0.0.1", "-p", String(state.pgPort), "-U", "verify", "-d", "business", "-c", query], { encoding: "utf8", timeout: 10_000 }).trim();
const rows = (query) => JSON.parse(sql(`SELECT coalesce(json_agg(row_to_json(t)), '[]'::json) FROM (${query}) t`));
const squash = (text) => text.replace(/\s+/g, "");
const ownOrigin = (url) => new URL(url).origin === state.origin;
if (!interactive && !manual) {
  await context.tracing.start({ screenshots: true, snapshots: true });
  await context.route("**/*", async (route) => {
    const url = route.request().url();
    if (ownOrigin(url)) await route.continue();
    else { external.push(url); await route.abort(); }
  });
}
// A persistent profile opens with its own start tab, whose navigation aborts ours.
const page = manual ? null : await context.newPage();
for (const startTab of context?.pages() ?? []) if (startTab !== page) await startTab.close();
page?.on("pageerror", (error) => { if (ownOrigin(page.url())) errors.push(error.message); });
page?.on("request", (request) => {
  const url = request.url();
  if (!ownOrigin(url)) { if (interactive && /^https?:/.test(url)) { const host = new URL(url).hostname; if (!external.includes(host)) external.push(host); } return; }
  if (url.includes("/api/internal/")) network.push({ kind: "request", path: new URL(url).pathname, method: request.method(), body: request.postData() });
});
page?.on("response", (response) => {
  const url = response.url();
  if (!ownOrigin(url)) return;
  // Auth.js responses carry session material, so only their status is kept.
  if (url.includes("/api/auth/")) network.push({ kind: "response", path: new URL(url).pathname, status: response.status() });
  if (url.includes("/api/internal/")) bodies.push((async () => {
    network.push({ kind: "response", path: new URL(url).pathname, status: response.status(), body: await response.text().catch(() => "response body unavailable") });
  })());
});
async function snapshot(name) {
  if (!page || !ownOrigin(page.url())) return;
  writeFileSync(join(evidence, `${feature}-${name}.aria.txt`), await page.locator("body").ariaSnapshot());
  await page.screenshot({ path: join(evidence, `${feature}-${name}.png`), fullPage: true });
}
const composer = () => page.getByRole("textbox", { name: "想聊些什么？" });

async function enterWithFixtureSession() {
  action("Install synthetic database-session fixture; OAuth is outside this journey.");
  await context.addCookies([{ name: "sayhear.session-token", value: state.sessionToken, url: state.origin, httpOnly: true, sameSite: "Lax" }]);
  await page.goto(state.origin + "/internal", { waitUntil: "networkidle" });
  await composer().waitFor();
  await snapshot("before");
}

async function sendThroughComposer(text) {
  const input = composer();
  action(`Fill the composer: ${text}`);
  await input.fill(text);
  await snapshot("draft");
  const response = page.waitForResponse((r) => r.url().endsWith("/api/internal/conversation/responses") && r.status() === 200, { timeout: 120_000 });
  action("Choose 发送; wait for the real NDJSON response and the settled assistant reply.");
  await page.getByRole("button", { name: "发送", exact: true }).click();
  await response;
  // The composer stays enabled while a reply is in flight (ADR-0152 lets new
  // input supersede), and the reply bubble exists before its first delta. Wait
  // for the in-flight marker to clear and the last reply to carry text, so the
  // assertions below read the settled timeline rather than a placeholder.
  await page.waitForFunction(() => {
    if (document.querySelector(".composerStop") !== null) return false;
    const replies = document.querySelectorAll(".assistantMessage");
    const last = replies[replies.length - 1];
    if (!last || last.classList.contains("waitingMessage")) return false;
    return (last.textContent ?? "").trim().length > 0;
  }, null, { timeout: 120_000 });
  assert.equal(await input.inputValue(), "");
}

const storedMessages = () => rows("SELECT e.actor, r.canonical_text, e.daily_session_id, e.created_at FROM conversation_events e JOIN conversation_event_revisions r ON r.conversation_event_revision_id=e.current_revision_id ORDER BY e.sequence_no");
// Content-free Provider lineage for the conversation replies in this instance.
const storedAttempts = () => rows("SELECT generation_command_id, attempt_no, operation_type, provider, model, model_snapshot, prompt_version, status, finish_reason, error_category, input_tokens, output_tokens, reasoning_tokens, cost_micros, round(extract(epoch FROM (first_token_at - started_at)) * 1000) AS first_token_ms, round(extract(epoch FROM (completed_at - started_at)) * 1000) AS completed_ms FROM model_run_attempts ORDER BY started_at");

async function accessJourney() {
  action("Visit / without a session through the real redirect chain.");
  await page.goto(state.origin + "/", { waitUntil: "networkidle" });
  assert.equal(new URL(page.url()).pathname, "/api/auth/signin");
  await page.getByRole("button", { name: "Sign in with GitHub" }).waitFor();
  await snapshot("anonymous");
  const response = await context.request.get(state.origin + "/api/internal/access");
  assert.equal(response.status(), 401);
  return { entries: ["/", "/api/internal/access"], oauth: "not exercised" };
}

async function textJourney() {
  await enterWithFixtureSession();
  const deterministic = state.standIns.provider === "deterministic";
  const text = `Synthetic verification ${state.runId}: I went for a walk today and felt calmer afterwards.`;
  assert.equal(Number(sql("SELECT count(*) FROM conversation_events")), 0, "Text proof needs a fresh launch; use a new run ID.");
  const sentAt = Date.now();
  await sendThroughComposer(text);
  const visibleReplyMs = Date.now() - sentAt;
  if (deterministic) await page.locator(".assistantMessage").filter({ hasText: DETERMINISTIC_REPLY }).waitFor({ timeout: 30_000 });
  await snapshot("sent");
  action("Reload /internal to prove canonical persistence rather than temporary stream state.");
  await page.reload({ waitUntil: "networkidle" });
  const stored = storedMessages();
  assert.deepEqual(stored.map((r) => r.actor), ["user", "assistant"]);
  assert.equal(stored[0].canonical_text, text);
  assert(stored[1].canonical_text.trim().length > 0, "The stored assistant reply is empty.");
  if (deterministic) assert.equal(stored[1].canonical_text, DETERMINISTIC_REPLY);
  assert.equal(await page.locator(".userMessage").filter({ hasText: text }).count(), 1);
  assert.equal(await page.locator(".assistantMessage").count(), 1);
  assert(squash(await page.locator(".assistantMessage").innerText()).includes(squash(stored[1].canonical_text)), "The rendered reply differs from the stored canonical reply.");
  const attempts = storedAttempts();
  const reply = attempts.find((attempt) => attempt.status === "succeeded" && attempt.operation_type === "conversation.text");
  assert(reply, "No succeeded model run attempt is stored for the reply.");
  if (!deterministic) assert.equal(reply.provider, state.standIns.provider, "The reply was not produced by the launched Provider.");
  const logicalDate = sql("SELECT logical_date::text FROM daily_sessions");
  action(`Visit the read-only date URL /internal?date=${logicalDate}; current date has only 今天 in navigation.`);
  await page.goto(`${state.origin}/internal?date=${logicalDate}`, { waitUntil: "networkidle" });
  await page.getByRole("region", { name: "历史聊天记录" }).waitFor();
  assert.equal(await composer().count(), 0);
  assert((await page.getByRole("region", { name: "历史聊天记录" }).innerText()).includes(text));
  await snapshot("history");
  action("Choose 返回今天 to return to the current composer.");
  await page.getByRole("link", { name: "返回今天", exact: true }).click();
  await composer().waitFor();
  save("stored", { messages: stored, attempts });
  return { entries: ["/internal", `/internal?date=${logicalDate}`], events: stored.length, provider: deterministic ? "deterministic" : `${reply.provider} / ${reply.model}`, visibleReplyMs, oauth: "fixture only", unverified: ["past-date navigation requires a past-date fixture", "Enter, Shift+Enter and IME", "older-message pagination", "interruption/retry", "cross-midnight exchange", ...(deterministic ? ["live Provider"] : ["reply quality and continuity; this proves transport, rendering and persistence of one live reply"])] };
}

async function journalEmptyJourney() {
  await enterWithFixtureSession();
  action("Choose 日记 from module navigation; inspect the real empty state.");
  await page.getByRole("link", { name: "日记", exact: true }).click();
  await page.getByRole("region", { name: "日记" }).waitFor();
  assert((await page.getByRole("region", { name: "日记" }).innerText()).includes("还没有可读的日记"));
  return { entries: ["/internal/journals"], coverage: "empty state only", unverified: ["automatic delivery", "date selection with published entries", "copy", "export", "Conversation backlink"] };
}

async function contextEntryJourney() {
  await enterWithFixtureSession();
  action("Choose 检查工具 to reach Context Inspector.");
  await page.getByRole("link", { name: "检查工具", exact: true }).click();
  await page.getByRole("heading", { name: "Context Inspector", exact: true }).waitFor();
  await page.getByRole("textbox", { name: "GenerationCommand ID" }).waitFor();
  return { entries: ["/internal/context-inspector"], coverage: "entry only", unverified: ["real compiled Context inspection", "message 查看 context link", "capability and step-up denial", "exact Evidence and audit"] };
}

async function requireGenerationSummary(commandId, attempt) {
  const summary = page.getByRole("region", { name: "Generation summary" });
  await summary.waitFor();
  const shown = await summary.innerText();
  assert(shown.includes(commandId), "The Inspector shows a different command.");
  assert(shown.includes(`${attempt.provider} / ${attempt.model}`), "The Inspector's Provider differs from the stored model run attempt.");
}

// The sensitive read has no Portal control; this is its HTTP surface, called
// with the browser's own session.
async function sensitiveRead(commandId) {
  const response = await context.request.get(`${state.origin}/api/internal/inspection/conversation-content?generation_command_id=${commandId}`);
  return { status: response.status(), body: await response.text() };
}
const sensitiveAudits = () => rows("SELECT capability, target_type, disposition, reason, policy_version, accessed_at FROM sensitive_access_audits ORDER BY accessed_at");

async function contextTraceJourney() {
  await enterWithFixtureSession();
  const stored = storedMessages();
  assert(stored.some((r) => r.actor === "assistant"), "Context trace needs a persisted reply; run the text journey on this instance first.");
  const attempt = storedAttempts().find((candidate) => candidate.status === "succeeded" && candidate.operation_type === "conversation.text");
  const userText = stored.find((r) => r.actor === "user").canonical_text;
  if (await page.getByRole("link", { name: "查看 context", exact: true }).count() === 0) {
    action("Today's chat is empty after the exchange ended; open that day through its dated navigation link.");
    await page.locator(`a[href='/internal?date=${sql("SELECT logical_date::text FROM daily_sessions ORDER BY started_at LIMIT 1")}']`).first().click();
    await page.getByRole("region", { name: "历史聊天记录" }).waitFor();
  }
  action("Choose 查看 context beside the persisted assistant reply.");
  await page.getByRole("link", { name: "查看 context", exact: true }).first().click();
  await page.getByRole("heading", { name: "Context Inspector", exact: true }).waitFor();
  const commandId = new URL(page.url()).searchParams.get("generation_command_id");
  assert.equal(commandId, attempt.generation_command_id, "The message link carries a different command than the stored reply.");
  await requireGenerationSummary(commandId, attempt);
  await snapshot("message-link");
  action("Open Context Inspector from 检查工具, type the same command ID and choose Inspect.");
  await page.goto(state.origin + "/internal", { waitUntil: "networkidle" });
  await page.getByRole("link", { name: "检查工具", exact: true }).click();
  await page.getByRole("textbox", { name: "GenerationCommand ID" }).fill(commandId);
  await page.getByRole("button", { name: "Inspect", exact: true }).click();
  await requireGenerationSummary(commandId, attempt);
  await snapshot("typed-lookup");
  action("Request the exact conversation content over HTTP with this session, which has no recent Evidence verification.");
  const auditsBefore = sensitiveAudits().length;
  const denied = await sensitiveRead(commandId);
  assert.equal(denied.status, 403, "A session without recent verification read exact content.");
  assert(!denied.body.includes(userText), "The denial leaked the user's text.");
  const audits = sensitiveAudits();
  assert.equal(audits.length, auditsBefore + 1, "The denied read left no audit row.");
  assert.equal(audits.at(-1).disposition, "denied");
  save("stored", { attempt, denial: denied, audits });
  return { entries: ["message 查看 context link", "/internal/context-inspector typed lookup", "GET /api/internal/inspection/conversation-content"], commandId, provider: `${attempt.provider} / ${attempt.model}`, sensitiveReadWithoutStepUp: `${denied.status} ${JSON.parse(denied.body).error}`, unverified: ["exact-content read after a real GitHub step-up (run the oauth journey)"] };
}

async function reflectionEntryJourney() {
  await enterWithFixtureSession();
  action("Visit /internal/reflection-inspector and inspect the real page.");
  await page.goto(state.origin + "/internal/reflection-inspector", { waitUntil: "networkidle" });
  await page.getByRole("heading", { name: "Reflection Inspector", exact: true }).waitFor();
  await page.getByRole("button", { name: "Verify again to view original Evidence", exact: true }).waitFor();
  return { entries: ["/internal/reflection-inspector"], coverage: "entry only", unverified: ["Daily/Weekly trace", "source expansion and audit", "GitHub step-up"] };
}

// GitHub Actions calls this endpoint on a schedule in the hosted target. Here
// the driver is the scheduler.
async function scheduledScan() {
  const response = await fetch(state.origin + "/api/internal/recovery/scan", { headers: { authorization: `Bearer ${state.scannerSecret}` }, signal: AbortSignal.timeout(90_000) });
  return response.status === 200 ? response.json() : { failedStatus: response.status };
}

async function deliveryJourney() {
  await enterWithFixtureSession();
  assert.equal(Number(sql("SELECT count(*) FROM conversation_events")), 0, "Delivery proof needs a fresh launch; use a new run ID.");
  const text = `Synthetic verification ${state.runId}: this morning I finished the garden fence I had put off for weeks, and I felt proud and a little tired afterwards.`;
  await sendThroughComposer(text);
  await snapshot("sent");
  const logicalDate = sql("SELECT logical_date::text FROM daily_sessions");
  action(`Leave the conversation idle past the ${state.inactivityTimeoutMs / 1000}s inactivity window; nothing ends the exchange by hand.`);
  await page.waitForTimeout(state.inactivityTimeoutMs + 5_000);
  const journal = page.getByRole("region", { name: "日记" });
  const scans = [];
  action("Run the scheduled recovery scan as the scheduler would, then read 日记 until the Journal is published.");
  const deadline = Date.now() + 240_000;
  for (;;) {
    const scan = await scheduledScan();
    // A scan can fail while the workflows it dispatched still hold the Owner
    // lock. The schedule would simply run again, so record it and keep going.
    scans.push({ at: new Date().toISOString(), ...(scan.failedStatus ? { failedStatus: scan.failedStatus } : { inactivity: scan.inactivity, eligibility: scan.eligibility, outbox: scan.outbox }) });
    await page.goto(state.origin + "/internal/journals", { waitUntil: "networkidle" });
    await journal.waitFor();
    if (await journal.getByRole("button", { name: "复制", exact: true }).count() > 0) break;
    if (Date.now() >= deadline) {
      save("unpublished", { scans, session: rows("SELECT activity_state, quiescent_reason, last_activity_at, dialogue_revision FROM daily_sessions"), inactivityEvaluations: rows("SELECT * FROM continuous_exchange_inactivity_evaluations"), outbox: rows("SELECT event_type, status, attempt_count FROM outbox_events ORDER BY created_at"), outcomes: rows("SELECT outcome, reason FROM journal_workflow_outcomes"), workflowCommands: rows("SELECT command_type, status, created_at, dispatched_at, cancelled_reason FROM workflow_commands ORDER BY created_at"), journalAttempts: rows("SELECT role, status, created_at FROM journal_model_run_attempts ORDER BY created_at") });
      assert.fail("No Journal was published within four minutes of the exchange ending; see delivery-unpublished.json.");
    }
    await page.waitForTimeout(5_000);
  }
  await snapshot("published");
  const readProse = async () => (await journal.locator(".journalStatement").allInnerTexts()).map((statement) => statement.trim()).join("\n\n");
  const prose = await readProse();
  assert(prose.length > 0, "The published Journal has no readable prose.");
  const stored = {
    session: rows("SELECT logical_date::text, activity_state, quiescent_reason, closure_policy_version FROM daily_sessions")[0],
    outcomes: rows("SELECT outcome, reason, source_revision FROM journal_workflow_outcomes"),
    journals: rows("SELECT j.journal_id, j.current_version_id IS NOT NULL AS has_current_version FROM journals j"),
    statements: rows("SELECT count(*)::int AS statements FROM journal_statements")[0].statements,
    outbox: rows("SELECT event_type, status, attempt_count FROM outbox_events ORDER BY created_at"),
    attempts: rows("SELECT role, provider, model, config_version, status FROM journal_model_run_attempts ORDER BY created_at"),
    scans,
  };
  save("stored", stored);
  assert.deepEqual(stored.session, { logical_date: logicalDate, activity_state: "quiescent", quiescent_reason: "inactivity_timeout", closure_policy_version: "continuous-exchange-inactivity:verify-short" });
  assert.deepEqual(stored.outcomes.map((outcome) => outcome.outcome), ["published"]);
  assert.equal(stored.journals.length, 1);
  assert.equal(stored.journals[0].has_current_version, true);
  assert(stored.outbox.some((event) => event.event_type === "journal_eligibility_requested"), "No Journal eligibility event was queued.");
  assert(stored.outbox.every((event) => event.status === "dispatched"), "An outbox event was left undispatched.");
  action("Reload 日记 to prove the published Journal persists.");
  await page.reload({ waitUntil: "networkidle" });
  assert.equal(await readProse(), prose);
  action(`Choose the ${logicalDate} date in Journal navigation, then open its date URL directly.`);
  await page.locator(`a[href='/internal/journals?date=${logicalDate}']`).click();
  await page.waitForURL(`**/internal/journals?date=${logicalDate}`);
  assert.equal(await readProse(), prose);
  await page.goto(`${state.origin}/internal/journals?date=${logicalDate}`, { waitUntil: "networkidle" });
  assert.equal(await readProse(), prose);
  action("Choose 复制 and read the browser clipboard.");
  await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin: state.origin });
  await journal.getByRole("button", { name: "复制", exact: true }).click();
  await journal.getByRole("button", { name: "已复制", exact: true }).waitFor();
  const copied = await page.evaluate(() => navigator.clipboard.readText());
  assert(squash(copied).includes(squash(prose)), "The clipboard does not hold the visible Journal prose.");
  action("Choose 导出 and read the downloaded text file.");
  const pending = page.waitForEvent("download");
  await journal.getByRole("button", { name: "导出", exact: true }).click();
  const download = await pending;
  const exported = join(evidence, `${feature}-export.txt`);
  await download.saveAs(exported);
  assert.equal(download.suggestedFilename(), `sayhear-journal-${logicalDate}.txt`);
  const exportedText = readFileSync(exported, "utf8");
  assert(exportedText.startsWith(`${logicalDate}\n\n`), "The export does not open with the Journal's date.");
  assert(squash(exportedText).includes(squash(prose)), "The export does not hold the visible Journal prose.");
  action("Choose 查看当天聊天 and require that day's read-only Conversation.");
  await journal.getByRole("link", { name: "查看当天聊天", exact: true }).click();
  const history = page.getByRole("region", { name: "历史聊天记录" });
  await history.waitFor();
  assert.equal(new URL(page.url()).searchParams.get("date"), logicalDate);
  assert((await history.innerText()).includes(text));
  assert.equal(await composer().count(), 0);
  await snapshot("backlink");
  action("Return to 今天 and require the ended same-day exchange without a duplicate dated navigation entry.");
  await page.goto(state.origin + "/internal", { waitUntil: "networkidle" });
  const conversation = page.getByRole("region", { name: "Text conversation" });
  const todayShowsExchange = (await conversation.innerText()).includes(text);
  save("ended-today", { todayShowsEndedExchange: todayShowsExchange });
  await snapshot("ended-today");
  assert.equal(todayShowsExchange, true, "Today hides the ended same-day exchange.");
  assert.equal(await page.locator(`a[href='/internal?date=${logicalDate}']`).count(), 0, "Today's Session has a duplicate dated navigation entry.");
  const followup = `Synthetic verification ${state.runId}: I came back to say the finished fence still makes me smile.`;
  action("Send a same-day follow-up and require both exchanges before any refresh.");
  await sendThroughComposer(followup);
  const visibleBeforeRefresh = await conversation.locator(".userMessage, .assistantMessage").allInnerTexts();
  const beforeRefreshText = await conversation.innerText();
  assert(beforeRefreshText.includes(text), "The original exchange disappeared after the follow-up.");
  assert(beforeRefreshText.includes(followup), "The follow-up is missing before refresh.");
  const followupStored = {
    sessions: rows("SELECT daily_session_id, logical_date::text, activity_state, current_continuous_exchange_no FROM daily_sessions"),
    messages: rows("SELECT e.daily_session_id, e.sequence_no::int AS sequence, e.actor, r.canonical_text AS text FROM conversation_events e JOIN conversation_event_revisions r ON r.conversation_event_revision_id = e.current_revision_id ORDER BY e.sequence_no"),
    visibleBeforeRefresh,
  };
  save("followup-stored", followupStored);
  assert.equal(visibleBeforeRefresh.length, 4, "The visible timeline contains missing or duplicate messages.");
  assert(visibleBeforeRefresh.every((message, index) => message.startsWith(followupStored.messages[index].text)), "The visible timeline differs from canonical order or content.");
  assert.equal(followupStored.sessions.length, 1, "The follow-up created a second Daily Session.");
  assert.equal(followupStored.sessions[0].logical_date, logicalDate);
  assert.equal(followupStored.sessions[0].activity_state, "active");
  assert.equal(followupStored.sessions[0].current_continuous_exchange_no, 2);
  assert.deepEqual(followupStored.messages.map((message) => message.actor), ["user", "assistant", "user", "assistant"]);
  assert.deepEqual(followupStored.messages.map((message) => message.sequence), [1, 2, 3, 4]);
  assert(followupStored.messages.every((message) => message.daily_session_id === followupStored.sessions[0].daily_session_id));
  assert.equal(followupStored.messages[0].text, text);
  assert.equal(followupStored.messages[2].text, followup);
  await snapshot("followup");
  await page.reload({ waitUntil: "networkidle" });
  assert.deepEqual(await conversation.locator(".userMessage, .assistantMessage").allInnerTexts(), visibleBeforeRefresh, "Canonical messages changed after refresh.");
  await snapshot("followup-reloaded");
  return { entries: ["/internal composer", "inactivity window + scheduled scan", "/internal/journals", `/internal/journals?date=${logicalDate}`, "复制", "导出", "查看当天聊天", "今天", "same-day follow-up before refresh"], journalProvider: state.standIns.provider, proseLength: prose.length, clipboardLength: copied.length, exportFile: download.suggestedFilename(), scansUntilPublished: scans.length, failedScans: scans.filter((scan) => scan.failedStatus).length, todayShowsEndedExchange: todayShowsExchange, sameDayFollowupWithoutRefresh: true, substitutions: ["60s inactivity window instead of the configured production window", "driver-invoked scan instead of the GitHub Actions schedule", "local Workflow runtime instead of hosted Vercel Workflows"], unverified: ["hosted Workflow delivery", "a second date, so date selection only proves one day's own prose"] };
}

async function signOut() {
  action("Open Auth.js's /api/auth/signout page and choose Sign out; the Portal has no sign-out control.");
  await page.goto(state.origin + "/api/auth/signout", { waitUntil: "networkidle" });
  await page.getByRole("button", { name: "Sign out" }).click();
  await page.waitForLoadState("networkidle");
  assert.equal((await context.request.get(state.origin + "/api/internal/access")).status(), 401, "The session still grants access after sign-out.");
  assert.equal(Number(sql("SELECT count(*) FROM auth_sessions")), 0, "The database session survived sign-out.");
  action("Visit /internal again; it must lead back to sign-in.");
  await page.goto(state.origin + "/internal", { waitUntil: "networkidle" });
  assert.equal(new URL(page.url()).pathname, "/api/auth/signin");
  await snapshot("signed-out");
}

async function signOutJourney() {
  await enterWithFixtureSession();
  assert.equal(Number(sql("SELECT count(*) FROM auth_sessions")), 1);
  await signOut();
  return { entries: ["/api/auth/signout"], session: "fixture session, removed by the real sign-out", note: "This ends the run's only session; launch again before other journeys." };
}

// The callback response is the proof that GitHub was reached; the starting page
// can already match the URL the roundtrip returns to.
async function throughGitHub(description, timeout, start, arrived) {
  action(`${description} Complete GitHub's page in the opened window; waiting up to ${timeout / 60_000} minutes.`);
  const callback = page.waitForResponse((response) => ownOrigin(response.url()) && new URL(response.url()).pathname === "/api/auth/callback/github", { timeout });
  await start();
  await callback;
  await page.waitForURL((url) => url.origin === state.origin && arrived(url), { timeout: 60_000 });
  await page.waitForLoadState("networkidle");
}

async function oauthJourney() {
  const ownerExpected = state.standIns.owner === "configured";
  assert.equal(Number(sql("SELECT count(*) FROM auth_sessions")), 0, "OAuth proof needs a fresh launch; use a new run ID.");
  action("Visit /internal without a session.");
  await page.goto(state.origin + "/internal", { waitUntil: "networkidle" });
  assert.equal(new URL(page.url()).pathname, "/api/auth/signin");
  await snapshot("signin");
  const chooseGitHub = () => page.getByRole("button", { name: "Sign in with GitHub" }).click();
  if (!ownerExpected) {
    await throughGitHub("Sign in as any GitHub account; this instance's Owner is a different, synthetic identity.", SIGN_IN_WAIT_MS, chooseGitHub, () => true);
    const landed = new URL(page.url());
    await snapshot("refused");
    assert.notEqual(landed.pathname, "/internal", "A GitHub account that is not the Owner reached the Portal.");
    // Auth.js reports the adapter's refusal to provision an identity with this
    // code; a cancelled or misconfigured OAuth exchange reports a different one.
    assert.equal(landed.searchParams.get("error"), "OAuthCreateAccount", "The sign-in failed for a reason other than the Owner mapping.");
    assert.equal(await composer().count(), 0);
    assert.equal((await context.request.get(state.origin + "/api/internal/access")).status(), 401);
    assert.equal(Number(sql("SELECT count(*) FROM auth_sessions")), 0, "A session was created for a non-Owner.");
    assert.equal(Number(sql("SELECT count(*) FROM internal_owner_identities")), 1, "The refused sign-in changed the Owner identity mapping.");
    action("Visit /internal after the refusal; it must still lead to sign-in.");
    await page.goto(state.origin + "/internal", { waitUntil: "networkidle" });
    assert.equal(new URL(page.url()).pathname, "/api/auth/signin");
    return { entries: ["/internal", "GitHub OAuth callback"], outcome: "non-Owner refused", landedPath: landed.pathname, authError: landed.searchParams.get("error"), sessions: 0 };
  }
  await throughGitHub("Sign in as the configured Owner.", SIGN_IN_WAIT_MS, chooseGitHub, (url) => url.pathname === "/internal");
  await composer().waitFor();
  await snapshot("owner");
  const access = await context.request.get(state.origin + "/api/internal/access");
  assert.equal(access.status(), 200);
  assert.deepEqual(rows("SELECT user_id FROM auth_sessions"), [{ user_id: state.ownerId }], "The callback did not create exactly one session for the Owner.");
  await sendThroughComposer(`Synthetic verification ${state.runId}: a short note so one reply exists to inspect.`);
  const userText = storedMessages().find((r) => r.actor === "user").canonical_text;
  const commandId = new URL(await page.getByRole("link", { name: "查看 context", exact: true }).first().getAttribute("href"), state.origin).searchParams.get("generation_command_id");
  action("Request exact conversation content before any Evidence verification.");
  const before = await sensitiveRead(commandId);
  assert.equal(before.status, 403, "A freshly signed-in session read exact content without Evidence verification.");
  assert(!before.body.includes(userText));
  action("Open Reflection Inspector and choose Verify again to view original Evidence.");
  await page.goto(state.origin + "/internal/reflection-inspector", { waitUntil: "networkidle" });
  await throughGitHub("Confirm the Owner account for the Evidence verification.", STEP_UP_WAIT_MS, () => page.getByRole("button", { name: "Verify again to view original Evidence", exact: true }).click(), (url) => url.pathname === "/internal/reflection-inspector");
  await snapshot("stepped-up");
  const grant = rows("SELECT capability, step_up_authenticated_at IS NOT NULL AND step_up_authenticated_at > now() - interval '10 minutes' AS recent FROM internal_diagnostic_access_grants WHERE capability = 'conversation_content:read'");
  assert.deepEqual(grant, [{ capability: "conversation_content:read", recent: true }], "The GitHub roundtrip did not record a recent Evidence verification.");
  action("Request the same exact content after the verification.");
  const after = await sensitiveRead(commandId);
  assert.equal(after.status, 200, "A verified Owner could not read exact content.");
  assert(after.body.includes(userText), "The verified read did not return the requested content.");
  const audits = sensitiveAudits();
  assert.deepEqual(audits.map((audit) => audit.disposition), ["denied", "allowed"], "The two reads did not leave one denied and one allowed audit row.");
  save("stored", { grant, audits, deniedBeforeStepUp: before });
  await signOut();
  return { entries: ["/internal", "GitHub OAuth callback", "Evidence verification roundtrip", "GET /api/internal/inspection/conversation-content", "/api/auth/signout"], outcome: "Owner signed in, verified, read, signed out", sensitiveRead: { beforeStepUp: before.status, afterStepUp: after.status }, audits: audits.map((audit) => `${audit.disposition}:${audit.reason}`), unverified: ["Reflection Evidence excerpt expansion, which needs a generated Reflection"] };
}

async function observed(description, read) {
  action(description);
  const deadline = Date.now() + SIGN_IN_WAIT_MS;
  for (;;) {
    const value = read();
    if (value) return value;
    assert(Date.now() < deadline, `Not observed within ${SIGN_IN_WAIT_MS / 60_000} minutes: ${description}`);
    await new Promise((done) => setTimeout(done, 1_000));
  }
}
const serverLog = () => readFileSync(join(evidence, "next.log"), "utf8");
const callbacksLogged = () => (serverLog().match(/\/api\/auth\/callback\/github/g) ?? []).length;

async function oauthManualJourney() {
  const ownerExpected = state.standIns.owner === "configured";
  assert.equal(Number(sql("SELECT count(*) FROM auth_sessions")), 0, "OAuth proof needs a fresh launch; use a new run ID.");
  if (!ownerExpected) {
    await observed(`In your own browser open ${state.origin}/internal and sign in with GitHub. This instance's Owner is a different, synthetic identity, so the sign-in must be refused.`, () => callbacksLogged() >= 1);
    const authError = await observed("Waiting for Auth.js to report the refusal.", () => serverLog().match(/\/api\/auth\/(?:error|signin)\?[^\s]*error=([A-Za-z]+)/)?.[1]);
    assert.equal(authError, "OAuthCreateAccount", "The sign-in failed for a reason other than the Owner mapping.");
    assert.equal(Number(sql("SELECT count(*) FROM auth_sessions")), 0, "A session was created for a non-Owner.");
    assert.equal(Number(sql("SELECT count(*) FROM internal_owner_identities")), 1, "The refused sign-in changed the Owner identity mapping.");
    return { entries: ["/internal", "GitHub OAuth callback"], browser: "operated by a person; verified from the database and server log", outcome: "non-Owner refused", authError, sessions: 0 };
  }
  await observed(`In your own browser open ${state.origin}/internal and sign in with GitHub as the Owner.`, () => callbacksLogged() >= 1 && Number(sql("SELECT count(*) FROM auth_sessions")) === 1);
  assert.deepEqual(rows("SELECT user_id FROM auth_sessions"), [{ user_id: state.ownerId }], "The callback did not create exactly one session for the Owner.");
  const attempt = await observed("Send one short synthetic message in the chat and wait for the reply.", () => storedAttempts().find((candidate) => candidate.status === "succeeded" && candidate.operation_type === "conversation.text"));
  const contentUrl = `${state.origin}/api/internal/inspection/conversation-content?generation_command_id=${attempt.generation_command_id}`;
  await observed(`Open ${contentUrl} . It must be refused.`, () => sensitiveAudits().length === 1);
  assert.equal(sensitiveAudits()[0].disposition, "denied", "A freshly signed-in session read exact content without Evidence verification.");
  const grantRows = () => rows("SELECT capability, step_up_authenticated_at IS NOT NULL AND step_up_authenticated_at > now() - interval '10 minutes' AS recent FROM internal_diagnostic_access_grants WHERE capability = 'conversation_content:read'");
  await observed(`Open ${state.origin}/internal/reflection-inspector , choose "Verify again to view original Evidence" and confirm the Owner account at GitHub.`, () => callbacksLogged() >= 2 && grantRows()[0]?.recent === true);
  await observed(`Reload ${contentUrl} . It must now return the content.`, () => sensitiveAudits().length === 2);
  const audits = sensitiveAudits();
  assert.deepEqual(audits.map((audit) => audit.disposition), ["denied", "allowed"], "The two reads did not leave one denied and one allowed audit row.");
  save("stored", { grant: grantRows(), audits });
  await observed(`Open ${state.origin}/api/auth/signout and choose Sign out.`, () => Number(sql("SELECT count(*) FROM auth_sessions")) === 0);
  return { entries: ["/internal", "GitHub OAuth callback", "Evidence verification roundtrip", "GET /api/internal/inspection/conversation-content", "/api/auth/signout"], browser: "operated by a person; verified from the database and server log", outcome: "Owner signed in, verified, read, signed out", audits: audits.map((audit) => `${audit.disposition}:${audit.reason}`), unverified: ["what the browser displayed at each step; no screenshot is taken of a person's own browser", "Reflection Evidence excerpt expansion, which needs a generated Reflection"] };
}

try {
  const result = await journey.run();
  await snapshot("after");
  await Promise.all(bodies);
  // Auth.js's default sign-in page references a public provider icon. It stays
  // blocked like every external request; it is not an OAuth navigation.
  const unexpectedExternal = interactive ? [] : external.filter((url) => url !== "https://authjs.dev/img/providers/github.svg");
  assert.equal(unexpectedExternal.length, 0, "The browser attempted unexpected external traffic; inspect the captured URLs.");
  assert.equal(errors.length, 0, "Browser runtime errors detected.");
  save("result", { feature, profile: state.profile, standIns: state.standIns, passed: true, ...result, externalBrowserRequests: external, pageErrors: errors });
  console.log(JSON.stringify({ feature, profile: state.profile, passed: true, ...result, evidence }, null, 2));
} catch (error) {
  await snapshot("failure").catch(() => {});
  save("result", { feature, profile: state.profile, standIns: state.standIns, passed: false, error: error.message, externalBrowserRequests: external, pageErrors: errors });
  throw error;
} finally {
  save("actions", actions);
  save("network", network);
  if (!interactive && !manual) await context.tracing.stop({ path: join(evidence, `${feature}-trace.zip`) });
  await context?.close();
  await browser?.close();
}

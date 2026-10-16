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
  keyboard: { requires: { provider: "deterministic", session: "fixture" }, run: keyboardJourney },
  history: { requires: { provider: "deterministic", session: "fixture" }, run: historyJourney },
  interruption: { requires: { clock: "controllable", provider: "deterministic", providerFault: "file", session: "fixture" }, run: interruptionJourney },
  "cross-date": { requires: { clock: "controllable", provider: "deterministic", session: "fixture" }, run: crossDateJourney },
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

async function sendThroughComposer(text, options = {}) {
  const { snapshotDraft = true } = options;
  const input = composer();
  action(`Fill the composer: ${text}`);
  await input.fill(text);
  if (snapshotDraft) await snapshot("draft");
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
// Journeys that build their own history assert an empty canonical store so a
// reused instance cannot pass on rows an earlier journey left behind.
const assertFreshLaunch = (proofName) => assert.equal(Number(sql("SELECT count(*) FROM conversation_events")), 0, `${proofName} needs a fresh launch; use a new run ID.`);

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
  assertFreshLaunch("Text proof");
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
  return { entries: ["/internal", `/internal?date=${logicalDate}`], events: stored.length, provider: deterministic ? "deterministic" : `${reply.provider} / ${reply.model}`, visibleReplyMs, oauth: "fixture only", unverified: ["past-date navigation requires a past-date fixture", "keyboard, pagination/scroll, interruption/retry and a second Journal date have their own journeys", ...(deterministic ? ["live Provider"] : ["reply quality and continuity; this proves transport, rendering and persistence of one live reply"])] };
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
  assertFreshLaunch("Delivery proof");
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

const requestsTo = (path) => network.filter((entry) => entry.kind === "request" && entry.path === path);
const DAY_MS = 24 * 60 * 60 * 1000;
// The browser context runs in America/Los_Angeles, so this is the logical date
// the composer will submit for a controlled instant.
const logicalDateInLosAngeles = (iso) => new Intl.DateTimeFormat("en-CA", { day: "2-digit", month: "2-digit", timeZone: "America/Los_Angeles", year: "numeric" }).format(new Date(iso));

function setControlledClock(offsetMs) {
  assert(state.testNowFile, "This journey needs a launch profile with a controllable clock.");
  const now = new Date(Date.parse(state.testNowInitial) + offsetMs).toISOString();
  action(`Set the controlled test clock to ${now} by rewriting ${state.testNowFile}; the runtime re-reads it per request.`);
  writeFileSync(state.testNowFile, `${now}\n`);
  return now;
}

function setProviderFault(value) {
  assert(state.providerFaultFile, "This journey needs a launch profile with the test-only Provider fault file.");
  action(value === null ? "Clear the test-only Provider fault file; the next response must succeed." : `Write fault ceiling ${value} to the test-only Provider fault file.`);
  writeFileSync(state.providerFaultFile, value === null ? "" : `${value}\n`);
}

// Records the real composition and keydown events the browser dispatches on
// the composer. It observes browser input and never fabricates events.
async function recordBrowserInput() {
  await page.evaluate(() => {
    window.__verifyInput = { compositions: [], keys: [] };
    const target = document.getElementById("user-text");
    target?.addEventListener("compositionstart", () => window.__verifyInput.compositions.push({ type: "compositionstart" }));
    target?.addEventListener("compositionend", () => window.__verifyInput.compositions.push({ type: "compositionend" }));
    window.addEventListener("keydown", (event) => {
      if (event.target?.id !== "user-text") return;
      window.__verifyInput.keys.push({ defaultPrevented: event.defaultPrevented, isComposing: event.isComposing, key: event.key, keyCode: event.keyCode, shiftKey: event.shiftKey });
    });
  });
}
const recordedInput = () => page.evaluate(() => window.__verifyInput);
const journalProse = (journal) => journal.locator(".journalStatement").allInnerTexts().then((statements) => statements.map((statement) => statement.trim()).join("\n\n"));
const logicalDateHeading = (logicalDate) => {
  const [year, month, day] = logicalDate.split("-").map(Number);
  return `${year}年${month}月${day}日`;
};
const storedJournalProse = (logicalDate) => rows(`SELECT statement.statement_text FROM journals journal INNER JOIN daily_sessions session ON session.daily_session_id = journal.daily_session_id INNER JOIN journal_versions version ON version.journal_id = journal.journal_id AND version.journal_version_id = journal.current_version_id INNER JOIN journal_statements statement ON statement.journal_version_id = version.journal_version_id WHERE session.logical_date = '${logicalDate}' ORDER BY statement.statement_index`).map((row) => row.statement_text.trim()).join("\n\n");

// Drives the scheduled scan and reloads the selected Journal date until a
// published Journal appears, then cross-checks the rendered prose against the
// stored statements. A scan may fail while dispatched workflows hold the Owner
// lock (#341), so failures are recorded and the schedule simply runs again.
async function publishJournal(logicalDate, { includes, excludes }) {
  const journal = page.getByRole("region", { name: "日记" });
  const scans = [];
  action(`Run the scheduled recovery scan until ${logicalDate} has a published Journal.`);
  const deadline = Date.now() + 240_000;
  for (;;) {
    const scan = await scheduledScan();
    scans.push({ at: new Date().toISOString(), ...(scan.failedStatus ? { failedStatus: scan.failedStatus } : { inactivity: scan.inactivity, eligibility: scan.eligibility, outbox: scan.outbox }) });
    await page.goto(`${state.origin}/internal/journals?date=${logicalDate}`, { waitUntil: "networkidle" });
    await journal.waitFor();
    if (await journal.getByRole("button", { name: "复制", exact: true }).count() > 0) break;
    if (Date.now() >= deadline) {
      save(`unpublished-${logicalDate}`, { scans, sessions: rows("SELECT logical_date::text, activity_state, quiescent_reason, dialogue_revision FROM daily_sessions ORDER BY logical_date"), inactivityEvaluations: rows("SELECT * FROM continuous_exchange_inactivity_evaluations"), outbox: rows("SELECT event_type, status, attempt_count FROM outbox_events ORDER BY created_at"), outcomes: rows("SELECT outcome, reason FROM journal_workflow_outcomes"), workflowCommands: rows("SELECT command_type, status, created_at, dispatched_at, cancelled_reason FROM workflow_commands ORDER BY created_at"), journalAttempts: rows("SELECT role, status, created_at FROM journal_model_run_attempts ORDER BY created_at") });
      assert.fail(`No Journal was published for ${logicalDate} within four minutes; see cross-date-unpublished-${logicalDate}.json.`);
    }
    await page.waitForTimeout(5_000);
  }
  const prose = await journalProse(journal);
  assert(prose.length > 0, `The published Journal for ${logicalDate} has no readable prose.`);
  for (const token of includes) assert(squash(prose).includes(squash(token)), `The ${logicalDate} Journal does not carry its own ${token}.`);
  for (const token of excludes) assert(!squash(prose).includes(squash(token)), `The ${logicalDate} Journal carries the other date's ${token}.`);
  assert.equal(squash(prose), squash(storedJournalProse(logicalDate)), `The ${logicalDate} rendered Journal differs from the stored statements.`);
  return { heading: await journal.locator(".journalViewTitle").innerText(), prose, scans };
}

async function keyboardJourney() {
  await enterWithFixtureSession();
  assertFreshLaunch("Keyboard proof");
  const responsesPath = "/api/internal/conversation/responses";
  const responseCount = () => requestsTo(responsesPath).length;
  const input = composer();
  await recordBrowserInput();

  action("Start a browser-level IME composition with CDP Input.imeSetComposition; this is emulated browser input, not a real operating-system IME.");
  await input.click();
  const cdp = await context.newCDPSession(page);
  await cdp.send("Input.imeSetComposition", { selectionEnd: 2, selectionStart: 2, text: "你好" });
  await page.waitForFunction(() => document.getElementById("user-text")?.value === "你好", null, { timeout: 10_000 });
  await snapshot("ime-composing");
  const beforeImeEnter = responseCount();
  await page.keyboard.press("Enter");
  await page.waitForTimeout(1_000);
  assert.equal(responseCount(), beforeImeEnter, "Enter during IME composition sent a response request.");
  assert.equal(await page.locator(".submissionError").count(), 0, "Enter during IME composition produced a failure notice.");
  const composition = await recordedInput();
  assert(composition.compositions.some((event) => event.type === "compositionstart"), "The composition never started on the composer.");
  const imeEnter = composition.keys.findLast((event) => event.key === "Enter");
  assert(imeEnter, "The Enter keydown during composition was not observed.");
  assert.equal(imeEnter.isComposing, true, "The observed Enter keydown was not inside the composition.");
  await snapshot("ime-after-enter");

  action("Reload to end the emulated composition; the composer must return to plain input.");
  await page.reload({ waitUntil: "networkidle" });
  await composer().waitFor();
  await recordBrowserInput();

  const firstLine = `Synthetic verification ${state.runId}: keyboard line one`;
  const multiline = `${firstLine}\nkeyboard line two`;
  action("Fill one line, press Shift+Enter once and require a newline with no response request.");
  await input.fill(firstLine);
  const beforeShiftEnter = responseCount();
  await input.press("Shift+Enter");
  await page.waitForTimeout(500);
  assert.equal(responseCount(), beforeShiftEnter, "Shift+Enter sent a response request.");
  assert.equal(await input.inputValue(), `${firstLine}\n`, "Shift+Enter did not insert exactly one newline.");
  assert.equal(await page.locator("form.composer.isMultiline").count(), 1, "The multiline composer state did not activate.");
  await input.pressSequentially("keyboard line two");

  action("Press Enter once; exactly one response request must leave, the composer must clear and the reply must settle.");
  const beforeEnter = responseCount();
  const response = page.waitForResponse((r) => r.url().endsWith(responsesPath) && r.status() === 200, { timeout: 120_000 });
  await input.press("Enter");
  await response;
  await page.waitForFunction(() => document.getElementById("user-text")?.disabled === false, null, { timeout: 120_000 });
  await page.locator(".assistantMessage:not(.waitingMessage)").last().waitFor();
  assert.equal(responseCount(), beforeEnter + 1, "Enter did not produce exactly one response request.");
  assert.equal(await input.inputValue(), "", "Enter left text in the composer after sending.");
  const stored = storedMessages();
  assert.equal(stored.length, 2, "Enter must commit exactly one user and one assistant message.");
  assert.equal(stored[0].canonical_text, multiline);
  assert.equal(stored[1].canonical_text, DETERMINISTIC_REPLY);
  assert.equal(await page.locator(".userMessage").count(), 1);
  assert(squash(await page.locator(".userMessage").innerText()).includes(squash(multiline)), "The rendered user message differs from what Enter sent.");
  await snapshot("sent");
  const afterSend = await recordedInput();
  const attempts = storedAttempts();
  save("stored", { attempts, ime: { compositionEvents: composition.compositions, enterDuringComposition: imeEnter, method: "CDP Input.imeSetComposition" }, keyEvents: afterSend.keys, multiline, stored });

  action("Reload after the send and verify the canonical messages render once from persisted state.");
  await page.reload({ waitUntil: "networkidle" });
  await page.getByRole("region", { name: "Text conversation" }).waitFor();
  assert.equal(await page.locator(".userMessage").count(), 1);
  assert.equal(await page.locator(".assistantMessage:not(.waitingMessage)").count(), 1);
  assert.equal(squash(await page.locator(".userMessage").last().innerText()).includes(squash(multiline)), true);
  assert.equal(squash(await page.locator(".assistantMessage:not(.waitingMessage) > p").last().innerText()), squash(DETERMINISTIC_REPLY));
  assert.deepEqual(storedMessages().map(({ actor, canonical_text }) => ({ actor, text: canonical_text })), [
    { actor: "user", text: multiline },
    { actor: "assistant", text: DETERMINISTIC_REPLY },
  ]);
  await snapshot("reloaded");
  return { entries: ["/internal composer", "CDP Input.imeSetComposition + Enter", "Shift+Enter", "Enter", "reload and verify persisted messages"], ime: { compositionEvents: composition.compositions.map((event) => event.type), enterDuringComposition: imeEnter, method: "browser-level composition through CDP Input.imeSetComposition; a real operating-system IME stays human-pending" }, responseRequests: responseCount(), unverified: ["a real operating-system IME (human pending)", "candidate selection and composition editing"] };
}

async function historyJourney() {
  await enterWithFixtureSession();
  assertFreshLaunch("History proof");
  const responsesPath = "/api/internal/conversation/responses";
  const messageText = (index) => `Synthetic verification ${state.runId}: history-${String(index).padStart(2, "0")} through the composer.`;
  const composerExchanges = 28;
  const totalExchanges = composerExchanges + 2;
  action(`Send ${composerExchanges} exchanges through the real composer to exceed the 50-message recent window.`);
  for (let index = 1; index <= composerExchanges; index += 1) {
    await sendThroughComposer(messageText(index), { snapshotDraft: false });
  }
  assert.equal(storedMessages().length, 2 * composerExchanges);

  action("Reload the current conversation; the bounded window must hold the latest 50 events, 25 exchanges.");
  await page.reload({ waitUntil: "networkidle" });
  const current = page.getByRole("region", { name: "Text conversation" });
  await current.waitFor();
  const currentList = current.locator(".messageList");
  assert.equal(await currentList.locator(".userMessage").count(), 25, "The current conversation did not apply the recent window.");
  assert.equal(await currentList.locator(".assistantMessage").count(), 25);
  assert.equal(await currentList.getByRole("button", { name: "加载更早消息" }).count(), 0, "The writable current conversation must not offer the read-only pagination control.");
  const firstShown = squash(await currentList.locator(".userMessage").first().innerText());
  assert(firstShown.includes(squash(messageText(4))), "The bounded window should open at the fourth exchange.");
  assert(!(await currentList.innerText()).includes(messageText(1)), "The first exchange must be outside the recent window.");

  action("Scroll to the oldest visible message and send one more exchange; the arriving reply must not force the viewport down.");
  await currentList.evaluate((node) => { node.scrollTop = 0; });
  await page.waitForTimeout(500);
  const beforeSend = await currentList.evaluate((node) => node.scrollTop);
  await sendThroughComposer(messageText(composerExchanges + 1), { snapshotDraft: false });
  const afterSend = await currentList.evaluate((node) => node.scrollTop);
  assert(Math.abs(afterSend - beforeSend) <= 4, `The viewport moved from ${beforeSend} to ${afterSend} while the reader was away from the bottom.`);
  const jump = page.getByRole("button", { name: "回到最新" });
  await jump.waitFor();
  await snapshot("reading-old-messages");
  action("Choose 回到最新; follow must resume at the bottom and the control must disappear.");
  await jump.click();
  await page.waitForTimeout(300);
  const distance = await currentList.evaluate((node) => node.scrollHeight - node.scrollTop - node.clientHeight);
  assert(distance <= 48, `回到最新 left the viewport ${distance}px above the bottom.`);
  assert.equal(await jump.count(), 0, "回到最新 is still shown after re-pinning.");

  action("Send another exchange after re-pinning; its reply must keep the viewport at the bottom without showing 回到最新.");
  await sendThroughComposer(messageText(composerExchanges + 2), { snapshotDraft: false });
  const afterFollowupDistance = await currentList.evaluate((node) => node.scrollHeight - node.scrollTop - node.clientHeight);
  assert(afterFollowupDistance <= 48, `A reply after re-pinning left the viewport ${afterFollowupDistance}px above the bottom.`);
  assert.equal(await jump.count(), 0, "回到最新 reappeared after a reply while following.");

  const logicalDate = sql("SELECT logical_date::text FROM daily_sessions");
  action(`Open the read-only date URL /internal?date=${logicalDate} and page the older messages.`);
  await page.goto(`${state.origin}/internal?date=${logicalDate}`, { waitUntil: "networkidle" });
  const history = page.getByRole("region", { name: "历史聊天记录" });
  await history.waitFor();
  assert.equal(await composer().count(), 0);
  const list = history.locator(".messageList");
  assert.equal(await list.locator(".userMessage").count(), 25, "The read-only recent window did not apply the same bound.");
  const loadOlder = list.getByRole("button", { name: "加载更早消息" });
  await loadOlder.waitFor();
  await list.evaluate((node) => { node.scrollTop = 0; });
  await page.waitForTimeout(300);
  const anchor = list.locator(".userMessage", { hasText: "history-06" });
  const container = await list.elementHandle();
  const offsetOf = (element) => element.evaluate((node, parent) => node.getBoundingClientRect().top - parent.getBoundingClientRect().top, container);
  const anchorBefore = await offsetOf(anchor);
  action("Choose 加载更早消息; the prepended events must not duplicate, drop or move the reading position.");
  const older = page.waitForResponse((r) => r.url().includes("/api/internal/conversation/messages") && r.status() === 200, { timeout: 60_000 });
  await loadOlder.click();
  await older;
  await list.locator(".userMessage", { hasText: "history-01" }).waitFor();
  const anchorAfter = await (async () => {
    const deadline = Date.now() + 5_000;
    for (;;) {
      const value = await offsetOf(anchor);
      if (Math.abs(value - anchorBefore) <= 4 || Date.now() >= deadline) return value;
      await page.waitForTimeout(100);
    }
  })();
  assert(Math.abs(anchorAfter - anchorBefore) <= 4, `The reading position moved ${anchorBefore} -> ${anchorAfter} while older messages loaded.`);
  assert.equal(await list.getByRole("button", { name: "加载更早消息" }).count(), 0, "The pagination control must disappear after the oldest page.");
  const storedEvents = rows("SELECT event.actor, revision.canonical_text, event.sequence_no, event.generation_command_id FROM conversation_events event INNER JOIN conversation_event_revisions revision ON revision.conversation_event_revision_id = event.current_revision_id ORDER BY event.sequence_no");
  const renderedEvents = await list.locator(":scope > article").evaluateAll((articles) => articles.map((article) => {
    const actor = article.classList.contains("userMessage") ? "user" : "assistant";
    const text = actor === "user"
      ? article.querySelector(".messageBody p")?.textContent?.trim()
      : article.querySelector(":scope > p")?.textContent?.trim();
    const contextLink = article.querySelector("a.contextInspectIcon");
    const generationCommandId = contextLink === null
      ? null
      : new URL(contextLink.href).searchParams.get("generation_command_id");
    return { actor, text, generationCommandId };
  }));
  const expectedEvents = storedEvents.map((event) => ({
    actor: event.actor,
    text: event.canonical_text,
    generationCommandId: event.generation_command_id,
  }));
  assert.deepEqual(renderedEvents, expectedEvents, "Older pagination rendered missing, duplicated, reordered or substituted events.");
  assert.equal(storedEvents.length, 2 * totalExchanges);
  await snapshot("all-messages");
  save("stored", { anchorAfter, anchorBefore, exchangeCount: totalExchanges, olderMessageRequests: requestsTo("/api/internal/conversation/messages").length, responseRequests: requestsTo(responsesPath).length, storedEvents: storedEvents.length });
  return { entries: [`/internal composer × ${composerExchanges}`, "scroll follow and 回到最新", `/internal?date=${logicalDate} with 加载更早消息`], anchorShiftPx: Math.abs(anchorAfter - anchorBefore), unverified: ["interrupted items inside a long history", "tampered pagination cursors"], window: { recent: 50, storedEvents: 2 * totalExchanges } };
}

async function interruptionJourney() {
  await enterWithFixtureSession();
  assertFreshLaunch("Interruption proof");
  const responsesPath = "/api/internal/conversation/responses";
  const retriesPath = "/api/internal/conversation/retries";
  const text = `Synthetic verification ${state.runId}: interruption original.`;
  setProviderFault("1");
  action("Send through the real composer with a one-chunk fault ceiling; the stream must interrupt after the first delta.");
  await sendThroughComposer(text, { snapshotDraft: false });
  const interrupted = page.locator(".interruptedMessage");
  await interrupted.waitFor({ timeout: 30_000 });
  const retry = page.getByRole("button", { name: "Retry response" });
  await retry.waitFor();
  assert.equal(await retry.isEnabled(), true, "Retry response is not available for the interruption.");
  assert((await page.locator(".submissionError").innerText()).includes("interrupted"), "The interruption notice is missing.");
  assert.equal(await page.locator(".assistantMessage:not(.interruptedMessage)").count(), 0, "A partial response became a committed assistant message.");
  assert.equal(await page.locator(".userMessage").count(), 1);
  await snapshot("interrupted");
  const interruptedState = rows("SELECT turn.status AS turn_status, command.status AS command_status, attempt.status AS attempt_status, (SELECT count(*)::int FROM conversation_events WHERE actor = 'user' AND event_type = 'message') AS user_messages, (SELECT count(*)::int FROM conversation_events WHERE actor = 'assistant') AS assistant_messages FROM interaction_turns turn INNER JOIN generation_commands command ON command.interaction_turn_id = turn.interaction_turn_id INNER JOIN model_run_attempts attempt ON attempt.generation_command_id = command.generation_command_id");
  assert.deepEqual(interruptedState, [{ assistant_messages: 0, attempt_status: "interrupted", command_status: "interrupted", turn_status: "interrupted", user_messages: 1 }]);

  const dayA = sql("SELECT logical_date::text FROM daily_sessions");
  setControlledClock(DAY_MS);
  action(`Open the read-only /internal?date=${dayA}; history must guide back to the current conversation and never retry or write.`);
  await page.goto(`${state.origin}/internal?date=${dayA}`, { waitUntil: "networkidle" });
  const history = page.getByRole("region", { name: "历史聊天记录" });
  await history.waitFor();
  assert.equal(await composer().count(), 0, "The read-only date page has a composer.");
  assert.equal(await history.getByRole("button", { name: "Retry response" }).count(), 0, "The read-only history offers Retry.");
  const guidance = history.locator(".interruptedAction");
  await guidance.waitFor();
  const guidanceText = await guidance.innerText();
  assert(guidanceText.includes("这次中断发生在"), "The guidance does not state when the interruption happened.");
  assert.equal(await guidance.getByRole("link", { name: "前往当前交流", exact: true }).count(), 1);
  await snapshot("history-guidance");
  assert.deepEqual(rows("SELECT (SELECT count(*)::int FROM conversation_events WHERE actor = 'user' AND event_type = 'message') AS user_messages, (SELECT count(*)::int FROM conversation_events WHERE actor = 'assistant') AS assistant_messages, (SELECT count(*)::int FROM interaction_turns WHERE retry_of_interaction_turn_id IS NOT NULL) AS retry_turns"), [{ assistant_messages: 0, retry_turns: 0, user_messages: 1 }], "The read-only history page wrote to the session.");

  action("Choose 前往当前交流, clear the fault file and retry there; the retried reply must settle without a duplicate user submission.");
  await guidance.getByRole("link", { name: "前往当前交流", exact: true }).click();
  await page.waitForURL((url) => url.origin === state.origin && url.pathname === "/internal" && url.search.length === 0);
  await composer().waitFor();
  const retryOnToday = page.getByRole("button", { name: "Retry response" });
  await retryOnToday.waitFor();
  setProviderFault(null);
  const retryResponse = page.waitForResponse((r) => r.url().endsWith(retriesPath) && r.status() === 200, { timeout: 120_000 });
  await retryOnToday.click();
  await retryResponse;
  await page.waitForFunction(() => document.getElementById("user-text")?.disabled === false, null, { timeout: 120_000 });
  await page.getByRole("button", { name: "Retried separately" }).waitFor();
  const committed = page.locator(".assistantMessage:not(.interruptedMessage)");
  await committed.waitFor();
  assert.equal(await committed.count(), 1, "The retry did not commit exactly one assistant message.");
  assert(squash(await committed.innerText()).includes(squash(DETERMINISTIC_REPLY)), "The retried reply does not match the deterministic Provider.");
  await snapshot("retried");
  const retried = rows("SELECT retry_turn.interaction_turn_id AS retry_turn_id, retry_turn.status AS turn_status, command.status AS command_status, (SELECT count(*)::int FROM conversation_events WHERE actor = 'user' AND event_type = 'message') AS user_messages, (SELECT count(*)::int FROM conversation_events WHERE actor = 'assistant') AS assistant_messages, (SELECT count(*)::int FROM conversation_events WHERE event_type = 'retry_action') AS retry_actions, (SELECT revision.canonical_text FROM conversation_events event INNER JOIN conversation_event_revisions revision ON revision.conversation_event_revision_id = event.current_revision_id WHERE event.actor = 'assistant') AS assistant_text FROM interaction_turns retry_turn INNER JOIN generation_commands command ON command.interaction_turn_id = retry_turn.interaction_turn_id WHERE retry_turn.retry_of_interaction_turn_id IS NOT NULL");
  const retryTurnId = retried[0]?.retry_turn_id;
  assert.equal(typeof retryTurnId, "string", "The retry turn was not stored.");
  assert.deepEqual(retried, [{ assistant_messages: 1, assistant_text: DETERMINISTIC_REPLY, command_status: "succeeded", retry_actions: 1, retry_turn_id: retryTurnId, turn_status: "settled", user_messages: 1 }]);
  const turns = rows("SELECT status, retry_of_interaction_turn_id IS NOT NULL AS is_retry FROM interaction_turns ORDER BY turn_sequence_no");
  assert.deepEqual(turns, [{ is_retry: false, status: "interrupted" }, { is_retry: true, status: "settled" }]);

  const retryRequest = requestsTo(retriesPath).at(-1);
  assert(retryRequest?.body, "The retry request was not captured.");
  action("Replay the exact retry request; the idempotent replay must return the same turn without appending events.");
  const replayResponse = await context.request.post(state.origin + retriesPath, { data: JSON.parse(retryRequest.body), headers: { "content-type": "application/json" } });
  assert.equal(replayResponse.status(), 200);
  const replayEvents = (await replayResponse.text()).trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
  assert.equal(replayEvents[0]?.type, "retry_committed");
  assert.equal(replayEvents.at(-1)?.type, "assistant_committed");
  assert.equal(replayEvents[0]?.turnId, retried[0]?.retry_turn_id, "The replayed retry returned a different turn.");
  const afterReplay = rows("SELECT (SELECT count(*)::int FROM conversation_events WHERE actor = 'assistant') AS assistant_messages, (SELECT count(*)::int FROM conversation_events WHERE actor = 'user' AND event_type = 'message') AS user_messages, (SELECT count(*)::int FROM interaction_turns) AS turns");
  assert.deepEqual(afterReplay, [{ assistant_messages: 1, turns: 2, user_messages: 1 }], "The replayed retry appended events.");
  save("stored", { afterReplay, guidanceText, interruptedState, replayEvents, retried, retryRequest: JSON.parse(retryRequest.body), turns });

  action("Reload after retry replay; the interrupted turn and its separate successful reply must render without duplication.");
  await page.reload({ waitUntil: "networkidle" });
  await page.getByRole("region", { name: "Text conversation" }).waitFor();
  await page.getByRole("button", { name: "Retried separately" }).waitFor();
  assert.equal(await page.locator(".interruptedMessage").count(), 1);
  assert.equal(await page.locator(".assistantMessage:not(.interruptedMessage):not(.waitingMessage)").count(), 1);
  assert.equal(squash(await page.locator(".assistantMessage:not(.interruptedMessage):not(.waitingMessage) > p").last().innerText()), squash(DETERMINISTIC_REPLY));
  assert.equal(await page.locator(".userMessage").count(), 1);
  assert.deepEqual(rows("SELECT (SELECT count(*)::int FROM conversation_events WHERE actor = 'assistant') AS assistant_messages, (SELECT count(*)::int FROM conversation_events WHERE actor = 'user' AND event_type = 'message') AS user_messages, (SELECT count(*)::int FROM interaction_turns) AS turns"), [{ assistant_messages: 1, turns: 2, user_messages: 1 }]);
  await snapshot("reloaded-after-retry");
  return { entries: ["/internal composer", "test-only Provider fault file", `/internal?date=${dayA} history guidance`, "Retry response", "POST /api/internal/conversation/retries replay", "reload and verify persisted interruption/retry state"], substitutions: ["one-chunk deterministic fault instead of a real Provider interruption", "controlled test clock advanced 24 hours instead of a real day change"], unverified: ["a real Provider or network interruption", "retry against a quiesced historical session"] };
}

async function crossDateJourney() {
  await enterWithFixtureSession();
  assertFreshLaunch("Cross-date proof");
  const dayOneText = `Synthetic verification ${state.runId}: I walked along the river and watched the herons.`;
  const dayTwoText = `Synthetic verification ${state.runId}: I repaired the lighthouse lamp and felt relieved.`;
  const dayOne = logicalDateInLosAngeles(state.testNowInitial);
  const dayTwo = logicalDateInLosAngeles(new Date(Date.parse(state.testNowInitial) + DAY_MS).toISOString());
  assert.notEqual(dayOne, dayTwo, "The controlled clock did not span two Los Angeles dates.");

  action(`Send the first exchange; the controlled clock puts it on ${dayOne}.`);
  await sendThroughComposer(dayOneText, { snapshotDraft: false });
  assert.deepEqual(rows("SELECT logical_date::text, activity_state FROM daily_sessions"), [{ activity_state: "active", logical_date: dayOne }]);
  action("Advance the controlled test clock two minutes; the first exchange must end by inactivity and publish its own Journal.");
  setControlledClock(2 * 60_000);
  const firstJournal = await publishJournal(dayOne, { excludes: ["lighthouse"], includes: ["herons"] });

  action("Advance the controlled test clock by 24 hours; the next send must open a second Daily Session on the next date.");
  setControlledClock(DAY_MS + 2 * 60_000);
  await page.goto(state.origin + "/internal", { waitUntil: "networkidle" });
  await composer().waitFor();
  await sendThroughComposer(dayTwoText, { snapshotDraft: false });
  assert.deepEqual(rows("SELECT logical_date::text, activity_state FROM daily_sessions ORDER BY logical_date"), [{ activity_state: "quiescent", logical_date: dayOne }, { activity_state: "active", logical_date: dayTwo }]);
  action("Advance the clock again; the second date must publish its own Journal.");
  setControlledClock(DAY_MS + 4 * 60_000);
  const secondJournal = await publishJournal(dayTwo, { excludes: ["herons"], includes: ["lighthouse"] });
  assert.notEqual(squash(firstJournal.prose), squash(secondJournal.prose), "The two dates share one Journal text.");

  const verified = [];
  for (const day of [dayOne, dayTwo]) {
    const expected = day === dayOne ? firstJournal : secondJournal;
    const ownToken = day === dayOne ? "herons" : "lighthouse";
    const otherJournal = day === dayOne ? secondJournal : firstJournal;
    const otherToken = day === dayOne ? "lighthouse" : "herons";
    action(`Read ${day} through its date entry in the Journal module.`);
    await page.goto(state.origin + "/internal/journals", { waitUntil: "networkidle" });
    const entry = page.locator(`a[href='/internal/journals?date=${day}']`);
    await entry.waitFor();
    await entry.click();
    await page.waitForURL(`**/internal/journals?date=${day}`);
    const journal = page.getByRole("region", { name: "日记" });
    await journal.waitFor();
    assert.equal(await journalProse(journal), expected.prose, `The date entry did not show ${day}'s own Journal.`);
    assert.equal(await journal.locator(".journalViewTitle").innerText(), logicalDateHeading(day), "The heading does not name the selected date.");

    action(`Open /internal/journals?date=${day} directly; the URL must show the same prose.`);
    await page.goto(`${state.origin}/internal/journals?date=${day}`, { waitUntil: "networkidle" });
    await journal.waitFor();
    assert.equal(await journal.locator(".journalViewTitle").innerText(), logicalDateHeading(day), "The direct URL heading does not name the selected date.");
    assert.equal(await journalProse(journal), expected.prose);

    action(`Choose 复制 for ${day} and compare the clipboard with the visible prose.`);
    await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin: state.origin });
    await journal.getByRole("button", { name: "复制", exact: true }).click();
    await journal.getByRole("button", { name: "已复制", exact: true }).waitFor();
    const copied = await page.evaluate(() => navigator.clipboard.readText());
    assert.equal(copied, expected.prose, `The ${day} clipboard differs from the visible Journal.`);
    assert(!copied.includes(otherJournal.prose), `The ${day} clipboard includes the other date's Journal.`);

    action(`Choose 导出 for ${day} and read the downloaded file.`);
    const pending = page.waitForEvent("download");
    await journal.getByRole("button", { name: "导出", exact: true }).click();
    const download = await pending;
    const exported = join(evidence, `${feature}-export-${day}.txt`);
    await download.saveAs(exported);
    assert.equal(download.suggestedFilename(), `sayhear-journal-${day}.txt`, "The export does not carry the selected date.");
    const exportedText = readFileSync(exported, "utf8");
    assert(exportedText.startsWith(`${day}\n\n`), "The export does not open with the Journal's date.");
    assert.equal(exportedText, `${day}\n\n${expected.prose}\n`, "The export differs from the selected date and visible Journal prose.");
    assert(!exportedText.includes(otherJournal.prose), `The ${day} export includes the other date's Journal.`);

    action(`Choose 查看当天聊天 for ${day}; only that day's read-only Conversation may open.`);
    await journal.getByRole("link", { name: "查看当天聊天", exact: true }).click();
    const history = page.getByRole("region", { name: "历史聊天记录" });
    await history.waitFor();
    assert.equal(new URL(page.url()).searchParams.get("date"), day);
    assert.equal(await composer().count(), 0);
    const historyText = await history.innerText();
    assert(historyText.includes(ownToken), `The ${day} backlink does not show that day's expression.`);
    assert(!historyText.includes(otherToken), `The ${day} backlink shows the other date's expression.`);
    await snapshot(`backlink-${day}`);
    verified.push({ copiedLength: copied.length, day, exportFile: download.suggestedFilename(), proseLength: expected.prose.length });
  }

  const stored = {
    journals: rows("SELECT session.logical_date::text AS logical_date, journal.current_version_id IS NOT NULL AS has_current_version FROM journals journal INNER JOIN daily_sessions session ON session.daily_session_id = journal.daily_session_id ORDER BY session.logical_date"),
    outcomes: rows("SELECT outcome, reason FROM journal_workflow_outcomes ORDER BY created_at"),
    scans: [...firstJournal.scans, ...secondJournal.scans],
    sessions: rows("SELECT logical_date::text, activity_state, quiescent_reason FROM daily_sessions ORDER BY logical_date"),
    statementCounts: rows("SELECT session.logical_date::text AS logical_date, count(*)::int AS statements FROM journal_statements statement INNER JOIN journal_versions version ON version.journal_version_id = statement.journal_version_id INNER JOIN journals journal ON journal.journal_id = version.journal_id INNER JOIN daily_sessions session ON session.daily_session_id = journal.daily_session_id GROUP BY session.logical_date ORDER BY session.logical_date"),
    verified,
  };
  save("stored", stored);
  assert.equal(stored.journals.length, 2, "Each logical date must have its own Journal row.");
  assert(stored.journals.every((journal) => journal.has_current_version), "A Journal has no current version.");
  return { clock: { dayOne, dayTwo, initial: state.testNowInitial, method: "test-only file clock re-read per request; no session row or generation result was edited" }, entries: [`/internal composer on ${dayOne}`, `inactivity + scan on ${dayOne}`, `/internal composer on ${dayTwo}`, `inactivity + scan on ${dayTwo}`, "date entries, URLs, 复制, 导出 and 查看当天聊天 for both dates"], failedScans: stored.scans.filter((scan) => scan.failedStatus).length, proseLengths: { [dayOne]: firstJournal.prose.length, [dayTwo]: secondJournal.prose.length }, scansUntilPublished: { [dayOne]: firstJournal.scans.length, [dayTwo]: secondJournal.scans.length }, substitutions: ["60s inactivity window instead of the configured production window", "driver-invoked scan instead of the GitHub Actions schedule", "controlled test clock instead of waiting for real midnight"], unverified: ["hosted Workflow delivery", "a real calendar crossing of midnight"] };
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

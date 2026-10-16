#!/usr/bin/env node
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { constants, cpSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, readlinkSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const [command, runId, option] = process.argv.slice(2);
assert(runId && /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(runId), "Supply a unique run ID (letters, numbers, hyphens, underscores).");
const evidence = join(root, "artifacts/verify", runId);
const statePath = join(evidence, "instance.json");
const pause = () => new Promise((done) => setTimeout(done, 250));
// With no locale in the caller's environment, macOS resolves one through
// CoreFoundation threads and the postmaster refuses to start.
if (!process.env.LC_ALL && !process.env.LANG) process.env.LC_ALL = "C";
// Each profile names what stands in for the real target. `local` is the fixed
// baseline; the others replace the stand-ins that differ in their row.
const PROFILES = {
  local: { clock: "fixed", provider: "deterministic", oauth: "inert", session: "fixture", owner: "synthetic" },
  live: { clock: "real", provider: "deterministic", oauth: "inert", session: "fixture", owner: "synthetic" },
  provider: { clock: "real", provider: "opencode-go", oauth: "inert", session: "fixture", owner: "synthetic" },
  // `timeline` keeps the deterministic Provider and swaps the fixed clock for a
  // file the driver advances between requests, so one instance can produce more
  // than one logical date without editing session rows.
  timeline: { clock: "controllable", provider: "deterministic", oauth: "inert", session: "fixture", owner: "synthetic" },
  // `fault` adds the existing deterministic fault injection as a file the
  // driver turns on for one request and off again for the retry.
  fault: { clock: "controllable", provider: "deterministic", providerFault: "file", oauth: "inert", session: "fixture", owner: "synthetic" },
  oauth: { clock: "real", provider: "deterministic", oauth: "github", session: "none", owner: "configured" },
  "oauth-stranger": { clock: "real", provider: "deterministic", oauth: "github", session: "none", owner: "synthetic" },
};
const FIXED_NOW = "2026-07-27T16:00:00.000Z";
const SHORT_INACTIVITY_MS = 60_000;
const run = (binary, args, options = {}) => execFileSync(binary, args, { encoding: "utf8", timeout: 120_000, ...options });
const save = (name, data) => writeFileSync(join(evidence, name), JSON.stringify(data, null, 2) + "\n");
const readState = () => {
  const state = JSON.parse(readFileSync(statePath, "utf8"));
  assert.equal(state.root, root);
  assert.equal(state.runId, runId);
  assert.equal(dirname(state.scratch), tmpdir().replace(/\/$/, ""));
  assert(state.scratch.startsWith(join(tmpdir(), "sayhear-verify-")));
  return state;
};

function profileValue(variable, name) {
  const file = process.env[variable];
  assert(file && existsSync(file), `Set ${variable} to the env profile that holds ${name}; see docs/agents/local-environment.md.`);
  const line = readFileSync(file, "utf8").split("\n").find((entry) => entry.startsWith(`${name}=`));
  assert(line, `${name} is missing from the profile named by ${variable}.`);
  return line.slice(name.length + 1).trim().replace(/^(["'])(.*)\1$/, "$2");
}

// `localhost` resolves to either loopback family, so a server on one of them
// could answer the browser while the instance binds the other.
async function portFree(port) {
  for (const address of ["127.0.0.1", "::1"]) {
    const server = createServer();
    try {
      await new Promise((done, fail) => { server.once("error", fail); server.listen(port, address, done); });
      await new Promise((done) => server.close(done));
    } catch (error) { if (error.code !== "EADDRNOTAVAIL") return false; }
  }
  return true;
}

async function freePort() {
  const server = createServer();
  await new Promise((done, fail) => { server.once("error", fail); server.listen(0, "127.0.0.1", done); });
  const port = server.address().port;
  await new Promise((done) => server.close(done));
  return port;
}

function postgresBin() {
  if (process.env.SAYHEAR_VERIFY_PG_BIN) return resolve(process.env.SAYHEAR_VERIFY_PG_BIN);
  try { return dirname(run("which", ["initdb"]).trim()); } catch {}
  for (const version of ["18", "17", "16"]) {
    const directory = `/opt/homebrew/opt/postgresql@${version}/bin`;
    if (existsSync(join(directory, "initdb"))) return directory;
  }
  throw new Error("PostgreSQL server binaries missing. Set SAYHEAR_VERIFY_PG_BIN to the directory containing initdb, pg_ctl and createdb.");
}

function childStart(pid) {
  try { return run("ps", ["-p", String(pid), "-o", "lstart="]).trim(); } catch { return null; }
}

function groupAlive(pid) {
  try { process.kill(-pid, 0); return true; }
  catch (error) { if (error.code === "ESRCH") return false; throw error; }
}

function sql(state, query, marker = false) {
  return run(join(state.pgBin, "psql"), ["-X", "-A", "-t", "-v", "ON_ERROR_STOP=1", "-h", "127.0.0.1", "-p", String(state.pgPort), "-U", "verify", "-d", marker ? "marker" : "business", "-c", query]);
}

async function cleanup(state) {
  if (state.cleaned && !existsSync(state.scratch)) return;
  if (state.webPid && groupAlive(state.webPid)) {
    if (childStart(state.webPid) !== state.webStarted) {
      const members = run("ps", ["-axo", "pid=,pgid="]).trim().split("\n")
        .map((line) => line.trim().split(/\s+/).map(Number))
        .filter(([, group]) => group === state.webPid);
      assert(members.length > 0, "Cannot identify the remaining process group.");
      const ownedDirectory = realpathSync(state.scratch);
      for (const [pid] of members) {
        const cwd = process.platform === "linux"
          ? readlinkSync(`/proc/${pid}/cwd`)
          : run("lsof", ["-a", "-p", String(pid), "-d", "cwd", "-Fn"]).split("\n").find((line) => line.startsWith("n"))?.slice(1);
        assert(cwd && (cwd === ownedDirectory || cwd.startsWith(ownedDirectory + "/")), "Refusing to stop a process group outside this run's scratch directory.");
      }
    }
    process.kill(-state.webPid, "SIGTERM");
    for (let i = 0; i < 40 && groupAlive(state.webPid); i++) await pause();
    if (groupAlive(state.webPid)) process.kill(-state.webPid, "SIGKILL");
    for (let i = 0; i < 20 && groupAlive(state.webPid); i++) await pause();
    assert(!groupAlive(state.webPid), "Owned Next process group has not exited; keep scratch and retry cleanup.");
  }
  const pgData = join(state.scratch, "pgdata");
  const postmaster = join(pgData, "postmaster.pid");
  if (existsSync(postmaster)) {
    const lines = readFileSync(postmaster, "utf8").split("\n");
    assert.equal(lines[1], pgData, "Refusing to stop an unowned PostgreSQL instance.");
    run(join(state.pgBin, "pg_ctl"), ["-D", pgData, "-m", "fast", "-w", "stop"]);
  }
  // Next dev logs request lines with their query, which for the OAuth callback
  // holds the one-time code and state.
  const nextLog = join(evidence, "next.log");
  if (existsSync(nextLog)) writeFileSync(nextLog, readFileSync(nextLog, "utf8").replace(/([?&](?:code|state)=)[^&\s"']+/g, "$1redacted"));
  rmSync(state.scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  state.cleaned = true;
  save("instance.json", state);
  save("cleanup.json", { cleaned: true, scratchRemoved: !existsSync(state.scratch), evidenceRetained: existsSync(statePath), at: new Date().toISOString() });
}

async function doctor(state) {
  assert(!state.cleaned, "Instance has been cleaned. Launch a new run.");
  assert.equal(childStart(state.webPid), state.webStarted, "Owned Next process is not running.");
  assert.equal(run("git", ["rev-parse", "HEAD"], { cwd: root }).trim(), state.commit, "Checkout HEAD changed since launch; launch a fresh run.");
  const request = async (path, init = {}) => {
    const response = await fetch(state.origin + path, { redirect: "manual", signal: AbortSignal.timeout(30_000), ...init });
    return { status: response.status, body: await response.text(), headers: response.headers };
  };
  const anonymous = await request("/api/internal/access");
  assert.equal(anonymous.status, 401);
  const report = { runId, origin: state.origin, commit: state.commit, sourceStatus: state.sourceStatus, profile: state.profile, deployment: "test", ...state.standIns, anonymousStatus: anonymous.status };
  if (state.standIns.session === "fixture") {
    const cookie = `sayhear.session-token=${state.sessionToken}`;
    const access = await request("/api/internal/access", { headers: { cookie } });
    assert.equal(access.status, 200);
    assert.equal(JSON.parse(access.body).privateWrites.allowed, true);
    const page = await request("/internal", { headers: { cookie } });
    assert.equal(page.status, 200);
    assert(page.body.includes('id="user-text"'), "The real composer is missing.");
    Object.assign(report, { ownerFixture: true, authenticatedStatus: access.status, composerPresent: true });
  } else {
    const csrf = await request("/api/auth/csrf");
    const signin = await request("/api/auth/signin/github", { method: "POST", headers: { cookie: csrf.headers.getSetCookie().map((entry) => entry.split(";")[0]).join("; "), "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ csrfToken: JSON.parse(csrf.body).csrfToken, callbackUrl: `${state.origin}/internal` }) });
    const authorize = new URL(signin.headers.get("location") ?? "about:blank");
    assert.equal(authorize.origin + authorize.pathname, "https://github.com/login/oauth/authorize", "Sign-in did not hand off to GitHub.");
    assert.equal(authorize.searchParams.get("redirect_uri"), `${state.origin}/api/auth/callback/github`);
    assert.notEqual(authorize.searchParams.get("client_id"), "synthetic-verification-client");
    Object.assign(report, { ownerFixture: false, authorizeEndpoint: authorize.origin + authorize.pathname, redirectUri: authorize.searchParams.get("redirect_uri"), scope: authorize.searchParams.get("scope") });
  }
  Object.assign(report, { businessMigrations: Number(sql(state, "SELECT count(*) FROM schema_migrations")), markerMigrations: Number(sql(state, "SELECT count(*) FROM schema_migrations", true)) });
  save("doctor.json", report);
  console.log(JSON.stringify(report, null, 2));
}

async function launch() {
  const profile = option ?? "local";
  const standIns = PROFILES[profile];
  assert(standIns, `Unknown profile. Use ${Object.keys(PROFILES).join(", ")}.`);
  assert(!existsSync(statePath), "Run ID already exists; keep old evidence and use a new ID.");
  assert(existsSync(join(root, "node_modules/.bin/tsx")), "Run pnpm install --frozen-lockfile first.");
  const realOAuth = standIns.oauth === "github";
  const origin = realOAuth ? new URL(profileValue("SAYHEAR_VERIFY_OAUTH_ENV", "NEXTAUTH_URL")).origin : `http://127.0.0.1:${await freePort()}`;
  const { hostname, port } = new URL(origin);
  assert(["localhost", "127.0.0.1"].includes(hostname) && port, "The OAuth profile must name a loopback origin with an explicit port.");
  if (realOAuth) assert(await portFree(Number(port)), `${origin} is the OAuth app's registered callback origin and is in use. Stop that server first.`);
  // Real credentials go from the named env profile to the child processes only;
  // they are never written to instance.json or the evidence directory.
  const credentials = {
    ...(standIns.provider === "deterministic" ? {} : { OPENCODE_GO_API_KEY: profileValue("SAYHEAR_VERIFY_PROVIDER_ENV", "OPENCODE_GO_API_KEY") }),
    ...(realOAuth
      ? { GITHUB_CLIENT_ID: profileValue("SAYHEAR_VERIFY_OAUTH_ENV", "GITHUB_CLIENT_ID"), GITHUB_CLIENT_SECRET: profileValue("SAYHEAR_VERIFY_OAUTH_ENV", "GITHUB_CLIENT_SECRET") }
      : { GITHUB_CLIENT_ID: "synthetic-verification-client", GITHUB_CLIENT_SECRET: "synthetic-verification-secret" }),
  };
  const ownerSubject = standIns.owner === "configured" ? profileValue("SAYHEAR_VERIFY_OAUTH_ENV", "SAYHEAR_INTERNAL_OWNER_SUBJECT") : "synthetic-verification-owner";
  const prepared = { pgBin: postgresBin(), pgPort: await freePort(), origin, commit: run("git", ["rev-parse", "HEAD"], { cwd: root }).trim(), sourceStatus: run("git", ["status", "--short"], { cwd: root }).trim() };
  mkdirSync(evidence, { recursive: true });
  const scratch = mkdtempSync(join(tmpdir(), "sayhear-verify-"));
  const state = { runId, root, scratch, ...prepared, profile, standIns, sessionToken: randomBytes(32).toString("hex"), scannerSecret: randomBytes(32).toString("hex"), ownerId: "01984477-31e1-7595-92c6-06889cb0fdde", cleaned: false };
  // `fixed` freezes the clock, `real` lets exchanges end by wall time, and
  // `controllable` does both: the driver freezes it and advances it by hand.
  const freezesClock = standIns.clock === "fixed";
  const endsExchangesByTime = standIns.clock !== "fixed";
  if (endsExchangesByTime) state.inactivityTimeoutMs = SHORT_INACTIVITY_MS;
  if (standIns.clock === "controllable") {
    // The driver rewrites this file between requests; the runtime re-reads it
    // on every clock call. Do not also set the static SAYHEAR_TEST_NOW value.
    state.testNowInitial = FIXED_NOW;
    state.testNowFile = join(evidence, "test-clock.txt");
    writeFileSync(state.testNowFile, `${FIXED_NOW}\n`);
  }
  if (standIns.providerFault === "file") {
    // A missing or empty file means no fault injection; the journey writes a
    // chunk ceiling to interrupt one response and empties it before the retry.
    state.providerFaultFile = join(evidence, "provider-fault.txt");
  }
  save("instance.json", state);
  try {
    const source = join(scratch, "source");
    mkdirSync(source);
    for (const entry of readdirSync(root)) {
      if (["apps", "packages", "eval", "scripts"].includes(entry) || /^(package\.json|pnpm-.*\.yaml|tsconfig.*\.json)$/.test(entry)) {
        cpSync(join(root, entry), join(source, entry), { recursive: true, filter: (path) => !["node_modules", ".next", ".vercel", "dist", "run"].includes(path.split("/").at(-1)) && !path.split("/").at(-1).startsWith(".env") });
      }
    }
    // Preserve pnpm's relative workspace links inside the snapshot. Turbopack
    // rejects dependencies symlinked outside its workspace root.
    for (const directory of ["", "apps/web", ...readdirSync(join(root, "packages")).map((name) => `packages/${name}`)]) {
      if (existsSync(join(root, directory, "node_modules"))) cpSync(join(root, directory, "node_modules"), join(source, directory, "node_modules"), { recursive: true, verbatimSymlinks: true, mode: constants.COPYFILE_FICLONE });
    }
    run(join(state.pgBin, "initdb"), ["-D", join(scratch, "pgdata"), "-U", "verify", "-A", "trust", "--no-locale", "--encoding=UTF8"]);
    run(join(state.pgBin, "pg_ctl"), ["-D", join(scratch, "pgdata"), "-l", join(evidence, "postgres.log"), "-o", `-h 127.0.0.1 -p ${state.pgPort} -k ${scratch}`, "-w", "start"]);
    for (const name of ["business", "marker"]) run(join(state.pgBin, "createdb"), ["-h", "127.0.0.1", "-p", String(state.pgPort), "-U", "verify", name]);
    const env = {
      PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: process.env.TMPDIR, NODE_ENV: "development", NEXT_TELEMETRY_DISABLED: "1",
      DATABASE_URL: `postgresql://verify@127.0.0.1:${state.pgPort}/business`, PURGE_MARKER_DATABASE_URL: `postgresql://verify@127.0.0.1:${state.pgPort}/marker`,
      NEXTAUTH_URL: state.origin, NEXTAUTH_SECRET: randomBytes(32).toString("hex"), SAYHEAR_AUTH_SECRET_SOURCE: "managed", SAYHEAR_DEPLOYMENT: "test",
      SAYHEAR_BACKUP_CONFIGURATION_FINGERPRINT: "sha256:local-verification-fixture", SAYHEAR_BACKUP_POLICY_VERSION: "local-verification:v1",
      SAYHEAR_CONTEXT_HMAC_SECRET: randomBytes(32).toString("hex"), CRON_SECRET: state.scannerSecret, SAYHEAR_EPISODE_BUILD_ENABLED: "false", SAYHEAR_REFLECTION_ENABLED: "false",
      ...(endsExchangesByTime
        ? { SAYHEAR_INACTIVITY_TIMEOUT_MS: String(SHORT_INACTIVITY_MS), SAYHEAR_INACTIVITY_POLICY_VERSION: "continuous-exchange-inactivity:verify-short" }
        : {}),
      ...(freezesClock
        ? { SAYHEAR_TEST_NOW: FIXED_NOW }
        : {}),
      ...(standIns.clock === "controllable"
        ? { SAYHEAR_TEST_NOW_FILE: state.testNowFile }
        : {}),
      ...(standIns.provider === "deterministic"
        ? { SAYHEAR_PROVIDER_ADAPTER: "deterministic", SAYHEAR_CONVERSATION_TEXT_MODEL: "gpt-5.4", SAYHEAR_CONVERSATION_TEXT_MODEL_SNAPSHOT: "gpt-5.4", SAYHEAR_TEST_PROVIDER_CHUNKS: JSON.stringify(["Synthetic verification reply. ", "Your message was received."]) }
        : { SAYHEAR_PROVIDER_ADAPTER: standIns.provider }),
      ...(standIns.providerFault === "file"
        ? { SAYHEAR_TEST_PROVIDER_FAIL_AFTER_CHUNKS_FILE: state.providerFaultFile }
        : {}),
      ...credentials,
    };
    // Next 16 flushes telemetry in a detached process even when disabled. Debug
    // mode keeps that flush synchronous and logs metadata instead of sending it.
    env.NEXT_TELEMETRY_DEBUG = "1";
    const fixture = run(process.execPath, ["--import", "tsx", join(source, "scripts/verify-fixture.mjs"), statePath], { cwd: source, env: { ...env, SAYHEAR_VERIFY_OWNER_SUBJECT: ownerSubject } });
    writeFileSync(join(evidence, "fixture.log"), fixture);
    const log = openSync(join(evidence, "next.log"), "a");
    const child = spawn(process.execPath, [join(source, "apps/web/node_modules/next/dist/bin/next"), "dev", "--hostname", hostname, "--port", port], { cwd: join(source, "apps/web"), env, detached: true, stdio: ["ignore", log, log] });
    await new Promise((done, fail) => { child.once("spawn", done); child.once("error", fail); });
    state.webPid = child.pid;
    state.webStarted = childStart(child.pid);
    save("instance.json", state);
    child.unref();
    for (let attempt = 0; attempt < 180; attempt++) {
      assert(childStart(child.pid), `Next exited; inspect ${evidence}/next.log`);
      let ready = false;
      try {
        const response = await fetch(state.origin + "/api/internal/access", { signal: AbortSignal.timeout(1000) });
        ready = response.status === 401;
      } catch {}
      if (ready) { await doctor(state); return; }
      await pause();
    }
    throw new Error(`Next did not become usable; inspect ${evidence}/next.log`);
  } catch (error) {
    save("launch-error.json", { error: error.message });
    await cleanup(state);
    throw error;
  }
}

if (command === "launch") await launch();
else if (command === "doctor") await doctor(readState());
else if (command === "cleanup") { await cleanup(readState()); console.log(`Cleaned ${runId}; evidence remains at ${evidence}`); }
else if (command === "drive") {
  const state = readState();
  try {
    await doctor(state);
    run(process.execPath, [join(root, "scripts/verify-browser.mjs"), statePath, option ?? "text"], { stdio: "inherit", timeout: 1_500_000 });
  } catch (error) { await cleanup(state); throw error; }
} else throw new Error("Use launch, doctor, drive or cleanup.");

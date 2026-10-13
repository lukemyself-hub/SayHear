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
const [command, runId] = process.argv.slice(2);
assert(runId && /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(runId), "Supply a unique run ID (letters, numbers, hyphens, underscores).");
const evidence = join(root, "artifacts/verify", runId);
const statePath = join(evidence, "instance.json");
const pause = () => new Promise((done) => setTimeout(done, 250));
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
  rmSync(state.scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  state.cleaned = true;
  save("instance.json", state);
  save("cleanup.json", { cleaned: true, scratchRemoved: !existsSync(state.scratch), evidenceRetained: existsSync(statePath), at: new Date().toISOString() });
}

async function doctor(state) {
  assert(!state.cleaned, "Instance has been cleaned. Launch a new run.");
  assert.equal(childStart(state.webPid), state.webStarted, "Owned Next process is not running.");
  assert.equal(run("git", ["rev-parse", "HEAD"], { cwd: root }).trim(), state.commit, "Checkout HEAD changed since launch; launch a fresh run.");
  const request = async (path, authenticated = false) => {
    const response = await fetch(state.origin + path, { headers: authenticated ? { cookie: `sayhear.session-token=${state.sessionToken}` } : {}, redirect: "manual", signal: AbortSignal.timeout(30_000) });
    return { status: response.status, body: await response.text() };
  };
  const anonymous = await request("/api/internal/access");
  assert.equal(anonymous.status, 401);
  const access = await request("/api/internal/access", true);
  assert.equal(access.status, 200);
  assert.equal(JSON.parse(access.body).privateWrites.allowed, true);
  const page = await request("/internal", true);
  assert.equal(page.status, 200);
  assert(page.body.includes('id="user-text"'), "The real composer is missing.");
  const report = { runId, origin: state.origin, commit: state.commit, sourceStatus: state.sourceStatus, deployment: "test", provider: "deterministic", ownerFixture: true, authenticatedStatus: access.status, anonymousStatus: anonymous.status, composerPresent: true, businessMigrations: Number(sql(state, "SELECT count(*) FROM schema_migrations")), markerMigrations: Number(sql(state, "SELECT count(*) FROM schema_migrations", true)) };
  save("doctor.json", report);
  console.log(JSON.stringify(report, null, 2));
}

async function launch() {
  assert(!existsSync(statePath), "Run ID already exists; keep old evidence and use a new ID.");
  assert(existsSync(join(root, "node_modules/.bin/tsx")), "Run pnpm install --frozen-lockfile first.");
  const prepared = { pgBin: postgresBin(), pgPort: await freePort(), origin: `http://127.0.0.1:${await freePort()}`, commit: run("git", ["rev-parse", "HEAD"], { cwd: root }).trim(), sourceStatus: run("git", ["status", "--short"], { cwd: root }).trim() };
  mkdirSync(evidence, { recursive: true });
  const scratch = mkdtempSync(join(tmpdir(), "sayhear-verify-"));
  const state = { runId, root, scratch, ...prepared, sessionToken: randomBytes(32).toString("hex"), ownerId: "01984477-31e1-7595-92c6-06889cb0fdde", cleaned: false };
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
    const env = { PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: process.env.TMPDIR, NODE_ENV: "development", NEXT_TELEMETRY_DISABLED: "1", DATABASE_URL: `postgresql://verify@127.0.0.1:${state.pgPort}/business`, PURGE_MARKER_DATABASE_URL: `postgresql://verify@127.0.0.1:${state.pgPort}/marker`, NEXTAUTH_URL: state.origin, NEXTAUTH_SECRET: randomBytes(32).toString("hex"), GITHUB_CLIENT_ID: "synthetic-verification-client", GITHUB_CLIENT_SECRET: "synthetic-verification-secret", SAYHEAR_AUTH_SECRET_SOURCE: "managed", SAYHEAR_DEPLOYMENT: "test", SAYHEAR_BACKUP_CONFIGURATION_FINGERPRINT: "sha256:local-verification-fixture", SAYHEAR_BACKUP_POLICY_VERSION: "local-verification:v1", SAYHEAR_CONTEXT_HMAC_SECRET: randomBytes(32).toString("hex"), CRON_SECRET: randomBytes(32).toString("hex"), SAYHEAR_PROVIDER_ADAPTER: "deterministic", SAYHEAR_CONVERSATION_TEXT_MODEL: "gpt-5.4", SAYHEAR_CONVERSATION_TEXT_MODEL_SNAPSHOT: "gpt-5.4", SAYHEAR_TEST_PROVIDER_CHUNKS: JSON.stringify(["Synthetic verification reply. ", "Your message was received."]), SAYHEAR_TEST_NOW: "2026-07-27T16:00:00.000Z", SAYHEAR_EPISODE_BUILD_ENABLED: "false", SAYHEAR_REFLECTION_ENABLED: "false" };
    // Next 16 flushes telemetry in a detached process even when disabled. Debug
    // mode keeps that flush synchronous and logs metadata instead of sending it.
    env.NEXT_TELEMETRY_DEBUG = "1";
    const fixture = run(process.execPath, ["--import", "tsx", join(source, "scripts/verify-fixture.mjs"), statePath], { cwd: source, env });
    writeFileSync(join(evidence, "fixture.log"), fixture);
    const log = openSync(join(evidence, "next.log"), "a");
    const child = spawn(process.execPath, [join(source, "apps/web/node_modules/next/dist/bin/next"), "dev", "--hostname", "127.0.0.1", "--port", new URL(state.origin).port], { cwd: join(source, "apps/web"), env, detached: true, stdio: ["ignore", log, log] });
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
    run(process.execPath, [join(root, "scripts/verify-browser.mjs"), statePath, process.argv[4] ?? "text"], { stdio: "inherit", timeout: 180_000 });
  } catch (error) { await cleanup(state); throw error; }
} else throw new Error("Use launch, doctor, drive or cleanup.");

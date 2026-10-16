/**
 * Per-repository+PR single-writer execution ownership.
 *
 * Foundational leaf for SPEC #362 follow-ups (#366/#368), NOT full ticket
 * delivery. This module keeps exactly one writer per repository+PR in a small
 * versioned JSON record per repo/PR, inside a user-owned directory outside the
 * source tree. It is deliberately isolated from approval: no approval/merge
 * authority, no CI/gate duplication, no signatures, no App keys.
 *
 * Round/pause authority lives ONLY in the controller's trusted App markers.
 * This leaf keeps no round ledger, no review history, and no pause flag. A
 * caller-read ledger snapshot (`TrustedLedger`) is passed into `reserveWork`,
 * which refuses a new reservation of any role while the ledger is paused,
 * inconsistent, or exhausted. The ledger is never persisted here as authority.
 *
 * Every operation that needs to know whether an old worker is gone takes an
 * explicit caller-supplied `probeWorker` capability
 * (`running` | `stopped` | `unknown`). There is no implicit default: without
 * fresh stopped proof, release/accept are denied, and an ambiguous old result
 * never starts a second writer. The production service adapter and CLI arrive
 * in a later leaf.
 *
 * Persistence rules:
 * - state directory is a configured absolute path outside the source tree,
 *   mode 0700; record files are mode 0600, written atomically via temp+rename;
 *   sizes are measured in bytes, and oversize writes are refused structurally.
 * - only short read-modify-write process locks (per-record `<file>.lock/`
 *   directories with pid+nonce owner metadata). Never a worker-lifetime lock.
 * - a crashed short-lock holder is reclaimed only when its process is
 *   conclusively absent (`kill(pid, 0)` says ESRCH) AND its nonce still matches
 *   under a reclaim guard. No TTL, no timestamps. A lock without complete
 *   owner metadata stays unknown/occupied. Concurrent calls: one wins.
 * - fail closed on corrupt records, malformed identity, symlinks, or ambiguous
 *   locks. State is never deleted on failure.
 *
 * Deployment constraints and manual recovery:
 * - Single-writer safety assumes a local filesystem (atomic mkdir/rename) and
 *   one shared PID namespace, so ESRCH conclusively means the lock holder is
 *   dead. Do not place the state directory on shared storage or span it
 *   across containers; ESRCH stops being proof there.
 * - A SIGKILL between the lock `mkdir` and the owner `rename` leaves a
 *   metadata-less lock directory that is never auto-reclaimed (fail closed).
 *   Likewise a reclaimer killed while holding `${lock}.reclaim` leaves the
 *   guard behind, so later dead-lock reclaims for that PR wedge as
 *   `lock_unknown`. Both need a human to confirm no holder process exists and
 *   then `rm -rf` the stale `<record>.lock` (or `<record>.lock.reclaim`)
 *   directory. Never remove a lock whose owner pid may still be alive.
 */

import { randomBytes, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
  lstat,
  mkdir,
  open,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

export type WorkRole = "implementation" | "code-review";
export type WorkPhase = "reserved" | "running" | "verifying";
export type FindingStatus = "confirmed" | "refuted" | "disputed";
export type WorkerProbe = "running" | "stopped" | "unknown";

/** Caller-supplied external liveness check for the recorded worker owner. */
export type ProbeWorker = (
  owner: WorkOwnerSnapshot,
) => Promise<WorkerProbe>;

export interface WorkIdentity {
  repositoryId: number;
  pullRequestNumber: number;
}

export interface WorkOwnerSnapshot {
  token: string;
  role: WorkRole;
  sessionId: string | null;
  /** Fencing generation: 0 at reserve, +1 on every successful attach. */
  generation: number;
  startHead: string;
  scopeDigest: string;
  changeDigest: string;
  worktree: string;
  taskFile: string;
  workerStateDir: string | null;
  model: string | null;
}

export interface WorkFinding {
  key: string;
  status: FindingStatus;
  evidence: string;
  repairDirective: string | null;
  /** True once a fix from an implementation owner covered this finding. */
  fixedAccepted: boolean;
  /** Sticky: this confirmed key reappeared after its fix was accepted. */
  repeatedAfterFix: boolean;
}

export interface SeenSession {
  id: string;
  role: WorkRole;
  /** Worker model bound when the session attached (receipt model + variant), or null if unrecorded. */
  model: string | null;
}

export interface WorkRecord extends WorkIdentity {
  version: 1;
  owner: WorkOwnerSnapshot | null;
  phase: WorkPhase;
  findings: WorkFinding[];
  /** Every session ever attached for this PR with the role that used it; bounded, fail closed. */
  seenSessions: SeenSession[];
}

/**
 * Caller-read snapshot of the controller's trusted round/pause ledger. This
 * leaf never persists it as authority; it only refuses new reservations while
 * the ledger says the PR may not take another writer. `latestReviewedHead`
 * binds an implementation round to the controller's latest request-changes
 * marker: null when no request-changes round is recorded yet, otherwise the
 * exact 40-char head that round reviewed.
 */
export interface TrustedLedger {
  roundsConsumed: number;
  paused: boolean;
  historyConsistent: boolean;
  latestReviewedHead: string | null;
}

export interface ReserveInput extends WorkIdentity {
  role: WorkRole;
  startHead: string;
  scopeDigest: string;
  changeDigest: string;
  worktree: string;
  taskFile: string;
  workerStateDir?: string | null;
  model?: string | null;
  ledger: TrustedLedger;
}

export interface AttachInput extends WorkIdentity {
  ownerToken: string;
  startHead: string;
  scopeDigest: string;
  role: WorkRole;
  sessionId: string;
  workerStateDir?: string | null;
  model?: string | null;
}

export interface ReleaseInput extends WorkIdentity {
  /** Omitted for crash-gap recovery; then any owner needs stopped proof. */
  ownerToken?: string;
}

export interface AcceptInput extends WorkIdentity {
  ownerToken: string;
  sessionId: string;
  startHead: string;
  scopeDigest: string;
  liveHead: string;
  liveChangeDigest?: string | null;
}

export interface FindingInput extends WorkIdentity {
  ownerToken: string;
  key: string;
  status: FindingStatus;
  evidence: string;
  repairDirective?: string | null;
}

export type CorruptReason = "corrupt" | "untrusted";

export type ReserveResult =
  | { ok: true; record: WorkRecord }
  | {
      ok: false;
      reason:
        | "paused"
        | "history_inconsistent"
        | "rounds_exhausted"
        | "review_not_recorded"
        | "repeated_finding"
        | "occupied"
        | "too_large"
        | CorruptReason;
      record: WorkRecord | null;
    };

export type AttachResult =
  | { ok: true; record: WorkRecord; resumed: boolean }
  | {
      ok: false;
      reason:
        | "not_found"
        | "token_mismatch"
        | "head_mismatch"
        | "scope_mismatch"
        | "role_mismatch"
        | "state_mismatch"
        | "session_conflict"
        | "model_changed"
        | "stale_review_session"
        | "history_full"
        | "too_large"
        | CorruptReason;
      record: WorkRecord | null;
    };

export type ReleaseResult =
  | { ok: true; record: WorkRecord | null; released: boolean }
  | {
      ok: false;
      reason:
        | "token_mismatch"
        | "worker_running"
        | "worker_unknown"
        | "too_large"
        | CorruptReason;
      record: WorkRecord | null;
    };

export type AcceptResult =
  | { ok: true; record: WorkRecord }
  | {
      ok: false;
      reason:
        | "not_found"
        | "token_mismatch"
        | "session_mismatch"
        | "start_head_mismatch"
        | "scope_mismatch"
        | "live_head_mismatch"
        | "worker_running"
        | "worker_unknown"
        | "too_large"
        | CorruptReason;
      record: WorkRecord | null;
    };

export type FindingResult =
  | { ok: true; record: WorkRecord; repeated: boolean }
  | {
      ok: false;
      reason:
        | "not_found"
        | "token_mismatch"
        | "too_large"
        | CorruptReason;
      record: WorkRecord | null;
    };

const RECORD_VERSION = 1 as const;
const MAX_ROUNDS = 3;
const MAX_RECORD_BYTES = 64_000;
const KEY_MAX = 128;
const EVIDENCE_MAX = 24_000;
const REPAIR_MAX = 8_000;
const SESSION_MAX = 256;
const MODEL_MAX = 128;
const PATH_MAX = 1_024;
const MAX_FINDINGS = 64;
const MAX_SESSION_IDS = 64;
const LOCK_SETTLE_LIMIT = 200;

const REPOSITORY_ROOT = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
);

export class PrWorkCoordinationError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "PrWorkCoordinationError";
    this.code = code;
  }
}

function errorCode(error: unknown): string | null {
  if (typeof error === "object" && error !== null && "code" in error) {
    const code = (error as { code?: unknown }).code;
    return typeof code === "string" ? code : null;
  }
  return null;
}

function corruptReason(error: unknown): CorruptReason | null {
  if (!(error instanceof PrWorkCoordinationError)) return null;
  if (error.code === "record_corrupt") return "corrupt";
  if (error.code === "record_untrusted") return "untrusted";
  return null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((done) => setTimeout(done, ms));
}

// --- input validation (single table of small validators) ---

function positiveInteger(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    throw new PrWorkCoordinationError(
      "input_invalid",
      `${name} must be a positive safe integer.`,
    );
  }
  return value;
}

function nonNegativeInteger(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new PrWorkCoordinationError(
      "input_invalid",
      `${name} must be a non-negative safe integer.`,
    );
  }
  return value;
}

function flag(value: unknown, name: string): boolean {
  if (typeof value !== "boolean") {
    throw new PrWorkCoordinationError(
      "input_invalid",
      `${name} must be a boolean.`,
    );
  }
  return value;
}

function hex(value: unknown, length: number, name: string): string {
  if (typeof value !== "string") {
    throw new PrWorkCoordinationError(
      "input_invalid",
      `${name} must be a ${length}-character hex string.`,
    );
  }
  const normalized = value.toLowerCase();
  if (normalized.length !== length || !/^[0-9a-f]+$/.test(normalized)) {
    throw new PrWorkCoordinationError(
      "input_invalid",
      `${name} must be a ${length}-character hex string.`,
    );
  }
  return normalized;
}

function text(value: unknown, name: string, max: number): string {
  if (typeof value !== "string" || value.length === 0 || value.length > max) {
    throw new PrWorkCoordinationError(
      "input_invalid",
      `${name} must be 1-${max} characters.`,
    );
  }
  return value;
}

function absolutePath(value: unknown, name: string): string {
  const raw = text(value, name, PATH_MAX);
  if (!isAbsolute(raw)) {
    throw new PrWorkCoordinationError(
      "input_invalid",
      `${name} must be an absolute path.`,
    );
  }
  return raw;
}

function optionalAbsolutePath(value: unknown, name: string): string | null {
  if (value === undefined || value === null) return null;
  return absolutePath(value, name);
}

function optionalText(
  value: unknown,
  name: string,
  max: number,
): string | null {
  if (value === undefined || value === null) return null;
  return text(value, name, max);
}

function checkIdentity(identity: WorkIdentity): {
  repositoryId: number;
  pullRequestNumber: number;
} {
  return {
    repositoryId: positiveInteger(identity.repositoryId, "repositoryId"),
    pullRequestNumber: positiveInteger(
      identity.pullRequestNumber,
      "pullRequestNumber",
    ),
  };
}

function checkRole(value: unknown): WorkRole {
  if (value !== "implementation" && value !== "code-review") {
    throw new PrWorkCoordinationError(
      "input_invalid",
      `role must be "implementation" or "code-review".`,
    );
  }
  return value;
}

function checkFindingStatus(value: unknown): FindingStatus {
  if (value !== "confirmed" && value !== "refuted" && value !== "disputed") {
    throw new PrWorkCoordinationError(
      "input_invalid",
      "finding status must be confirmed, refuted, or disputed.",
    );
  }
  return value;
}

function checkLedger(value: unknown): TrustedLedger {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new PrWorkCoordinationError(
      "input_invalid",
      "ledger must be the controller's trusted ledger snapshot.",
    );
  }
  const ledger = value as Record<string, unknown>;
  const latestReviewedHead = ledger.latestReviewedHead;
  if (latestReviewedHead === undefined) {
    throw new PrWorkCoordinationError(
      "input_invalid",
      "ledger.latestReviewedHead is required.",
    );
  }
  return {
    roundsConsumed: nonNegativeInteger(ledger.roundsConsumed, "ledger.roundsConsumed"),
    paused: flag(ledger.paused, "ledger.paused"),
    historyConsistent: flag(ledger.historyConsistent, "ledger.historyConsistent"),
    latestReviewedHead:
      latestReviewedHead === null
        ? null
        : hex(latestReviewedHead, 40, "ledger.latestReviewedHead"),
  };
}

export class PrWorkCoordinationStore {
  readonly #stateDir: string;

  constructor(options: { stateDir: string }) {
    const raw = options?.stateDir;
    if (typeof raw !== "string" || raw.length === 0 || !isAbsolute(raw)) {
      throw new PrWorkCoordinationError(
        "state_directory_invalid",
        "stateDir must be a configured absolute directory outside the source tree.",
      );
    }
    const resolved = resolve(raw);
    for (const root of [REPOSITORY_ROOT, resolve(process.cwd())]) {
      if (resolved === root || resolved.startsWith(root + sep)) {
        throw new PrWorkCoordinationError(
          "state_directory_inside_source",
          "stateDir must live outside the source checkout.",
        );
      }
    }
    this.#stateDir = resolved;
  }

  get stateDir(): string {
    return this.#stateDir;
  }

  recordPath(repositoryId: number, pullRequestNumber: number): string {
    const repo = positiveInteger(repositoryId, "repositoryId");
    const pr = positiveInteger(pullRequestNumber, "pullRequestNumber");
    return resolve(this.#stateDir, `repo-${repo}-pr-${pr}.json`);
  }
}

async function assertStateDirectory(stateDir: string): Promise<void> {
  await mkdir(stateDir, { recursive: true, mode: 0o700 });
  const info = await lstat(stateDir);
  if (
    !info.isDirectory() ||
    info.isSymbolicLink() ||
    info.uid !== process.getuid?.() ||
    (info.mode & 0o077) !== 0
  ) {
    throw new PrWorkCoordinationError(
      "state_directory_untrusted",
      "Work state directory is not a user-owned 0700 directory.",
    );
  }
  let parent = dirname(stateDir);
  while (parent !== dirname(parent)) {
    const parentInfo = await lstat(parent);
    if (
      !parentInfo.isDirectory() ||
      parentInfo.isSymbolicLink() ||
      ((parentInfo.mode & 0o022) !== 0 &&
        (parentInfo.mode & 0o1000) === 0) ||
      (parentInfo.uid !== 0 && parentInfo.uid !== process.getuid?.())
    ) {
      throw new PrWorkCoordinationError(
        "state_directory_untrusted",
        "Work state directory parent chain is untrusted.",
      );
    }
    parent = dirname(parent);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function corrupt(message: string): PrWorkCoordinationError {
  return new PrWorkCoordinationError("record_corrupt", message);
}

// --- strict record parsing: every field validated, fail closed ---

function parseOwner(value: unknown): WorkOwnerSnapshot | null {
  if (value === null) return null;
  if (!isRecord(value)) throw corrupt("owner must be an object or null.");
  const token = value.token;
  if (typeof token !== "string" || token.toLowerCase() !== token || !/^[0-9a-f]{32}$/.test(token)) {
    throw corrupt("owner token is malformed.");
  }
  const role = value.role;
  if (role !== "implementation" && role !== "code-review") {
    throw corrupt("owner role is malformed.");
  }
  const sessionId = value.sessionId;
  if (
    sessionId !== null &&
    (typeof sessionId !== "string" ||
      sessionId.length === 0 ||
      sessionId.length > SESSION_MAX)
  ) {
    throw corrupt("owner sessionId is malformed.");
  }
  for (const [field, length] of [
    ["startHead", 40],
    ["scopeDigest", 64],
    ["changeDigest", 64],
  ] as const) {
    const entry = value[field];
    if (
      typeof entry !== "string" ||
      entry.length !== length ||
      entry.toLowerCase() !== entry ||
      !/^[0-9a-f]+$/.test(entry)
    ) {
      throw corrupt(`owner ${field} is malformed.`);
    }
  }
  const generation = value.generation;
  if (
    typeof generation !== "number" ||
    !Number.isSafeInteger(generation) ||
    generation < 0
  ) {
    throw corrupt("owner generation is malformed.");
  }
  const worktree = value.worktree;
  const taskFile = value.taskFile;
  if (
    typeof worktree !== "string" ||
    worktree.length === 0 ||
    worktree.length > PATH_MAX ||
    !isAbsolute(worktree) ||
    typeof taskFile !== "string" ||
    taskFile.length === 0 ||
    taskFile.length > PATH_MAX ||
    !isAbsolute(taskFile)
  ) {
    throw corrupt("owner worktree/taskFile must be absolute paths.");
  }
  const workerStateDir = value.workerStateDir;
  if (
    workerStateDir !== null &&
    (typeof workerStateDir !== "string" ||
      workerStateDir.length === 0 ||
      workerStateDir.length > PATH_MAX ||
      !isAbsolute(workerStateDir))
  ) {
    throw corrupt("owner workerStateDir is malformed.");
  }
  const model = value.model;
  if (
    model !== null &&
    (typeof model !== "string" ||
      model.length === 0 ||
      model.length > MODEL_MAX)
  ) {
    throw corrupt("owner model is malformed.");
  }
  return {
    token,
    role,
    sessionId,
    generation,
    startHead: value.startHead as string,
    scopeDigest: value.scopeDigest as string,
    changeDigest: value.changeDigest as string,
    worktree,
    taskFile,
    workerStateDir,
    model,
  };
}

function parseWorkRecord(value: unknown, identity: WorkIdentity): WorkRecord {
  if (!isRecord(value)) throw corrupt("record must be a JSON object.");
  if (value.version !== RECORD_VERSION) {
    throw corrupt("record version is unsupported.");
  }
  if (value.repositoryId !== identity.repositoryId) {
    throw corrupt("record repositoryId does not match its path.");
  }
  if (value.pullRequestNumber !== identity.pullRequestNumber) {
    throw corrupt("record pullRequestNumber does not match its path.");
  }
  const phase = value.phase;
  if (phase !== "reserved" && phase !== "running" && phase !== "verifying") {
    throw corrupt("record phase is malformed.");
  }
  const findings = value.findings;
  if (!Array.isArray(findings) || findings.length > MAX_FINDINGS) {
    throw corrupt("record findings are malformed.");
  }
  const seenKeys = new Set<string>();
  const parsedFindings: WorkFinding[] = [];
  for (const finding of findings) {
    if (!isRecord(finding)) throw corrupt("record finding is malformed.");
    const allowed = new Set([
      "key",
      "status",
      "evidence",
      "repairDirective",
      "fixedAccepted",
      "repeatedAfterFix",
    ]);
    for (const field of Object.keys(finding)) {
      if (!allowed.has(field)) throw corrupt("record finding has unknown fields.");
    }
    if (
      typeof finding.key !== "string" ||
      finding.key.length === 0 ||
      finding.key.length > KEY_MAX ||
      (finding.status !== "confirmed" &&
        finding.status !== "refuted" &&
        finding.status !== "disputed") ||
      typeof finding.evidence !== "string" ||
      finding.evidence.length === 0 ||
      finding.evidence.length > EVIDENCE_MAX ||
      (finding.repairDirective !== null &&
        (typeof finding.repairDirective !== "string" ||
          finding.repairDirective.length === 0 ||
          finding.repairDirective.length > REPAIR_MAX)) ||
      typeof finding.fixedAccepted !== "boolean" ||
      typeof finding.repeatedAfterFix !== "boolean"
    ) {
      throw corrupt("record finding is malformed.");
    }
    if (seenKeys.has(finding.key as string)) {
      throw corrupt("record findings have duplicate keys.");
    }
    seenKeys.add(finding.key as string);
    parsedFindings.push({
      key: finding.key as string,
      status: finding.status as WorkFinding["status"],
      evidence: finding.evidence as string,
      repairDirective: finding.repairDirective as string | null,
      fixedAccepted: finding.fixedAccepted as boolean,
      repeatedAfterFix: finding.repeatedAfterFix as boolean,
    });
  }
  const seenSessions = value.seenSessions;
  if (!Array.isArray(seenSessions) || seenSessions.length > MAX_SESSION_IDS) {
    throw corrupt("record seenSessions are malformed.");
  }
  const sessionSet = new Set<string>();
  const parsedSessions: SeenSession[] = [];
  for (const session of seenSessions) {
    if (!isRecord(session)) throw corrupt("record seenSessions are malformed.");
    const allowedSession = new Set(["id", "role", "model"]);
    for (const field of Object.keys(session)) {
      if (!allowedSession.has(field)) throw corrupt("record seenSessions are malformed.");
    }
    const id = session.id;
    const sessionRole = session.role;
    const sessionModel = session.model;
    if (
      typeof id !== "string" ||
      id.length === 0 ||
      id.length > SESSION_MAX ||
      (sessionRole !== "implementation" && sessionRole !== "code-review") ||
      sessionSet.has(id) ||
      (sessionModel !== undefined &&
        sessionModel !== null &&
        (typeof sessionModel !== "string" ||
          sessionModel.length === 0 ||
          sessionModel.length > MODEL_MAX))
    ) {
      throw corrupt("record seenSessions are malformed.");
    }
    sessionSet.add(id);
    parsedSessions.push({
      id,
      role: sessionRole,
      model: (sessionModel ?? null) as string | null,
    });
  }
  return {
    version: RECORD_VERSION,
    repositoryId: identity.repositoryId,
    pullRequestNumber: identity.pullRequestNumber,
    owner: parseOwner(value.owner),
    phase,
    findings: parsedFindings,
    seenSessions: parsedSessions,
  };
}

function recordByteLength(record: WorkRecord): number {
  return Buffer.byteLength(JSON.stringify(record));
}

async function readRecordFile(
  stateDir: string,
  recordPath: string,
  identity: WorkIdentity,
): Promise<WorkRecord | null> {
  await assertStateDirectory(stateDir);
  let handle;
  try {
    handle = await open(recordPath, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    if (errorCode(error) === "ENOENT") return null;
    if (errorCode(error) === "ELOOP") {
      throw new PrWorkCoordinationError(
        "record_untrusted",
        "Work record path is a symlink.",
      );
    }
    throw error;
  }
  try {
    const info = await handle.stat();
    if (
      !info.isFile() ||
      info.uid !== process.getuid?.() ||
      (info.mode & 0o077) !== 0 ||
      info.size > MAX_RECORD_BYTES
    ) {
      throw new PrWorkCoordinationError(
        "record_untrusted",
        "Work record file is untrusted.",
      );
    }
    const buffer = Buffer.alloc(MAX_RECORD_BYTES + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    if (bytesRead > MAX_RECORD_BYTES) {
      throw new PrWorkCoordinationError(
        "record_untrusted",
        "Work record file is untrusted.",
      );
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(buffer.subarray(0, bytesRead).toString("utf8"));
    } catch {
      throw corrupt("Work record is not valid JSON.");
    }
    return parseWorkRecord(parsed, identity);
  } finally {
    await handle.close();
  }
}

async function writeRecordFile(
  stateDir: string,
  recordPath: string,
  record: WorkRecord,
  identity: WorkIdentity,
): Promise<void> {
  await assertStateDirectory(stateDir);
  // Validate shape before writing so a bug can never persist an unreadable
  // record, then enforce the byte budget on every write path.
  parseWorkRecord(JSON.parse(JSON.stringify(record)) as unknown, identity);
  if (recordByteLength(record) > MAX_RECORD_BYTES) {
    throw new PrWorkCoordinationError(
      "record_too_large",
      "Work record exceeds the byte budget.",
    );
  }
  const temporary = `${recordPath}.${randomUUID()}.tmp`;
  const handle = await open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(JSON.stringify(record));
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await rename(temporary, recordPath);
    const directoryHandle = await open(stateDir, "r");
    try {
      await directoryHandle.sync();
    } finally {
      await directoryHandle.close();
    }
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined);
  }
}

// --- short process lock with guarded reclaim (P1-1) ---

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means the process exists but belongs to someone else. Any error
    // other than conclusive absence keeps the lock occupied (fail closed).
    return errorCode(error) !== "ESRCH";
  }
}

interface LockOwnerMeta {
  pid: number;
  nonce: string;
}

async function readLockOwner(ownerFile: string): Promise<LockOwnerMeta | null> {
  let raw: string;
  try {
    raw = await readFile(ownerFile, "utf8");
  } catch {
    return null;
  }
  let meta: unknown;
  try {
    meta = JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
  if (
    !isRecord(meta) ||
    typeof meta.pid !== "number" ||
    !Number.isInteger(meta.pid) ||
    typeof meta.nonce !== "string" ||
    meta.nonce.length === 0
  ) {
    return null;
  }
  return { pid: meta.pid, nonce: meta.nonce };
}

/**
 * Try to reclaim a lock whose holder is conclusively absent. The reclaim
 * guard serializes concurrent reclaimers; the owner is re-read under the
 * guard and removed only when the nonce still matches the dead holder, so a
 * contender can never delete a freshly installed lock.
 */
async function tryReclaimLock(
  lockDir: string,
  seen: LockOwnerMeta,
): Promise<boolean> {
  const guard = `${lockDir}.reclaim`;
  try {
    await mkdir(guard);
  } catch (error) {
    if (errorCode(error) === "EEXIST") return false;
    throw error;
  }
  try {
    const current = await readLockOwner(join(lockDir, "owner.json"));
    if (
      current === null ||
      current.pid !== seen.pid ||
      current.nonce !== seen.nonce ||
      isProcessAlive(current.pid)
    ) {
      return false;
    }
    await rm(lockDir, { recursive: true, force: true });
    return true;
  } finally {
    await rm(guard, { recursive: true, force: true });
  }
}

async function acquireRecordLock(
  stateDir: string,
  lockDir: string,
): Promise<() => Promise<void>> {
  await assertStateDirectory(stateDir);
  const nonce = randomUUID();
  const ownerFile = join(lockDir, "owner.json");
  const ownerTmp = join(stateDir, `.owner.${nonce}.tmp`);
  let waits = 0;
  for (;;) {
    try {
      await mkdir(lockDir);
      // We won the race. Publish owner metadata via temp+rename; on any
      // failure remove the lock so no orphan stays behind.
      try {
        await writeFile(
          ownerTmp,
          JSON.stringify({ pid: process.pid, nonce }),
          { mode: 0o600 },
        );
        await rename(ownerTmp, ownerFile);
      } catch (error) {
        await rm(ownerTmp, { force: true }).catch(() => undefined);
        await rm(lockDir, { recursive: true, force: true });
        throw error;
      }
      return async () => {
        const current = await readLockOwner(ownerFile);
        if (current === null || current.nonce !== nonce) return;
        await rm(lockDir, { recursive: true, force: true });
      };
    } catch (error) {
      if (errorCode(error) !== "EEXIST") throw error;
    }
    let stat;
    try {
      stat = await lstat(lockDir);
    } catch (error) {
      if (errorCode(error) === "ENOENT") continue;
      throw error;
    }
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new PrWorkCoordinationError(
        "lock_untrusted",
        "Work lock path is not a real directory.",
      );
    }
    const meta = await readLockOwner(ownerFile);
    if (
      meta !== null &&
      meta.pid !== process.pid &&
      !isProcessAlive(meta.pid) &&
      (await tryReclaimLock(lockDir, meta))
    ) {
      continue;
    }
    waits += 1;
    if (waits > LOCK_SETTLE_LIMIT) {
      throw new PrWorkCoordinationError(
        "lock_unknown",
        "Work lock stayed occupied past the short-lock budget.",
      );
    }
    await sleep(10);
  }
}

/** One short read-modify-write critical section per operation. */
async function withRecord<Result>(
  store: PrWorkCoordinationStore,
  identity: { repositoryId: number; pullRequestNumber: number },
  mutate: (
    current: WorkRecord | null,
  ) => Promise<{ write: WorkRecord | null; result: Result }>,
): Promise<Result> {
  const recordPath = store.recordPath(
    identity.repositoryId,
    identity.pullRequestNumber,
  );
  const release = await acquireRecordLock(store.stateDir, `${recordPath}.lock`);
  try {
    const current = await readRecordFile(store.stateDir, recordPath, identity);
    const outcome = await mutate(current);
    if (outcome.write !== null) {
      await writeRecordFile(store.stateDir, recordPath, outcome.write, identity);
    }
    return outcome.result;
  } finally {
    await release();
  }
}

function blankRecord(identity: {
  repositoryId: number;
  pullRequestNumber: number;
}): WorkRecord {
  return {
    version: RECORD_VERSION,
    repositoryId: identity.repositoryId,
    pullRequestNumber: identity.pullRequestNumber,
    owner: null,
    phase: "reserved",
    findings: [],
    seenSessions: [],
  };
}

/** Upper bound on serialized owner bytes (paths + session + fixed fields). */
function maxOwnerBytes(): number {
  return (
    3 * PATH_MAX * 4 +
    SESSION_MAX * 4 +
    MODEL_MAX * 4 +
    40 + 64 + 64 + 32 + 64 +
    // `"generation":<max safe integer>` JSON overhead.
    14 + 16
  );
}

/**
 * Wrap a mutating op so an oversize write becomes a structured `too_large`
 * refusal instead of a thrown error. The record on disk is untouched.
 */
async function withTooLarge<Result extends { record: WorkRecord | null }>(
  current: WorkRecord | null,
  run: () => Promise<Result>,
): Promise<Result | { ok: false; reason: "too_large"; record: WorkRecord | null }> {
  try {
    return await run();
  } catch (error) {
    if (
      error instanceof PrWorkCoordinationError &&
      error.code === "record_too_large"
    ) {
      return { ok: false, reason: "too_large" as const, record: current };
    }
    throw error;
  }
}

function randomOwnerToken(): string {
  return randomBytes(16).toString("hex");
}

/** Next fencing generation; null on overflow so the caller fails closed. */
function nextGeneration(current: number): number | null {
  if (!Number.isSafeInteger(current) || current < 0) return null;
  if (current >= Number.MAX_SAFE_INTEGER) return null;
  return current + 1;
}

async function resolveProbe(
  probe: ProbeWorker,
  owner: WorkOwnerSnapshot,
): Promise<WorkerProbe> {
  try {
    const status = await probe(owner);
    if (status === "running" || status === "stopped" || status === "unknown") {
      return status;
    }
    return "unknown";
  } catch {
    return "unknown";
  }
}

function requireProbe(probe: unknown, name: string): asserts probe is ProbeWorker {
  if (typeof probe !== "function") {
    throw new PrWorkCoordinationError(
      "input_invalid",
      `${name} requires a caller-supplied probeWorker capability.`,
    );
  }
}

/** Read-only snapshot for probe-first flows; corruption stays explicit. */
async function readSnapshot(
  store: PrWorkCoordinationStore,
  ids: { repositoryId: number; pullRequestNumber: number },
): Promise<
  | { record: WorkRecord | null; failed: null }
  | { record: null; failed: CorruptReason }
> {
  try {
    const record = await withRecord<WorkRecord | null>(store, ids, async (current) => ({
      write: null,
      result: current,
    }));
    return { record, failed: null };
  } catch (error) {
    const reason = corruptReason(error);
    if (reason !== null) return { record: null, failed: reason };
    throw error;
  }
}

/**
 * Re-read the record without masking corruption behind a stale snapshot:
 * untrusted/corrupt must surface, never silently fall back.
 */
async function readProbeSnapshot(
  store: PrWorkCoordinationStore,
  ids: { repositoryId: number; pullRequestNumber: number },
): Promise<
  | { record: WorkRecord | null; failed: null }
  | { record: null; failed: CorruptReason }
> {
  try {
    const record = await readWork(store, ids);
    return { record, failed: null };
  } catch (error) {
    const reason = corruptReason(error);
    if (reason !== null) return { record: null, failed: reason };
    throw error;
  }
}

/** Read the current record without taking the lock. Throws fail-closed. */
export async function readWork(
  store: PrWorkCoordinationStore,
  identity: WorkIdentity,
): Promise<WorkRecord | null> {
  const ids = checkIdentity(identity);
  return readRecordFile(
    store.stateDir,
    store.recordPath(ids.repositoryId, ids.pullRequestNumber),
    ids,
  );
}

/**
 * Persist a reservation BEFORE wrapper dispatch, when the session id is still
 * unknown. The caller-read controller ledger gates entry: a paused,
 * inconsistent, or exhausted ledger refuses first (permanent), then an
 * existing reservation blocks a second writer, including the null-session
 * crash gap. The ledger is not stored.
 */
export async function reserveWork(
  store: PrWorkCoordinationStore,
  input: ReserveInput,
): Promise<ReserveResult> {
  const ids = checkIdentity(input);
  const role = checkRole(input.role);
  const startHead = hex(input.startHead, 40, "startHead");
  const scopeDigest = hex(input.scopeDigest, 64, "scopeDigest");
  const changeDigest = hex(input.changeDigest, 64, "changeDigest");
  const worktree = absolutePath(input.worktree, "worktree");
  const taskFile = absolutePath(input.taskFile, "taskFile");
  const workerStateDir = optionalAbsolutePath(input.workerStateDir, "workerStateDir");
  const model = optionalText(input.model, "model", MODEL_MAX);
  const ledger = checkLedger(input.ledger);
  try {
    return await withTooLarge<ReserveResult>(null, () =>
      withRecord<ReserveResult>(store, ids, async (current) => {
      const refuse = (reason: "paused" | "history_inconsistent" | "rounds_exhausted" | "review_not_recorded" | "repeated_finding" | "occupied" | CorruptReason): { write: null; result: ReserveResult } =>
        ({ write: null, result: { ok: false, reason, record: current } });
      if (ledger.paused) return refuse("paused");
      if (!ledger.historyConsistent) return refuse("history_inconsistent");
      if (ledger.roundsConsumed >= MAX_ROUNDS) return refuse("rounds_exhausted");
      // An implementation fix is bound to the controller's latest
      // request-changes marker: the review must cover exactly the head being
      // fixed, otherwise a stale caller ledger could run extra fixes without
      // any controller review in between. Code-review reservations bypass.
      if (role === "implementation" && ledger.latestReviewedHead !== startHead) {
        return refuse("review_not_recorded");
      }
      // A recurring confirmed finding after an accepted fix escalates to
      // human: the next automatic implementation reservation is refused.
      if (role === "implementation" && (current?.findings.some((finding) => finding.repeatedAfterFix) ?? false)) {
        return refuse("repeated_finding");
      }
      if (current?.owner !== null && current?.owner !== undefined) {
        return refuse("occupied");
      }
      const base = current ?? blankRecord(ids);
      const record: WorkRecord = {
        ...base,
        owner: {
          token: randomOwnerToken(),
          role,
          sessionId: null,
          generation: 0,
          startHead,
          scopeDigest,
          changeDigest,
          worktree,
          taskFile,
          workerStateDir,
          model,
        },
        phase: "reserved",
      };
      return { write: record, result: { ok: true as const, record } };
      }),
    );
  } catch (error) {
    const reason = corruptReason(error);
    if (reason !== null) return { ok: false, reason, record: null };
    throw error;
  }
}

/**
 * Bind the wrapper-confirmed session to an existing reservation. Requires the
 * exact owner token, start head, scope, role, and worker state pointer. The
 * exact same implementation session may re-attach (resume) under the same
 * identity; a different session never silently replaces the bound one, and
 * re-attaching after `verifying` is refused. An implementation owner may
 * rebind its own original implementation session after release plus a new
 * reservation (head/scope still rechecked); review sessions are always fresh
 * and an implementation may never reuse a review-role session id.
 *
 * Protocol ordering (coordinator runner): attach is bookkeeping only and
 * never by itself grants permission to start or resume a model. Before each
 * new wrapper attempt or resume, the runner must first hold a fresh
 * null-session reservation (new token) for this PR; a stopped old owner is
 * released first. While the new reservation is still null-session/unbound,
 * its probe reads unknown, so a second writer stays blocked until the
 * wrapper confirms the session via attach.
 */
export async function attachSession(
  store: PrWorkCoordinationStore,
  input: AttachInput,
): Promise<AttachResult> {
  const ids = checkIdentity(input);
  const role = checkRole(input.role);
  const startHead = hex(input.startHead, 40, "startHead");
  const scopeDigest = hex(input.scopeDigest, 64, "scopeDigest");
  const sessionId = text(input.sessionId, "sessionId", SESSION_MAX);
  const workerStateDir = optionalAbsolutePath(input.workerStateDir, "workerStateDir");
  const model = optionalText(input.model, "model", MODEL_MAX);
  try {
    return await withTooLarge<AttachResult>(null, () =>
      withRecord<AttachResult>(store, ids, async (current) => {
      const refuse = (reason: "not_found" | "token_mismatch" | "head_mismatch" | "scope_mismatch" | "role_mismatch" | "state_mismatch" | "session_conflict" | "model_changed" | "stale_review_session" | "history_full" | "too_large" | CorruptReason): { write: null; result: AttachResult } =>
        ({ write: null, result: { ok: false, reason, record: current } });
      if (current === null || current.owner === null) return refuse("not_found");
      const owner = current.owner;
      if (input.ownerToken !== owner.token) return refuse("token_mismatch");
      if (startHead !== owner.startHead) return refuse("head_mismatch");
      if (scopeDigest !== owner.scopeDigest) return refuse("scope_mismatch");
      if (role !== owner.role) return refuse("role_mismatch");
      if (workerStateDir !== owner.workerStateDir) return refuse("state_mismatch");
      const seen = current.seenSessions.find((entry) => entry.id === sessionId);
      if (owner.sessionId !== null && owner.sessionId !== sessionId) {
        return refuse("session_conflict");
      }
      if (owner.sessionId === sessionId) {
        // Same identity resuming. Refuse once the result was accepted.
        // Every successful attach bumps the fencing generation, including
        // this resumed branch, so a same-session re-attach landing between
        // another caller's snapshot and probe still invalidates the stale
        // stopped proof under the lock.
        if (current.phase === "verifying") return refuse("stale_review_session");
        // A resume attach pins the worker model: the receipt model must match
        // the model stored for the session's prior attempt (seen entry first,
        // else the prior owner record). A changed model refuses with the
        // record intact.
        const priorModel = seen?.model ?? owner.model ?? null;
        if (priorModel !== null && model !== null && model !== priorModel) {
          return refuse("model_changed");
        }
        const resumedGeneration = nextGeneration(owner.generation);
        if (resumedGeneration === null) return refuse("too_large");
        const resumedSeen =
          seen === undefined
            ? [...current.seenSessions, { id: sessionId, role, model }]
            : model === null || (seen.model ?? null) !== null
              ? current.seenSessions
              : current.seenSessions.map((entry) =>
                  entry.id === sessionId ? { ...entry, model } : entry,
                );
        const resumedRecord: WorkRecord = {
          ...current,
          owner: { ...owner, generation: resumedGeneration, model: model ?? owner.model },
          seenSessions: resumedSeen,
        };
        return { write: resumedRecord, result: { ok: true as const, record: resumedRecord, resumed: true } };
      }
      // Reuse rules: an implementation owner may rebind only a session id
      // previously used by the implementation role; any other seen id is
      // refused, so review sessions stay fresh and review-role ids are never
      // recycled by implementation owners.
      const mayReuse = seen !== undefined && role === "implementation" && seen.role === "implementation";
      if (seen !== undefined && !mayReuse) return refuse("stale_review_session");
      if (current.seenSessions.length >= MAX_SESSION_IDS && !mayReuse) {
        return refuse("history_full");
      }
      // Rebinding a previously seen implementation session is also a resume:
      // pin the worker model the same way before recording it.
      if (mayReuse) {
        const priorModel = seen?.model ?? null;
        if (priorModel !== null && model !== null && model !== priorModel) {
          return refuse("model_changed");
        }
      }
      const attachedGeneration = nextGeneration(owner.generation);
      if (attachedGeneration === null) return refuse("too_large");
      const attachedSeen =
        seen === undefined
          ? [...current.seenSessions, { id: sessionId, role, model }]
          : model === null || (seen.model ?? null) !== null
            ? current.seenSessions
            : current.seenSessions.map((entry) =>
                entry.id === sessionId ? { ...entry, model } : entry,
              );
      const record: WorkRecord = {
        ...current,
        owner: { ...owner, sessionId, generation: attachedGeneration, model: model ?? owner.model },
        phase: "running",
        seenSessions: attachedSeen,
      };
      return { write: record, result: { ok: true as const, record, resumed: false } };
      }),
    );
  } catch (error) {
    const reason = corruptReason(error);
    if (reason !== null) return { ok: false, reason, record: null };
    throw error;
  }
}

/**
 * Release the current owner (or recover the crash gap when no token is
 * given). The probe runs outside the short lock; the owner token is
 * re-checked under the lock before clearing. Requires fresh stopped proof: a
 * running/unknown worker keeps occupancy. Findings and other edits are kept.
 */
export async function releaseWork(
  store: PrWorkCoordinationStore,
  input: ReleaseInput,
  probe: ProbeWorker,
): Promise<ReleaseResult> {
  const ids = checkIdentity(input);
  requireProbe(probe, "releaseWork");
  const token =
    input.ownerToken === undefined
      ? null
      : hex(input.ownerToken, 32, "ownerToken");
  const snapshot = await readSnapshot(store, ids);
  if (snapshot.failed) return { ok: false, reason: snapshot.failed, record: null };
  if (snapshot.record === null || snapshot.record.owner === null) {
    return { ok: true, record: snapshot.record, released: false };
  }
  if (token !== null && token !== snapshot.record.owner.token) {
    return { ok: false, reason: "token_mismatch", record: snapshot.record };
  }
  const status = await resolveProbe(probe, snapshot.record.owner);
  if (status !== "stopped") {
    const fresh = await readProbeSnapshot(store, ids);
    if (fresh.failed) return { ok: false, reason: fresh.failed, record: null };
    return {
      ok: false,
      reason: status === "running" ? "worker_running" : "worker_unknown",
      record: fresh.record,
    };
  }
  try {
    return await withTooLarge<ReleaseResult>(snapshot.record, () =>
      withRecord<ReleaseResult>(store, ids, async (current) => {
      if (current === null || current.owner === null) {
        return { write: null, result: { ok: true as const, record: current, released: false } };
      }
      const probed = snapshot.record?.owner ?? null;
      const probedPhase = snapshot.record?.phase ?? null;
      if (probed === null || current.owner.token !== probed.token) {
        return { write: null, result: { ok: false as const, reason: "token_mismatch" as const, record: current } };
      }
      // The probed owner must still be the one recorded: an attach that
      // landed after the probe means we stopped someone else's worker.
      // Generation fences the same-session resumed branch too: any
      // successful attach bumps it, so token/session/phase equality alone
      // cannot clear a live writer re-attached after the snapshot.
      if (
        current.owner.sessionId !== probed.sessionId ||
        current.owner.generation !== probed.generation ||
        current.phase !== probedPhase
      ) {
        return { write: null, result: { ok: false as const, reason: "worker_unknown" as const, record: current } };
      }
      const record: WorkRecord = { ...current, owner: null, phase: "reserved" };
      return { write: record, result: { ok: true as const, record, released: true } };
      }),
    );
  } catch (error) {
    const reason = corruptReason(error);
    if (reason !== null) return { ok: false, reason, record: null };
    throw error;
  }
}

/**
 * Accept a worker result into verifying. Validates owner token, session, start
 * head, scope, and the live head, plus fresh stopped proof (probed outside the
 * lock, re-checked under it), before entering verifying. A late head/scope
 * mismatch retains the record and partial work and rejects without deletion.
 * Accepted confirmed findings are marked fixed so a reappearance is reported.
 * Never stages or pushes.
 */
export async function acceptResult(
  store: PrWorkCoordinationStore,
  input: AcceptInput,
  probe: ProbeWorker,
): Promise<AcceptResult> {
  const ids = checkIdentity(input);
  requireProbe(probe, "acceptResult");
  const startHead = hex(input.startHead, 40, "startHead");
  const scopeDigest = hex(input.scopeDigest, 64, "scopeDigest");
  const liveHead = hex(input.liveHead, 40, "liveHead");
  const liveChangeDigest =
    input.liveChangeDigest === undefined || input.liveChangeDigest === null
      ? null
      : hex(input.liveChangeDigest, 64, "liveChangeDigest");
  const sessionId = text(input.sessionId, "sessionId", SESSION_MAX);
  const snapshot = await readSnapshot(store, ids);
  if (snapshot.failed) return { ok: false, reason: snapshot.failed, record: null };
  const reject = (
    reason: Exclude<AcceptResult, { ok: true }>["reason"],
  ): AcceptResult => ({ ok: false, reason, record: snapshot.record });
  if (snapshot.record === null || snapshot.record.owner === null) {
    return reject("not_found");
  }
  const owner = snapshot.record.owner;
  if (input.ownerToken !== owner.token) return reject("token_mismatch");
  if (owner.sessionId === null || sessionId !== owner.sessionId) {
    return reject("session_mismatch");
  }
  if (startHead !== owner.startHead) return reject("start_head_mismatch");
  if (scopeDigest !== owner.scopeDigest) return reject("scope_mismatch");
  if (liveHead !== owner.startHead) return reject("live_head_mismatch");
  const status = await resolveProbe(probe, owner);
  if (status !== "stopped") {
    const fresh = await readProbeSnapshot(store, ids);
    if (fresh.failed) return { ok: false, reason: fresh.failed, record: null };
    return {
      ok: false,
      reason: status === "running" ? "worker_running" : "worker_unknown",
      record: fresh.record,
    };
  }
  const probedOwner = owner;
  const probedPhase = snapshot.record.phase;
  try {
    return await withTooLarge<AcceptResult>(snapshot.record, () =>
      withRecord<AcceptResult>(store, ids, async (current) => {
      if (current === null || current.owner === null) {
        return { write: null, result: reject("not_found") };
      }
      const live = current.owner;
      if (live.token !== probedOwner.token) {
        return { write: null, result: { ok: false as const, reason: "token_mismatch" as const, record: current } };
      }
      if (live.sessionId === null || live.sessionId !== sessionId) {
        return { write: null, result: { ok: false as const, reason: "session_mismatch" as const, record: current } };
      }
      if (
        live.generation !== probedOwner.generation ||
        current.phase !== probedPhase
      ) {
        return { write: null, result: { ok: false as const, reason: "worker_unknown" as const, record: current } };
      }
      // Only an accepted implementation fix arms the repeat signal; a
      // code-review accept never marked findings fixed (P2-2).
      const fixed = live.role === "implementation";
      const record: WorkRecord = {
        ...current,
        owner: { ...live, changeDigest: liveChangeDigest ?? live.changeDigest },
        phase: "verifying",
        findings: fixed
          ? current.findings.map((finding) =>
              finding.status === "confirmed" ? { ...finding, fixedAccepted: true } : finding,
            )
          : current.findings,
      };
      return { write: record, result: { ok: true as const, record } };
      }),
    );
  } catch (error) {
    const reason = corruptReason(error);
    if (reason !== null) return { ok: false, reason, record: null };
    throw error;
  }
}

/**
 * Record a finding disposition under the live owner's token. A confirmed key
 * that reappears after its fix was accepted reports `repeated: true` so the
 * coordinator escalates to human (同一问题反复出现提前转人工). Oversize
 * content is refused structurally, never persisted.
 */
export async function recordFinding(
  store: PrWorkCoordinationStore,
  input: FindingInput,
): Promise<FindingResult> {
  const ids = checkIdentity(input);
  const key = text(input.key, "key", KEY_MAX);
  const status = checkFindingStatus(input.status);
  const evidence = text(input.evidence, "evidence", EVIDENCE_MAX);
  const repairDirective = optionalText(input.repairDirective, "repairDirective", REPAIR_MAX);
  try {
    return await withTooLarge<FindingResult>(null, () =>
      withRecord<FindingResult>(store, ids, async (current) => {
      if (current === null || current.owner === null) {
        return { write: null, result: { ok: false as const, reason: "not_found" as const, record: current } };
      }
      if (input.ownerToken !== current.owner.token) {
        return { write: null, result: { ok: false as const, reason: "token_mismatch" as const, record: current } };
      }
      const existing = current.findings.find((entry) => entry.key === key);
      // Bound the finding count structurally: a new key past MAX_FINDINGS is
      // refused before construction so the record stays valid and readable.
      // Updating an existing key at the limit stays allowed (no growth).
      if (existing === undefined && current.findings.length >= MAX_FINDINGS) {
        return { write: null, result: { ok: false as const, reason: "too_large" as const, record: current } };
      }
      // Repeat latch: `repeatedAfterFix` stays sticky in storage once set, but
      // `repeated` is reported only for an incoming confirmed disposition.
      const latched = existing?.repeatedAfterFix ?? false;
      const newlyRepeated =
        existing !== undefined &&
        existing.status === "confirmed" &&
        existing.fixedAccepted &&
        status === "confirmed";
      const stored = latched || newlyRepeated;
      const repeated = status === "confirmed" && stored;
      const entry: WorkFinding = {
        key,
        status,
        evidence,
        repairDirective,
        fixedAccepted: false,
        repeatedAfterFix: stored,
      };
      const findings =
        existing === undefined
          ? [...current.findings, entry]
          : current.findings.map((candidate) =>
              candidate.key === key ? entry : candidate,
            );
      const record: WorkRecord = { ...current, findings };
      // Best-effort headroom: keep room for a maximum-size owner so a later
      // attach/reserve is less likely to hit the budget. The actual safety
      // guarantee is the universal write guard in writeRecordFile, which
      // refuses any oversize write structurally; this check alone does not
      // promise all future writes will fit.
      if (recordByteLength(record) > MAX_RECORD_BYTES - maxOwnerBytes()) {
        return { write: null, result: { ok: false as const, reason: "too_large" as const, record: current } };
      }
      return { write: record, result: { ok: true as const, record, repeated } };
      }),
    );
  } catch (error) {
    const reason = corruptReason(error);
    if (reason !== null) return { ok: false, reason, record: null };
    throw error;
  }
}

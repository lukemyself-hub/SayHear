import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, rename, unlink, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { deflateSync } from "node:zlib";

import type { GitHubApi } from "../pr-approval-controller.ts";

const REPOSITORY = "/repos/lukemyself-hub/SayHear";
const MAX_NATIVE_DIFF_BYTES = 800_000;
const MAX_FILES = 3_000;
const MAX_BLOB_BYTES = 8 * 1024 * 1024;
const MAX_CONTENT_BYTES = 64 * 1024 * 1024;
const MAX_PATCH_BYTES = 128 * 1024 * 1024;
const BLOB_CONCURRENCY = 6;
const ZERO_SHA = "0".repeat(40);
const BASE85 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz!#$%&()*+-;<=>?@^_`{|}~";

export type DiffIdentity = Readonly<{
  number: number;
  headSha: string;
  baseSha: string;
  changedFiles: number;
}>;

type FileRecord = Readonly<{
  filename: string;
  previousFilename: string | null;
  status: "added" | "modified" | "removed" | "renamed" | "copied";
  sha: string;
  additions: number | null;
  deletions: number | null;
}>;

type TreeEntry = Readonly<{
  sha: string;
  mode: string;
  type: "blob" | "commit";
  size: number;
}>;

type FileVersions = Readonly<{
  file: FileRecord;
  oldPath: string;
  old: TreeEntry | null;
  next: TreeEntry | null;
}>;

export type CollectedPrDiff = Readonly<{
  complete: boolean;
  changedFiles: number;
  expectedChangedFiles: number;
  text: string;
  digest: string;
  source: "github-diff" | "github-blobs" | "unavailable";
  reason: string | null;
  mergeBaseSha: string | null;
  binaryFiles: number;
  contentBytes: number;
}>;

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sha(value: unknown, name: string): string {
  if (typeof value !== "string" || !/^[0-9a-f]{40}$/i.test(value)) {
    throw new Error(`${name} is not a Git SHA.`);
  }
  return value.toLowerCase();
}

function path(value: unknown): string {
  if (typeof value !== "string" || value.length === 0 || value.includes("\0") ||
    value.startsWith("/") || value.split("/").some((part) =>
      part === "" || part === "." || part === ".." || part.toLowerCase() === ".git")) {
    throw new Error("The file manifest contains an unsafe or empty path.");
  }
  return value;
}

function fileRecords(values: readonly unknown[], expected: number): FileRecord[] {
  if (!Number.isSafeInteger(expected) || expected < 1 || expected > MAX_FILES ||
    values.length !== expected) {
    throw new Error(`File manifest count ${values.length} does not match ${expected}, or exceeds ${MAX_FILES}.`);
  }
  const seen = new Set<string>();
  return values.map((value): FileRecord => {
    if (!record(value)) throw new Error("The file manifest contains a non-object.");
    const filename = path(value.filename);
    if (seen.has(filename)) throw new Error(`Duplicate changed file: ${filename}.`);
    seen.add(filename);
    const status = value.status;
    if (status !== "added" && status !== "modified" && status !== "removed" &&
      status !== "renamed" && status !== "copied") {
      throw new Error(`Unsupported file status for ${filename}.`);
    }
    const previousFilename = value.previous_filename === undefined || value.previous_filename === null
      ? null : path(value.previous_filename);
    if (status === "renamed" && (!previousFilename || previousFilename === filename)) {
      throw new Error(`The rename source for ${filename} is missing or invalid.`);
    }
    const count = (value: unknown) => typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
    return { filename, previousFilename, status, sha: sha(value.sha, `File ${filename}`),
      additions: count(value.additions), deletions: count(value.deletions) };
  }).sort((left, right) => left.filename < right.filename ? -1 : left.filename > right.filename ? 1 : 0);
}

// Git's C quoting keeps arbitrary UTF-8 paths out of patch control syntax.
function quotePath(value: string): string {
  const bytes = Buffer.from(value, "utf8");
  if (bytes.every((byte) => byte >= 32 && byte < 127 && byte !== 34 && byte !== 92)) return value;
  const quoted = [...bytes].map((byte) => {
    if (byte === 34 || byte === 92) return `\\${String.fromCharCode(byte)}`;
    if (byte >= 32 && byte < 127) return String.fromCharCode(byte);
    return `\\${byte.toString(8).padStart(3, "0")}`;
  }).join("");
  return `"${quoted}"`;
}

function fileHeader(file: FileRecord): string {
  const oldPath = file.status === "renamed" ? file.previousFilename! : file.filename;
  return `diff --git ${quotePath(`a/${oldPath}`)} ${quotePath(`b/${file.filename}`)}`;
}

function completeHunks(block: string, file: FileRecord): boolean {
  if (file.additions === null || file.deletions === null) return false;
  const lines = block.split("\n");
  let added = 0;
  let removed = 0;
  let index = lines.findIndex((line) => line.startsWith("@@ "));
  if (index === -1) return file.status !== "modified" && file.additions === 0 && file.deletions === 0;
  while (index < lines.length && lines[index] !== "") {
    const header = lines[index++]!.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(?:.*)$/);
    if (!header) return false;
    let old = Number(header[2] ?? 1);
    let next = Number(header[4] ?? 1);
    let consumed = false;
    while (old > 0 || next > 0) {
      const line = lines[index++];
      if (line === "\\ No newline at end of file" && consumed) continue;
      if (line?.startsWith("+")) { added++; next--; }
      else if (line?.startsWith("-")) { removed++; old--; }
      else if (line?.startsWith(" ")) { old--; next--; }
      else return false;
      consumed = true;
      if (old < 0 || next < 0) return false;
    }
    if (lines[index] === "\\ No newline at end of file") index++;
  }
  return lines.slice(index).every((line) => line === "") && added === file.additions && removed === file.deletions;
}

function nativeDiffIsComplete(bytes: Uint8Array, files: readonly FileRecord[]): boolean {
  const text = Buffer.from(bytes).toString("utf8");
  if (!Buffer.from(text).equals(Buffer.from(bytes)) ||
    /^Binary files .+ differ$/m.test(text) || /^GIT binary patch$/m.test(text)) return false;
  const headers = text.match(/^diff --git .+$/gm) ?? [];
  const expected = new Set(files.map(fileHeader));
  if (headers.length !== files.length || new Set(headers).size !== headers.length ||
    !headers.every((header) => expected.has(header))) return false;
  const byHeader = new Map(files.map((file) => [fileHeader(file), file]));
  return text.split(/(?=^diff --git )/m).filter(Boolean).every((block) => {
    const file = byHeader.get(block.split("\n")[0]!);
    if (!file || !completeHunks(block, file)) return false;
    const index = block.match(/^index ([0-9a-f]{7,40})\.\.([0-9a-f]{7,40})(?: [0-9]{6})?$/m);
    if (!index || !file.sha.startsWith(file.status === "removed" ? index[1]! : index[2]!)) return false;
    const added = /^new file mode /m.test(block);
    const removed = /^deleted file mode /m.test(block);
    const renamed = /^rename from /m.test(block) && /^rename to /m.test(block);
    const copied = /^copy from /m.test(block) && /^copy to /m.test(block);
    return file.status === "added" ? added : file.status === "removed" ? removed :
      file.status === "renamed" ? renamed : file.status === "copied" ? copied || added :
      !added && !removed && !renamed && !copied;
  });
}

async function readCommitTree(api: GitHubApi, commitSha: string): Promise<Map<string, TreeEntry>> {
  const commit = await api.request<unknown>(`${REPOSITORY}/git/commits/${commitSha}`);
  if (!record(commit) || sha(commit.sha, "Commit response") !== commitSha || !record(commit.tree)) {
    throw new Error("The commit identity or tree is missing or inconsistent.");
  }
  const treeSha = sha(commit.tree.sha, "Commit tree");
  const tree = await api.request<unknown>(`${REPOSITORY}/git/trees/${treeSha}?recursive=1`);
  if (!record(tree) || sha(tree.sha, "Tree response") !== treeSha ||
    tree.truncated !== false || !Array.isArray(tree.tree)) {
    throw new Error("The commit tree is missing, truncated, or has a different identity.");
  }
  const entries = new Map<string, TreeEntry>();
  const seen = new Set<string>();
  for (const item of tree.tree) {
    if (!record(item)) throw new Error("The tree contains a non-object entry.");
    const filename = path(item.path);
    if (seen.has(filename)) throw new Error(`Duplicate tree path: ${filename}.`);
    seen.add(filename);
    if (item.type === "tree" && item.mode === "040000") continue;
    const isBlob = item.type === "blob" && ["100644", "100755", "120000"].includes(String(item.mode));
    const isSubmodule = item.type === "commit" && item.mode === "160000";
    if (!isBlob && !isSubmodule) throw new Error(`Unsupported tree entry: ${filename}.`);
    const size = isSubmodule ? 0 : item.size;
    if (typeof size !== "number" || !Number.isSafeInteger(size) || size < 0) {
      throw new Error(`Missing blob size: ${filename}.`);
    }
    entries.set(filename, {
      sha: sha(item.sha, `Tree entry ${filename}`), mode: String(item.mode),
      type: isBlob ? "blob" : "commit", size,
    });
  }
  return entries;
}

function versionsFromTrees(
  files: readonly FileRecord[],
  base: ReadonlyMap<string, TreeEntry>,
  head: ReadonlyMap<string, TreeEntry>,
): FileVersions[] {
  const changed = new Set<string>();
  for (const filename of new Set([...base.keys(), ...head.keys()])) {
    const old = base.get(filename);
    const next = head.get(filename);
    if (old?.sha !== next?.sha || old?.mode !== next?.mode || old?.type !== next?.type) changed.add(filename);
  }
  const covered = new Set<string>();
  const versions = files.map((file) => {
    const oldPath = file.status === "renamed" ? file.previousFilename! : file.filename;
    const old = base.get(oldPath) ?? null;
    const next = head.get(file.filename) ?? null;
    if ((file.status === "added" || file.status === "copied") && (old || !next) ||
      file.status === "removed" && (!old || next) ||
      file.status === "modified" && (!old || !next || !changed.has(file.filename)) ||
      file.status === "renamed" && (!old || !next || head.has(oldPath))) {
      throw new Error(`File status does not match the commit trees: ${file.filename}.`);
    }
    if ((next ?? old)?.sha !== file.sha) throw new Error(`File SHA does not match the tree: ${file.filename}.`);
    if (old?.type === "commit" || next?.type === "commit") {
      throw new Error(`Changed submodule cannot be fully reviewed: ${file.filename}.`);
    }
    if (!changed.has(file.filename) || (file.status === "renamed" && !changed.has(oldPath))) {
      throw new Error(`Manifest path is not changed in the trees: ${file.filename}.`);
    }
    covered.add(file.filename);
    if (file.status === "renamed") covered.add(oldPath);
    return { file, oldPath, old, next };
  });
  if (covered.size !== changed.size || [...changed].some((filename) => !covered.has(filename))) {
    throw new Error("The file manifest omits changes present in the authenticated commit trees.");
  }
  return versions;
}

export function gitBlobSha(bytes: Uint8Array): string {
  return createHash("sha1").update(`blob ${bytes.byteLength}\0`).update(bytes).digest("hex");
}

async function cachedBlob(directory: string | undefined, entry: TreeEntry): Promise<Buffer | null> {
  if (!directory) return null;
  try {
    // Open the actual file without following symlinks or blocking on a pipe;
    // read at most the expected size plus one even if the cache changes.
    const handle = await open(resolve(directory, entry.sha), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const info = await handle.stat();
      if (!info.isFile() || info.size !== entry.size || info.size > MAX_BLOB_BYTES) return null;
      const buffer = Buffer.alloc(entry.size + 1);
      let size = 0;
      while (size < buffer.length) {
        const read = await handle.read(buffer, size, buffer.length - size, size);
        if (read.bytesRead === 0) break;
        size += read.bytesRead;
      }
      const bytes = buffer.subarray(0, size);
      return size === entry.size && gitBlobSha(bytes) === entry.sha ? bytes : null;
    } finally { await handle.close(); }
  } catch { return null; }
}

async function cacheBlob(directory: string | undefined, entry: TreeEntry, bytes: Buffer): Promise<void> {
  if (!directory) return;
  const temporary = resolve(directory, `${entry.sha}.${randomUUID()}.tmp`);
  try {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    if (!(await lstat(directory)).isDirectory()) return;
    await writeFile(temporary, bytes, { flag: "wx", mode: 0o600 });
    await rename(temporary, resolve(directory, entry.sha));
  } catch { /* A cache write is optional; verified bytes remain authoritative. */ }
  finally { await unlink(temporary).catch(() => undefined); }
}

async function readBlobs(
  api: GitHubApi,
  versions: readonly FileVersions[],
  cacheDirectory?: string,
): Promise<{ blobs: Map<string, Buffer>; contentBytes: number }> {
  const entries = new Map<string, TreeEntry>();
  let contentBytes = 0;
  for (const version of versions) {
    for (const entry of [version.old, version.next]) {
      if (!entry) continue;
      if (entry.size > MAX_BLOB_BYTES) throw new Error(`Blob ${entry.sha} exceeds the ${MAX_BLOB_BYTES}-byte limit.`);
      contentBytes += entry.size;
      if (contentBytes > MAX_CONTENT_BYTES) throw new Error(`Complete content exceeds the ${MAX_CONTENT_BYTES}-byte limit.`);
      if (entries.has(entry.sha) && entries.get(entry.sha)!.size !== entry.size) {
        throw new Error(`Conflicting sizes for blob ${entry.sha}.`);
      }
      entries.set(entry.sha, entry);
    }
  }
  const queue = [...entries.values()];
  const blobs = new Map<string, Buffer>();
  let nextIndex = 0;
  let failed = false;
  // Wait for every worker, even on failure: no background work may race a new snapshot.
  const workers = await Promise.allSettled(Array.from({ length: Math.min(BLOB_CONCURRENCY, queue.length) }, async () => {
    try {
    while (!failed && nextIndex < queue.length) {
      const entry = queue[nextIndex++]!;
      let bytes = await cachedBlob(cacheDirectory, entry);
      if (!bytes) {
        bytes = Buffer.from(await api.bytes(`${REPOSITORY}/git/blobs/${entry.sha}`, {
          accept: "application/vnd.github.raw+json", maxBytes: MAX_BLOB_BYTES,
        }));
        if (bytes.byteLength !== entry.size || gitBlobSha(bytes) !== entry.sha) {
          throw new Error(`Blob ${entry.sha} failed size or Git SHA verification.`);
        }
        await cacheBlob(cacheDirectory, entry, bytes);
      }
      blobs.set(entry.sha, bytes);
    }
    } catch (error) { failed = true; throw error; }
  }));
  for (const worker of workers) if (worker.status === "rejected") throw worker.reason;
  return { blobs, contentBytes };
}

function isBinary(bytes: Buffer): boolean {
  return bytes.includes(0) || !Buffer.from(bytes.toString("utf8"), "utf8").equals(bytes);
}

function binaryLiteral(bytes: Buffer): string {
  const compressed = deflateSync(bytes);
  const lines: string[] = [];
  for (let offset = 0; offset < compressed.length; offset += 52) {
    const block = compressed.subarray(offset, offset + 52);
    let line = String.fromCharCode(block.length <= 26 ? 64 + block.length : 70 + block.length);
    for (let index = 0; index < block.length; index += 4) {
      let value = 0;
      for (let byte = 0; byte < 4; byte++) value = value * 256 + (block[index + byte] ?? 0);
      let encoded = "";
      for (let digit = 0; digit < 5; digit++) {
        encoded = BASE85[value % 85]! + encoded;
        value = Math.floor(value / 85);
      }
      line += encoded;
    }
    lines.push(line);
  }
  return `literal ${bytes.length}\n${lines.join("\n")}\n\n`;
}

function textLines(bytes: Buffer, prefix: string): { count: number; text: string } {
  if (bytes.length === 0) return { count: 0, text: "" };
  const source = bytes.toString("utf8");
  const lines = source.split("\n");
  const terminated = lines.at(-1) === "";
  if (terminated) lines.pop();
  return {
    count: lines.length,
    text: lines.map((line) => `${prefix}${line}\n`).join("") + (terminated ? "" : "\\ No newline at end of file\n"),
  };
}

function fullFilePatch(version: FileVersions, blobs: ReadonlyMap<string, Buffer>): { text: string; binary: boolean } {
  const old = version.old ? blobs.get(version.old.sha)! : Buffer.alloc(0);
  const next = version.next ? blobs.get(version.next.sha)! : Buffer.alloc(0);
  const lines = [fileHeader(version.file)];
  if (!version.old) lines.push(`new file mode ${version.next!.mode}`);
  else if (!version.next) lines.push(`deleted file mode ${version.old.mode}`);
  else if (version.old.mode !== version.next.mode) lines.push(`old mode ${version.old.mode}`, `new mode ${version.next.mode}`);
  if (version.file.status === "renamed") {
    lines.push(`rename from ${quotePath(version.oldPath)}`, `rename to ${quotePath(version.file.filename)}`);
  }
  lines.push(`index ${version.old?.sha ?? ZERO_SHA}..${version.next?.sha ?? ZERO_SHA}`);
  const binary = isBinary(old) || isBinary(next);
  if (binary) return { text: `${lines.join("\n")}\nGIT binary patch\n${binaryLiteral(next)}${binaryLiteral(old)}`, binary };
  if (old.equals(next)) return { text: `${lines.join("\n")}\n`, binary };
  const removed = textLines(old, "-");
  const added = textLines(next, "+");
  lines.push(
    `--- ${version.old ? quotePath(`a/${version.oldPath}`) : "/dev/null"}`,
    `+++ ${version.next ? quotePath(`b/${version.file.filename}`) : "/dev/null"}`,
    `@@ -${removed.count === 0 ? 0 : 1},${removed.count} +${added.count === 0 ? 0 : 1},${added.count} @@`,
  );
  return { text: `${lines.join("\n")}\n${removed.text}${added.text}`, binary };
}

async function assertCurrentIdentity(api: GitHubApi, identity: DiffIdentity): Promise<void> {
  const pull = await api.request<unknown>(`${REPOSITORY}/pulls/${identity.number}`);
  if (!record(pull) || !record(pull.head) || !record(pull.base) ||
    sha(pull.head.sha, "Current head") !== identity.headSha ||
    sha(pull.base.sha, "Current base") !== identity.baseSha || pull.changed_files !== identity.changedFiles) {
    throw new Error("The PR head, base, or file count changed during diff collection.");
  }
}

export async function readPullRequestFileManifest(
  api: GitHubApi,
  pullRequestNumber: number,
): Promise<Readonly<{ files: readonly Record<string, unknown>[]; error: string | null }>> {
  try {
    const files = await api.pages<Record<string, unknown>>(`${REPOSITORY}/pulls/${pullRequestNumber}/files`);
    return { files, error: null };
  } catch (error) {
    return { files: [], error: error instanceof Error ? error.message : "GitHub file manifest could not be read." };
  }
}

export async function collectPullRequestDiff(
  api: GitHubApi,
  identity: DiffIdentity,
  values: readonly unknown[],
  cacheDirectory?: string,
): Promise<CollectedPrDiff> {
  const unavailable = (reason: string): CollectedPrDiff => ({
    complete: false, changedFiles: values.length, expectedChangedFiles: identity.changedFiles,
    text: "", digest: createHash("sha256").update(JSON.stringify({ identity, values })).digest("hex"),
    source: "unavailable", reason, mergeBaseSha: null, binaryFiles: 0, contentBytes: 0,
  });
  try {
    if (!Number.isSafeInteger(identity.number) || identity.number < 1) throw new Error("Invalid PR number.");
    sha(identity.headSha, "Pinned head");
    sha(identity.baseSha, "Pinned base");
    const files = fileRecords(values, identity.changedFiles);
    // Fixed commit IDs prevent a mutable PR endpoint from mixing versions.
    // Ordinary text keeps GitHub's unified patch; large PRs skip that endpoint.
    if (files.length <= 300) {
      const native = await api.bytes(`${REPOSITORY}/compare/${identity.baseSha}...${identity.headSha}`, {
        accept: "application/vnd.github.diff", maxBytes: MAX_NATIVE_DIFF_BYTES,
      }).catch(() => null);
      if (native && nativeDiffIsComplete(native, files)) {
        await assertCurrentIdentity(api, identity);
        return {
          complete: true, changedFiles: files.length, expectedChangedFiles: identity.changedFiles,
          text: Buffer.from(native).toString("utf8"), digest: createHash("sha256").update(native).digest("hex"),
          source: "github-diff", reason: null, mergeBaseSha: null, binaryFiles: 0, contentBytes: native.byteLength,
        };
      }
    }
    const compare = await api.request<unknown>(`${REPOSITORY}/compare/${identity.baseSha}...${identity.headSha}?per_page=1`);
    if (!record(compare) || !record(compare.base_commit) || !record(compare.merge_base_commit) ||
      sha(compare.base_commit.sha, "Comparison base") !== identity.baseSha) {
      throw new Error("The comparison base or merge-base is unavailable or inconsistent.");
    }
    const mergeBaseSha = sha(compare.merge_base_commit.sha, "Merge-base");
    const [base, head] = await Promise.all([
      readCommitTree(api, mergeBaseSha), readCommitTree(api, identity.headSha),
    ]);
    const versions = versionsFromTrees(files, base, head);
    const { blobs, contentBytes } = await readBlobs(api, versions, cacheDirectory);
    const parts: string[] = [];
    let binaryFiles = 0;
    let patchBytes = 0;
    for (const version of versions) {
      const patch = fullFilePatch(version, blobs);
      patchBytes += Buffer.byteLength(patch.text);
      if (patchBytes > MAX_PATCH_BYTES) throw new Error(`Complete patch exceeds the ${MAX_PATCH_BYTES}-byte limit.`);
      parts.push(patch.text);
      if (patch.binary) binaryFiles++;
    }
    await assertCurrentIdentity(api, identity);
    const text = parts.join("");
    return {
      complete: true, changedFiles: files.length, expectedChangedFiles: identity.changedFiles,
      text, digest: createHash("sha256").update(text).digest("hex"), source: "github-blobs",
      reason: null, mergeBaseSha, binaryFiles, contentBytes,
    };
  } catch (error) {
    return unavailable(error instanceof Error ? error.message : "Complete diff collection failed.");
  }
}

import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile, stat, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { describe, expect, it } from "vitest";

import { collectPullRequestDiff, readPullRequestFileManifest, gitBlobSha, type DiffIdentity } from "../scripts/pr-approval/diff.ts";
import type { GitHubApi } from "../scripts/pr-approval-controller.ts";

const BASE = "a".repeat(40);
const HEAD = "b".repeat(40);
const OLD_TREE = "c".repeat(40);
const NEW_TREE = "d".repeat(40);
const ROOT = "/repos/lukemyself-hub/SayHear";
const gitEnvironment = { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" };

type File = {
  path: string;
  old?: Buffer;
  next?: Buffer;
  previousPath?: string;
  oldMode?: string;
  nextMode?: string;
};

// Git provides an independent oracle for content identity and patch correctness.
function blobSha(bytes: Buffer): string {
  return execFileSync("/usr/bin/git", ["hash-object", "--stdin"], {
    input: bytes, env: gitEnvironment,
  }).toString().trim();
}

function fixture(files: File[]) {
  const blobs = new Map<string, Buffer>();
  const oldEntries: Record<string, unknown>[] = [];
  const newEntries: Record<string, unknown>[] = [];
  const values = files.map((file) => {
    const oldSha = file.old ? blobSha(file.old) : null;
    const nextSha = file.next ? blobSha(file.next) : null;
    const oldPath = file.previousPath ?? file.path;
    if (file.old) {
      blobs.set(oldSha!, file.old);
      oldEntries.push({ path: oldPath, sha: oldSha, mode: file.oldMode ?? "100644", type: "blob", size: file.old.length });
    }
    if (file.next) {
      blobs.set(nextSha!, file.next);
      newEntries.push({ path: file.path, sha: nextSha, mode: file.nextMode ?? "100644", type: "blob", size: file.next.length });
    }
    return {
      filename: file.path, previous_filename: file.previousPath,
      sha: nextSha ?? oldSha,
      additions: file.old?.equals(file.next ?? Buffer.alloc(0)) ? 0 : file.next?.toString().split("\n").filter(Boolean).length ?? 0,
      deletions: file.old?.equals(file.next ?? Buffer.alloc(0)) ? 0 : file.old?.toString().split("\n").filter(Boolean).length ?? 0,
      status: file.previousPath ? "renamed" : !file.old ? "added" : !file.next ? "removed" : "modified",
    };
  });
  const identity: DiffIdentity = { number: 333, baseSha: BASE, headSha: HEAD, changedFiles: files.length };
  const responses = new Map<string, unknown>([
    [`${ROOT}/compare/${BASE}...${HEAD}?per_page=1`, { base_commit: { sha: BASE }, merge_base_commit: { sha: BASE } }],
    [`${ROOT}/git/commits/${BASE}`, { sha: BASE, tree: { sha: OLD_TREE } }],
    [`${ROOT}/git/commits/${HEAD}`, { sha: HEAD, tree: { sha: NEW_TREE } }],
    [`${ROOT}/git/trees/${OLD_TREE}?recursive=1`, { sha: OLD_TREE, truncated: false, tree: oldEntries }],
    [`${ROOT}/git/trees/${NEW_TREE}?recursive=1`, { sha: NEW_TREE, truncated: false, tree: newEntries }],
    [`${ROOT}/pulls/333`, { head: { sha: HEAD }, base: { sha: BASE }, changed_files: files.length }],
  ]);
  const reads: string[] = [];
  let native: Buffer | null = null;
  let corruptBlob = false;
  const api: GitHubApi = {
    async request<T>(path: string): Promise<T> {
      reads.push(path);
      if (!responses.has(path)) throw new Error(`Unexpected API request ${path}`);
      return responses.get(path) as T;
    },
    async pages<T>(): Promise<T[]> { throw new Error("File pagination belongs to the snapshot collector"); },
    async bytes(path: string): Promise<Uint8Array> {
      reads.push(path);
      if (path.includes("/compare/")) {
        if (!native) throw new Error("HTTP 406: too many files");
        return native;
      }
      const value = blobs.get(path.split("/").at(-1)!);
      if (!value) throw new Error(`Missing blob ${path}`);
      return corruptBlob ? Buffer.from("forged content") : value;
    },
  };
  return {
    api, identity, values, responses, reads, newEntries, oldEntries, blobs,
    setNative: (bytes: Buffer) => { native = bytes; },
    corrupt: () => { corruptBlob = true; },
  };
}

async function applyAndVerify(files: File[], patch: string): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "sayhear-pr-diff-"));
  try {
    for (const file of files) {
      if (!file.old) continue;
      const path = join(directory, file.previousPath ?? file.path);
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, file.old, { mode: file.oldMode === "100755" ? 0o755 : 0o644 });
    }
    execFileSync("/usr/bin/git", ["apply", "--binary", "--whitespace=nowarn", "-"], {
      cwd: directory, input: patch, env: gitEnvironment,
    });
    for (const file of files) {
      if (file.next) expect(await readFile(join(directory, file.path))).toEqual(file.next);
      else await expect(stat(join(directory, file.path))).rejects.toThrow();
      if (file.previousPath) await expect(stat(join(directory, file.previousPath))).rejects.toThrow();
      if (file.nextMode === "100755") expect((await stat(join(directory, file.path))).mode & 0o111).not.toBe(0);
    }
    // The reverse literal section must restore binary and text contents too.
    execFileSync("/usr/bin/git", ["apply", "--binary", "--reverse", "--whitespace=nowarn", "-"], {
      cwd: directory, input: patch, env: gitEnvironment,
    });
    for (const file of files) {
      if (file.old) expect(await readFile(join(directory, file.previousPath ?? file.path))).toEqual(file.old);
      else await expect(stat(join(directory, file.path))).rejects.toThrow();
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
}

describe("PR complete diff collection", () => {
  it("matches Git's blob identity including the header and raw binary bytes", () => {
    for (const data of [Buffer.alloc(0), Buffer.from("hello\n"), Buffer.from([0, 255, 42])]) {
      expect(gitBlobSha(data)).toBe(blobSha(data));
    }
  });

  it("collects more than 300 files without calling the whole-diff endpoint", async () => {
    const files = Array.from({ length: 301 }, (_, index) => ({ path: `cases/${index}.txt`, next: Buffer.from("new\n") }));
    const f = fixture(files);
    const diff = await collectPullRequestDiff(f.api, f.identity, f.values);
    expect(diff).toMatchObject({ complete: true, source: "github-blobs", changedFiles: 301, mergeBaseSha: BASE });
    expect(diff.text.match(/^diff --git /gm)).toHaveLength(301);
    expect(f.reads.filter((path) => path === `${ROOT}/pulls/333`)).toHaveLength(1);
    expect(f.reads.filter((path) => path.includes("/git/blobs/"))).toHaveLength(1);
    await applyAndVerify(files, diff.text);
  });

  it("reconstructs text, binary, rename, mode, deletion and missing-newline patches that Git applies in both directions", async () => {
    const files: File[] = [
      { path: "text.txt", old: Buffer.from("old\r\nvalue\n"), next: Buffer.from("new\r\nvalue") },
      { path: "created.txt", next: Buffer.from("created without newline") },
      { path: "removed.txt", old: Buffer.from("remove\n") },
      { path: "renamed.txt", previousPath: "original.txt", old: Buffer.from("unchanged\n"), next: Buffer.from("unchanged\n") },
      { path: "mode.txt", old: Buffer.from("mode\n"), next: Buffer.from("mode\n"), nextMode: "100755" },
      { path: "capture.bin", old: Buffer.from([0, 1, 255, 10]), next: Buffer.from([0, 3, 254, 13]) },
      { path: "new.bin", next: Buffer.from([0, 127, 255]) },
      { path: "removed.bin", old: Buffer.from([0, 42, 255]) },
      { path: "invalid-utf8.bin", next: Buffer.from([0xc0, 0x80]) },
      { path: "中文 space.txt", next: Buffer.from("source\n") },
      { path: "quote\"tab\t.txt", next: Buffer.from("quoted\n") },
      { path: "empty.txt", next: Buffer.alloc(0) },
    ];
    const f = fixture(files);
    const diff = await collectPullRequestDiff(f.api, f.identity, f.values);
    expect(diff).toMatchObject({ complete: true, source: "github-blobs", binaryFiles: 4 });
    expect(diff.text).toContain("GIT binary patch");
    expect(diff.text).not.toContain("Binary files ");
    await applyAndVerify(files, diff.text);
    expect((await collectPullRequestDiff(f.api, f.identity, [...f.values].reverse())).digest).toBe(diff.digest);
  });

  it("preserves ordinary native text diffs and their digest without fetching blobs", async () => {
    const f = fixture([{ path: "file.txt", old: Buffer.from("old\n"), next: Buffer.from("new\n") }]);
    const native = Buffer.from(`diff --git a/file.txt b/file.txt\nindex ${blobSha(Buffer.from("old\n"))}..${f.values[0]!.sha} 100644\n--- a/file.txt\n+++ b/file.txt\n@@ -1 +1 @@\n-old\n+new\n`);
    f.setNative(native);
    const diff = await collectPullRequestDiff(f.api, f.identity, f.values);
    expect(diff).toMatchObject({ complete: true, source: "github-diff", text: native.toString() });
    expect(f.reads).not.toContain(`${ROOT}/git/commits/${HEAD}`);
  });

  it("does not accept a header-only mode change as a complete native diff", async () => {
    const f = fixture([{ path: "mode.txt", old: Buffer.from("mode\n"), next: Buffer.from("mode\n"), nextMode: "100755" }]);
    f.setNative(Buffer.from("diff --git a/mode.txt b/mode.txt\n"));
    const diff = await collectPullRequestDiff(f.api, f.identity, f.values);
    expect(diff).toMatchObject({ complete: true, source: "github-blobs" });
    expect(diff.text).toContain("old mode 100644\nnew mode 100755");
  });

  it("retains the file-list API failure for a diagnostic packet without claiming completeness", async () => {
    const f = fixture([{ path: "file.txt", next: Buffer.from("content\n") }]);
    const manifest = await readPullRequestFileManifest(f.api, 333);
    expect(manifest).toEqual({ files: [], error: "File pagination belongs to the snapshot collector" });
    const diff = await collectPullRequestDiff(f.api, f.identity, manifest.files);
    expect(diff.complete).toBe(false);
    expect(diff.text).toBe("");
    expect(f.reads).toEqual([]);
  });

  it("does not accept a same-count native diff for different paths", async () => {
    const f = fixture([{ path: "real.txt", next: Buffer.from("real\n") }]);
    f.setNative(Buffer.from("diff --git a/fake.txt b/fake.txt\n+fake\n"));
    const diff = await collectPullRequestDiff(f.api, f.identity, f.values);
    expect(diff).toMatchObject({ complete: true, source: "github-blobs" });
    expect(diff.text).toContain("a/real.txt b/real.txt");
  });

  it("falls back when native hunks are truncated despite retaining all file headers", async () => {
    const f = fixture([{ path: "file.txt", old: Buffer.from("old\n"), next: Buffer.from("new\n") }]);
    f.setNative(Buffer.from("diff --git a/file.txt b/file.txt\n--- a/file.txt\n+++ b/file.txt\n@@ -1 +1 @@\n-old\n"));
    expect((await collectPullRequestDiff(f.api, f.identity, f.values)).source).toBe("github-blobs");
  });

  it("falls back when complete hunks omit a change counted by the file manifest", async () => {
    const f = fixture([{ path: "file.txt", old: Buffer.from("old\n"), next: Buffer.from("new\n") }]);
    f.values[0]!.additions = 2;
    f.setNative(Buffer.from("diff --git a/file.txt b/file.txt\n--- a/file.txt\n+++ b/file.txt\n@@ -1 +1 @@\n-old\n+new\n"));
    expect((await collectPullRequestDiff(f.api, f.identity, f.values)).source).toBe("github-blobs");
  });

  it("does not call truncated per-file patches complete", async () => {
    const f = fixture([{ path: "file.txt", next: Buffer.from("full content\n") }]);
    const diff = await collectPullRequestDiff(f.api, f.identity, f.values.map((value) => ({ ...value, patch: "+truncated" })));
    expect(diff.complete).toBe(true);
    expect(diff.text).toContain("+full content");
    expect(diff.text).not.toContain("+truncated");
  });

  it.each(["count", "duplicate", "unsafe", "unsupported"])("rejects an incomplete or invalid manifest: %s", async (kind) => {
    const f = fixture([{ path: "file.txt", next: Buffer.from("content\n") }]);
    const identity = kind === "count" || kind === "duplicate" ? { ...f.identity, changedFiles: 2 } : f.identity;
    const values = kind === "duplicate" ? [f.values[0], f.values[0]] :
      kind === "unsafe" ? [{ ...f.values[0], filename: "../escape" }] :
      kind === "unsupported" ? [{ ...f.values[0], status: "unknown" }] : f.values;
    const diff = await collectPullRequestDiff(f.api, identity, values);
    expect(diff.complete).toBe(false);
    expect(diff.text).toBe("");
    expect(f.reads).toEqual([]);
  });

  it("rejects omissions that the manifest count alone cannot detect", async () => {
    const f = fixture([{ path: "file.txt", next: Buffer.from("content\n") }]);
    f.newEntries.push({ path: "hidden.txt", sha: blobSha(Buffer.from("hidden")), mode: "100644", type: "blob", size: 6 });
    const diff = await collectPullRequestDiff(f.api, f.identity, f.values);
    expect(diff).toMatchObject({ complete: false, source: "unavailable" });
    expect(diff.reason).toContain("omits changes");
  });

  it.each(["truncated", "identity", "blob-sha", "oversized", "submodule"])("fails closed for bad authenticated metadata: %s", async (kind) => {
    const f = fixture([{ path: "file.txt", next: Buffer.from("content\n") }]);
    if (kind === "truncated") f.responses.set(`${ROOT}/git/trees/${NEW_TREE}?recursive=1`, { sha: NEW_TREE, truncated: true, tree: f.newEntries });
    if (kind === "identity") f.responses.set(`${ROOT}/git/commits/${HEAD}`, { sha: BASE, tree: { sha: NEW_TREE } });
    if (kind === "blob-sha") f.values[0]!.sha = "f".repeat(40);
    if (kind === "oversized") f.newEntries[0]!.size = 9 * 1024 * 1024;
    if (kind === "submodule") Object.assign(f.newEntries[0]!, { mode: "160000", type: "commit" });
    const diff = await collectPullRequestDiff(f.api, f.identity, f.values);
    expect(diff.complete).toBe(false);
    expect(diff.reason).toBeTruthy();
    expect(f.reads.some((path) => path.includes("/git/blobs/"))).toBe(false);
  });

  it("rejects wrong raw blob bytes even when metadata claims the right SHA", async () => {
    const f = fixture([{ path: "file.txt", next: Buffer.from("content\n") }]);
    f.corrupt();
    const diff = await collectPullRequestDiff(f.api, f.identity, f.values);
    expect(diff.complete).toBe(false);
    expect(diff.reason).toContain("Git SHA verification");
  });

  it("rechecks the PR identity after reading content", async () => {
    const f = fixture([{ path: "file.txt", next: Buffer.from("content\n") }]);
    f.responses.set(`${ROOT}/pulls/333`, { head: { sha: "e".repeat(40) }, base: { sha: BASE }, changed_files: 1 });
    const diff = await collectPullRequestDiff(f.api, f.identity, f.values);
    expect(diff.complete).toBe(false);
    expect(diff.reason).toContain("changed during diff collection");
  });

  it("rejects an aggregate content budget overflow before fetching any blob", async () => {
    const f = fixture(Array.from({ length: 10 }, (_, index) => ({ path: `${index}.txt`, next: Buffer.from("content\n") })));
    for (const entry of f.newEntries) entry.size = 7 * 1024 * 1024;
    const diff = await collectPullRequestDiff(f.api, f.identity, f.values);
    expect(diff.complete).toBe(false);
    expect(diff.reason).toContain("Complete content exceeds");
    expect(f.reads.some((path) => path.includes("/git/blobs/"))).toBe(false);
  });

  it("ignores a cache symlink and reads verified content from the API", async () => {
    const directory = await mkdtemp(join(tmpdir(), "sayhear-pr-cache-link-"));
    try {
      const f = fixture([{ path: "file.txt", next: Buffer.from("content\n") }]);
      const target = join(directory, "target");
      await writeFile(target, "content\n");
      await symlink(target, join(directory, f.values[0]!.sha!));
      const diff = await collectPullRequestDiff(f.api, f.identity, f.values, directory);
      expect(diff.complete).toBe(true);
      expect(f.reads.filter((path) => path.includes("/git/blobs/"))).toHaveLength(1);
      expect(await readFile(target, "utf8")).toBe("content\n");
    } finally { await rm(directory, { recursive: true, force: true }); }
  });

  it("uses content-addressed cache only after hash verification and replaces polluted entries", async () => {
    const directory = await mkdtemp(join(tmpdir(), "sayhear-pr-blob-cache-"));
    try {
      const f = fixture([{ path: "file.txt", next: Buffer.from("content\n") }]);
      const first = await collectPullRequestDiff(f.api, f.identity, f.values, directory);
      const rawCount = () => f.reads.filter((path) => path.includes("/git/blobs/")).length;
      expect(rawCount()).toBe(1);
      expect((await collectPullRequestDiff(f.api, f.identity, f.values, directory)).digest).toBe(first.digest);
      expect(rawCount()).toBe(1);
      await writeFile(join(directory, f.values[0]!.sha!), "forged!\n");
      expect((await collectPullRequestDiff(f.api, f.identity, f.values, directory)).complete).toBe(true);
      expect(rawCount()).toBe(2);
      expect(await readFile(join(directory, f.values[0]!.sha!))).toEqual(Buffer.from("content\n"));
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
});

import { createSign, createVerify, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, readdir, rename, unlink } from "node:fs/promises";
import { dirname, resolve } from "node:path";

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function positive(value: number): number {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error("signed_store_path_invalid");
  return value;
}
// Signatures give the user-owned directory integrity without granting the
// controller root privileges. Recovery still independently checks GitHub.
export class SignedJsonStore<T> {
  constructor(private readonly directory: string, private readonly privateKey: string, private readonly publicKey: string, private readonly parse: (value: unknown) => T, private readonly numberOf: (value: T) => number, private readonly label = "signed_store") {}
  private path(number: number): string { return resolve(this.directory, `pr-${positive(number)}.json`); }
  private async assertDirectory(): Promise<void> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const info = await lstat(this.directory);
    if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== process.getuid?.() || (info.mode & 0o077) !== 0) throw new Error(`${this.label}_directory_untrusted`);
    let parent = dirname(this.directory);
    while (parent !== dirname(parent)) {
      const parentInfo = await lstat(parent);
      if (!parentInfo.isDirectory() || parentInfo.isSymbolicLink() || ((parentInfo.mode & 0o022) !== 0 && (parentInfo.mode & 0o1000) === 0) ||
        (parentInfo.uid !== 0 && parentInfo.uid !== process.getuid?.())) throw new Error(`${this.label}_directory_untrusted`);
      parent = dirname(parent);
    }
  }
  async read(number: number): Promise<T | null> {
    await this.assertDirectory();
    let handle;
    try { handle = await open(this.path(number), constants.O_RDONLY | constants.O_NOFOLLOW); }
    catch (error) { if (record(error) && error.code === "ENOENT") return null; throw error; }
    try {
      const info = await handle.stat();
      if (!info.isFile() || info.uid !== process.getuid?.() || (info.mode & 0o077) !== 0 || info.size > 32_000) throw new Error(`${this.label}_file_untrusted`);
      const bytes = Buffer.alloc(32_001);
      const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
      if (bytesRead > 32_000) throw new Error(`${this.label}_file_untrusted`);
      const envelope: unknown = JSON.parse(bytes.subarray(0, bytesRead).toString("utf8"));
      if (!record(envelope) || typeof envelope.payload !== "string" || typeof envelope.signature !== "string") throw new Error(`${this.label}_signature_invalid`);
      const verifier = createVerify("RSA-SHA256").update(envelope.payload).end();
      if (!verifier.verify(this.publicKey, envelope.signature, "base64")) throw new Error(`${this.label}_signature_invalid`);
      const value = this.parse(JSON.parse(envelope.payload));
      if (this.numberOf(value) !== number) throw new Error(`${this.label}_path_mismatch`);
      return value;
    } finally { await handle.close(); }
  }
  async save(value: T): Promise<void> {
    await this.assertDirectory();
    const payload = JSON.stringify(this.parse(value));
    const signature = createSign("RSA-SHA256").update(payload).end().sign(this.privateKey, "base64");
    const temporary = `${this.path(this.numberOf(value))}.${randomUUID()}.tmp`;
    const handle = await open(temporary, "wx", 0o600);
    try {
      await handle.writeFile(JSON.stringify({ payload, signature }));
      await handle.sync();
    } finally { await handle.close(); }
    try {
      await rename(temporary, this.path(this.numberOf(value)));
      const directoryHandle = await open(this.directory, "r");
      try { await directoryHandle.sync(); } finally { await directoryHandle.close(); }
    } finally { await unlink(temporary).catch(() => undefined); }
  }
  async list(): Promise<T[]> {
    await this.assertDirectory();
    const names = await readdir(this.directory);
    const results: T[] = [];
    for (const name of names) {
      const match = /^pr-([1-9]\d*)\.json$/.exec(name);
      if (!match) continue;
      if (results.length >= 1_000) throw new Error(`${this.label}_record_limit`);
      const value = await this.read(Number(match[1]));
      if (value) results.push(value);
    }
    return results;
  }
}


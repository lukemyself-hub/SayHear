import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { acquireExclusiveLock } from "./exclusive-lock";

describe("exclusive cross-process lock", () => {
  const directories: string[] = [];
  const lockPath = () => {
    const directory = mkdtempSync(path.join(tmpdir(), "sayhear-lock-"));
    directories.push(directory);
    return path.join(directory, "nested", "dev-server.lock");
  };

  afterEach(() => {
    for (const directory of directories.splice(0)) {
      rmSync(directory, { force: true, recursive: true });
    }
  });

  it("makes a second holder wait until the first releases", async () => {
    const lock = lockPath();
    const order: string[] = [];
    const releaseFirst = await acquireExclusiveLock(lock);
    order.push("first acquired");
    const second = acquireExclusiveLock(lock, { pollMs: 5 }).then((release) => {
      order.push("second acquired");
      return release;
    });
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(order).toEqual(["first acquired"]);
    releaseFirst();
    const releaseSecond = await second;
    expect(order).toEqual(["first acquired", "second acquired"]);
    releaseSecond();
    // Released locks can be taken again immediately.
    (await acquireExclusiveLock(lock))();
  });

  it("takes over a lock whose holder process no longer exists", async () => {
    const lock = lockPath();
    mkdirSync(lock, { recursive: true });
    // PID 2^31-1 is never a live process.
    writeFileSync(path.join(lock, "pid"), "2147483647");
    const release = await acquireExclusiveLock(lock, { pollMs: 5, timeoutMs: 1_000 });
    release();
  });

  it("fails with a clear error instead of waiting forever", async () => {
    const lock = lockPath();
    const release = await acquireExclusiveLock(lock);
    await expect(
      acquireExclusiveLock(lock, { pollMs: 5, timeoutMs: 30 }),
    ).rejects.toThrow(/held by process/);
    release();
  });
});

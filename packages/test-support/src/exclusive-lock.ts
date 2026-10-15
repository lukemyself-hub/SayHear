import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

/**
 * A cross-process exclusive lock backed by an atomic `mkdir`.
 *
 * Next.js allows only one `next dev` per project directory, so two suites that
 * each start the real web app cannot overlap when the test runner uses more
 * than one worker. They serialise on this lock instead of failing at random.
 * A lock left behind by a process that no longer exists is taken over.
 */
export async function acquireExclusiveLock(
  lockDirectory: string,
  options: Readonly<{ pollMs?: number; timeoutMs?: number }> = {},
): Promise<() => void> {
  const pollMs = options.pollMs ?? 250;
  const deadline = Date.now() + (options.timeoutMs ?? 10 * 60_000);
  const pidFile = path.join(lockDirectory, "pid");
  mkdirSync(path.dirname(lockDirectory), { recursive: true });

  for (;;) {
    try {
      mkdirSync(lockDirectory);
      writeFileSync(pidFile, String(process.pid));
      let released = false;
      return () => {
        if (released) return;
        released = true;
        rmSync(lockDirectory, { force: true, recursive: true });
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }

    let holder: number | null = null;
    try {
      holder = Number(readFileSync(pidFile, "utf8"));
    } catch {
      // The holder is between mkdir and writing its pid; look again shortly.
    }
    if (holder !== null && Number.isInteger(holder) && !isAlive(holder)) {
      rmSync(lockDirectory, { force: true, recursive: true });
      continue;
    }
    if (Date.now() >= deadline) {
      throw new Error(
        `Lock ${lockDirectory} is still held by process ${holder ?? "unknown"}.`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means the process exists but belongs to someone else.
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * The lock every suite takes before starting `next dev` in `apps/web`. It
 * lives under `node_modules/.cache`, which is never tracked and which Next
 * does not clear on start.
 */
export function acquireNextDevServerLock(
  webDirectory: string,
): Promise<() => void> {
  return acquireExclusiveLock(
    path.join(webDirectory, "node_modules", ".cache", "sayhear-next-dev.lock"),
  );
}

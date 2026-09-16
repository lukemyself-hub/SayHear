import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { loadDotEnv } from "../eval/memory-pairwise-126/shared";

const KEY = "SAYHEAR_TEST_ENV_FILE_OVERRIDE";
const original = process.env[KEY];

afterEach(() => {
  if (original === undefined) delete process.env[KEY];
  else process.env[KEY] = original;
});

describe("evaluation env-file loading", () => {
  it("overrides a stale inherited value only when explicitly requested", () => {
    const directory = mkdtempSync(join(tmpdir(), "sayhear-env-"));
    const file = join(directory, ".env.neon");
    writeFileSync(file, `${KEY}=fresh&literal\n`, "utf8");
    process.env[KEY] = "stale";

    try {
      loadDotEnv({ path: file });
      expect(process.env[KEY]).toBe("stale");

      loadDotEnv({ override: true, path: file });
      expect(process.env[KEY]).toBe("fresh&literal");
    } finally {
      rmSync(directory, { force: true, recursive: true });
    }
  });

  it("rejects a missing explicit env file", () => {
    expect(() =>
      loadDotEnv({
        override: true,
        path: join(tmpdir(), "sayhear-missing-env-file"),
      }),
    ).toThrow(/does not exist/i);
  });
});

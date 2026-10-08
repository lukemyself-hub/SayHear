import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import {
  assertRepositoryIncludesCommit,
  repositoryRoot,
} from "../scripts/verify-1a3b-g1-evidence";

function git(...arguments_: string[]): string {
  return execFileSync("git", arguments_, {
    cwd: repositoryRoot,
    encoding: "utf8",
  }).trim();
}

describe("G1 release checkout identity", () => {
  const head = git("rev-parse", "HEAD");
  const parent = git("rev-parse", "HEAD~1");

  it("accepts the acceptance commit itself and a later checkout that contains it", () => {
    expect(() => assertRepositoryIncludesCommit(head)).not.toThrow();
    // ADR-0148: an operator may verify or roll back from a later commit without
    // re-accepting; the accepted commit only has to be in this checkout.
    expect(() => assertRepositoryIncludesCommit(parent)).not.toThrow();
  });

  it("refuses a commit that is not part of the current checkout", () => {
    expect(() => assertRepositoryIncludesCommit("f".repeat(40))).toThrow(
      /not contained in the current checkout/,
    );
  });
});

describe("same-configuration G1 release path does not start the full producer", () => {
  const producerReference = "produce-1a3b-g1-evidence";

  for (const file of [
    "apps/web/src/runtime-config.ts",
    "apps/web/src/server-composition.ts",
    "apps/web/src/validate-startup.ts",
    "scripts/activate-1a3b-g1.ts",
    "scripts/verify-1a3b-g1-release-manifest.ts",
    "scripts/rollback-1a3b-g1.ts",
  ]) {
    it(`${file} does not reference the full evidence producer`, () => {
      const source = readFileSync(resolve(repositoryRoot, file), "utf8");
      expect(source).not.toContain(producerReference);
      expect(source).not.toContain("release:g1:produce");
    });
  }
});

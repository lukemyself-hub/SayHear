import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));

describe("Workflow deployment boundaries", () => {
  it("does not activate a Vercel Cron before the production reliability gate", async () => {
    const configuration = JSON.parse(
      await readFile(`${repositoryRoot}apps/web/vercel.json`, "utf8"),
    ) as {
      crons?: readonly { path?: string; schedule?: string }[];
    };

    expect(configuration.crons).toBeUndefined();
  });

  it("keeps every deployed durable entrypoint on stable Workflow v4", async () => {
    const webPackage = JSON.parse(
      await readFile(`${repositoryRoot}apps/web/package.json`, "utf8"),
    ) as { dependencies?: Record<string, string> };
    expect(webPackage.dependencies?.workflow).toMatch(/^\^?4\./);

    for (const entrypoint of [
      "journal-eligibility.workflow.ts",
      "dialogue-state.workflow.ts",
      "owner-full-purge.workflow.ts",
      "rolling-summary.workflow.ts",
    ]) {
      const source = await readFile(
        `${repositoryRoot}apps/web/src/workflows/${entrypoint}`,
        "utf8",
      );
      expect(source).toContain('"use workflow"');
      expect(source).toContain('"use step"');
    }
  });
});

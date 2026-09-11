import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));

type WebPackage = {
  scripts?: {
    build?: string;
    prestart?: string;
  };
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
};

describe("Web startup validation runtime", () => {
  it("runs prestart through a production-available TypeScript runtime", async () => {
    const webPackage = JSON.parse(
      await readFile(`${repositoryRoot}apps/web/package.json`, "utf8"),
    ) as WebPackage;

    expect(webPackage.dependencies?.tsx).toBe("4.23.1");
    expect(webPackage.devDependencies?.tsx).toBeUndefined();
    expect(webPackage.scripts?.prestart).toBe("tsx src/validate-startup.ts");
    expect(webPackage.scripts?.build).toBe(
      "tsx src/validate-startup.ts && next build --webpack && node ../../scripts/check-browser-bundle.mjs",
    );

    const result = spawnSync(
      `${repositoryRoot}apps/web/node_modules/.bin/tsx`,
      ["src/validate-startup.ts"],
      {
        cwd: `${repositoryRoot}apps/web`,
        encoding: "utf8",
        env: {
          ...process.env,
          CI: "true",
          NODE_ENV: "test",
          SAYHEAR_DEPLOYMENT: "test",
          SAYHEAR_EPISODE_BUILD_ENABLED: undefined,
          SAYHEAR_1A_3B_G1_RELEASE_MANIFEST: undefined,
          SAYHEAR_REFLECTION_ENABLED: undefined,
        },
      },
    );
    const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;

    expect(result.status, output).toBe(0);
    expect(output).not.toContain("ERR_MODULE_NOT_FOUND");
  });
});

import { execFile } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { afterEach, describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const temporaryRoots: string[] = [];

describe("Provider module and credential boundaries", () => {
  afterEach(async () => {
    await Promise.all(
      temporaryRoots.splice(0).map((root) =>
        rm(root, { force: true, recursive: true }),
      ),
    );
  });

  it("rejects Browser access to the Provider adapter and credential", async () => {
    const root = await mkdtemp(join(tmpdir(), "sayhear-boundary-fixture-"));
    temporaryRoots.push(root);
    for (const directory of [
      "apps/web/app",
      "apps/web/src",
      "packages/ai/src",
      "packages/application/src",
      "packages/data/src",
      "packages/domain/src",
      "packages/test-support/src",
    ]) {
      await mkdir(join(root, directory), { recursive: true });
    }
    await writeFile(
      join(root, "apps/web/app/provider-client.tsx"),
      [
        '"use client";',
        'import { createResponsesApiConversationTextModel } from "@sayhear/ai";',
        "export const leakedCredential = process.env.OPENAI_API_KEY;",
      ].join("\n"),
      "utf8",
    );
    await writeFile(
      join(root, "apps/web/src/ordinary-provider-service.ts"),
      [
        'import { createProviderEgressPort } from "@sayhear/ai/testing";',
        "export const leakedCredential = process.env.OPENAI_API_KEY;",
      ].join("\n"),
      "utf8",
    );

    const result = await execFileAsync(
      process.execPath,
      ["scripts/check-boundaries.mjs"],
      {
        cwd: process.cwd(),
        env: {
          ...process.env,
          SAYHEAR_BOUNDARY_ROOT: root,
        },
      },
    ).then(
      () => ({ exitCode: 0, output: "" }),
      (error: { code?: number; stderr?: string; stdout?: string }) => ({
        exitCode: error.code ?? 1,
        output: `${error.stdout ?? ""}${error.stderr ?? ""}`,
      }),
    );

    expect(result.exitCode).toBe(1);
    expect(result.output).toContain(
      "Browser module imports forbidden @sayhear/ai",
    );
    expect(result.output).toContain(
      "provider-client.tsx references server-only OPENAI_API_KEY",
    );
    expect(result.output).toContain(
      "ordinary-provider-service.ts imports Provider adapter outside Egress",
    );
    expect(result.output).toContain(
      "ordinary-provider-service.ts references server-only OPENAI_API_KEY",
    );
  });

  it("fails a build when a server-only credential reaches a Browser bundle", async () => {
    const root = await mkdtemp(join(tmpdir(), "sayhear-bundle-fixture-"));
    temporaryRoots.push(root);
    await mkdir(root, { recursive: true });
    await writeFile(
      join(root, "client.js"),
      'globalThis.leaked = "BUNDLE_PROVIDER_CREDENTIAL_CANARY";',
      "utf8",
    );

    const result = await execFileAsync(
      process.execPath,
      ["scripts/check-browser-bundle.mjs"],
      {
        cwd: process.cwd(),
        env: {
          ...process.env,
          OPENAI_API_KEY: "BUNDLE_PROVIDER_CREDENTIAL_CANARY",
          SAYHEAR_WEB_BUILD_ROOT: root,
        },
      },
    ).then(
      () => ({ exitCode: 0, output: "" }),
      (error: { code?: number; stderr?: string; stdout?: string }) => ({
        exitCode: error.code ?? 1,
        output: `${error.stdout ?? ""}${error.stderr ?? ""}`,
      }),
    );

    expect(result.exitCode).toBe(1);
    expect(result.output).toContain(
      "Browser bundle contains server-only OPENAI_API_KEY",
    );
    expect(result.output).not.toContain(
      "BUNDLE_PROVIDER_CREDENTIAL_CANARY",
    );
  });
});

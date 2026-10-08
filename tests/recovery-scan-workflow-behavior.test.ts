import { execFile } from "node:child_process";
import { createServer, type Server } from "node:http";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";

import { afterEach, describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));
const recoveryWorkflowPath = `${repositoryRoot}.github/workflows/internal-recovery-scan.yml`;
const cronSecret = "test-cron-secret";
const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) =>
      rm(root, { force: true, recursive: true }),
    ),
  );
});

// Mirrors the workflow's step extraction: the first `run: |` after the named
// `- name:` step, de-indented to the smallest common indentation.
function extractRunBlock(source: string, stepName: string): string {
  const lines = source.split("\n");
  const start = lines.findIndex((line) => line.trim() === `- name: ${stepName}`);
  if (start < 0) {
    throw new Error(`workflow step not found: ${stepName}`);
  }
  const runIndex = lines.findIndex(
    (line, index) => index > start && /^\s+run: \|\s*$/.test(line),
  );
  if (runIndex < 0) {
    throw new Error(`run block not found for step: ${stepName}`);
  }
  const runLine = lines[runIndex];
  if (runLine === undefined) {
    throw new Error(`run block not found for step: ${stepName}`);
  }
  const runIndent = runLine.match(/^\s*/)?.[0].length ?? 0;
  const body: string[] = [];
  for (let index = runIndex + 1; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    const indent = line.match(/^\s*/)?.[0].length ?? 0;
    if (line.trim() !== "" && indent <= runIndent) {
      break;
    }
    body.push(line);
  }
  const bodyIndent = Math.min(
    ...body
      .filter((line) => line.trim() !== "")
      .map((line) => line.match(/^\s*/)?.[0].length ?? 0),
  );
  return body.map((line) => line.slice(bodyIndent)).join("\n");
}

async function runBash(
  script: string,
  environment: Record<string, string>,
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  return execFileAsync("bash", ["-c", script], {
    env: { ...process.env, ...environment },
  }).then(
    ({ stdout, stderr }) => ({ exitCode: 0, stdout, stderr }),
    (error: { code?: number; stdout?: string; stderr?: string }) => ({
      exitCode: error.code ?? 1,
      stdout: error.stdout ?? "",
      stderr: error.stderr ?? "",
    }),
  );
}

type RecordedRequest = {
  url: string;
  method: string;
  authorization: string | null;
};

async function startHttpFixture(handler: () => { status: number }): Promise<{
  origin: string;
  requests: RecordedRequest[];
  close: () => Promise<void>;
}> {
  const requests: RecordedRequest[] = [];
  const server: Server = createServer((request, response) => {
    requests.push({
      url: request.url ?? "",
      method: request.method ?? "",
      authorization: request.headers.authorization ?? null,
    });
    const { status } = handler();
    response.statusCode = status;
    response.end("{}");
  });
  await new Promise<void>((resolve) =>
    server.listen(0, "127.0.0.1", resolve),
  );
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("fixture server did not bind a TCP port");
  }
  return {
    origin: `http://127.0.0.1:${address.port}`,
    requests,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
  };
}

const fetchStubSource = `
import { writeFileSync } from "node:fs";
globalThis.fetch = async (url, init) => {
  writeFileSync(process.env.FIXTURE_RECORD, JSON.stringify({
    url: String(url),
    method: init?.method ?? "GET",
    authorization: init?.headers?.Authorization ?? init?.headers?.authorization ?? null,
    hasAbortSignal: Boolean(init?.signal),
  }));
  if (process.env.FIXTURE_FAIL === "timeout") {
    const error = new Error("The operation was aborted due to timeout");
    error.name = "TimeoutError";
    throw error;
  }
  return new Response(process.env.FIXTURE_BODY ?? "{}", {
    status: Number(process.env.FIXTURE_STATUS ?? "200"),
  });
};
`;

async function runScopedStep(options: {
  endpoint: string;
  mode: "identity" | "recovery";
  fixture: { status?: number; body?: unknown; fail?: "timeout" };
}): Promise<{
  exitCode: number;
  stdout: string;
  stderr: string;
  request: (RecordedRequest & { hasAbortSignal: boolean }) | null;
}> {
  const root = await mkdtemp(join(tmpdir(), "sayhear-fetch-stub-"));
  temporaryRoots.push(root);
  const preloadPath = join(root, "preload.mjs");
  const recordPath = join(root, "request.json");
  await writeFile(preloadPath, fetchStubSource, "utf8");
  const script = extractRunBlock(
    await readFile(recoveryWorkflowPath, "utf8"),
    "Verify scoped production endpoint",
  );
  const result = await runBash(script, {
    CRON_SECRET: cronSecret,
    ENDPOINT: options.endpoint,
    MODE: options.mode,
    FIXTURE_RECORD: recordPath,
    FIXTURE_STATUS: String(options.fixture.status ?? 200),
    FIXTURE_BODY: JSON.stringify(options.fixture.body ?? {}),
    FIXTURE_FAIL: options.fixture.fail ?? "",
    NODE_OPTIONS: `--import=${pathToFileURL(preloadPath).href}`,
  });
  let request:
    | (RecordedRequest & { hasAbortSignal: boolean })
    | null = null;
  try {
    request = JSON.parse(await readFile(recordPath, "utf8")) as typeof request;
  } catch {
    request = null;
  }
  return { ...result, request };
}

const identityBody = {
  version: "1",
  commit: "a".repeat(40),
  environment: "production",
  projectId: "prj_KJD7fJhlIxlOMc4W4goUsIhOaLly",
  teamId: null,
  businessTargetHash: "b".repeat(64),
  purgeMarkerTargetHash: "c".repeat(64),
};
const identityEndpoint =
  "https://say-hear-web.vercel.app/api/internal/inspection/release-identity";
const recoveryEndpoint =
  "https://say-hear-web.vercel.app/api/internal/recovery/scan";

describe("Internal recovery scan workflow behavior", () => {
  it("runs schedule and empty-url dispatch against the configured recovery scan target", async () => {
    const fixture = await startHttpFixture(() => ({ status: 200 }));
    try {
      const script = extractRunBlock(
        await readFile(recoveryWorkflowPath, "utf8"),
        "Call recovery scan endpoint",
      );
      const triggers: Record<string, string>[] = [
        { trigger: "schedule" },
        { trigger: "empty-url dispatch", OVERRIDE_URL: "" },
      ];
      for (const trigger of triggers) {
        const result = await runBash(script, {
          CRON_SECRET: cronSecret,
          CONFIGURED_URL: `${fixture.origin}/api/internal/recovery/scan`,
          ...trigger,
        });
        expect(result.exitCode, `${trigger.trigger}: ${result.stderr}`).toBe(0);
        expect(result.stdout).toContain("status=200");
        expect(result.stdout).not.toContain(cronSecret);
      }
      expect(fixture.requests).toHaveLength(2);
      for (const request of fixture.requests) {
        expect(request.method).toBe("GET");
        expect(request.url).toBe("/api/internal/recovery/scan");
        expect(request.authorization).toBe(`Bearer ${cronSecret}`);
      }
    } finally {
      await fixture.close();
    }
  }, 20_000);

  it("fails the original recovery scan on a non-200 response", async () => {
    const fixture = await startHttpFixture(() => ({ status: 401 }));
    try {
      const result = await runBash(
        extractRunBlock(
          await readFile(recoveryWorkflowPath, "utf8"),
          "Call recovery scan endpoint",
        ),
        {
          CRON_SECRET: cronSecret,
          CONFIGURED_URL: `${fixture.origin}/api/internal/recovery/scan`,
          OVERRIDE_URL: "",
        },
      );
      expect(result.exitCode).not.toBe(0);
      expect(`${result.stdout}${result.stderr}`).toContain(
        "recovery scan returned HTTP 401",
      );
    } finally {
      await fixture.close();
    }
  });

  it(
    "fails the original recovery scan when the request times out",
    { timeout: 8_000 },
    async () => {
      // The fixture never responds. The production workflow ships a fixed
      // `--max-time 120` (spec decision 8 forbids an operator-visible timeout
      // knob); the fixture substitutes the literal so the deadline is short and
      // deterministic to exercise.
      const hanging = createServer(() => {});
      await new Promise<void>((resolve) =>
        hanging.listen(0, "127.0.0.1", resolve),
      );
      const address = hanging.address();
      if (address === null || typeof address === "string") {
        throw new Error("hanging fixture did not bind a TCP port");
      }
      try {
        const script = extractRunBlock(
          await readFile(recoveryWorkflowPath, "utf8"),
          "Call recovery scan endpoint",
        ).replace("--max-time 120", "--max-time 1");
        expect(script).toContain("--max-time 1");
        expect(script).not.toContain("--max-time 120");
        const result = await runBash(script, {
          CRON_SECRET: cronSecret,
          CONFIGURED_URL: `http://127.0.0.1:${address.port}/api/internal/recovery/scan`,
          OVERRIDE_URL: "",
        });
        expect(result.exitCode).not.toBe(0);
      } finally {
        await new Promise<void>((resolve) => hanging.close(() => resolve()));
      }
    },
  );

  it("selects the release-identity route for identity mode and logs no secret", async () => {
    const result = await runScopedStep({
      endpoint: identityEndpoint,
      mode: "identity",
      fixture: { body: identityBody },
    });

    expect(result.exitCode, result.stderr).toBe(0);
    expect(result.request?.url).toBe(identityEndpoint);
    expect(result.request?.method).toBe("GET");
    expect(result.request?.authorization).toBe(`Bearer ${cronSecret}`);
    expect(result.request?.hasAbortSignal).toBe(true);
    expect(result.stdout).toContain("RELEASE_IDENTITY");
    expect(`${result.stdout}${result.stderr}`).not.toContain(cronSecret);
  });

  it("selects the original recovery scan route for recovery mode", async () => {
    const result = await runScopedStep({
      endpoint: recoveryEndpoint,
      mode: "recovery",
      fixture: {
        body: { inactivity: { applied: 0 }, outbox: { dispatched: 2, failed: 0 } },
      },
    });

    expect(result.exitCode, result.stderr).toBe(0);
    expect(result.request?.url).toBe(recoveryEndpoint);
    expect(result.request?.authorization).toBe(`Bearer ${cronSecret}`);
    expect(result.stdout).toContain("RECOVERY_SCAN");
  });

  it("fails the scoped verification on a non-200 response", async () => {
    const result = await runScopedStep({
      endpoint: recoveryEndpoint,
      mode: "recovery",
      fixture: { status: 503, body: {} },
    });

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("Operator request failed HTTP 503");
  });

  it("fails the scoped verification when the request times out", async () => {
    const result = await runScopedStep({
      endpoint: identityEndpoint,
      mode: "identity",
      fixture: { fail: "timeout" },
    });

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("timeout");
  });

  it("rejects an identity body whose shape is not the content-free contract", async () => {
    const result = await runScopedStep({
      endpoint: identityEndpoint,
      mode: "identity",
      fixture: { body: { ...identityBody, teamId: 123 } },
    });

    expect(result.exitCode).not.toBe(0);
    expect(result.stdout).toContain("IDENTITY_SHAPE");
  });

  it("rejects a recovery counter that is not a non-negative integer", async () => {
    const result = await runScopedStep({
      endpoint: recoveryEndpoint,
      mode: "recovery",
      fixture: { body: { outbox: { dispatched: -1 } } },
    });

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("Unexpected scan counter");
  });
});

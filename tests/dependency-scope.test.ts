import { readFile, readdir, stat } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

/**
 * Scope protection for the 1A.1 Text Foundation (parent SPEC acceptance #39):
 * the production dependency graph contains no independent Provider Egress
 * Gateway, Replay runtime, Voice worker, Python production worker, Redis,
 * Temporal, queue, or unused future feature package.
 */

const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));

const FORBIDDEN_DEPENDENCY_PATTERNS: readonly RegExp[] = [
  /^(i?redis|@redis\..*)$/i,
  /^(@temporal(io)?|temporal|@temporal-io)$/i,
  /^(@livekit|livekit.*)$/i,
  /^(kafka|kafkajs|@confluent.*)$/i,
  /^(amqp|amqplib|rabbitmq|rhea)$/i,
  /^(bull|bullmq|bee-queue|agenda|fastq)$/i,
  /^(celery|nsq|nats|sqs-producer)$/i,
  /^(@aws-sdk\/sqs|@google-cloud\/pubsub|@google-cloud\/tasks)$/i,
];

const ALLOWED_MATERIALIZED_PACKAGES = new Set([
  "ai",
  "application",
  "data",
  "domain",
  "test-support",
]);

async function readPackageJson(filePath: string): Promise<{
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
}> {
  try {
    return JSON.parse(await readFile(filePath, "utf8")) as Record<string, unknown> as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
      peerDependencies?: Record<string, string>;
    };
  } catch {
    return {};
  }
}

async function listProductionSourceTree(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map(async (entry) => {
      if (
        entry.name.startsWith(".") ||
        entry.name === "node_modules" ||
        entry.name === ".next" ||
        entry.name === "dist"
      ) {
        return [];
      }
      const path = `${directory}/${entry.name}`;
      if (entry.isDirectory()) {
        return listProductionSourceTree(path);
      }
      return [path];
    }),
  );
  return nested.flat();
}

describe("1A.1 production dependency scope", () => {
  it("declares no Redis, Temporal, queue, Voice, or Python worker dependency", async () => {
    const packageFiles = [
      `${repositoryRoot}package.json`,
      `${repositoryRoot}apps/web/package.json`,
      ...(await readdir(`${repositoryRoot}packages`, { withFileTypes: true }))
        .filter((entry) => entry.isDirectory())
        .map((entry) => `${repositoryRoot}packages/${entry.name}/package.json`),
    ];

    for (const packageFile of packageFiles) {
      const manifest = await readPackageJson(packageFile);
      const declared = new Set([
        ...Object.keys(manifest.dependencies ?? {}),
        ...Object.keys(manifest.devDependencies ?? {}),
        ...Object.keys(manifest.peerDependencies ?? {}),
      ]);
      for (const dependency of declared) {
        for (const pattern of FORBIDDEN_DEPENDENCY_PATTERNS) {
          expect(
            pattern.test(dependency),
            `${packageFile} declares out-of-scope dependency ${dependency}`,
          ).toBe(false);
        }
      }
    }
  });

  it("materializes only the 1A.1 packages and the internal Web BFF", async () => {
    for (const parent of ["apps", "packages"]) {
      const entries = await readdir(`${repositoryRoot}${parent}`, {
        withFileTypes: true,
      });
      for (const entry of entries) {
        if (!entry.isDirectory() || entry.name.startsWith(".")) {
          continue;
        }
        const allowed =
          parent === "apps"
            ? entry.name === "web"
            : ALLOWED_MATERIALIZED_PACKAGES.has(entry.name);
        expect(allowed, `${parent}/${entry.name} is an unused future feature package`).toBe(
          true,
        );
      }
    }
  });

  it("contains no Provider Egress Gateway, Replay, Voice, Python, or queue worker source", async () => {
    const forbiddenPathTokens: readonly RegExp[] = [
      /egress[-_ ]?gateway/i,
      /\breplay\b/i,
      /\bvoice\b/i,
      /\bpython\b/i,
      /\btemporal\b/i,
      /queue[-_ ]?worker/i,
    ];
    for (const root of [
      `${repositoryRoot}packages`,
      `${repositoryRoot}apps`,
    ]) {
      const sourceFiles = await listProductionSourceTree(root);
      const relative = sourceFiles.map((path) => path.slice(root.length));
      const offending = relative.filter((path) =>
        forbiddenPathTokens.some((pattern) => pattern.test(path)),
      );
      expect(
        offending,
        `unexpected out-of-scope source: ${offending.join(", ")}`,
      ).toEqual([]);
      const pythonWorkers = relative.filter((path) => /\.py$/i.test(path));
      expect(
        pythonWorkers,
        "Python production workers are out of scope",
      ).toEqual([]);
    }
  });
});

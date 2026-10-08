import { readdir, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

/**
 * Everything reachable from a `"use client"` module is bundled for the
 * browser, so a single value import of a workspace package drags the whole
 * barrel in. `@sayhear/application` re-exports modules that read
 * `node:perf_hooks` and `node:crypto`; while the Portal date formatter lived
 * beside `localDateAt`, client components imported it and Next failed to
 * generate the `[app-client]` chunk ("the chunking context (unknown) does not
 * support external modules"), returning 500 for every authenticated page.
 *
 * Type-only imports are erased at compile time and stay allowed.
 */

const appDirectory = fileURLToPath(new URL("../apps/web/app/", import.meta.url));
const serverOnlyPackages = ["@sayhear/ai", "@sayhear/application", "@sayhear/data"];
const moduleExtensions = [".ts", ".tsx", ".mts", ".js"];

type ImportStatement = Readonly<{ specifier: string; typeOnly: boolean }>;

describe("portal client bundle boundary", () => {
  it("keeps server-only workspace packages out of the client module graph", async () => {
    const modules = await readModules();
    const reachable = new Set<string>();
    const queue = [...modules]
      .filter(([, source]) => isClientModule(source))
      .map(([path]) => path);

    while (queue.length > 0) {
      const path = queue.pop();
      if (path === undefined || reachable.has(path)) continue;
      reachable.add(path);
      for (const statement of parseImports(modules.get(path) ?? "")) {
        if (statement.typeOnly) continue;
        for (const candidate of localCandidates(path, statement.specifier)) {
          if (modules.has(candidate)) queue.push(candidate);
        }
      }
    }

    // A silently empty graph would make the assertion below meaningless.
    expect(reachable.size).toBeGreaterThan(10);

    const violations = [...reachable].flatMap((path) =>
      parseImports(modules.get(path) ?? "")
        .filter(
          (statement) =>
            !statement.typeOnly &&
            serverOnlyPackages.includes(
              statement.specifier.split("/").slice(0, 2).join("/"),
            ),
        )
        .map(
          (statement) =>
            `${path.slice(appDirectory.length - 1)} imports ${statement.specifier}`,
        ),
    );

    expect(violations).toEqual([]);
  });
});

async function readModules(): Promise<Map<string, string>> {
  const paths = await sourceFiles(appDirectory);
  const entries = await Promise.all(
    paths.map(async (path) => [path, await readFile(path, "utf8")] as const),
  );
  return new Map(entries);
}

async function sourceFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map(async (entry) => {
      const path = resolve(directory, entry.name);
      if (entry.isDirectory()) return sourceFiles(path);
      return moduleExtensions.some((extension) => path.endsWith(extension))
        ? [path]
        : [];
    }),
  );
  return nested.flat();
}

function isClientModule(source: string): boolean {
  return /^\s*(?:"use client"|'use client')\s*;/.test(source);
}

function parseImports(source: string): ImportStatement[] {
  const statements: ImportStatement[] = [];
  const pattern = /import\s+(type\s+)?(?:[^"'`]*?from\s+)?["']([^"']+)["']/g;
  for (const match of source.matchAll(pattern)) {
    const specifier = match[2];
    if (specifier === undefined) continue;
    statements.push({
      specifier,
      typeOnly: match[1] !== undefined || isInlineTypeOnly(match[0]),
    });
  }
  return statements;
}

/**
 * `import { type A, type B } from "pkg"` erases at compile time just like
 * `import type`, so it never reaches the browser either. A clause that mixes
 * value and type specifiers is still a value import.
 */
function isInlineTypeOnly(clause: string): boolean {
  const braces = /\{([\s\S]*?)\}/.exec(clause);
  if (braces === null || braces[1] === undefined) return false;
  const specifiers = braces[1]
    .split(",")
    .map((specifier) => specifier.trim())
    .filter((specifier) => specifier.length > 0);
  return (
    specifiers.length > 0 &&
    specifiers.every((specifier) => /^type\s/.test(specifier))
  );
}

function localCandidates(fromPath: string, specifier: string): string[] {
  if (!specifier.startsWith(".")) return [];
  const base = resolve(dirname(fromPath), specifier);
  return [
    base,
    ...moduleExtensions.map((extension) => `${base}${extension}`),
    ...moduleExtensions.map((extension) => `${base}/index${extension}`),
  ];
}

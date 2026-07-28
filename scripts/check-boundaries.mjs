import { readdir, readFile, stat } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";

const repositoryRoot = process.env.SAYHEAR_BOUNDARY_ROOT
  ? pathToFileURL(`${resolve(process.env.SAYHEAR_BOUNDARY_ROOT)}${sep}`)
  : new URL("../", import.meta.url);
const sourceRoots = {
  ai: new URL("packages/ai/src/", repositoryRoot),
  application: new URL("packages/application/src/", repositoryRoot),
  data: new URL("packages/data/src/", repositoryRoot),
  domain: new URL("packages/domain/src/", repositoryRoot),
  "test-support": new URL("packages/test-support/src/", repositoryRoot),
  web: new URL("apps/web/", repositoryRoot),
};
const allowedInternalDependencies = {
  ai: new Set(["@sayhear/application"]),
  application: new Set(["@sayhear/domain"]),
  data: new Set(["@sayhear/application", "@sayhear/domain"]),
  domain: new Set(),
  "test-support": new Set([
    "@sayhear/application",
    "@sayhear/data",
    "@sayhear/domain",
  ]),
  web: new Set(["@sayhear/ai", "@sayhear/application", "@sayhear/data"]),
};
const allowedMaterializedModules = new Set(Object.keys(sourceRoots));
const failures = [];

async function sourceFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map(async (entry) => {
      if (entry.name.startsWith(".") || entry.name === "node_modules") {
        return [];
      }
      const path = join(directory.pathname, entry.name);
      if (entry.isDirectory()) {
        return sourceFiles(new URL(`${entry.name}/`, directory));
      }
      return /\.[cm]?[jt]sx?$/.test(entry.name) ? [path] : [];
    }),
  );
  return nested.flat();
}

for (const [moduleName, sourceRoot] of Object.entries(sourceRoots)) {
  for (const filename of await sourceFiles(sourceRoot)) {
    const source = await readFile(filename, "utf8");
    const relativeFilename = relative(repositoryRoot.pathname, filename);
    const isBrowserModule =
      moduleName === "web" &&
      /^\s*["']use client["'];?/m.test(source);
    const imports = source.matchAll(
      /(?:from\s+|import\s*\(\s*)["']([^"']+)["']/g,
    );
    for (const match of imports) {
      const dependency = match[1];
      if (
        dependency?.startsWith("@sayhear/") &&
        !allowedInternalDependencies[moduleName].has(dependency)
      ) {
        failures.push(
          `${relativeFilename} imports forbidden ${dependency}`,
        );
      }
      if (
        moduleName === "web" &&
        dependency?.startsWith("@sayhear/ai") &&
        relativeFilename !== "apps/web/src/server-composition.ts"
      ) {
        failures.push(
          `${relativeFilename} imports Provider adapter outside Egress`,
        );
      }
      if (
        moduleName !== "ai" &&
        dependency?.startsWith(".") &&
        resolve(dirname(filename), dependency).startsWith(
          sourceRoots.ai.pathname,
        )
      ) {
        failures.push(
          `${relativeFilename} imports Provider adapter outside Egress`,
        );
      }
      if (
        isBrowserModule &&
        (dependency === "@sayhear/ai" || dependency === "@sayhear/data")
      ) {
        failures.push(
          `${relativeFilename}: Browser module imports forbidden ${dependency}`,
        );
      }
      if (
        moduleName === "domain" &&
        (dependency === "pg" ||
          dependency?.startsWith("next") ||
          dependency?.startsWith("next-auth"))
      ) {
        failures.push(
          `${relativeFilename} couples domain to ${dependency}`,
        );
      }
    }
    if (
      isBrowserModule &&
      /(?:runtime-config|server-composition)/.test(source)
    ) {
      failures.push(
        `${relativeFilename}: Browser module imports server composition or runtime configuration`,
      );
    }
    if (
      moduleName !== "ai" &&
      relativeFilename !== "apps/web/src/runtime-config.ts"
    ) {
      for (const credentialName of [
        "OPENAI_API_KEY",
        "GITHUB_CLIENT_SECRET",
        "NEXTAUTH_SECRET",
        "SAYHEAR_CONTEXT_HMAC_SECRET",
      ]) {
        if (source.includes(credentialName)) {
          failures.push(
            `${relativeFilename} references server-only ${credentialName}`,
          );
        }
      }
    }
  }
}

for (const parent of ["apps", "packages"]) {
  const directory = new URL(`${parent}/`, repositoryRoot);
  for (const entry of await readdir(directory)) {
    const entryPath = new URL(`${entry}/`, directory);
    if (
      (await stat(entryPath)).isDirectory() &&
      !allowedMaterializedModules.has(entry)
    ) {
      failures.push(`${parent}/${entry} is not used by the current ticket`);
    }
  }
}

if (failures.length > 0) {
  console.error(failures.join("\n"));
  process.exitCode = 1;
} else {
  console.log("Module boundaries match the 1A.1 ticket graph.");
}

import { readdir, readFile, stat } from "node:fs/promises";
import { join, relative } from "node:path";

const repositoryRoot = new URL("../", import.meta.url);
const sourceRoots = {
  application: new URL("../packages/application/src/", import.meta.url),
  data: new URL("../packages/data/src/", import.meta.url),
  domain: new URL("../packages/domain/src/", import.meta.url),
  "test-support": new URL("../packages/test-support/src/", import.meta.url),
  web: new URL("../apps/web/", import.meta.url),
};
const allowedInternalDependencies = {
  application: new Set(["@sayhear/domain"]),
  data: new Set(["@sayhear/application", "@sayhear/domain"]),
  domain: new Set(),
  "test-support": new Set([
    "@sayhear/application",
    "@sayhear/data",
    "@sayhear/domain",
  ]),
  web: new Set(["@sayhear/application", "@sayhear/data"]),
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
    const imports = source.matchAll(
      /(?:from\s+|import\s*\(\s*)["'](@sayhear\/[^"']+|next(?:\/[^"']*)?|next-auth(?:\/[^"']*)?|pg)["']/g,
    );
    for (const match of imports) {
      const dependency = match[1];
      if (
        dependency?.startsWith("@sayhear/") &&
        !allowedInternalDependencies[moduleName].has(dependency)
      ) {
        failures.push(
          `${relative(repositoryRoot.pathname, filename)} imports forbidden ${dependency}`,
        );
      }
      if (
        moduleName === "domain" &&
        (dependency === "pg" ||
          dependency?.startsWith("next") ||
          dependency?.startsWith("next-auth"))
      ) {
        failures.push(
          `${relative(repositoryRoot.pathname, filename)} couples domain to ${dependency}`,
        );
      }
    }
  }
}

for (const parent of ["apps", "packages"]) {
  const directory = new URL(`../${parent}/`, import.meta.url);
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

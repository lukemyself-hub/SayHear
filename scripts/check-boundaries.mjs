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
      const dependencyModule = dependency?.startsWith("@sayhear/")
        ? dependency.split("/").slice(0, 2).join("/")
        : dependency;
      if (
        dependency?.startsWith("@sayhear/") &&
        !allowedInternalDependencies[moduleName].has(dependency) &&
        !allowedInternalDependencies[moduleName].has(dependencyModule)
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
        "DEEPSEEK_API_KEY",
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

// The Workflow transform builds a deterministic sandbox for each registered
// entrypoint. Runtime-only code must therefore be reachable only from a step,
// never through a top-level import in a workflow module. This source guard
// keeps the boundary explicit and complements the build-backed transform check
// that follows in Next.js.
const workflowStarterPath = join(
  sourceRoots.web.pathname,
  "src",
  "workflow-starter.ts",
);
const isBoundaryFixture = Boolean(process.env.SAYHEAR_BOUNDARY_ROOT);
let workflowEntrypoints = [];
let workflowStarterSource = null;
try {
  workflowStarterSource = await readFile(workflowStarterPath, "utf8");
} catch (error) {
  if (!isBoundaryFixture || error?.code !== "ENOENT") {
    throw error;
  }
}
if (workflowStarterSource !== null) {
  workflowEntrypoints = [
    ...workflowStarterSource.matchAll(
      /from\s+["']\.\/workflows\/([^"']+\.workflow)["']/g,
    ),
  ].map((match) => match[1]);
}
if (!isBoundaryFixture && workflowEntrypoints.length === 0) {
  failures.push(
    "apps/web/src/workflow-starter.ts registers no Workflow entrypoints",
  );
}
const allowedWorkflowStaticImports = new Set([
  "@sayhear/application/entity-identity-revalidation",
  "@sayhear/application/model-role-contract",
  "@sayhear/application/workflow-contract",
  "workflow/api",
]);

for (const entrypoint of workflowEntrypoints) {
  const filename = join(sourceRoots.web.pathname, "src", "workflows", `${entrypoint}.ts`);
  const source = await readFile(filename, "utf8");
  if (!source.includes('"use workflow"')) {
    failures.push(`${relative(repositoryRoot.pathname, filename)} has no workflow directive`);
  }
  if (!source.includes('"use step"')) {
    failures.push(`${relative(repositoryRoot.pathname, filename)} has no step directive`);
  }

  const declarations = [
    ...source.matchAll(/^\s*import\s+(?!type\b)[\s\S]*?;/gm),
  ];
  for (const declaration of declarations) {
    const dependency = declaration[0].match(
      /(?:from\s+)?["']([^"']+)["']/,
    )?.[1];
    if (!dependency) {
      failures.push(
        `${relative(repositoryRoot.pathname, filename)} has an unparsable static import`,
      );
      continue;
    }
    if (dependency.startsWith("node:")) {
      failures.push(
        `${relative(repositoryRoot.pathname, filename)} imports Node builtin ${dependency} outside a step`,
      );
    }
    if (dependency === "../server-composition") {
      failures.push(
        `${relative(repositoryRoot.pathname, filename)} imports server composition outside a step`,
      );
    }
    if (
      dependency.startsWith("@sayhear/application") &&
      !allowedWorkflowStaticImports.has(dependency)
    ) {
      failures.push(
        `${relative(repositoryRoot.pathname, filename)} imports runtime application code ${dependency} outside a step`,
      );
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
  console.log(
    `Module boundaries match the 1A.2 ticket graph; ${workflowEntrypoints.length} Workflow entrypoints keep Node runtime code behind steps.`,
  );
}

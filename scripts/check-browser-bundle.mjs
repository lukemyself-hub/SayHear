import { readdir, readFile } from "node:fs/promises";
import { relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const buildRoot = process.env.SAYHEAR_WEB_BUILD_ROOT
  ? resolve(process.env.SAYHEAR_WEB_BUILD_ROOT)
  : fileURLToPath(new URL("../apps/web/.next/static/", import.meta.url));
const credentialNames = [
  "OPENAI_API_KEY",
  "GITHUB_CLIENT_SECRET",
  "NEXTAUTH_SECRET",
  "SAYHEAR_CONTEXT_HMAC_SECRET",
];
const failures = [];

for (const filename of await bundleFiles(buildRoot)) {
  const content = await readFile(filename, "utf8");
  for (const credentialName of credentialNames) {
    const credentialValue = process.env[credentialName];
    if (
      content.includes(credentialName) ||
      (credentialValue &&
        credentialValue.length >= 8 &&
        content.includes(credentialValue))
    ) {
      failures.push(
        `${relative(buildRoot, filename)}: Browser bundle contains server-only ${credentialName}`,
      );
    }
  }
}

if (failures.length > 0) {
  console.error(failures.join("\n"));
  process.exitCode = 1;
} else {
  console.log("Browser bundle excludes server-only credentials.");
}

async function bundleFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map((entry) => {
      const path = resolve(directory, entry.name);
      return entry.isDirectory() ? bundleFiles(path) : [path];
    }),
  );
  return nested.flat();
}

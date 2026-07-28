import { readFile } from "node:fs/promises";

const expectedNodeVersion = (
  await readFile(new URL("../.node-version", import.meta.url), "utf8")
).trim();
const actualNodeVersion = process.versions.node;

if (actualNodeVersion !== expectedNodeVersion) {
  throw new Error(
    `SayHear requires Node ${expectedNodeVersion}; current runtime is ${actualNodeVersion}. Apply the repository .node-version before running validation.`,
  );
}

console.log(`Runtime matches .node-version: Node ${actualNodeVersion}.`);

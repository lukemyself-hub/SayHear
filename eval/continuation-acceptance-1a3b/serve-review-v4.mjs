import { createReadStream, statSync } from "node:fs";
import { createServer } from "node:http";
import { extname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDirectory = fileURLToPath(new URL(".", import.meta.url));
const reviewDirectory = resolve(scriptDirectory, "run-v4/review");
const allowedFiles = new Set(["index.html", "public-package.json", "scores.json"]);
const args = process.argv.slice(2);
const portIndex = args.indexOf("--port");
const portValue = portIndex >= 0 ? args[portIndex + 1] : "4177";
const port = Number(portValue);
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error("--port must be a valid TCP port.");
}

const server = createServer((request, response) => {
  if (request.method !== "GET" && request.method !== "HEAD") {
    response.writeHead(405, { Allow: "GET, HEAD" }).end();
    return;
  }
  let requestedPath;
  try {
    requestedPath = decodeURIComponent(new URL(request.url ?? "/", "http://localhost").pathname);
  } catch {
    response.writeHead(400).end("Invalid path");
    return;
  }
  const filename = requestedPath === "/" ? "index.html" : requestedPath.slice(1);
  if (!allowedFiles.has(filename) || filename.includes("/") || filename.includes("\\")) {
    response.writeHead(404).end("Not found");
    return;
  }
  const fullPath = resolve(reviewDirectory, filename);
  if (!fullPath.startsWith(`${reviewDirectory}${sep}`)) {
    response.writeHead(404).end("Not found");
    return;
  }
  let size;
  try {
    size = statSync(fullPath).size;
  } catch {
    response.writeHead(404).end("Review artifact not found. Build the v4 package first.");
    return;
  }
  const contentType = extname(filename) === ".html" ? "text/html; charset=utf-8" : "application/json; charset=utf-8";
  response.writeHead(200, {
    "Content-Length": size,
    "Content-Type": contentType,
    "Cache-Control": "no-store",
    "Content-Security-Policy": "default-src 'self' blob:; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data:",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
  });
  if (request.method === "HEAD") response.end();
  else createReadStream(fullPath).pipe(response);
});

server.listen(port, "127.0.0.1", () => {
  console.log(`G2 v4 review page: http://127.0.0.1:${port}/`);
  console.log("This local server only serves the public review folder.");
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => server.close(() => process.exit(0)));
}

import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

describe("F3 OpenCode Go conversation capture", () => {
  it("uses one opaque Daily Session identity across a fixture's turns", () => {
    const directory = mkdtempSync(join(tmpdir(), "sayhear-f3-session-"));
    const headersPath = join(directory, "sessions.json");
    const preloadPath = join(directory, "provider.mjs");
    const catalogPath = join(directory, "fixtures.json");
    const catalog = JSON.parse(readFileSync(
      "eval/continuation-acceptance-1a3b/holdout/fixtures.json", "utf8",
    ));
    catalog.scenarios = catalog.scenarios.filter(
      (fixture: { id: string }) => fixture.id === "holdout-cont-repeat-zh",
    );
    writeFileSync(catalogPath, JSON.stringify(catalog));
    writeFileSync(preloadPath, `
      import { writeFileSync } from 'node:fs';
      const sessions = [];
      globalThis.fetch = async (url, options) => {
        if (String(url) !== 'https://opencode.ai/zen/go/v1/chat/completions') {
          throw new Error('Unexpected Provider endpoint');
        }
        const session = new Headers(options.headers).get('x-opencode-session');
        sessions.push(session);
        writeFileSync(${JSON.stringify(headersPath)}, JSON.stringify(sessions));
        const frame = {model:'deepseek-v4.1-flash',choices:[{index:0,delta:{content:'好的。'},finish_reason:null}]};
        const final = {model:'deepseek-v4.1-flash',choices:[{index:0,delta:{},finish_reason:'stop'}]};
        return new Response('data: '+JSON.stringify(frame)+'\\n\\ndata: '+JSON.stringify(final)+'\\n\\ndata: [DONE]\\n\\n', {headers:{'content-type':'text/event-stream'}});
      };
    `);
    try {
      const result = spawnSync(process.execPath, [
        "--import", preloadPath, "--import", "tsx",
        "eval/continuation-acceptance-1a3b/run-synthetic-capture.ts",
        "--catalog", catalogPath,
        "--pins", "eval/continuation-acceptance-1a3b/g1-activation-pins.json",
        "--only", "holdout-cont-repeat-zh",
        "--out", join(directory, "capture.json"),
        "--hard-gates-out", join(directory, "gates.json"),
      ], {
        cwd: process.cwd(),
        encoding: "utf8",
        timeout: 30_000,
        env: {
          ...process.env,
          SAYHEAR_PROVIDER_ADAPTER: "opencode-go",
          SAYHEAR_CONVERSATION_TEXT_MODEL: "deepseek-v4.1-flash",
          SAYHEAR_CONVERSATION_TEXT_MODEL_SNAPSHOT: "deepseek-v4.1-flash",
          OPENCODE_GO_API_KEY: "synthetic-test-key",
        },
      });
      expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
      const sessions: string[] = JSON.parse(readFileSync(headersPath, "utf8"));
      expect(sessions.length).toBeGreaterThanOrEqual(2);
      expect(sessions.every((session) => /^[a-f0-9]{64}$/.test(session))).toBe(true);
      expect(new Set(sessions).size).toBe(1);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

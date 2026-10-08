import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

/**
 * Layout is the behavior here (ticket #283 / SPEC #260 US 6): the Owner status
 * is a bottom strip under a locally scrolling module list, the module rail is a
 * top row, and long dates/tool names wrap instead of being clipped. These tests
 * assert the structural CSS and DOM order rather than pixel snapshots.
 */

const stylesUrl = new URL("../apps/web/app/styles.css", import.meta.url);
const shellUrl = new URL("../apps/web/app/internal/portal-shell.tsx", import.meta.url);

type Declarations = Readonly<Record<string, string>>;

/**
 * Flattens a plain CSS file into `selector -> declarations`, merging duplicate
 * selectors (including rules nested in at-rules) with later declarations
 * winning. Only the selectors and properties this contract cares about are
 * read; no value is normalized beyond trimming.
 */
async function readDeclarationsBySelector(): Promise<Map<string, Declarations>> {
  const source = (await readFile(stylesUrl, "utf8")).replace(/\/\*[\s\S]*?\*\//g, "");
  const rules = new Map<string, Record<string, string>>();
  const rulePattern = /([^{}]+)\{([^{}]*)\}/g;
  for (const match of source.matchAll(rulePattern)) {
    const selectorList = match[1];
    const body = match[2];
    if (selectorList === undefined || body === undefined) continue;
    const declarations: Record<string, string> = {};
    for (const part of body.split(";")) {
      const separator = part.indexOf(":");
      if (separator === -1) continue;
      const property = part.slice(0, separator).trim().toLowerCase();
      const value = part.slice(separator + 1).trim();
      if (property) declarations[property] = value;
    }
    for (const selector of selectorList.split(",")) {
      const key = selector.trim();
      if (!key || key.startsWith("@")) continue;
      rules.set(key, { ...(rules.get(key) ?? {}), ...declarations });
    }
  }
  return rules;
}

describe("portal shell layout (ticket #283)", () => {
  it("stacks the navigation columns so the module list sits above a bottom footer", async () => {
    const rules = await readDeclarationsBySelector();
    const nav = rules.get(".portalNav") ?? {};
    expect(nav["flex-direction"]).toBe("column");
  });

  it("turns the module rail into a top icon row instead of a left column", async () => {
    const rules = await readDeclarationsBySelector();
    const rail = rules.get(".moduleRail") ?? {};
    expect(rail["flex-direction"]).toBe("row");
    expect(rail.width ?? "auto").toBe("auto");
    expect(rail["border-right"] ?? "0").toMatch(/^(0|none)$/);
    expect(rail["border-bottom"]).toBeTruthy();
  });

  it("lets the module list shrink and scroll locally under a definite-height nav", async () => {
    const rules = await readDeclarationsBySelector();
    const list = rules.get(".moduleList") ?? {};
    expect(list["min-height"]).toBe("0");
    expect(list["overflow-y"]).toBe("auto");
    expect(list.flex).toContain("1");
  });

  it("keeps the footer pinned as a non-shrinking bottom strip", async () => {
    const rules = await readDeclarationsBySelector();
    const footer = rules.get(".portalFooter") ?? {};
    expect(footer["border-top"]).toBeTruthy();
    expect(footer["flex-shrink"]).toBe("0");
  });

  it("wraps long module entries and Journal date labels instead of clipping them", async () => {
    const rules = await readDeclarationsBySelector();
    const entry = rules.get(".moduleListEntry") ?? {};
    const dateLabel = rules.get(".journalDateLabel") ?? {};

    expect(entry["white-space"] ?? "normal").not.toBe("nowrap");
    expect(dateLabel["white-space"] ?? "normal").not.toBe("nowrap");
    expect(`${entry["overflow"] ?? ""}`).not.toBe("hidden");
    expect(`${dateLabel["overflow"] ?? ""}`).not.toBe("hidden");
    expect(entry["overflow-wrap"] ?? entry["word-break"] ?? "").toMatch(/anywhere|break-word/);
    expect(dateLabel["overflow-wrap"] ?? dateLabel["word-break"] ?? "").toMatch(
      /anywhere|break-word/,
    );
  });

  it("renders the rail before the list and the footer after the list in the DOM", async () => {
    const shell = await readFile(shellUrl, "utf8");
    const railIndex = shell.indexOf("<ModuleRail");
    const listIndex = shell.indexOf("<ModuleList");
    const footerIndex = shell.indexOf('className="portalFooter"');

    expect(railIndex).toBeGreaterThan(-1);
    expect(listIndex).toBeGreaterThan(-1);
    expect(footerIndex).toBeGreaterThan(-1);
    expect(railIndex).toBeLessThan(listIndex);
    expect(listIndex).toBeLessThan(footerIndex);
  });
});

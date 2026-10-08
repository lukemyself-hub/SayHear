import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

/**
 * Layout is the behavior here (SPEC #260 US 6, aligned with the high-fidelity
 * Portal reference): a vertical module rail, a second column holding the date
 * list, and the Owner status pinned under that list. The list scrolls locally
 * and long dates or tool names wrap instead of being clipped. These tests
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

describe("portal shell layout (high-fidelity alignment)", () => {
  it("lays the navigation out as a module rail beside a date column", async () => {
    const rules = await readDeclarationsBySelector();
    const nav = rules.get(".portalNav") ?? {};
    const railColumn = rules.get(".portalRailColumn") ?? {};
    const moduleColumn = rules.get(".portalModuleColumn") ?? {};

    // The default flex direction keeps the two columns side by side; a column
    // direction here would stack the rail above the date list again.
    expect(nav["flex-direction"] ?? "row").toBe("row");
    expect(moduleColumn["flex-direction"]).toBe("column");
    expect(railColumn["border-right"]).toBeTruthy();
    // Desktop keeps the 72px reference rail; the drawer narrows it to 64px.
    expect(railColumn.width).toMatch(/^(72px|64px)$/);
  });

  it("keeps the module rail a vertical icon column", async () => {
    const rules = await readDeclarationsBySelector();
    const rail = rules.get(".moduleRail") ?? {};

    expect(rail["flex-direction"]).toBe("column");
    expect(rail["border-bottom"] ?? "0").toMatch(/^(0|none)$/);
  });

  it("lets the module list shrink and scroll locally under a definite-height nav", async () => {
    const rules = await readDeclarationsBySelector();
    const list = rules.get(".moduleList") ?? {};
    expect(list["min-height"]).toBe("0");
    expect(list["overflow-y"]).toBe("auto");
    expect(list.flex).toContain("1");
  });

  it("keeps the footer pinned as a non-shrinking strip inside the date column", async () => {
    const rules = await readDeclarationsBySelector();
    const footer = rules.get(".portalFooter") ?? {};
    const moduleColumn = rules.get(".portalModuleColumn") ?? {};

    expect(footer["border-top"]).toBeTruthy();
    expect(footer["flex-shrink"]).toBe("0");
    expect(moduleColumn["min-height"]).toBe("0");
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

  it("renders the rail column before the date column and the footer after the list", async () => {
    const shell = await readFile(shellUrl, "utf8");
    const railIndex = shell.indexOf('className="portalRailColumn"');
    const listIndex = shell.indexOf("<ModuleList");
    const footerIndex = shell.indexOf('className="portalFooter"');
    const moduleColumnIndex = shell.indexOf('className="portalModuleColumn"');

    expect(railIndex).toBeGreaterThan(-1);
    expect(listIndex).toBeGreaterThan(-1);
    expect(footerIndex).toBeGreaterThan(-1);
    expect(moduleColumnIndex).toBeGreaterThan(-1);
    expect(railIndex).toBeLessThan(moduleColumnIndex);
    expect(moduleColumnIndex).toBeLessThan(listIndex);
    expect(listIndex).toBeLessThan(footerIndex);
  });

  it("keeps the visual-acceptance harness classes aligned with the real stylesheet", async () => {
    const harness = await readFile(
      new URL("../scripts/portal-visual-acceptance.mjs", import.meta.url),
      "utf8",
    );
    const styles = await readFile(stylesUrl, "utf8");
    const shell = await readFile(shellUrl, "utf8");

    // The harness mirrors the shell's markup by hand (it cannot import the TS
    // components), so this guard fails if either side renames one of the
    // measured classes and the harness would otherwise measure nothing.
    const measuredClasses = [
      "portalShell",
      "portalNav",
      "portalRailColumn",
      "moduleRail",
      "portalModuleColumn",
      "moduleList",
      "moduleListEntry",
      "journalDateLabel",
      "portalFooter",
      "portalFooterOwner",
      "portalFooterState",
    ];
    for (const className of measuredClasses) {
      expect(harness, `harness is missing .${className}`).toContain(className);
      expect(styles, `styles.css is missing .${className}`).toContain(
        `.${className}`,
      );
    }
    for (const className of [
      "portalRailColumn",
      "portalModuleColumn",
      "portalFooter",
      "portalFooterOwner",
      "portalFooterState",
    ]) {
      expect(shell, `portal-shell.tsx is missing .${className}`).toContain(
        className,
      );
    }
  });
});

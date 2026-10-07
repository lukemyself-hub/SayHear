import { describe, expect, it } from "vitest";

import {
  createToolNavigationMemory,
  DEFAULT_TOOL_HREF,
  formatPortalDate,
  interruptedHistoryGuidance,
  isLogicalDateValue,
  isToolPath,
  journalRailHref,
  resolveToolEntryHref,
  resolveToolsRailHref,
  shouldCollapseNavigationOnEscape,
  toToolLocation,
  toolLocationHref,
} from "../apps/web/app/internal/portal-integration";

describe("portal-integration tool navigation memory", () => {
  it("recognizes only the three committed tool routes", () => {
    expect(isToolPath("/internal/context-inspector")).toBe(true);
    expect(isToolPath("/internal/reflection-inspector")).toBe(true);
    expect(isToolPath("/internal/candidate-review")).toBe(true);
    expect(isToolPath("/internal")).toBe(false);
    expect(isToolPath("/internal/journals")).toBe(false);
    expect(isToolPath("/internal/context-inspectors")).toBe(false);
  });

  it("normalizes the address and rejects non-tool paths", () => {
    expect(
      toToolLocation(
        "/internal/context-inspector",
        "generation_command_id=abc",
      ),
    ).toEqual({
      pathname: "/internal/context-inspector",
      search: "?generation_command_id=abc",
    });
    expect(
      toToolLocation(
        "/internal/reflection-inspector",
        "?reflection_id=xyz",
      ),
    ).toEqual({
      pathname: "/internal/reflection-inspector",
      search: "?reflection_id=xyz",
    });
    expect(toToolLocation("/internal", "?date=2026-10-06")).toBeNull();
  });

  it("starts empty so a fresh navigation falls back to the bare route", () => {
    const memory = createToolNavigationMemory();
    expect(memory.lastActive()).toBeNull();
    expect(
      resolveToolsRailHref({ current: null, lastActive: memory.lastActive() }),
    ).toBe(DEFAULT_TOOL_HREF);
  });

  it("remembers the last selected tool entry and ignores non-tools", () => {
    const memory = createToolNavigationMemory();
    memory.remember(toToolLocation("/internal", "?date=2026-10-06"));
    expect(memory.lastActive()).toBeNull();

    const selected = toToolLocation(
      "/internal/context-inspector",
      "?generation_command_id=abc",
    );
    memory.remember(selected);
    expect(memory.lastActive()).toEqual(selected);
    expect(
      resolveToolsRailHref({ current: null, lastActive: memory.lastActive() }),
    ).toBe("/internal/context-inspector?generation_command_id=abc");

    // A later selection supersedes the earlier one (last active, not first).
    const other = toToolLocation(
      "/internal/reflection-inspector",
      "?reflection_id=xyz",
    );
    memory.remember(other);
    expect(
      resolveToolsRailHref({ current: null, lastActive: memory.lastActive() }),
    ).toBe("/internal/reflection-inspector?reflection_id=xyz");
  });

  it("keeps the currently viewed tool entry when the rail is activated", () => {
    const current = toToolLocation(
      "/internal/context-inspector",
      "?generation_command_id=inside",
    );
    expect(
      resolveToolsRailHref({
        current,
        lastActive: toToolLocation(
          "/internal/reflection-inspector",
          "?reflection_id=other",
        ),
      }),
    ).toBe("/internal/context-inspector?generation_command_id=inside");
  });

  it("renders a tool location back to its exact href", () => {
    expect(
      toolLocationHref(
        toToolLocation("/internal/candidate-review", "")!,
      ),
    ).toBe("/internal/candidate-review");
  });
});

describe("portal-integration per-tool entry restore", () => {
  it("keeps the active tool's current selection", () => {
    const base = "/internal/context-inspector";
    expect(
      resolveToolEntryHref({
        base,
        current: toToolLocation(base, "?generation_command_id=abc"),
        remembered: null,
      }),
    ).toBe("/internal/context-inspector?generation_command_id=abc");
  });

  it("restores another tool module's own last selection", () => {
    expect(
      resolveToolEntryHref({
        base: "/internal/reflection-inspector",
        current: toToolLocation("/internal/context-inspector", ""),
        remembered: toToolLocation(
          "/internal/reflection-inspector",
          "?reflection_id=xyz",
        ),
      }),
    ).toBe("/internal/reflection-inspector?reflection_id=xyz");
  });

  it("falls back to the bare tool URL without memory", () => {
    expect(
      resolveToolEntryHref({
        base: "/internal/candidate-review",
        current: null,
        remembered: null,
      }),
    ).toBe("/internal/candidate-review");
  });

  it("exposes per-tool remembered locations", () => {
    const memory = createToolNavigationMemory();
    const context = toToolLocation(
      "/internal/context-inspector",
      "?generation_command_id=abc",
    );
    const reflection = toToolLocation(
      "/internal/reflection-inspector",
      "?reflection_id=xyz",
    );
    memory.remember(context);
    memory.remember(reflection);
    expect(memory.rememberedFor("/internal/context-inspector")).toEqual(context);
    expect(memory.rememberedFor("/internal/reflection-inspector")).toEqual(
      reflection,
    );
    expect(memory.rememberedFor("/internal/candidate-review")).toBeNull();
    expect(memory.lastActive()).toEqual(reflection);
  });
});

describe("portal-integration interrupted history guidance", () => {
  it("states the source date without claiming the history is rewritten", () => {
    const guidance = interruptedHistoryGuidance("2026-10-01");
    expect(guidance.actionLabel).toBe("前往当前交流");
    expect(guidance.message).toContain("2026年10月1日");
    expect(guidance.message).toContain("不会被改写");
  });

  it("passes a malformed date through unchanged", () => {
    expect(formatPortalDate("not-a-date")).toBe("not-a-date");
    expect(formatPortalDate("2026-10-06")).toBe("2026年10月6日");
  });
});

describe("portal-integration Escape guard", () => {
  it("collapses the navigation only for the open narrow drawer", () => {
    expect(
      shouldCollapseNavigationOnEscape({ isDesktop: false, navOpen: true }),
    ).toBe(true);
    expect(
      shouldCollapseNavigationOnEscape({ isDesktop: false, navOpen: false }),
    ).toBe(false);
  });

  it("never collapses on desktop, where the navigation is always visible", () => {
    expect(
      shouldCollapseNavigationOnEscape({ isDesktop: true, navOpen: true }),
    ).toBe(false);
    expect(
      shouldCollapseNavigationOnEscape({ isDesktop: true, navOpen: false }),
    ).toBe(false);
  });
});

describe("portal-integration journal rail memory", () => {
  it("returns to the committed bare URL when no date was selected", () => {
    expect(journalRailHref(null)).toBe("/internal/journals");
    expect(journalRailHref("")).toBe("/internal/journals");
    expect(journalRailHref("not-a-date")).toBe("/internal/journals");
  });

  it("preserves the last selected Journal date", () => {
    expect(journalRailHref("2026-10-01")).toBe(
      "/internal/journals?date=2026-10-01",
    );
  });

  it("validates plain logical dates", () => {
    expect(isLogicalDateValue("2026-10-06")).toBe(true);
    expect(isLogicalDateValue("2026-1-1")).toBe(false);
    expect(isLogicalDateValue(null)).toBe(false);
    expect(isLogicalDateValue("2026-10-06T00:00:00Z")).toBe(false);
  });
});

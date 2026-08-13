import { describe, expect, it } from "vitest";

import {
  EMPTY_CONVERSATION_ACTION_CATALOG,
  INITIAL_CONVERSATION_HARNESS_POLICY,
} from "./conversation-action-catalog";

describe("Conversation Action Catalog (issue #24 AC5)", () => {
  it("publishes an immutable empty initial Catalog", () => {
    expect(Object.isFrozen(EMPTY_CONVERSATION_ACTION_CATALOG)).toBe(true);
    expect(Object.isFrozen(EMPTY_CONVERSATION_ACTION_CATALOG.definitions)).toBe(
      true,
    );
    expect(EMPTY_CONVERSATION_ACTION_CATALOG.definitions).toEqual([]);
    expect(EMPTY_CONVERSATION_ACTION_CATALOG.version).toBe(
      "conversation-action-catalog:empty:v1",
    );
  });

  it("does not expose internal Journal, Workflow, Claim, Profile, deletion, or CRUD operations", () => {
    const exposedKeys = Object.keys(EMPTY_CONVERSATION_ACTION_CATALOG).sort();
    // Only the immutable Catalog surface is exposed; no CRUD or domain operation.
    expect(extractedOperationLikeKeys(exposedKeys)).toEqual([]);
    // No Definition can be added by mutation — the array is frozen.
    expect(() => {
      void (
        EMPTY_CONVERSATION_ACTION_CATALOG as unknown as {
          definitions: { push(...items: unknown[]): unknown };
        }
      ).definitions.push({ actionKind: "regenerate_journal", schemaVersion: "x" });
    }).toThrow();
    expect(EMPTY_CONVERSATION_ACTION_CATALOG.definitions).toEqual([]);
  });

  it("freezes a Harness policy that admits no state-changing Action and one model stage", () => {
    expect(Object.isFrozen(INITIAL_CONVERSATION_HARNESS_POLICY)).toBe(true);
    expect(INITIAL_CONVERSATION_HARNESS_POLICY.maxStateChangingActions).toBe(0);
    expect(INITIAL_CONVERSATION_HARNESS_POLICY.maxDecisionStages).toBe(1);
    expect(INITIAL_CONVERSATION_HARNESS_POLICY.version).toBe(
      "conversation-harness:v1",
    );
  });
});

function extractedOperationLikeKeys(keys: readonly string[]): string[] {
  const forbiddenPatterns = [
    /journal/i,
    /workflow/i,
    /claim/i,
    /profile/i,
    /delet/i,
    /create/i,
    /update/i,
    /insert/i,
    /remove/i,
    /crud/i,
  ];
  return keys
    .filter((key) => forbiddenPatterns.some((pattern) => pattern.test(key)))
    .sort();
}

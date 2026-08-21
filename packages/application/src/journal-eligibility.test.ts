import { describe, expect, it } from "vitest";

import { assertWorkflowSafe } from "./journal-eligibility";

describe("assertWorkflowSafe", () => {
  it("validates nested allowlisted payloads without recursive call frames", () => {
    expect(() => assertWorkflowSafe({
      outcome: "published",
      nested: {
        workflowReceiptId: "run-1",
      },
    })).toThrow("non-allowlisted field: nested");

    expect(() => assertWorkflowSafe({
      outcome: "published",
      workflowReceiptId: {
        subjectId: "subject-1",
      },
    })).not.toThrow();
  });

  it("reports the full path for an invalid nested key", () => {
    expect(() => assertWorkflowSafe({
      outcome: {
        subjectId: {
          privateText: "must not cross Workflow history",
        },
      },
    })).toThrow("Workflow payload.outcome.subjectId contains a non-allowlisted field: privateText");
  });
});

import { describe, expect, it } from "vitest";

import {
  assertModelRoleWorkflowInput,
  type ModelRoleWorkflowInput,
} from "../apps/web/src/workflows/model-role.workflow";

const baseInput: ModelRoleWorkflowInput = {
  workflowCommandId: "01984477-1f9a-7b25-a5cc-83c3b21fbc68",
  subjectId: "01984477-2f9a-7b25-a5cc-83c3b21fbc68",
  sourceRevision: 4,
  policyVersion: "1a3b-model-role-policy:v1",
  expectedDataEpoch: 2,
  modelRole: "reflection.daily",
  generationCommandId: "01984477-3f9a-7b25-a5cc-83c3b21fbc68",
  modelRunAttemptId: "01984477-4f9a-7b25-a5cc-83c3b21fbc68",
  attemptNo: 1,
  attemptKind: "initial",
  rolloutPin: "synthetic-rollout:v1",
};

describe("model-role Workflow envelope", () => {
  it("accepts content-free metadata for a G1 role", () => {
    expect(() => assertModelRoleWorkflowInput(baseInput)).not.toThrow();
  });

  it("keeps later release roles closed", () => {
    expect(() =>
      assertModelRoleWorkflowInput({
        ...baseInput,
        modelRole: "bio.write",
      }),
    ).toThrow("deferred");
  });

  it("rejects an attempt envelope that carries private content", () => {
    expect(() =>
      assertModelRoleWorkflowInput({
        ...baseInput,
        sourceSnapshot: "private draft text",
      } as ModelRoleWorkflowInput & { sourceSnapshot: string }),
    ).toThrow("non-allowlisted field");
  });

  it("requires non-empty command identity fields", () => {
    expect(() =>
      assertModelRoleWorkflowInput({
        ...baseInput,
        workflowCommandId: " ",
      }),
    ).toThrow("workflowCommandId must be non-empty");
  });

  it("does not permit schema repair for a G1 role", () => {
    expect(() =>
      assertModelRoleWorkflowInput({
        ...baseInput,
        attemptKind: "schema_repair",
      }),
    ).toThrow("schema_repair is not enabled for G1 roles");
  });
});

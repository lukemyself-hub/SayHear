import { describe, expect, it } from "vitest";

import {
  CATALOG_V2_CONVERSATION_HARNESS_POLICY,
  ENTITY_IDENTITY_CORRECTION_ACTION_DEFINITION,
  EMPTY_CONVERSATION_ACTION_CATALOG,
  INITIAL_CONVERSATION_HARNESS_POLICY,
  JOURNAL_REGENERATION_CONVERSATION_ACTION_CATALOG,
  MEMORY_TRUST_ACTIONS_CONVERSATION_ACTION_CATALOG,
  REGENERATE_JOURNAL_ACTION_DEFINITION,
  actionFunctionsForCatalog,
  normalizeProviderActionProposal,
  validateConversationActionCatalog,
} from "./conversation-action-catalog";
import type {
  ConversationActionDefinition,
} from "./conversation-action-catalog";
import type { ConversationEventRevisionId } from "@sayhear/domain";
import { asConversationEventRevisionId } from "@sayhear/domain";

const requestEventRevisionId: ConversationEventRevisionId =
  asConversationEventRevisionId("01984477-1f9a-7d25-9d97-e588769566c1");

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

describe("Conversation Action Catalog v2 foundation (issue #109)", () => {
  const secondDefinition: ConversationActionDefinition = {
    actionKind: "prefactor_probe",
    availabilityPolicy: "authenticated_owner",
    consistencyPolicy: "exact_head",
    confirmationPolicy: "none",
    effectClass: "test_only_effect",
    executionMode: "synchronous",
    functionDescription: "Probe that a second definition coexists with the Journal one.",
    handlerBinding: "test.prefactor-probe.v1",
    idempotencyScope: "decision_command_action_target",
    inputSchema: Object.freeze({
      additionalProperties: false as const,
      properties: Object.freeze({
        probeHandle: Object.freeze({ minLength: 1, type: "string" }),
      }),
      required: Object.freeze(["probeHandle"]),
      type: "object" as const,
    }),
    ratePolicy: Object.freeze({ maxInFlightPerTarget: null, name: "none" }),
    schemaVersion: "prefactor-probe:v1",
    targetContract: Object.freeze({
      handleArgument: "probeHandle",
      handleKind: "journal",
      versioned: true,
    }),
    trustClass: "user_private_test_probe",
  };

  it("validates a Catalog carrying two coexisting Definitions", () => {
    const catalog = {
      definitions: [
        REGENERATE_JOURNAL_ACTION_DEFINITION,
        secondDefinition,
      ],
      version: "conversation-action-catalog:test-two-definitions:v1",
    };
    expect(validateConversationActionCatalog(catalog)).toEqual({ valid: true });
  });

  it("still validates the published Journal and empty Catalogs unchanged", () => {
    expect(
      validateConversationActionCatalog(JOURNAL_REGENERATION_CONVERSATION_ACTION_CATALOG),
    ).toEqual({ valid: true });
    expect(
      validateConversationActionCatalog(EMPTY_CONVERSATION_ACTION_CATALOG),
    ).toEqual({ valid: true });
  });

  it("keeps rejecting duplicate kinds, missing safety policies, and broken schemas", () => {
    const duplicated = {
      definitions: [REGENERATE_JOURNAL_ACTION_DEFINITION, REGENERATE_JOURNAL_ACTION_DEFINITION],
      version: "conversation-action-catalog:test-duplicated:v1",
    };
    expect(validateConversationActionCatalog(duplicated)).toEqual({
      valid: false,
      reason: "duplicate_action_kind",
    });
    // Runtime-invalid fixtures are cast: the type system refuses to express
    // them, which is exactly the fail-closed posture under test.
    const unsafeConfirmation = {
      ...secondDefinition,
      confirmationPolicy: "explicit_user_confirm",
    } as unknown as ConversationActionDefinition;
    expect(
      validateConversationActionCatalog({
        definitions: [REGENERATE_JOURNAL_ACTION_DEFINITION, unsafeConfirmation],
        version: "conversation-action-catalog:test-unsafe:v1",
      }).valid,
    ).toBe(false);
    const schemaFree = {
      definitions: [
        {
          ...secondDefinition,
          inputSchema: { ...secondDefinition.inputSchema, additionalProperties: true },
        },
      ],
      version: "conversation-action-catalog:test-open-schema:v1",
    } as unknown as Parameters<typeof validateConversationActionCatalog>[0];
    expect(schemaFree.definitions[0]?.inputSchema.additionalProperties).toBe(true);
    expect(validateConversationActionCatalog(schemaFree).valid).toBe(false);
  });

  it("generates one Function per eligible Definition from the Definition itself", () => {
    const handles = [
      {
        actionKinds: ["regenerate_journal"],
        handle: "shh-handle-journal",
        targetKind: "journal" as const,
      },
      {
        actionKinds: ["prefactor_probe"],
        handle: "shh-handle-probe",
        targetKind: "journal" as const,
      },
    ];
    const catalog = {
      definitions: [REGENERATE_JOURNAL_ACTION_DEFINITION, secondDefinition],
      version: "conversation-action-catalog:test-two-definitions:v1",
    };
    const functions = actionFunctionsForCatalog(catalog, handles);
    expect(functions.map((fn) => fn.name)).toEqual([
      "regenerate_journal",
      "prefactor_probe",
    ]);
    expect(functions[1]).toEqual({
      description: secondDefinition.functionDescription,
      name: "prefactor_probe",
      parameters: secondDefinition.inputSchema,
      strict: true,
    });
    expect(functions[0]?.description).toBe(
      REGENERATE_JOURNAL_ACTION_DEFINITION.functionDescription,
    );
  });

  it("normalizes proposals against any Definition in the frozen set", () => {
    const normalized = normalizeProviderActionProposal({
      definitions: [REGENERATE_JOURNAL_ACTION_DEFINITION, secondDefinition],
      rawArguments: JSON.stringify({ probeHandle: "shh-handle-probe" }),
      rawFunctionName: "prefactor_probe",
      requestEventRevisionId,
    });
    expect(normalized.type).toBe("normalized");
    if (normalized.type !== "normalized") return;
    expect(normalized.proposal).toEqual({
      actionKind: "prefactor_probe",
      arguments: { probeHandle: "shh-handle-probe" },
      requestEventRevisionId,
      schemaVersion: "prefactor-probe:v1",
    });

    const regen = normalizeProviderActionProposal({
      definitions: [REGENERATE_JOURNAL_ACTION_DEFINITION],
      rawArguments: '{"guidance":"clearer","journalHandle":"shh-handle"}',
      rawFunctionName: "regenerate_journal",
      requestEventRevisionId,
    });
    expect(regen.type).toBe("normalized");
    if (regen.type !== "normalized") return;
    expect(regen.proposal.schemaVersion).toBe("regenerate-journal:v1");
  });

  it("rejects arguments that violate the selected Definition's schema", () => {
    expect(
      normalizeProviderActionProposal({
        definitions: [secondDefinition],
        rawArguments: '{"probeHandle":"h","extra":"no"}',
        rawFunctionName: "prefactor_probe",
        requestEventRevisionId,
      }).type,
    ).toBe("invalid");
    expect(
      normalizeProviderActionProposal({
        definitions: [ENTITY_IDENTITY_CORRECTION_ACTION_DEFINITION],
        rawArguments: JSON.stringify({
          operation: "guess",
          targetAnchor: "Alex",
        }),
        rawFunctionName: "entity_identity_correction",
        requestEventRevisionId,
      }).type,
    ).toBe("invalid");
    expect(
      normalizeProviderActionProposal({
        definitions: [secondDefinition],
        rawArguments: "{}",
        rawFunctionName: "prefactor_probe",
        requestEventRevisionId,
      }).type,
    ).toBe("invalid");
    expect(
      normalizeProviderActionProposal({
        definitions: [secondDefinition],
        rawArguments: '{"probeHandle":""}',
        rawFunctionName: "prefactor_probe",
        requestEventRevisionId,
      }).type,
    ).toBe("invalid");
  });

  it("pins all five memory trust-control Definitions in Catalog v2", () => {
    expect(
      MEMORY_TRUST_ACTIONS_CONVERSATION_ACTION_CATALOG.definitions.map(
        (definition) => definition.actionKind,
      ),
    ).toEqual([
      "regenerate_journal",
      "memory_correction",
      "explain_memory_source",
      "memory_forget_request",
      "memory_forget_reversal",
      "entity_identity_correction",
    ]);
    expect(
      validateConversationActionCatalog(
        MEMORY_TRUST_ACTIONS_CONVERSATION_ACTION_CATALOG,
      ),
    ).toEqual({ valid: true });
  });

  it("bumps the Harness policy version while preserving one state-changing Action", () => {
    expect(Object.isFrozen(CATALOG_V2_CONVERSATION_HARNESS_POLICY)).toBe(true);
    expect(CATALOG_V2_CONVERSATION_HARNESS_POLICY.version).toBe(
      "conversation-harness:v3",
    );
    expect(CATALOG_V2_CONVERSATION_HARNESS_POLICY.maxStateChangingActions).toBe(1);
    expect(CATALOG_V2_CONVERSATION_HARNESS_POLICY.maxDecisionStages).toBe(1);
  });
});

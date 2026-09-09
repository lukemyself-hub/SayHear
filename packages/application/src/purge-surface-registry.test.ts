import { describe, expect, it } from "vitest";

import {
  PURGE_EXTERNAL_INTEGRATION_MANIFEST_VERSION,
  PURGE_SURFACE_EXTERNAL_INTEGRATIONS,
  PURGE_SURFACE_REGISTRY,
  PURGE_SURFACE_REGISTRY_SNAPSHOT,
  PURGE_SURFACE_REGISTRY_VERSION,
  PurgeSurfaceRegistryError,
  assertPurgeSurfaceRegistry,
  fingerprintPurgeSurfaceConstraints,
  fingerprintPurgeSurfaceIndexes,
  normalizePurgeSurfaceConstraintDefinition,
  normalizePurgeSurfaceIndexDefinition,
  validatePurgeSurfaceInventory,
} from "./purge-surface-registry";

describe("Full Purge Surface Registry", () => {
  it("is a frozen, versioned contract with independent clear and verify handlers", () => {
    expect(PURGE_SURFACE_REGISTRY_VERSION).toBe("purge-surface-registry:v1");
    expect(PURGE_EXTERNAL_INTEGRATION_MANIFEST_VERSION).toBe(
      "purge-external-integration-manifest:v1",
    );
    expect(Object.isFrozen(PURGE_SURFACE_REGISTRY)).toBe(true);
    expect(Object.isFrozen(PURGE_SURFACE_REGISTRY[0])).toBe(true);
    expect(PURGE_SURFACE_REGISTRY.length).toBeGreaterThan(1);
    expect(PURGE_SURFACE_EXTERNAL_INTEGRATIONS).toHaveLength(1);
    expect(PURGE_SURFACE_EXTERNAL_INTEGRATIONS[0]).toMatchObject({
      clearHandler: "record_provider_retention",
      integrationId: "provider-egress.responses-api",
      verifyHandler: "verify_provider_retention_receipt",
    });
    for (const surface of PURGE_SURFACE_REGISTRY) {
      expect(surface.surfaceId).not.toBe("");
      expect(surface.clearHandler).not.toBe(surface.verifyHandler);
      expect(surface.schemaObjects.length).toBeGreaterThan(0);
      expect(surface.restoreReapplyHandler).not.toBe("");
      expect(surface.introducedBySchemaOrIntegration).not.toBe("");
    }
    expect(assertPurgeSurfaceRegistry()).toBe(PURGE_SURFACE_REGISTRY_SNAPSHOT);
  });

  it("rejects duplicate or incomplete registry entries before a purge can open", () => {
    const first = PURGE_SURFACE_REGISTRY_SNAPSHOT.surfaces[0]!;
    expect(() =>
      assertPurgeSurfaceRegistry({
        ...PURGE_SURFACE_REGISTRY_SNAPSHOT,
        surfaces: [first, first],
      }),
    ).toThrow(PurgeSurfaceRegistryError);
    expect(() =>
      assertPurgeSurfaceRegistry({
        ...PURGE_SURFACE_REGISTRY_SNAPSHOT,
        surfaces: [
          {
            ...first,
            schemaObjects: [],
          },
        ],
      }),
    ).toThrow(/surface_without_schema_object/);
  });

  it("binds every declared private field to the registered schema columns", () => {
    const compiledContexts = PURGE_SURFACE_REGISTRY_SNAPSHOT.surfaces.find(
      (surface) => surface.surfaceId === "compiled_contexts",
    );
    expect(compiledContexts?.privateContentFields).toEqual(
      expect.arrayContaining([
        "content_hmac",
        "sections",
        "rolling_summary",
        "retrieval_manifest",
      ]),
    );

    expect(() =>
      assertPurgeSurfaceRegistry({
        ...PURGE_SURFACE_REGISTRY_SNAPSHOT,
        surfaces: PURGE_SURFACE_REGISTRY_SNAPSHOT.surfaces.map((surface) =>
          surface.surfaceId === "compiled_contexts"
            ? {
                ...surface,
                privateContentFields: ["column_added_without_registration"],
              }
            : surface,
        ),
      }),
    ).toThrow(/private_content_field_not_registered:compiled_contexts/);

    expect(() =>
      assertPurgeSurfaceRegistry({
        ...PURGE_SURFACE_REGISTRY_SNAPSHOT,
        nonPrivateColumns: PURGE_SURFACE_REGISTRY_SNAPSHOT.nonPrivateColumns.slice(
          1,
        ),
      }),
    ).toThrow(/unclassified_registered_column/);
  });

  it("rejects an owner table, index, or external integration without registration", () => {
    const result = validatePurgeSurfaceInventory({
      foreignKeys: [],
      tables: ["app_users", "new_private_surface"],
      indexes: [
        { name: "auth_sessions_user_id_idx", table: "wrong_table" },
        { name: "new_private_surface_owner_idx", table: "new_private_surface" },
      ],
      externalIntegrations: ["provider:new-private-surface"],
    });
    expect(result).toMatchObject({
      ok: false,
      missingTables: ["new_private_surface"],
      missingIndexes: ["new_private_surface_owner_idx"],
      missingExternalIntegrations: ["provider:new-private-surface"],
      indexTableMismatches: [
        {
          name: "auth_sessions_user_id_idx",
          registeredTable: "auth_sessions",
          inventoryTable: "wrong_table",
        },
      ],
    });
  });

  it("fingerprints PostgreSQL-rewritten constraint and index definitions", () => {
    const sourceConstraint = normalizePurgeSurfaceConstraintDefinition(
      "CHECK (status IN ('active', 'stale'))",
    );
    const postgresConstraint = normalizePurgeSurfaceConstraintDefinition(
      "CHECK ((status = ANY (ARRAY['active'::text, 'stale'::text])))",
    );
    expect(sourceConstraint).toBe(postgresConstraint);
    expect(
      fingerprintPurgeSurfaceConstraints([`sessions|${sourceConstraint}`]),
    ).toBe(
      fingerprintPurgeSurfaceConstraints([`sessions|${postgresConstraint}`]),
    );
    expect(
      fingerprintPurgeSurfaceConstraints([
        "sessions|CHECK STATUS IN ('ACTIVE', 'DELETED')",
      ]),
    ).not.toBe(
      fingerprintPurgeSurfaceConstraints([`sessions|${sourceConstraint}`]),
    );

    const sourceIndex = normalizePurgeSurfaceIndexDefinition(
      "CREATE UNIQUE INDEX sessions_active_idx ON sessions (user_id) WHERE status IN ('active', 'stale')",
    );
    const postgresIndex = normalizePurgeSurfaceIndexDefinition(
      "CREATE UNIQUE INDEX sessions_active_idx ON public.sessions USING btree (user_id) WHERE ((status = ANY (ARRAY['active'::text, 'stale'::text])))",
    );
    expect(sourceIndex).toBe(postgresIndex);
    expect(
      fingerprintPurgeSurfaceIndexes([
        { name: "sessions_active_idx", table: "sessions", definition: sourceIndex },
      ]),
    ).toBe(
      fingerprintPurgeSurfaceIndexes([
        { name: "sessions_active_idx", table: "sessions", definition: postgresIndex },
      ]),
    );
    expect(
      fingerprintPurgeSurfaceIndexes([
        {
          name: "sessions_active_idx",
          table: "sessions",
          definition: "CREATE UNIQUE INDEX sessions_active_idx ON sessions (user_id) WHERE status = 'active'",
        },
      ]),
    ).not.toBe(
      fingerprintPurgeSurfaceIndexes([
        { name: "sessions_active_idx", table: "sessions", definition: sourceIndex },
      ]),
    );
  });
});

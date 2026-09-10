import { describe, expect, it } from "vitest";

import {
  decodeReflectionInspectionCursor,
  encodeReflectionInspectionCursor,
  normalizeReflectionInspectionLimit,
  reflectionInspectionFilterFingerprint,
  ReflectionInspectionCursorError,
  ReflectionInspectionLimitError,
} from "./reflection-inspection";

const owner = "01984477-1f9a-7b25-a5cc-83c3b21fbc68" as never;

describe("Reflection Inspector pagination contract", () => {
  it("defaults and caps page sizes while rejecting invalid values", () => {
    expect(normalizeReflectionInspectionLimit(undefined)).toBe(25);
    expect(normalizeReflectionInspectionLimit(1000)).toBe(100);
    expect(() => normalizeReflectionInspectionLimit(0)).toThrow(
      ReflectionInspectionLimitError,
    );
    expect(() => normalizeReflectionInspectionLimit(1.5)).toThrow(
      ReflectionInspectionLimitError,
    );
  });

  it("round-trips an owner- and query-bound opaque cursor", () => {
    const cursor = encodeReflectionInspectionCursor(
      {
        after: ["2026-09-09", "01984477-1f9a-7b25-a5cc-83c3b21fbc69"],
        filter: reflectionInspectionFilterFingerprint({
          status: ["committed", "stale"],
          scopeType: "daily_session",
        }),
        layer: "reflections",
        limit: 25,
        owner,
        snapshot: "2026-09-10T15:00:00.000Z",
        sort: "scope_end_desc_reflection_id_asc",
        version: 1,
      },
      "cursor-secret",
    );

    expect(decodeReflectionInspectionCursor(cursor, "cursor-secret")).toMatchObject({
      layer: "reflections",
      limit: 25,
      owner,
    });
    expect(decodeReflectionInspectionCursor(`${cursor}tampered`, "cursor-secret"))
      .toBeNull();
    expect(decodeReflectionInspectionCursor(cursor, "wrong-secret")).toBeNull();
  });

  it("round-trips the four-key Bio impact continuation cursor", () => {
    const cursor = encodeReflectionInspectionCursor(
      {
        after: [
          "7",
          "01984477-1f9a-7b25-a5cc-83c3b21fbc69",
          "01984477-1f9a-7b25-a5cc-83c3b21fbc70",
          "01984477-1f9a-7b25-a5cc-83c3b21fbc71",
        ],
        filter: "claim-version",
        layer: "bio_impact",
        limit: 25,
        owner,
        snapshot: "2026-09-10T15:00:00.000Z",
        sort: "revision_desc_bio_version_id_asc_link_id_asc_coverage_unit_id_asc",
        version: 1,
      },
      "cursor-secret",
    );

    expect(decodeReflectionInspectionCursor(cursor, "cursor-secret")).toMatchObject({
      after: [
        "7",
        "01984477-1f9a-7b25-a5cc-83c3b21fbc69",
        "01984477-1f9a-7b25-a5cc-83c3b21fbc70",
        "01984477-1f9a-7b25-a5cc-83c3b21fbc71",
      ],
      layer: "bio_impact",
    });
  });

  it("keeps filter order canonical for cursor binding", () => {
    expect(
      reflectionInspectionFilterFingerprint({
        candidateId: "01984477-1f9a-7b25-a5cc-83c3b21fbc69" as never,
        reflectionVersionId: "01984477-1f9a-7b25-a5cc-83c3b21fbc70" as never,
        status: ["stale", "committed"],
      }),
    ).toBe(
      reflectionInspectionFilterFingerprint({
        candidateId: "01984477-1f9a-7b25-a5cc-83c3b21fbc69" as never,
        reflectionVersionId: "01984477-1f9a-7b25-a5cc-83c3b21fbc70" as never,
        status: ["committed", "stale"],
      }),
    );
  });

  it("uses a typed cursor error for invalid continuation state", () => {
    expect(new ReflectionInspectionCursorError()).toBeInstanceOf(Error);
  });
});

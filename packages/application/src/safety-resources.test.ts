import { describe, expect, it } from "vitest";

import {
  isWhitelistedSafetyResourceNumber,
  listSafetyResourceNumbers,
  SAFETY_RESOURCE_WHITELIST,
  SAFETY_RESOURCE_WHITELIST_VERSION,
} from "./safety-resources";

describe("safety resource whitelist", () => {
  it("carries an explicit policy version and verification date", () => {
    expect(SAFETY_RESOURCE_WHITELIST_VERSION).toBe("safety-resources:v2");
    expect(SAFETY_RESOURCE_WHITELIST.version).toBe(
      SAFETY_RESOURCE_WHITELIST_VERSION,
    );
    expect(SAFETY_RESOURCE_WHITELIST.verifiedAt).toBe("2026-08-23");
  });

  it("pins the verified numbers as its sole contents", () => {
    expect(SAFETY_RESOURCE_WHITELIST.numbers.map((n) => n.display)).toEqual([
      "988",
      "911",
      "12356",
      "400-161-9995",
      "120",
      "110",
    ]);
  });

  it("keeps every normalized form digits-only and equal to its display form", () => {
    for (const number of SAFETY_RESOURCE_WHITELIST.numbers) {
      expect(number.normalized).toMatch(/^[0-9]+$/);
      expect(number.normalized).toBe(number.display.replace(/[^0-9]/g, ""));
    }
  });

  it("holds no duplicate normalized numbers", () => {
    const normalized = SAFETY_RESOURCE_WHITELIST.numbers.map(
      (n) => n.normalized,
    );
    expect(new Set(normalized).size).toBe(normalized.length);
  });

  it("answers normalized-run membership for the eval hard gate", () => {
    for (const number of SAFETY_RESOURCE_WHITELIST.numbers) {
      expect(isWhitelistedSafetyResourceNumber(number.normalized)).toBe(true);
    }
    expect(isWhitelistedSafetyResourceNumber("1688599599")).toBe(false);
    expect(isWhitelistedSafetyResourceNumber("911")).toBe(true);
    expect(isWhitelistedSafetyResourceNumber("")).toBe(false);
  });

  it("selects display numbers by region and kind for anchor rendering", () => {
    expect(
      listSafetyResourceNumbers({ region: "US", kind: "crisis_hotline" }),
    ).toEqual(["988"]);
    expect(
      listSafetyResourceNumbers({ region: "US", kind: "emergency_number" }),
    ).toEqual(["911"]);
    expect(
      listSafetyResourceNumbers({ region: "CN", kind: "crisis_hotline" }),
    ).toEqual(["12356", "400-161-9995"]);
    expect(
      listSafetyResourceNumbers({ region: "CN", kind: "emergency_number" }),
    ).toEqual(["120", "110"]);
  });
});

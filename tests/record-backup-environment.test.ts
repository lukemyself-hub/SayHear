import { describe, expect, it } from "vitest";

import { requiredNonNegativeNumberEnvironment } from "../packages/data/src/cli/environment";

describe("requiredNonNegativeNumberEnvironment", () => {
  function read(name: string, value: string | undefined): number | Error {
    const previous = process.env[name];
    try {
      if (value === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = value;
      }
      try {
        return requiredNonNegativeNumberEnvironment(name);
      } catch (error) {
        return error as Error;
      }
    } finally {
      if (previous === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = previous;
      }
    }
  }

  it("keeps fractional days instead of truncating them (Neon 6h PITR)", () => {
    expect(read("TEST_DAYS", "0.25")).toBe(0.25);
  });

  it("accepts zero and integer days", () => {
    expect(read("TEST_DAYS", "0")).toBe(0);
    expect(read("TEST_DAYS", "7")).toBe(7);
  });

  it("rejects non-numeric, negative, and missing values", () => {
    expect(read("TEST_DAYS", "1d")).toBeInstanceOf(Error);
    expect(read("TEST_DAYS", "-1")).toBeInstanceOf(Error);
    expect(read("TEST_DAYS", "")).toBeInstanceOf(Error);
    expect(read("TEST_DAYS", undefined)).toBeInstanceOf(Error);
  });
});

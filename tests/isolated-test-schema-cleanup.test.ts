import { describe, expect, it } from "vitest";

import {
  assertDistinctTestDatabaseUrls,
  isIsolatedTestSchemaName,
  planIsolatedTestSchemaDrops,
} from "@sayhear/test-support";

const schemaName = (suffix: string): string =>
  `sayhear_test_${suffix.repeat(32 / suffix.length)}`;

describe("isolated test schema cleanup", () => {
  it("accepts only generated schema names", () => {
    expect(isIsolatedTestSchemaName(schemaName("a"))).toBe(true);
    expect(isIsolatedTestSchemaName("sayhear_test_short")).toBe(false);
    expect(isIsolatedTestSchemaName("sayhear_test_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA")).toBe(
      false,
    );
    expect(isIsolatedTestSchemaName("public")).toBe(false);
  });

  it("rejects a test URL that targets the production database", () => {
    expect(() =>
      assertDistinctTestDatabaseUrls(
        "postgres://test:one@db.example:5432/sayhear",
        "postgres://owner:two@db.example:5432/sayhear",
      ),
    ).toThrow(/same host and database/);
    expect(() =>
      assertDistinctTestDatabaseUrls(
        "postgres://test:one@db.example:5432/sayhear_test",
        "postgres://owner:two@db.example:5432/sayhear",
      ),
    ).not.toThrow();
  });

  it("batches validated names and refuses duplicates", () => {
    const first = schemaName("a");
    const second = schemaName("b");
    const third = schemaName("c");
    expect(planIsolatedTestSchemaDrops([first, second, third], 2)).toEqual([
      [first, second],
      [third],
    ]);
    expect(() => planIsolatedTestSchemaDrops([first, first])).toThrow(
      /Duplicate/,
    );
    expect(() => planIsolatedTestSchemaDrops(["public"])).toThrow(
      /unexpected test schema name/,
    );
  });
});

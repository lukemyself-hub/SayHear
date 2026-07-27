import { describe, expect, it } from "vitest";

import { asUserId } from "@sayhear/domain";

describe("persistent user identity", () => {
  it("accepts UUIDv7 and rejects another UUID version", () => {
    expect(asUserId("01984477-1f9a-7b25-a5cc-83c3b21fbc68")).toBe(
      "01984477-1f9a-7b25-a5cc-83c3b21fbc68",
    );
    expect(() =>
      asUserId("7d444840-9dc0-4dd1-b282-7420e5867320"),
    ).toThrow("UUIDv7");
  });
});

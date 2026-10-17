import { expect, it } from "vitest";

// Temporary controlled-red fixture to prove hosted Validate refusal; removed in a later commit before any merge, never reaches main.
it("SPEC362 controlled CI failure fixture must never reach main", () => {
  expect("controlled-red").toBe("controlled-green");
});

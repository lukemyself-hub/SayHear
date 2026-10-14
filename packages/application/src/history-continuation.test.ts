import { describe, expect, it } from "vitest";

import { normalizeHistoryReviewCall } from "./history-recall";

describe("continuation proposal (#317)", () => {
  it("marks a search as a continuation of the current talk with its trigger basis", () => {
    expect(
      normalizeHistoryReviewCall({
        rawArguments: JSON.stringify({
          continuation_basis: ["current_input", "dialogue_state", "current_input"],
          search_terms: ["bowls", "entry"],
        }),
      }),
    ).toMatchObject({
      proposal: {
        continuation: { basis: ["current_input", "dialogue_state"] },
        kind: "search_experience",
        terms: ["bowls", "entry"],
      },
    });
  });

  it("keeps an ordinary search free of a continuation marker", () => {
    const result = normalizeHistoryReviewCall({
      rawArguments: '{"search_terms":["piano","钢琴"]}',
    });
    expect(result).toMatchObject({ proposal: { kind: "search_experience" } });
    expect("proposal" in result && "continuation" in result.proposal).toBe(false);
  });

  it("rejects a basis outside the three valid signals, an empty basis, or a basis on a date review", () => {
    for (const rawArguments of [
      '{"search_terms":["bowls"],"continuation_basis":["assistant_reply"]}',
      '{"search_terms":["bowls"],"continuation_basis":[]}',
      '{"search_terms":["bowls"],"continuation_basis":"current_input"}',
      '{"start_date":"2026-08-20","continuation_basis":["current_input"]}',
    ]) {
      expect(normalizeHistoryReviewCall({ rawArguments })).toEqual({ invalid: true });
    }
  });
});

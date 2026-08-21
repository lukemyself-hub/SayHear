import { describe, expect, it } from "vitest";

import {
  describeJournalFinding,
  describeJournalGenerationNotice,
} from "../apps/web/app/internal/journal-diagnostics";

describe("Internal Portal Journal diagnostics", () => {
  it("maps fixed finding codes to natural language without exposing code fields", () => {
    const text = describeJournalFinding({
      statementId: "statement-1",
      code: "third_person_style",
      detailCode: "first_person_expression",
    });

    expect(text).toContain("第三人称观察视角");
    expect(text).not.toContain("third_person_style");
    expect(text).not.toContain("severity");
  });

  it("maps hard failures to a user-readable notice without draft content", () => {
    const text = describeJournalGenerationNotice({
      logicalDate: "2026-08-19",
      failureCode: "invalid_evidence",
    });

    expect(text).toContain("2026-08-19 的 Journal 未生成");
    expect(text).toContain("Evidence 来源校验");
    expect(text).not.toContain("draft");
  });
});

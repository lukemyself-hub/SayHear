import { describe, expect, it } from "vitest";

import {
  diagnoseStep,
  type DiagnosticEvidence,
} from "../eval/continuity-acceptance-301/src/diagnose";

describe("diagnosis of a source sent as a conversation turn", () => {
  it("reads the day of a source sent as a conversation turn from its own \"[written\" line (time:v4)", () => {
    const evidenceWith = (firstLine: string, expectedLocalDate: string): DiagnosticEvidence => ({
      authoritativeTexts: ["周三把背包拿去补了。"],
      recall: null,
      requests: [
        {
          instructions: "Time context\nNow is Saturday 12 September 2026, 20:00.",
          messages: [
            { role: "user", text: `${firstLine}周三把背包拿去补了。` },
            { role: "assistant", text: "补好了吗？" },
            { role: "user", text: "[written Saturday 12 September 2026, today, 20:00]\n我哪天去补的？" },
          ],
          providerResponseId: "request-1",
          sequence: 1,
          toolsOffered: [],
        },
      ],
      semanticVerdict: null,
      sources: [{ expectedLocalDate, revisionId: "revision-1", source: "bag", text: "周三把背包拿去补了。" }],
      turn: null,
    });
    const line = "[written Wednesday 9 September 2026, 3 days ago, 19:40]\n";
    expect(diagnoseStep(evidenceWith(line, "2026-09-09")).sources[0]!.fault).toBe("undetermined");
    expect(diagnoseStep(evidenceWith(line, "2026-09-08")).sources[0]!.fault).toBe("time_lost");
    expect(diagnoseStep(evidenceWith("", "2026-09-09")).sources[0]!.fault).toBe("time_lost");
    expect(
      diagnoseStep(evidenceWith("[written at an unrecorded time]\n", "2026-09-09")).sources[0]!.fault,
    ).toBe("time_lost");
  });
});

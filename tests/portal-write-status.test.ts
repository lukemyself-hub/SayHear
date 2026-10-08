import { describe, expect, it } from "vitest";

import {
  portalFooterStateText,
  writeStatusFromAccessResponse,
} from "../apps/web/app/internal/portal-write-status.ts";

/**
 * The sidebar's normal status must live at the bottom of the module list, but
 * moving it there must never make a blocked write look like an unblocked one
 * (ticket #283; SPEC #260 US 7). These are the pure mappings the shell footer
 * renders from, tested without a browser.
 */

describe("writeStatusFromAccessResponse", () => {
  it("reads an allowed private-writes gate from a 200", () => {
    expect(
      writeStatusFromAccessResponse(200, {
        privateWrites: { allowed: true, reason: "backup_evidence_current" },
      }),
    ).toEqual({ kind: "allowed", reason: "backup_evidence_current" });
  });

  it("keeps the gate reason for a 200 that blocks writes", () => {
    expect(
      writeStatusFromAccessResponse(200, {
        privateWrites: { allowed: false, reason: "backup_evidence_expired" },
      }),
    ).toEqual({ kind: "blocked", reason: "backup_evidence_expired" });
  });

  it("treats a 401 as a blocked write instead of an unknown normal state", () => {
    expect(writeStatusFromAccessResponse(401, { error: "unauthorized" })).toEqual(
      { kind: "blocked", reason: "unauthorized" },
    );
  });

  it("treats a 403 as a blocked write instead of an unknown normal state", () => {
    expect(writeStatusFromAccessResponse(403, { error: "forbidden" })).toEqual({
      kind: "blocked",
      reason: "forbidden",
    });
  });

  it("surfaces the Recovery Gate reason from a 503", () => {
    expect(
      writeStatusFromAccessResponse(503, {
        error: "recovery_gate_closed",
        status: { evalEpoch: 1 },
      }),
    ).toEqual({ kind: "blocked", reason: "recovery_gate_closed" });
  });

  it("falls back to the HTTP status when a non-2xx body has no error code", () => {
    expect(writeStatusFromAccessResponse(500, {})).toEqual({
      kind: "blocked",
      reason: "http_500",
    });
  });

  it("stays unknown for a malformed 2xx body so it is not reported as allowed", () => {
    expect(writeStatusFromAccessResponse(200, {})).toEqual({ kind: "unknown" });
    expect(
      writeStatusFromAccessResponse(200, { privateWrites: { allowed: "yes" } }),
    ).toEqual({ kind: "unknown" });
  });
});

describe("portalFooterStateText", () => {
  it("shows the neutral normal label while the status is unknown", () => {
    expect(portalFooterStateText({ kind: "unknown" })).toBe("内部自用");
  });

  it("shows the writable label only when allowed", () => {
    expect(
      portalFooterStateText({ kind: "allowed", reason: "backup_evidence_current" }),
    ).toBe("内部自用 · 可写入");
  });

  it("never hides the block reason behind the normal bottom status", () => {
    const text = portalFooterStateText({
      kind: "blocked",
      reason: "recovery_gate_closed",
    });
    expect(text).toContain("写入已阻断");
    expect(text).toContain("recovery_gate_closed");
  });
});

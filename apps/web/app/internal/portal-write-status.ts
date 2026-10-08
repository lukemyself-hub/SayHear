/**
 * Normalizes the sidebar's `GET /api/internal/access` read into the small
 * status the footer renders. This is kept as a pure function so the blocked
 * presentation can be tested without a browser.
 *
 * The contract (SPEC #260 US 7 / ticket #283): a normal, writable owner state
 * may live at the bottom of the navigation, but a blocked write must stay
 * visibly blocked with its reason. A non-2xx response (401 unauthorized, 403
 * forbidden, 503 Recovery-Gate closed, …) is a write block, never the neutral
 * "内部自用" state.
 */

export type PortalWriteStatus =
  | Readonly<{ kind: "unknown" }>
  | Readonly<{ kind: "allowed"; reason: string }>
  | Readonly<{ kind: "blocked"; reason: string }>;

export const UNKNOWN_WRITE_STATUS: PortalWriteStatus = { kind: "unknown" };

type PrivateWrites = Readonly<{ allowed: boolean; reason: string }>;

function readPrivateWrites(payload: unknown): PrivateWrites | null {
  if (typeof payload !== "object" || payload === null) {
    return null;
  }
  const candidate = (payload as { privateWrites?: unknown }).privateWrites;
  if (typeof candidate !== "object" || candidate === null) {
    return null;
  }
  const { allowed, reason } = candidate as { allowed?: unknown; reason?: unknown };
  if (typeof allowed === "boolean" && typeof reason === "string") {
    return { allowed, reason };
  }
  return null;
}

function readErrorCode(payload: unknown): string | null {
  if (typeof payload !== "object" || payload === null) {
    return null;
  }
  const error = (payload as { error?: unknown }).error;
  return typeof error === "string" && error.length > 0 ? error : null;
}

export function writeStatusFromAccessResponse(
  httpStatus: number,
  payload: unknown,
): PortalWriteStatus {
  if (httpStatus >= 200 && httpStatus < 300) {
    const privateWrites = readPrivateWrites(payload);
    if (privateWrites === null) {
      // A malformed success body has no authorization signal; stay neutral
      // rather than claiming the owner can write.
      return UNKNOWN_WRITE_STATUS;
    }
    return privateWrites.allowed
      ? { kind: "allowed", reason: privateWrites.reason }
      : { kind: "blocked", reason: privateWrites.reason };
  }
  return {
    kind: "blocked",
    reason: readErrorCode(payload) ?? `http_${httpStatus}`,
  };
}

export function portalFooterStateText(status: PortalWriteStatus): string {
  switch (status.kind) {
    case "allowed":
      return "内部自用 · 可写入";
    case "blocked":
      return `内部自用 · 写入已阻断：${status.reason}`;
    default:
      return "内部自用";
  }
}

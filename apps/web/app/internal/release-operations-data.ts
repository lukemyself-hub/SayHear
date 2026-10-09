import type { OneA3bG1ReleaseManifest } from "@sayhear/application";

/**
 * Content-free projection for the Internal Owner release-operations page.
 *
 * Everything here is deliberately small and side-effect free so it can be
 * shared by the server page and the client component and unit-tested without a
 * database, a session or a React renderer. The page never receives the full
 * release manifest or a raw environment object; the server extracts only the
 * last accepted business migration name, and the client renders only the
 * content-free inspection endpoints.
 */

/** The minimum manifest shape needed to name the last accepted migration. */
export type AcceptedMigrationManifest = Pick<OneA3bG1ReleaseManifest, "schema">;

/**
 * The last accepted business migration name, or `null` when no manifest is
 * configured or it carries no migrations. Only the migration name leaves the
 * server: the rest of the manifest (pins, roles, evidence) never crosses into
 * the page.
 */
export function lastAcceptedBusinessMigrationName(
  manifest: AcceptedMigrationManifest | null,
): string | null {
  const migrations = manifest?.schema.migrations;
  if (!migrations || migrations.length === 0) return null;
  const last = migrations[migrations.length - 1];
  return last?.name ?? null;
}

/**
 * The content-free shape the page reads off the effective runtime config
 * endpoint. Kept structural so the client bundle never imports the server
 * configuration module.
 */
export type ReleaseOperationsConfigItem = Readonly<{
  category: string;
  critical: boolean;
  inManifestFingerprint: boolean;
  key: string;
  source: string;
  value: string | number | boolean | null;
}>;

/**
 * Drop the Internal Owner identity values from the effective runtime
 * configuration before display. `owner.subject` / `owner.user_id` / `owner.issuer`
 * are the only operator-identifying fields; every other item is already
 * content-free metadata (presence booleans, versions, target hashes).
 */
export function safeRuntimeConfigItems<T extends ReleaseOperationsConfigItem>(
  items: readonly T[],
): readonly T[] {
  return items.filter((item) => !item.key.startsWith("owner."));
}

/** The existing, session-authenticated endpoints the page reads. */
export const RELEASE_IDENTITY_PATH =
  "/api/internal/inspection/release-identity";
export const EFFECTIVE_RUNTIME_CONFIG_PATH =
  "/api/internal/inspection/effective-runtime-config";
export const RECENT_CONTEXT_PATH = "/api/internal/operator/recent-context";

export type ReleaseOperationsFetchKind =
  | "ok"
  | "unauthorized"
  | "forbidden"
  | "unavailable"
  | "conflict"
  | "error";

export type ReleaseOperationsFetchResult<T> = Readonly<{
  kind: ReleaseOperationsFetchKind;
  /** The `error` code the endpoint returned, or `http_<status>`; never raw HTML. */
  detail: string | null;
  data: T | null;
}>;

function extractErrorDetail(payload: unknown): string | null {
  if (
    typeof payload === "object" &&
    payload !== null &&
    typeof (payload as { error?: unknown }).error === "string"
  ) {
    return (payload as { error: string }).error;
  }
  return null;
}

/**
 * Map an inspection response to an operator-visible outcome.
 *
 * A `404` is the expected result on the compatibility deployment that carries
 * no recent-context governance endpoint yet: it reads as `unavailable`, not as
 * a crash or a silent success. `401`/`403` fail closed, `409` reports the
 * already-applied state, and anything else is a generic error with the HTTP
 * status as the only detail.
 */
export function classifyReleaseOperationsResponse<T = unknown>(
  status: number,
  payload: unknown,
): ReleaseOperationsFetchResult<T> {
  const detail = extractErrorDetail(payload);
  switch (status) {
    case 200:
      return { kind: "ok", detail: null, data: (payload ?? null) as T | null };
    case 401:
      return { kind: "unauthorized", detail, data: null };
    case 403:
      return { kind: "forbidden", detail, data: null };
    case 404:
      return { kind: "unavailable", detail, data: null };
    case 409:
      return { kind: "conflict", detail, data: null };
    default:
      return { kind: "error", detail: detail ?? `http_${status}`, data: null };
  }
}

/** Human-readable Chinese label for a classified outcome. */
export function releaseOperationsOutcomeLabel(
  result: ReleaseOperationsFetchResult<unknown>,
): string {
  switch (result.kind) {
    case "ok":
      return "已获取";
    case "unauthorized":
      return "会话未授权（401），请重新登录 Internal Owner 会话";
    case "forbidden":
      return "无 Internal Owner 权限（403）";
    case "unavailable":
      return "当前部署未提供该端点（404），此兼容版本预期不可用";
    case "conflict":
      return "状态冲突（409）：该操作已经生效";
    case "error":
      return `请求失败（${result.detail ?? "unknown"}）`;
  }
}

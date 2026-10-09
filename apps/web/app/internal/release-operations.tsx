"use client";

import { useCallback, useEffect, useState } from "react";

import {
  classifyReleaseOperationsResponse,
  releaseOperationsOutcomeLabel,
  safeRuntimeConfigItems,
  EFFECTIVE_RUNTIME_CONFIG_PATH,
  RECENT_CONTEXT_PATH,
  RELEASE_IDENTITY_PATH,
  type ReleaseOperationsConfigItem,
  type ReleaseOperationsFetchResult,
} from "./release-operations-data";

type HostedReleaseIdentity = Readonly<{
  businessTargetHash: string;
  commit: string;
  environment: string | null;
  projectId: string;
  purgeMarkerTargetHash: string;
  teamId: string | null;
  version: string;
}>;

type EffectiveConfigurationSnapshot = Readonly<{
  collectedAt: string;
  commit: string;
  deploymentId: string;
  items: readonly ReleaseOperationsConfigItem[];
  version: string;
}>;

type RecentContextPolicy = Readonly<{
  budgetTokens: number;
  compilerVersion: string;
  createdAt: string;
  maxCandidateBytes: number;
  maxCandidateRows: number;
  maxSingleEventTokens: number;
  policyVersion: string;
  readTimeoutMs: number;
  revokedAt: string | null;
  selectionPolicyVersion: string;
  selectorPolicyVersion: string;
  status: string;
}>;

type RecentContextState = Readonly<{
  active: RecentContextPolicy | null;
  enabled: boolean;
  latest: RecentContextPolicy | null;
  policyCount: number;
}>;

type Loadable<T> = Readonly<{
  loading: boolean;
  result: ReleaseOperationsFetchResult<T> | null;
}>;

async function readJson(
  url: string,
  init?: RequestInit,
): Promise<{ status: number; payload: unknown }> {
  const response = await fetch(url, { cache: "no-store", ...init });
  let payload: unknown = null;
  try {
    payload = await response.json();
  } catch {
    // A Next 404 is HTML, not JSON; the status alone classifies it.
    payload = null;
  }
  return { status: response.status, payload };
}

export function ReleaseOperations({
  lastAcceptedBusinessMigration,
}: Readonly<{ lastAcceptedBusinessMigration: string | null }>) {
  const [identity, setIdentity] = useState<Loadable<HostedReleaseIdentity>>({
    loading: true,
    result: null,
  });
  const [runtimeConfig, setRuntimeConfig] = useState<
    Loadable<EffectiveConfigurationSnapshot>
  >({ loading: true, result: null });
  const [recentContext, setRecentContext] = useState<
    Loadable<RecentContextState>
  >({ loading: true, result: null });
  const [recentBusy, setRecentBusy] = useState(false);
  const [actionNotice, setActionNotice] = useState<
    Readonly<{ tone: "success" | "failure"; message: string }> | null
  >(null);

  const loadIdentity = useCallback(async () => {
    setIdentity({ loading: true, result: null });
    try {
      const { status, payload } = await readJson(RELEASE_IDENTITY_PATH);
      setIdentity({
        loading: false,
        result: classifyReleaseOperationsResponse<HostedReleaseIdentity>(
          status,
          payload,
        ),
      });
    } catch {
      setIdentity({
        loading: false,
        result: { kind: "error", detail: "network_error", data: null },
      });
    }
  }, []);

  const loadRuntimeConfig = useCallback(async () => {
    setRuntimeConfig({ loading: true, result: null });
    try {
      const { status, payload } = await readJson(EFFECTIVE_RUNTIME_CONFIG_PATH);
      setRuntimeConfig({
        loading: false,
        result:
          classifyReleaseOperationsResponse<EffectiveConfigurationSnapshot>(
            status,
            payload,
          ),
      });
    } catch {
      setRuntimeConfig({
        loading: false,
        result: { kind: "error", detail: "network_error", data: null },
      });
    }
  }, []);

  const loadRecentContext = useCallback(async () => {
    setRecentContext({ loading: true, result: null });
    try {
      const { status, payload } = await readJson(RECENT_CONTEXT_PATH);
      setRecentContext({
        loading: false,
        result: classifyReleaseOperationsResponse<RecentContextState>(
          status,
          payload,
        ),
      });
    } catch {
      setRecentContext({
        loading: false,
        result: { kind: "error", detail: "network_error", data: null },
      });
    }
  }, []);

  useEffect(() => {
    void loadIdentity();
    void loadRuntimeConfig();
    void loadRecentContext();
  }, [loadIdentity, loadRuntimeConfig, loadRecentContext]);

  async function changeRecentContext(action: "enable" | "disable") {
    // Buttons act only after an explicit click; nothing is enabled on load.
    setRecentBusy(true);
    setActionNotice(null);
    try {
      const { status, payload } = await readJson(RECENT_CONTEXT_PATH, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action }),
      });
      const result = classifyReleaseOperationsResponse<{
        effective: RecentContextState;
        outcome: string;
      }>(status, payload);
      if (result.kind === "ok") {
        const effective = (payload as { effective?: RecentContextState })
          .effective;
        setActionNotice({
          tone: "success",
          message: `操作已受理：${(payload as { outcome?: string }).outcome ?? "ok"}`,
        });
        if (effective) {
          setRecentContext({
            loading: false,
            result: { kind: "ok", detail: null, data: effective },
          });
        } else {
          await loadRecentContext();
        }
      } else {
        setActionNotice({
          tone: "failure",
          message: releaseOperationsOutcomeLabel(result),
        });
        // A conflict (already enabled) or a closed switch is not success:
        // re-read so the displayed state is the deployment's real state.
        await loadRecentContext();
      }
    } catch {
      setActionNotice({ tone: "failure", message: "请求失败（network_error）" });
    } finally {
      setRecentBusy(false);
    }
  }

  const recentContextUnavailable =
    recentContext.loading ||
    recentContext.result?.kind === "unavailable" ||
    recentContext.result?.kind === "unauthorized" ||
    recentContext.result?.kind === "forbidden";

  return (
    <div className="releaseOperations">
      <section className="releaseOperationsCard">
        <h2>部署身份（内容无关）</h2>
        {identity.loading ? (
          <p className="note">读取中…</p>
        ) : identity.result?.kind === "ok" && identity.result.data ? (
          <dl className="releaseOperationsFacts">
            <Fact label="Commit" value={identity.result.data.commit} />
            <Fact label="环境" value={identity.result.data.environment ?? "—"} />
            <Fact label="项目" value={identity.result.data.projectId} />
            <Fact label="团队" value={identity.result.data.teamId ?? "—"} />
            <Fact
              label="业务库目标哈希"
              value={identity.result.data.businessTargetHash}
            />
            <Fact
              label="Purge Marker 目标哈希"
              value={identity.result.data.purgeMarkerTargetHash}
            />
            <Fact label="标识版本" value={identity.result.data.version} />
          </dl>
        ) : (
          <p className="notice noticeFailure">
            {releaseOperationsOutcomeLabel(identity.result!)}
          </p>
        )}
      </section>

      <section className="releaseOperationsCard">
        <h2>最后接受的业务迁移</h2>
        <p className="note">
          来自服务端解析并校验的生产运行时 manifest；只显示最后一个已接受的业务迁移名。
        </p>
        <p className="releaseOperationsMigration">
          {lastAcceptedBusinessMigration ?? "未知（未配置或无效 manifest）"}
        </p>
      </section>

      <section className="releaseOperationsCard">
        <h2>最近上下文治理</h2>
        {recentContext.loading ? (
          <p className="note">读取中…</p>
        ) : recentContext.result?.kind === "ok" && recentContext.result.data ? (
          <dl className="releaseOperationsFacts">
            <Fact
              label="当前状态"
              value={recentContext.result.data.enabled ? "已启用" : "已停用"}
            />
            <Fact
              label="生效策略版本"
              value={
                recentContext.result.data.active?.policyVersion ??
                "无生效版本"
              }
            />
            <Fact
              label="历史版本数"
              value={String(recentContext.result.data.policyCount)}
            />
            <Fact
              label="最近版本状态"
              value={recentContext.result.data.latest?.status ?? "—"}
            />
          </dl>
        ) : (
          <p className="notice noticeFailure">
            {releaseOperationsOutcomeLabel(recentContext.result!)}
          </p>
        )}
        <div className="releaseOperationsActions">
          <button
            type="button"
            disabled={recentBusy || recentContextUnavailable}
            onClick={() => void changeRecentContext("enable")}
          >
            启用最近上下文
          </button>
          <button
            type="button"
            disabled={recentBusy || recentContextUnavailable}
            onClick={() => void changeRecentContext("disable")}
          >
            停用最近上下文
          </button>
        </div>
        {actionNotice ? (
          <p
            className={
              actionNotice.tone === "success"
                ? "notice noticeSuccess"
                : "notice noticeFailure"
            }
          >
            {actionNotice.message}
          </p>
        ) : null}
      </section>

      <section className="releaseOperationsCard">
        <h2>有效运行时配置（内容无关）</h2>
        {runtimeConfig.loading ? (
          <p className="note">读取中…</p>
        ) : runtimeConfig.result?.kind === "ok" && runtimeConfig.result.data ? (
          <ul className="releaseOperationsConfig">
            {safeRuntimeConfigItems(runtimeConfig.result.data.items).map(
              (item) => (
                <li key={item.key}>
                  <code>{item.key}</code>
                  <span>{formatConfigValue(item.value)}</span>
                </li>
              ),
            )}
          </ul>
        ) : (
          <p className="notice noticeFailure">
            {releaseOperationsOutcomeLabel(runtimeConfig.result!)}
          </p>
        )}
      </section>
    </div>
  );
}

function Fact({ label, value }: Readonly<{ label: string; value: string }>) {
  return (
    <>
      <dt>{label}</dt>
      <dd>{value}</dd>
    </>
  );
}

function formatConfigValue(value: string | number | boolean | null): string {
  if (value === null) return "null";
  if (typeof value === "boolean") return value ? "true" : "false";
  return String(value);
}

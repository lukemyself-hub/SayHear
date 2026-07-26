# 架构与产品决策索引

## TL;DR

- `docs/adr/` 中的文件名是唯一正式 ADR 标识。
- ADR 记录决定及其原因；产品规则以相关 `product/` 文档为准，技术契约以
  `architecture/` 文档为准，未来正式 SPEC 以 `specs/` 为准。
- `docs/adr/` 路径由 matt skills 依赖，不得移动或改名。
- 只读取当前任务相关的 ADR，不要默认加载整个目录。
- 归档架构 v0.1 第 30 节曾使用另一套 `ADR-001`–`ADR-058` 摘要编号；那不是本目录的
  正式文件编号，也不再作为当前决策索引。

## Status

Accepted

## 按主题读取

### 用户控制、删除与导出

- [`0001`](adr/0001-memory-correction-precedes-profile-editor.md)：Memory 纠错先于完整 Profile 编辑器
- [`0002`](adr/0002-phase-one-content-deletion-scope.md)：Internal Core 延后单条内容删除
- [`0003`](adr/0003-journal-correction-creates-a-new-version.md)：Journal 纠错创建新版本
- [`0004`](adr/0004-account-data-export-is-a-public-release-gate.md)：Account Data Export 是外部发布门槛
- [`0022`](adr/0022-deletion-capability-expands-with-data-surface.md)：删除能力随数据面扩展

### 产品阶段、Journal 与对话边界

- [`0005`](adr/0005-internal-core-precedes-external-mvp.md)：Internal Core 先于 External MVP
- [`0006`](adr/0006-journal-delivery-is-automatic.md)：Journal 自动交付
- [`0007`](adr/0007-journal-observations-preserve-uncertainty.md)：Journal Observation 保留不确定性
- [`0008`](adr/0008-memory-source-explanations-are-conversational-and-evidence-backed.md)：Memory 来源解释基于 Evidence
- [`0009`](adr/0009-objective-memory-and-ai-impression-use-distinct-recall-language.md)：两类 Memory 使用不同召回语言
- [`0010`](adr/0010-minimum-high-risk-response-starts-in-core-flow-1a1.md)：1A.1 建立最低高风险回应
- [`0011`](adr/0011-journal-eligibility-does-not-judge-importance.md)：Journal Eligibility 不判断重要性
- [`0012`](adr/0012-daily-session-ownership-does-not-change-at-midnight.md)：Daily Session 不在午夜切分
- [`0013`](adr/0013-continuous-exchange-end-is-deterministic.md)：连续交流结束由确定性规则控制
- [`0014`](adr/0014-phase-one-has-one-internal-owner-account.md)：Phase 1 只有一个 Internal Owner Account

### Core Flow 实现边界

- [`0015`](adr/0015-core-flow-1a1-does-not-persist-streaming-chunks.md)：1A.1 不持久化 streaming chunks
- [`0016`](adr/0016-provider-egress-is-an-in-process-port-in-1a1.md)：1A.1 使用进程内 Provider Egress Port
- [`0017`](adr/0017-durable-workflow-and-outbox-start-in-1a2.md)：Durable Workflow 与 outbox 从 1A.2 开始
- [`0018`](adr/0018-persisted-context-projections-start-in-1a2.md)：持久 Context projection 从 1A.2 开始
- [`0019`](adr/0019-model-routing-expands-after-1a1.md)：模型路由在 1A.1 后扩展
- [`0020`](adr/0020-replay-isolation-is-gated-by-private-data.md)：Replay 隔离由私人数据门槛触发
- [`0021`](adr/0021-core-flow-1b-splits-transport-from-delivery-precision.md)：1B 拆分传输与 delivery precision
- [`0023`](adr/0023-agent-core-precedes-realtime-and-ptt-is-removed.md)：Agent Core 先行并移除 PTT 产品切片

### Entity 与身份变化

- [`0024`](adr/0024-entity-clarification-follows-semantic-impact.md)：Entity 澄清由语义影响触发
- [`0025`](adr/0025-entity-changes-trigger-targeted-journal-impact-review.md)：Entity 变化定向复核 Journal
- [`0026`](adr/0026-entity-changes-suspend-affected-memory-claims.md)：Entity 变化先暂停受影响 Claim

### 人物关系

- [`0027`](adr/0027-person-relationships-are-versioned-memory-claims.md)：人物关系是版本化 Memory Claim
- [`0028`](adr/0028-each-account-has-one-self-entity.md)：每个 Account 有一个 Self Entity
- [`0029`](adr/0029-one-independently-valid-relationship-per-logical-claim.md)：每个独立关系一个 logical Claim
- [`0030`](adr/0030-relationship-state-does-not-require-exact-dates.md)：关系状态不要求精确日期
- [`0031`](adr/0031-third-party-relationships-require-direct-user-evidence.md)：第三方关系需要直接 User Evidence

## Open questions

当前没有未决 ADR。新的决定应创建下一个正式文件编号，不要复用归档架构摘要编号。

## References

- [文档地图](README.md)
- [归档核心架构 v0.1](archive/architecture/sayhear-core-agent-architecture-v0.1.md)

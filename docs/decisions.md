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
- [`0054`](adr/0054-reflection-is-inspected-not-productized-in-phase-one.md)：Phase 1 只检查 Reflection，不建设独立用户页面
- [`0055`](adr/0055-profile-is-an-llm-written-semantic-projection.md)：Profile 是忠实映射 active Memory、由 LLM 写作的语义投影
- [`0056`](adr/0056-profile-refresh-is-manual-weekly-and-trust-reactive.md)：Bio 手动或每周重写，信任边界变化立即失效并重建
- [`0057`](adr/0057-validated-bio-refreshes-do-not-require-approval.md)：验证通过的新 Bio 直接生效，不增加预览、批准或编辑流程
- [`0062`](adr/0062-external-mvp-launches-on-web-before-ios.md)：External MVP 首发仅提供 Web，正式 iOS 在核心价值验证后再引入

### Memory 准入与认识状态

- [`0038`](adr/0038-explicit-user-statements-create-confirmed-objective-memory.md)：用户一次明确陈述即可形成 confirmed Objective Memory
- [`0039`](adr/0039-ai-impressions-require-cross-session-evidence.md)：AI Impression 需要跨 Session 独立 Evidence
- [`0040`](adr/0040-memory-conflict-is-a-last-resort-state.md)：先解释时间与 scope，无法消解时才 contested
- [`0041`](adr/0041-only-ai-impressions-use-time-based-dormancy.md)：只有 AI Impression 使用按时间复核的 dormancy
- [`0042`](adr/0042-open-loops-are-expiring-context-projections.md)：Open Loop 是有期限的短期 Context projection
- [`0043`](adr/0043-proactive-follow-up-starts-inside-user-initiated-conversations.md)：主动关心先限定在用户已发起的对话内
- [`0044`](adr/0044-proactive-follow-up-stops-on-user-signals.md)：主动关心让位于当前诉求并尊重停止信号
- [`0045`](adr/0045-sensitive-memory-allows-stated-facts-not-inferred-labels.md)：敏感事实可记，敏感标签不可由 AI 推断
- [`0046`](adr/0046-rejected-memory-candidates-do-not-auto-revive.md)：Rejected Memory Candidate 不自动复活
- [`0047`](adr/0047-humans-govern-predicate-registry-expansion.md)：LLM 提议概念，人工治理 Predicate Registry 扩张
- [`0048`](adr/0048-predicate-review-candidates-expire-after-thirty-days.md)：Predicate review Candidate 30 天未处理则 stale
- [`0049`](adr/0049-internal-tool-reviews-candidates-without-publishing-registry.md)：内部工具审批 Candidate，但不直接发布 Registry
- [`0050`](adr/0050-registry-proposals-persist-while-awaiting-candidates-expire.md)：Registry Proposal 持续存在，等待发布的 Candidate 90 天后 stale
- [`0051`](adr/0051-terminal-candidate-content-expires-after-seven-days.md)：Terminal Candidate 派生语义 7 天后清除
- [`0052`](adr/0052-only-materially-new-evidence-creates-successor-candidates.md)：只有 Materially New Evidence 可以创建 successor Candidate
- [`0053`](adr/0053-product-value-rejection-is-a-proposal-version.md)：概念级产品拒绝保存为无用户内容的 Proposal version

### Core Flow 实现边界

- [`0015`](adr/0015-core-flow-1a1-does-not-persist-streaming-chunks.md)：1A.1 不持久化 streaming chunks
- [`0016`](adr/0016-provider-egress-is-an-in-process-port-in-1a1.md)：1A.1 使用进程内 Provider Egress Port
- [`0017`](adr/0017-durable-workflow-and-outbox-start-in-1a2.md)：Durable Workflow 与 outbox 从 1A.2 开始
- [`0018`](adr/0018-persisted-context-projections-start-in-1a2.md)：持久 Context projection 从 1A.2 开始
- [`0019`](adr/0019-model-routing-expands-after-1a1.md)：模型路由在 1A.1 后扩展
- [`0020`](adr/0020-replay-isolation-is-gated-by-private-data.md)：Replay 隔离由私人数据门槛触发
- [`0021`](adr/0021-core-flow-1b-splits-transport-from-delivery-precision.md)：1B 拆分传输与 delivery precision
- [`0023`](adr/0023-agent-core-precedes-realtime-and-ptt-is-removed.md)：Agent Core 先行并移除 PTT 产品切片
- [`0058`](adr/0058-replay-recommends-and-humans-publish-model-routing.md)：Replay 只提出模型晋升建议，真实路由由授权人工发布
- [`0059`](adr/0059-text-fallback-handover-precedes-visible-output.md)：Text 只在零可见输出前串行 fallback，并固定到当前连续交流
- [`0060`](adr/0060-background-fallback-is-explicit-per-role.md)：后台 fallback 按 role 显式开放，每个 command 最多一次
- [`0061`](adr/0061-model-promotion-is-developer-judged.md)：模型替换由开发者根据适合该 role 的评测判断，不增加早期正式门禁

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
- [`0032`](adr/0032-one-relationship-fact-has-one-canonical-claim.md)：同一关系事实只有一个 canonical Claim
- [`0033`](adr/0033-relationship-roles-are-evidence-backed-qualifiers.md)：具体关系角色是有 Evidence 的 Qualifier
- [`0034`](adr/0034-relationship-qualifiers-can-be-forgotten-independently.md)：关系 Qualifier 可以独立 Forget
- [`0035`](adr/0035-forgotten-memory-requires-explicit-reversal.md)：被 Forget 的 Memory 只能显式恢复
- [`0036`](adr/0036-restarted-relationships-reuse-the-logical-claim.md)：关系重启复用原 logical Claim

### Episode

- [`0037`](adr/0037-episodes-require-real-world-event-anchors.md)：Episode 必须有现实事件锚点并保守续接

## Open questions

当前没有未决 ADR。新的决定应创建下一个正式文件编号，不要复用归档架构摘要编号。

## References

- [文档地图](README.md)
- [归档核心架构 v0.1](archive/architecture/sayhear-core-agent-architecture-v0.1.md)

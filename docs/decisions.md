# 架构与产品决策索引

## TL;DR

- `docs/adr/` 中的文件名是唯一正式 ADR 标识。
- ADR 记录决定及其原因；产品规则以相关 `product/` 文档为准，技术契约以
  `architecture/` 文档为准，未来正式 SPEC 以对应 GitHub Issue 为准，
  `specs/README.md` 只维护发现索引。
- `docs/adr/` 路径由 matt skills 依赖，不得移动或改名。
- 设计、开发或修改具体功能前，先按下方主题和任务关键词检索，并读取所有相关 ADR；
  Issue、SPEC 或架构文档中的直接链接只是最低起点。
- 无需无目标地加载整个目录，但不能因为某份 ADR 未被任务直接链接就跳过相关结论。
- 归档架构 v0.1 第 30 节曾使用另一套 `ADR-001`–`ADR-058` 摘要编号；那不是本目录的
  正式文件编号。其迁移结果记录在本文末尾，当前实现只引用正式文件编号。

## Status

Accepted

## 按主题读取

### 技术底座、部署与运行时

- [`0063`](adr/0063-typescript-modular-monolith-is-the-domain-kernel.md)：TypeScript 模块化单体承载领域内核
- [`0064`](adr/0064-postgresql-is-the-system-of-record-and-pgvector-is-rebuildable.md)：PostgreSQL 是 System of Record，pgvector 是可重建索引
- [`0115`](adr/0115-memory-recall-starts-with-structured-lexical-retrieval.md)：1A.3a 先用 PostgreSQL structured-lexical retrieval 验证 Memory 价值，Embedding 与 pgvector 改为证据触发的后续升级
- [`0065`](adr/0065-vercel-hosts-web-bff-and-durable-workflows.md)：Vercel 承载 Web、BFF 与 Durable Workflow
- [`0066`](adr/0066-vercel-workflows-v4-runs-durable-asynchronous-work.md)：1A.2 起由 Vercel Workflows v4 承载持久异步任务
- [`0068`](adr/0068-agent-frameworks-do-not-own-long-term-product-state.md)：Agent Framework 不保存产品长期状态
- [`0069`](adr/0069-internal-core-does-not-add-python-redis-or-temporal.md)：Internal Core 不增加 Python Worker、Redis 或 Temporal
- [`0072`](adr/0072-internal-core-validates-bilingual-and-code-switched-use.md)：Internal Core 验收英文、中文与 code-switching，不建设中国大陆部署
- [`0078`](adr/0078-internal-web-uses-authjs-github-oauth-and-database-sessions.md)：内部 Web 使用 Auth.js、GitHub OAuth 与 database session
- [`0129`](adr/0129-reflection-prose-uses-owner-auth-and-evidence-excerpts-require-step-up.md)：Reflection Inspector 正文使用 owner session 与专门 capability，底层 Evidence 原话仍需 step-up 与访问审计
- [`0080`](adr/0080-backup-window-is-verified-before-private-data-writes.md)：真实私人数据写入前核验最长备份窗口
- [`0081`](adr/0081-domain-transactions-use-node-and-pooled-postgresql-connections.md)：领域事务使用 Node runtime 与 pooled PostgreSQL interactive connection
- [`0093`](adr/0093-conversation-runtime-uses-a-replaceable-bounded-agent-harness.md)：Conversation Runtime 使用可替换的受限 Agent Harness，暂不引入通用 Framework
- [`0094`](adr/0094-conversation-agent-stages-use-separate-generation-commands.md)：Conversation Decision 与 Action Finalization 使用独立 GenerationCommand
- [`0133`](adr/0133-bio-writing-and-validation-have-separate-command-budgets.md)：Bio 写作与验证使用独立 GenerationCommand 和可计算的 attempt 预算，repair 后必须重新验证
- [`0136`](adr/0136-1a3b-model-pins-are-evidence-outputs.md)：1A.3b SPEC 固定角色评测合同，生产模型 pin 由冻结验收证据产生而不是提前指定
- [`0138`](adr/0138-1a3b-formal-acceptance-uses-synthetic-data.md)：1A.3b 正式验收只使用固定合成数据，准确 release manifest 必须通过完整 purge 与旧备份恢复 drill
- [`0098`](adr/0098-conversation-actions-use-descriptors-gateway-and-typed-handlers.md)：Conversation Action 通过 descriptor、统一 Gateway 与 typed deep handler 扩展
- [`0099`](adr/0099-conversation-actions-separate-admission-from-execution-state.md)：Conversation Action 分离受理状态与执行状态，并以不可变 Receipt 驱动当前投影
- [`0100`](adr/0100-current-conversation-actions-require-no-secondary-confirmation.md)：当前 Agent Catalog 只允许无需二次确认的安全 Action
- [`0101`](adr/0101-conversation-action-audit-does-not-duplicate-user-content.md)：Action 审计只保留最小 envelope，执行 payload 加密短存并及时清除
- [`0118`](adr/0118-trust-action-targets-outside-frozen-context-resolve-at-admission.md)：Trust Action 对不在本轮冻结 Context 的目标，由 Admission 阶段确定性词面解析受理
- [`0103`](adr/0103-journal-regeneration-accepts-bounded-user-guidance.md)：Journal regeneration 接受受限用户 guidance，但保留事实、版本与幂等边界
- [`0111`](adr/0111-persona-and-conversation-state-inputs-are-compiled-versioned-contracts.md)：Persona 与对话状态输入由编译的版本化契约承载，Person Portrait 逐条注入，Profile 不进对话 Context

### 用户控制、删除与导出

- [`0001`](adr/0001-memory-correction-precedes-profile-editor.md)：Memory 纠错先于完整 Profile 编辑器
- [`0002`](adr/0002-phase-one-content-deletion-scope.md)：Internal Core 延后单条内容删除
- [`0003`](adr/0003-journal-correction-creates-a-new-version.md)：Journal 纠错创建新版本
- [`0004`](adr/0004-account-data-export-is-a-public-release-gate.md)：Account Data Export 是外部发布门槛
- [`0022`](adr/0022-deletion-capability-expands-with-data-surface.md)：删除能力随数据面扩展
- [`0104`](adr/0104-purge-marker-owns-backup-recovery-authority.md)：Purge Marker 是备份恢复防复活的权威来源
- [`0130`](adr/0130-1a3b-retention-separates-domain-history-from-diagnostic-content.md)：Episode 历史版本保留到 Full Purge，Reflection 与模型原始内容采用分级短期保留
- [`0131`](adr/0131-every-private-data-surface-registers-its-purge-contract.md)：每个 owner 私人数据面必须登记可验证的 Full Purge 合同，未登记的数据面阻断验收
- [`0106`](adr/0106-github-actions-schedules-the-internal-owner-recovery-scan.md)：Internal Owner 阶段由 GitHub Actions schedule 调用 Recovery Scan
- [`0119`](adr/0119-backup-evidence-renewal-is-monthly-fail-closed-automation.md)：Backup evidence 由 fail-closed 自动化每月续期，窗口漂移时停止续期让 gate 到期阻塞
- [`0107`](adr/0107-journal-diagnostics-do-not-block-publication.md)：Journal Diagnostic Finding 不阻止 Journal 发布
- [`0070`](adr/0070-user-audio-is-not-retained-long-term.md)：正式用户音频不长期保留，内部 opt-in 以 72 小时为访问边界
- [`0090`](adr/0090-one-conversation-action-represents-one-semantic-intent.md)：一次 Conversation Action 表达一个语义意图，可确定性传播到多个对象
- [`0091`](adr/0091-conversation-actions-come-from-a-versioned-allowlist.md)：Conversation Action 只能来自版本化 allowlist，不支持时明确拒绝
- [`0092`](adr/0092-trust-control-actions-take-priority-in-compound-requests.md)：复合请求优先执行唯一且已满足门槛的 Trust-Control Action，其他情况不静默部分执行
- [`0095`](adr/0095-models-see-focused-functions-and-the-domain-sees-one-action-proposal-union.md)：模型看到多个聚焦 Function，领域只接收统一 ActionProposal union
- [`0096`](adr/0096-models-reference-action-targets-through-command-scoped-handles.md)：模型通过 Command-scoped Handle 或当前 Event locator 引用 Action target
- [`0097`](adr/0097-derived-artifact-regeneration-is-a-policy-governed-action.md)：派生产物重生成是版本化 policy 管理的独立 Action 语义
- [`0099`](adr/0099-conversation-actions-separate-admission-from-execution-state.md)：Action 是否受理与执行是否完成使用独立生命周期
- [`0100`](adr/0100-current-conversation-actions-require-no-secondary-confirmation.md)：需要二次确认或 step-up 的高风险能力不进入当前对话 Agent
- [`0101`](adr/0101-conversation-action-audit-does-not-duplicate-user-content.md)：Action 记录不能成为第二份用户内容仓库

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
- [`0108`](adr/0108-canonical-persona-separates-compassionate-presence-from-relationship-identity.md)：Canonical Persona 以慈悲陪伴建立体验，但不建立需要维护的关系身份
- [`0109`](adr/0109-persona-safety-deference-persists-until-immediate-risk-clears.md)：高风险后的 Persona 让位持续到迫近危险解除（已被 0112 取代）
- [`0112`](adr/0112-persona-safety-posture-is-session-scoped-and-releases-by-clean-turns.md)：Persona 安全姿态按 Daily Session 存活，连续干净 turn 自动解除
- [`0113`](adr/0113-persona-and-safety-precedes-memory-recall.md)：1A.2P Persona & Safety 先于 Memory & Recall 交付，原 1A.3 拆为 1A.3a / 1A.3b，后续编号不变
- [`0134`](adr/0134-1a3b-rollout-is-staged-and-correctness-triggered.md)：1A.3b 分三阶段直接切换，已确认的正确性失败立即回滚受影响阶段
- [`0115`](adr/0115-memory-recall-starts-with-structured-lexical-retrieval.md)：1A.3a 不预装向量检索，先以可观测的 structured-lexical baseline 验证召回
- [`0116`](adr/0116-ai-impressions-use-natural-relational-recall.md)：相关 AI Impression 可以用自然、朋友式的观察主动表达，不强制每次加入来源声明或仪式化保留语
- [`0117`](adr/0117-narrow-opener-permission-precedes-open-loop-selector.md)：1A.3a 只以提示词级许可回应已注入记忆（含开场），零信号开场不表现连续性属正确行为，完整 Open Loop 选择器仍归 1A.3b

### 行为评测

- [`0110`](adr/0110-human-taste-is-authoritative-in-behavior-evaluation.md)：行为评测的最终权威是人工味觉裁定，机械检查与 LLM judge 只做结构预筛
- [`0114`](adr/0114-low-fatigue-pairwise-evaluation-sampling.md)：后续盲评使用分层随机抽样与 A / 持平 / B 三选一，降低单评审疲劳
- [`0135`](adr/0135-1a3b-acceptance-does-not-grandfather-hard-failures.md)：1A.3b 不继承 incumbent 的硬门禁豁免，Continuation、Bio 和确定性正确性证据互不抵消
- [`0137`](adr/0137-narrative-validator-acceptance-weights-bio.md)：`narrative.validate` 首版 18 例按每语言 4 个 Bio 与 2 个 Reflection 分配，不替代 Bio 自然度盲评
- [`0139`](adr/0139-narrative-validator-calibration-allows-a-bounded-miss.md)：`narrative.validate` 18 例全部人工裁定，允许最多 10% 校准漏检，precision 误伤与确定性硬失败保持零容忍

### Memory 准入与认识状态

- [`0038`](adr/0038-explicit-user-statements-create-confirmed-objective-memory.md)：用户一次明确陈述即可形成 confirmed Objective Memory
- [`0039`](adr/0039-ai-impressions-require-cross-session-evidence.md)：AI Impression 需要跨 Session 独立 Evidence
- [`0040`](adr/0040-memory-conflict-is-a-last-resort-state.md)：先解释时间与 scope，无法消解时才 contested
- [`0041`](adr/0041-only-ai-impressions-use-time-based-dormancy.md)：只有 AI Impression 使用按时间复核的 dormancy
- [`0042`](adr/0042-open-loops-are-expiring-context-projections.md)：Open Loop 是有期限的 Context projection
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
- [`0122`](adr/0122-candidate-review-commands-are-synchronous-and-fail-closed.md)：Candidate review 处置是同步 CAS 命令，人工处置以 `decided_at <= review_due_at` fail closed；取消 Proposal 立即终局等待中的候选人；Proposal 无用户内容由 schema 结构排除保证
- [`0123`](adr/0123-bio-narrative-identity-is-explicit-and-locale-frozen.md)：Bio 与 User Profile 使用不同领域身份；Bio 使用 Self Entity 姓名与用户明确声明的代词，每个版本冻结一个经过生成和校验的展示 locale
- [`0124`](adr/0124-bio-materiality-is-policy-owned-and-validation-is-dual-decomposed.md)：Bio materiality 由版本化 policy 和 Predicate metadata 决定，生成器声明原子命题后由 validator 独立重拆并比较
- [`0125`](adr/0125-bio-publishing-requires-human-validator-acceptance-and-has-no-force-publish.md)：Bio 在固定中英与 code-switch 案例经 Luke 逐例裁定并通过 ADR-0139 预算前不开放；失败只允许一次有界修复且不能强制发布
- [`0126`](adr/0126-bio-structure-is-typed-and-failed-content-expires-after-seven-days.md)：Bio 使用 typed rows；发布版本保留到 Full Purge，失败草稿语义内容七天后清除
- [`0127`](adr/0127-bio-trust-rebuilds-preempt-ordinary-refreshes.md)：Bio trust rebuild 抢占普通刷新，读取路径独立复核 support fence 并保持 fail closed
- [`0128`](adr/0128-bio-budget-overflow-is-disclosed-not-fatal.md)：Bio 篇幅不足时由 coverage policy 记录 deferred unit 并提示选择性覆盖，不让产品失败或把取舍交给模型

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
- [`0121`](adr/0121-narrative-grounding-validation-is-one-shared-role.md)：Reflection 与 Profile 共用同一个 `narrative.validate` grounding-validator 模型角色，按 artifact kind 冻结 Prompt 与校验 policy 版本
- [`0132`](adr/0132-1a3b-model-roles-fail-independently.md)：1A.3b 的七个模型角色独立冻结、失败与回滚，不因共用模型而合并合同
- [`0067`](adr/0067-livekit-agents-is-the-realtime-media-and-voice-session-layer.md)：LiveKit Agents 是正式实时媒体与 Voice Session 层
- [`0071`](adr/0071-model-comparison-uses-explicit-replay-not-shadowing.md)：模型比较使用显式 Replay，不自动 Shadow 私人对话
- [`0073`](adr/0073-replay-is-non-authoritative-and-cannot-write-product-state.md)：Replay 永不写回正式产品状态
- [`0075`](adr/0075-private-replay-output-expires-after-thirty-days.md)：真实私人 Replay output 默认 30 天过期并服从删除传播
- [`0076`](adr/0076-realtime-separates-provisional-response-from-canonical-transcript.md)：Realtime 低延迟 provisional 路径与 canonical transcript 分离
- [`0079`](adr/0079-livekit-cloud-agents-hosts-the-core-flow-1b-worker.md)：Core Flow 1B 默认使用 LiveKit Cloud Agents 托管 Voice Worker
- [`0082`](adr/0082-one-turn-detector-owns-each-voice-session.md)：每个 Voice Session 只有一个 turn detector owner
- [`0084`](adr/0084-voice-session-and-turn-are-runtime-mappings.md)：VoiceSession / VoiceTurn 是持久运行映射，不是产品长期记录

### 数据身份、证据与派生状态

- [`0074`](adr/0074-versioned-domain-artifacts-require-lineage.md)：版本化领域产物必须保留 revision 与 lineage
- [`0077`](adr/0077-generation-command-is-separate-from-model-run-attempt.md)：逻辑 GenerationCommand 与每次 ModelRunAttempt 分离
- [`0083`](adr/0083-generation-commands-use-versioned-freshness-policies.md)：Command 使用版本化 exact-head、source-valid 或 monotonic freshness policy
- [`0085`](adr/0085-persistent-ids-are-opaque-and-semantic-ids-are-versioned.md)：持久实例使用 opaque UUIDv7，语义 ID 使用版本化 `sh.*` namespace
- [`0086`](adr/0086-interaction-voice-and-event-identities-are-distinct.md)：InteractionTurn、VoiceTurn 与 Event Revision 使用独立身份和职责
- [`0087`](adr/0087-evidence-item-is-a-typed-reference-to-user-event-revisions.md)：EvidenceItem 是指向 final / corrected User Event Revision 的一等类型化引用
- [`0088`](adr/0088-entities-are-user-scoped-and-labels-do-not-define-identity.md)：Entity 默认 user-scoped，label 与 external mapping 不决定身份
- [`0089`](adr/0089-derived-artifacts-are-versioned-and-projections-are-rebuildable.md)：Journal、Reflection、Claim、Episode 版本化，Profile 与索引可重建
- [`0130`](adr/0130-1a3b-retention-separates-domain-history-from-diagnostic-content.md)：Episode 版本属于长期领域历史；Reflection 非当前正文与模型原始内容按期限清除

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
- [`0120`](adr/0120-episode-kinds-are-a-closed-typed-catalog-with-a-catch-all.md)：Episode kind 是闭集代码版本化 typed catalog 加 `other` 兜底，模型不得自由分类，不走运行时治理队列

## 归档架构 v0.1 迁移映射

下表只用于证明归档第 30 节的每条结论已被当前正式 ADR 承接。`归档 ADR` 不是当前
标识；存在冲突、延期或细化时，右栏所列正式 ADR 的完整正文优先。

| 归档 ADR | 当前正式 ADR | 迁移结果 |
| --- | --- | --- |
| ADR-001 | [`0063`](adr/0063-typescript-modular-monolith-is-the-domain-kernel.md) | 同步 |
| ADR-002 | [`0064`](adr/0064-postgresql-is-the-system-of-record-and-pgvector-is-rebuildable.md) | 同步 |
| ADR-003 | [`0065`](adr/0065-vercel-hosts-web-bff-and-durable-workflows.md) | 同步 |
| ADR-004 | [`0066`](adr/0066-vercel-workflows-v4-runs-durable-asynchronous-work.md) | 同步；适用阶段由 0017 明确为 1A.2 起 |
| ADR-005 | [`0067`](adr/0067-livekit-agents-is-the-realtime-media-and-voice-session-layer.md) | 同步 |
| ADR-006 | [`0068`](adr/0068-agent-frameworks-do-not-own-long-term-product-state.md) | 同步 |
| ADR-007 | [`0069`](adr/0069-internal-core-does-not-add-python-redis-or-temporal.md) | 同步 |
| ADR-008 | [`0070`](adr/0070-user-audio-is-not-retained-long-term.md) | 同步并补充当前删除语义 |
| ADR-009 | [`0071`](adr/0071-model-comparison-uses-explicit-replay-not-shadowing.md) | 同步 |
| ADR-010 | [`0072`](adr/0072-internal-core-validates-bilingual-and-code-switched-use.md) | 同步 |
| ADR-011 | [`0073`](adr/0073-replay-is-non-authoritative-and-cannot-write-product-state.md) | 同步；私人数据隔离门槛另见 0020 |
| ADR-012 | [`0074`](adr/0074-versioned-domain-artifacts-require-lineage.md) | 同步 |
| ADR-013 | [`0075`](adr/0075-private-replay-output-expires-after-thirty-days.md) | 同步 |
| ADR-014 | [`0015`](adr/0015-core-flow-1a1-does-not-persist-streaming-chunks.md) | 已延期；1A.1 不持久化 chunk |
| ADR-015 | [`0076`](adr/0076-realtime-separates-provisional-response-from-canonical-transcript.md) | 同步 |
| ADR-016 | [`0077`](adr/0077-generation-command-is-separate-from-model-run-attempt.md) | 同步 |
| ADR-017 | [`0006`](adr/0006-journal-delivery-is-automatic.md) | 已存在 |
| ADR-018 | [`0078`](adr/0078-internal-web-uses-authjs-github-oauth-and-database-sessions.md) | 同步 |
| ADR-019 | [`0079`](adr/0079-livekit-cloud-agents-hosts-the-core-flow-1b-worker.md) | 同步 |
| ADR-020 | [`0080`](adr/0080-backup-window-is-verified-before-private-data-writes.md) | 同步 |
| ADR-021 | [`0081`](adr/0081-domain-transactions-use-node-and-pooled-postgresql-connections.md) | 同步 |
| ADR-022 | [`0023`](adr/0023-agent-core-precedes-realtime-and-ptt-is-removed.md) | 已取代；不建设 PTT 产品路径 |
| ADR-023 | [`0082`](adr/0082-one-turn-detector-owns-each-voice-session.md) | 同步 |
| ADR-024 | [`0020`](adr/0020-replay-isolation-is-gated-by-private-data.md) | 已细化；只对 Private Replay 要求独立部署 |
| ADR-025 | [`0015`](adr/0015-core-flow-1a1-does-not-persist-streaming-chunks.md) | 已延期；1A.1 不存在持久 delivery chunk |
| ADR-026 | [`0016`](adr/0016-provider-egress-is-an-in-process-port-in-1a1.md) | 已延期；独立 Gateway 按私人数据运行边界抽离 |
| ADR-027 | [`0083`](adr/0083-generation-commands-use-versioned-freshness-policies.md) | 同步 |
| ADR-028 | [`0084`](adr/0084-voice-session-and-turn-are-runtime-mappings.md) | 同步 |
| ADR-029 | [`0085`](adr/0085-persistent-ids-are-opaque-and-semantic-ids-are-versioned.md) | 同步 |
| ADR-030 | [`0086`](adr/0086-interaction-voice-and-event-identities-are-distinct.md) | 同步 |
| ADR-031 | [`0087`](adr/0087-evidence-item-is-a-typed-reference-to-user-event-revisions.md) | 同步 |
| ADR-032 | [`0088`](adr/0088-entities-are-user-scoped-and-labels-do-not-define-identity.md) | 同步 |
| ADR-033 | [`0089`](adr/0089-derived-artifacts-are-versioned-and-projections-are-rebuildable.md) | 同步 |
| ADR-034 | [`0005`](adr/0005-internal-core-precedes-external-mvp.md)、[`0062`](adr/0062-external-mvp-launches-on-web-before-ios.md) | 已存在并细化 iOS 阶段 |
| ADR-035 | [`0008`](adr/0008-memory-source-explanations-are-conversational-and-evidence-backed.md) | 已存在 |
| ADR-036 | [`0009`](adr/0009-objective-memory-and-ai-impression-use-distinct-recall-language.md) | 已存在 |
| ADR-037 | [`0010`](adr/0010-minimum-high-risk-response-starts-in-core-flow-1a1.md) | 已存在 |
| ADR-038 | [`0011`](adr/0011-journal-eligibility-does-not-judge-importance.md) | 已存在 |
| ADR-039 | [`0012`](adr/0012-daily-session-ownership-does-not-change-at-midnight.md) | 已存在 |
| ADR-040 | [`0013`](adr/0013-continuous-exchange-end-is-deterministic.md) | 已存在 |
| ADR-041 | [`0014`](adr/0014-phase-one-has-one-internal-owner-account.md) | 已存在 |
| ADR-042 | [`0015`](adr/0015-core-flow-1a1-does-not-persist-streaming-chunks.md) | 已存在 |
| ADR-043 | [`0016`](adr/0016-provider-egress-is-an-in-process-port-in-1a1.md) | 已存在 |
| ADR-044 | [`0017`](adr/0017-durable-workflow-and-outbox-start-in-1a2.md) | 已存在 |
| ADR-045 | [`0018`](adr/0018-persisted-context-projections-start-in-1a2.md) | 已存在 |
| ADR-046 | [`0019`](adr/0019-model-routing-expands-after-1a1.md) | 已存在 |
| ADR-047 | [`0020`](adr/0020-replay-isolation-is-gated-by-private-data.md) | 已存在 |
| ADR-048 | [`0021`](adr/0021-core-flow-1b-splits-transport-from-delivery-precision.md) | 已存在 |
| ADR-049 | [`0022`](adr/0022-deletion-capability-expands-with-data-surface.md) | 已存在 |
| ADR-050 | [`0023`](adr/0023-agent-core-precedes-realtime-and-ptt-is-removed.md) | 已存在 |
| ADR-051 | [`0024`](adr/0024-entity-clarification-follows-semantic-impact.md) | 已存在 |
| ADR-052 | [`0025`](adr/0025-entity-changes-trigger-targeted-journal-impact-review.md) | 已存在 |
| ADR-053 | [`0026`](adr/0026-entity-changes-suspend-affected-memory-claims.md) | 已存在 |
| ADR-054 | [`0027`](adr/0027-person-relationships-are-versioned-memory-claims.md) | 已存在 |
| ADR-055 | [`0028`](adr/0028-each-account-has-one-self-entity.md) | 已存在 |
| ADR-056 | [`0029`](adr/0029-one-independently-valid-relationship-per-logical-claim.md) | 已存在 |
| ADR-057 | [`0030`](adr/0030-relationship-state-does-not-require-exact-dates.md) | 已存在 |
| ADR-058 | [`0031`](adr/0031-third-party-relationships-require-direct-user-evidence.md) | 已存在 |

## Open questions

当前没有未决 ADR。新的决定应创建下一个正式文件编号，不要复用归档架构摘要编号。

## References

- [文档地图](README.md)
- [归档核心架构 v0.1](archive/architecture/sayhear-core-agent-architecture-v0.1.md)

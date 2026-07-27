# Conversation 数据模型

## TL;DR

- 区分 DailySession、InteractionTurn、VoiceSession / VoiceTurn 与 ConversationEventRevision。
- 只有 final / corrected User Event Revision 是用户事实的 primary evidence root。
- 流式片段、模型 Session 和运行时映射都不能替代正式领域记录。

## Status

Proposed

## 7. 核心领域模型

### 7.1 对象边界

“是否真源”容易把原始证据、正式产物和可重建投影混为一谈。这里改用
“事实角色”描述：

| 对象 | 谁创建 | 事实角色 | 是否可精确重建 | 删除传播 |
| --- | --- | --- | --- | --- |
| User | 认证/账号服务 | 账号记录；通过唯一绑定拥有一个 Self Entity | 否 | 删除主体 |
| DailySession | Session Service | 正式会话边界 | 否 | 删除或失效其全部派生物 |
| InteractionTurn | Turn Service | 正式交互分组，不是 evidence | 否 | 随 Event / Session 删除 |
| ContinuousExchangeModelBinding | Model Runtime | Continuous Exchange 内 fallback 接管后的冻结执行配置；不是用户事实 | 否 | 随 User / DailySession 删除 |
| VoiceSession / VoiceTurn | Voice Session Service | 临时运行映射 | 否 | 随 User / DailySession 删除 |
| ConversationEvent / Revision | Turn Service | 原始记录；只有有效 User Revision 可作生活事实 evidence | 否 | 触发全部证据和派生物失效 |
| TranscriptSegment | STT / Voice adapter | Source Revision 的时间片细节 | 仅音频存在时可重建 | 随 Event 与 Audio 删除 |
| EvidenceItem / EntityMention | Evidence / Entity Resolver | 类型化引用和解析，不创造事实 | 可重新提取但结果不保证相同 | 随 Source Revision 失效 |
| Entity / EntityVersion | Entity Service | 用户范围内的稳定语义身份 | 否；merge / split 必须保留历史 | 清除来源独有 label 和关联 |
| SummaryVersion | 1A.2+ Summary Builder | 可替换的派生上下文 | 不保证相同；current 可重建 | 随 evidence 失效 |
| Episode / EpisodeVersion | Episode Builder | 必须保留版本的派生语义事件 | 不保证相同 | 随 evidence 失效或重建 |
| Journal / JournalVersion | Journal Workflow | 已发布派生产物，不是生活事实源 | 不保证相同 | 随 Session / Evidence 删除 |
| Reflection / ReflectionVersion | Reflection Workflow | 非权威派生产物，不是 evidence | 不保证相同 | 随 Evidence 删除或失效 |
| MemoryCandidate | Extraction Workflow | 非权威候选 | 是 | 随 source revision 删除 |
| MemoryClaim / ClaimVersion | Memory Service | 正式语义判断，不是 primary evidence | 否 | 撤回、supersede 或删除 |
| RelationshipResolverHint | Entity Resolver Projection | Claim 派生的非权威称呼索引 | 是 | 随 ClaimVersion 失效并重建 |
| OpenLoop / OpenLoopVersion | Context Projection Worker | 有期限的待发生事项 / 待结果 Context projection，不是事实源 | 否；历史按引用保留 | 随 Evidence / Claim / Episode 失效 |
| ProactiveFollowupStateVersion | Conversation Behavior Projection | 主动关心资格与停止信号，不是用户事实 | 可从版本化行为结果重建 | 随 target 与 Event 删除 |
| ProfileProjectionVersion | Projection Worker | 可重建投影 | 是 | 从有效 ClaimVersion 重建 |
| VectorIndex | Embedding Worker | 可重建索引 | 是 | 立即停止检索并删除向量 |
| WorkflowRun | Workflow Service | 运行元数据 | 否 | 正文不应存在于其中 |
| GenerationCommand | Application Service | 运行意图元数据 | 否 | 随主体失效，不保存正文 |
| ModelRunAttempt | Model Runtime | Provider 调用元数据 | 否 | 随 command 审计，不保存正文 |
| ReplayRun | Replay Service | 非权威评估记录 | 可重跑 | 随源失效或 TTL 删除 |
| AudioAsset | Audio Service | 短期敏感源材料 | 否 | 72 小时或撤回授权后删除 |
| DeletionMarker / DeletionLedger | Deletion Service | 无正文防复活记录；1A.2 先有单 owner 最小 marker，External MVP 扩展为完整 ledger | 否 | 按最长备份窗口保留最小信息 |

ID 约定：

- 持久实例 ID 使用服务端生成的 opaque UUIDv7；ID 不编码名称、语言、用户输入、
  Provider、模型或对象状态；
- 每个对象 row 仍显式保存 `user_id` / owner boundary，不能从 ID 推导租户；
- TypeScript domain 使用 branded ID type，例如 `EntityId`、`ClaimId`、
  `ClaimVersionId`，不能把所有 UUID 当作可互换的 `string`；
- PostgreSQL 使用真实 foreign key 和 typed link table 约束引用，不只靠应用校验；
- 逻辑对象 ID 与 Version ID 分离，例如 `claim_id + claim_version_id`、
  `journal_id + journal_version_id`；
- Entity kind、Claim predicate 等机器语义使用 SayHear 自有、版本化 namespace，
  例如 `sh.entity.person`、`sh.relationship.works_on`；
- Wikidata、GeoNames 等公共 ID 只进入 external identifier mapping，
  永远不作为 SayHear 主键；
- 私人 Entity 默认 user-scoped；不同用户的同名人物不得自动合并；
- 需要暴露在公开 URL 的 ID 另行使用随机 public identifier，不能依赖 UUIDv7
  的生成时间作为访问控制。

### 7.2 Daily Session

建议字段：

```text
id
user_id
logical_date
timezone_at_start
started_at
last_activity_at
activity_state
quiescent_at
closure_policy_version
current_continuous_exchange_no
dialogue_revision
source_revision
journal_id
created_at
updated_at
deleted_at
```

约束：

- 唯一键：`user_id + logical_date`；
- `logical_date` 由用户时区决定，不使用服务器 UTC 日期直接替代；
- `logical_date` 与 `timezone_at_start` 在 Session 创建后不可变；
- 跨午夜仍在进行的连续交流不拆分、不迁移，继续路由到开始时的 Daily Session；
- 午夜不能使 active Session 自动 `quiescent` / `finalized`，也不能单独触发 Journal；
- 连续交流自然结束后，下一条发生在新本地日期的 User Event 创建新 Daily Session；
- 没有进行中交流时，新一天重新打开产品创建新 Daily Session；
- 同日继续表达时复用原 Session；
- Session 首次交流的 `current_continuous_exchange_no = 1`；同日 Session 从
  `quiescent` 重新进入 `active` 时，在提交新 User Event 的同一事务中加一；
  跨午夜仍连续的 active 交流不增加该编号；
- 每个 final / corrected User Event 或完整提交的 Assistant Event 增加
  `dialogue_revision`，供在线 Context 使用；
- 只有 final / corrected User Event 以及其修正、撤回、删除增加
  `source_revision`，供 Journal、Reflection、Memory 和 Embedding 使用；
- provisional transcript、Interrupted Response 和未播放 Voice 内容不增加任何
  authoritative revision。

建议把 Session 活动状态和 Journal 状态分开。

```text
active → quiescent → finalized
   ↑         |
   └─────────┘  同日新对话
```

- 只有用户明确结束，或达到 `closure_policy_version` 定义的无活动窗口后，
  才能进入 `quiescent`；
- 模型可以提出自然收尾文案或 closure candidate，但不能直接改变
  `activity_state`；
- inactivity command 必须冻结 expected `dialogue_revision`，提交前通过 CAS
  确认没有新 Event；旧 timer 不能关闭已经恢复交流的 Session；
- `quiescent` 可以触发 Journal；
- 同日新增对话重新进入 `active`；
- 跨日且没有进行中对话后进入 `finalized`；之后的新 Event 不能重新打开旧 Session；
- active Session 跨午夜后自然结束时，先固定完成旧 Session；之后的新 Event
  按当时用户本地日期创建新 Session；
- Journal 发布不意味着 Session 永远不可继续。
- `DailySession.journal_id` 指向稳定 Journal；current Version pointer 只保存在
  `journals.current_version_id`，避免双重真源。

### 7.3 Interaction Turn

`interaction_turns` 是 Text 和 Realtime 共用的交互分组：

```text
id
user_id
daily_session_id
client_turn_id
turn_sequence_no
continuous_exchange_no
status                    # open / responding / settled / interrupted / failed
retry_of_interaction_turn_id
started_at
settled_at
deleted_at
```

规则：

- `user_id + client_turn_id` 和 `daily_session_id + turn_sequence_no` 唯一；
- `continuous_exchange_no` 在 Turn 创建时冻结为 DailySession 当前值，为
  “每段连续交流最多一次”之类的行为门禁提供可审计边界；
- 一个 InteractionTurn 包含一个 primary User Event，以及零个或多个
  Assistant / System Event；
- `conversation_events.interaction_turn_id` 是正式关联，
  `correlation_id` 只用于 Trace，不能承担领域身份；
- 用户显式 Retry 创建新的 InteractionTurn，并通过
  `retry_of_interaction_turn_id` 指向原 Turn；
- barge-in 会先把旧 Turn 标记 `interrupted`，再为新的用户表达创建 Turn；
- Turn 的 settled 状态只表示交互处理完成，不表示其中内容可以成为事实证据；
- Evidence 必须引用具体 ConversationEventRevision，不能引用 InteractionTurn；
- InteractionTurn 随其 User Event 删除；允许保留的诊断 envelope 必须无正文并去关联化。

### 7.3.1 Continuous Exchange Model Binding

`continuous_exchange_model_bindings` 只在 1A.4 的 Conversation Fallback
Handover 成功取得接管权时创建，用来让进程重启和后续 Turn 都能证明当前
Continuous Exchange 已经切换到哪个配置：

```text
id
user_id
daily_session_id
continuous_exchange_no
model_role                       # 1A.4 仅 conversation.text
model_routing_policy_version
fallback_model_config_version
source_generation_command_id
source_attempt_id
handover_attempt_id
expected_data_epoch
created_at
deleted_at
```

约束：

- `daily_session_id + continuous_exchange_no + model_role` 是数据库唯一键；
- 创建 binding 与保留 `handover_attempt_id` 必须在同一事务中取得唯一键，
  并再次验证 source command 尚无可见输出、无 Assistant Event、无
  authoritative result，且 `expected_data_epoch` 仍有效；
- 只有成功提交 binding 的事务可以向 fallback Provider dispatch；唯一键冲突方
  必须回滚自己的新 attempt、读取已有 binding，不能执行第二次 handover；
- binding 创建后执行配置不可原地改回 Champion 或改成第二个 fallback；
- 后续 Turn 创建 GenerationCommand 时先读取该 tuple。存在 binding 时必须冻结其
  `fallback_model_config_version` 与 `model_routing_policy_version`，并记录
  `continuous_exchange_model_binding_id`；不存在时才按当前已发布 Policy 选择
  Champion；
- 进程重启、技术重试或午夜跨越不能从最新 ModelRunAttempt 推断绑定；只能读取这条
  持久记录。记录缺失、重复或引用失效时 fail closed；
- binding 只保存 ID、配置版本和 fencing metadata，不保存 Conversation 正文；
  它随 User / DailySession 删除，允许保留的诊断 envelope 必须去关联化。

### 7.4 Voice Session 与 Voice Turn

Realtime 的 Room、Provider item 和重连映射必须持久化，但它们不是产品长期记忆。

`voice_sessions`：

```text
id
user_id
daily_session_id
room_id
turn_detection_owner
realtime_provider
status                    # connecting / active / reconnecting / ended / expired / deleting
expected_data_epoch
last_acknowledged_event_id
started_at
expires_at
ended_at
```

`voice_turns`：

```text
id
voice_session_id
interaction_turn_id
client_turn_id
turn_sequence_no
user_event_id
assistant_delivery_id
provider_input_item_id
status                    # speech_started / streaming / turn_ended / transcript_pending
                          # completed / interrupted / failed
started_at
ended_at
terminal_reason
```

约束：

- `room_id` 唯一绑定一个未结束 VoiceSession；
- `voice_session_id + client_turn_id` 和
  `voice_session_id + turn_sequence_no` 唯一；
- 每个 VoiceTurn 必须映射一个 InteractionTurn；InteractionTurn 是跨渠道领域身份，
  VoiceTurn 只是 LiveKit / Provider 运行映射；
- 非空 `realtime_provider + provider_input_item_id` 唯一；
- speech start 先创建 VoiceTurn，Provider item ID 返回后通过 CAS 绑定；
- Service JWT 的 `voice_session_id / room_id / expected_data_epoch`
  必须与 active VoiceSession 匹配；
- reconnect 只恢复同一 VoiceSession，并从 `last_acknowledged_event_id` 继续；
- Provider resume token 如需保存，进入独立 `voice_runtime_secrets`，
  使用应用层加密、短 TTL 和 access audit；
- Provider resume token 不是产品长期记录，过期后从 CompiledContext 建立新 Provider Session；
- VoiceSession / VoiceTurn / runtime secret 随 User 或 DailySession 删除传播；
- ended / expired runtime metadata 使用独立最小 retention policy，不保存音频或正文。

### 7.5 Conversation Event

`conversation_events` 是稳定的事件信封，不直接保存可被修正的正文：

```text
id
user_id
daily_session_id
interaction_turn_id
sequence_no
client_event_id
actor                 # user / assistant / system
channel               # text / realtime
event_type
current_revision_id
lifecycle_status
correlation_id          # observability only
generation_command_id
created_at
deleted_at
```

`conversation_event_revisions` 是 append-only 正文历史：

```text
id
conversation_event_id
revision
locale
canonical_text
transcript_status
based_on_revision_id
supersedes_revision_id
created_by             # client / stt / user_correction / delivery_reconciler
created_at
content_purged_at
```

数据库约束：

- 唯一键：`user_id + client_event_id`；
- 唯一键：`conversation_event_id + revision`；
- 唯一键：`daily_session_id + sequence_no`；
- 每个 User / Assistant Event 必须属于一个 InteractionTurn；
- Assistant Event 的 `generation_command_id` 唯一；
- `sequence_no` 必须在锁定 Daily Session row 的同一事务中单调分配；
- 客户端重试不能创建重复 event；
- Event 信封只允许通过 compare-and-set 更新 `current_revision_id`；
- 正常修正不得修改原 revision 的 `canonical_text`；
  唯一例外是 privacy erasure 将正文置空并写 `content_purged_at`；
- 修正转写或用户纠错创建新 revision，并保留旧 revision；
- tombstone 只改变可见性，不销毁审计所需的无正文 lineage；
- `CompiledContext`、Evidence、Entity、Journal、Reflection、Claim 和 Replay 必须引用具体
  `conversation_event_revision_id`，不能只引用可变的 Event ID。

用户生活事实的证据边界：

- 事实证据必须引用 `actor=user` 且 transcript 为 `final` 或 `corrected`
  的 Event revision；
- Assistant / System Event 只能作为交互上下文或行为审计，不能证明用户生活事实；
- 如果 AI 先做出推断，后续不能再引用自己的回答把推断“证实”；
- 用户对 AI 回答的反应必须引用后续 User Event；
- `confirmed` 只表示 Claim 来自一次或多次直接、明确的用户陈述，
  不表示 SayHear 已对外部世界完成事实核验；
- 反复出现但从未被用户直接陈述的模式，只能支撑 `inferred`
  AI Impression，不能成为 Objective Memory。

Core Flow 1A.1 的 Assistant 响应使用最小提交语义：

- 模型调用前先持久化 User Event、InteractionTurn、GenerationCommand 和
  ModelRunAttempt；
- 文本 token 直接 best-effort stream 给客户端，不写
  `assistant_delivery_chunks`，也不要求 rendered-chunk ACK；
- 进程内累积完整响应；模型完整成功后，在一个事务中创建 Assistant Event /
  Revision、提交 authoritative result、增加 `dialogue_revision` 并 settle Turn；
- 流式异常、客户端中断或进程崩溃时，把 Turn / Attempt 标记为 `interrupted`
  或由 reconciler 收敛为该状态，不创建 Assistant Event；
- Interrupted Response 即使可能被用户看到，也不进入后续 Context；UI 必须显示
  中断并提供显式 Retry；
- 一旦已有 token 可能展示，系统不得在同一 Turn 中静默生成不同回答；
- 从 1A.4 开始，只有在零 token 可能展示、Complete Assistant Response 尚未提交，
  且当前人工发布的 Model Routing Policy 已授权时，同一 GenerationCommand 才能
  新增一个指向唯一 eligible fallback 的 ModelRunAttempt；
- fallback handover 必须记录 source attempt、Model Routing Policy version、
  fallback model config 与 Provider Egress disposition，并通过
  `continuous_exchange_model_bindings` 的唯一键把该 fallback 固定到
  `daily_session_id + continuous_exchange_no + role`；同一 Continuous Exchange
  不能再次 handover 或切回 Champion。

逐 chunk 持久化、客户端 ACK、断点恢复或 delivered-prefix reconstruction
不属于 1A.1。Realtime 或未来明确批准的交付渠道只有在评估证明需要时，才通过后续
ADR 引入对应 delivery object、retention 和删除语义。14.5 的 Voice 保守交付规则
不代表 1A.1 预先实现通用 delivery buffer。

### 7.6 Transcript Segment

```text
id
conversation_event_id
event_revision_id
revision
speaker
text
locale
start_ms
end_ms
confidence
status                 # provisional / final / corrected / rejected
provider
model
audio_asset_id
created_at
content_purged_at
```

规则：

- Realtime 低延迟转写可以是 `provisional`；
- 创建 factual / subjective Evidence，并进入 Journal、Reflection 和 Claim 的
  必须是 `final` 或 `corrected`；
- 低置信度片段不得直接生成高置信度 Memory Claim；
- 原语言转写为 canonical，翻译不能覆盖原文；
- code-switching 可以在同一 Event 内由多个 Segment 表示。

## References

- [原始 核心架构 v0.1 快照](../archive/architecture/sayhear-core-agent-architecture-v0.1.md)
- [Session 与 Journal 产品规则](../product/12-13-session-and-journal.md)
- [Knowledge 数据模型](07-07-12-knowledge-data-model.md)

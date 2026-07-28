# 在线对话、Context 与检索

## TL;DR

- 在线 Turn 只提交完整成功的 Assistant Response，并显式处理失败。
- 用户控制意图最多产生一个 typed Conversation Action；确定性代码执行并返回真实 receipt。
- Conversation Agent Harness 只拥有单 Turn 的受限模型 / Action 往返，Framework 可替换但不拥有领域状态。
- Context Compiler 每轮在预算内重建可追溯 Context，不依赖模型自行记忆。
- 检索只使用当前有效 Claim 与可验证版本，并以精度优先于召回率。

## Status

Proposed

## 8. 在线 Turn 路径

### 8.1 Text 标准时序

```mermaid
sequenceDiagram
    participant C as Client
    participant API as Vercel API
    participant T as Turn Service
    participant DB as PostgreSQL
    participant CC as Context Compiler
    participant H as Conversation Agent Harness
    participant A as Action Gateway
    participant E as In-process Egress Port
    participant M as Model Provider
    C->>API: Text + client_event_id
    API->>T: Authenticated TurnCommand
    T->>DB: One transaction: InteractionTurn + User Event Revision + command
    T->>CC: Compile context at dialogue revision
    CC->>DB: Committed raw Events (+ 1A.2 projections)
    CC-->>T: Versioned CompiledContext reference
    T->>DB: Create Conversation Decision Command
    T->>H: Frozen Turn + Command + CompiledContext refs
    H->>DB: Create Decision ModelRunAttempt
    H->>E: Attempt + CompiledContext reference
    E->>DB: Check source + epoch + policy; record egress metadata
    E->>M: Response or one Action proposal
    M-->>E: Normal response or typed proposal
    E-->>H: Normalized response or typed proposal
    opt 1A.2+ Action proposal
        H->>A: Normalized proposal
        A->>DB: Validate and commit action receipt
        A-->>H: Committed receipt
        H->>DB: Create Action Finalization Command + Attempt
        H->>E: Final response call with tools disabled
        E->>M: Receipt-grounded generation
        M-->>E: Final response chunks
        E-->>H: Final response chunks
    end
    H-->>T: User-visible final response chunks
    T-->>C: Best-effort text stream
    T->>T: Accumulate full response in request process
    T->>DB: On complete: Assistant Event Revision + authoritative result + settle Turn
```

关键顺序是“先提交 User Event 和运行身份，再调用模型；完整成功后才提交
Assistant Event”。流式 token 是 1A.1 的暂态展示，不是可恢复消息日志。
后续 Context 只消费完整提交的 Assistant Event revision。

Conversation Agent Harness 的 seam 位于 application layer。调用方只提供冻结的
InteractionTurn、GenerationCommand 与 CompiledContext reference，并消费最终用户
可见 stream 与 terminal result reference；它不编排 Provider messages、Function
Calling、Action Gateway 或第二次模型调用。Harness 内部可以替换 Provider 或未来
Framework Adapter，但任何实现都必须服从相同 Conversation Harness Policy。

1A.1 的请求路径到此结束，不依赖 Workflow 或 outbox 才能恢复。一个轻量定时
恢复扫描器从 PostgreSQL 读取到期的 `next_evaluation_at_utc` 与长期未 settled
的 InteractionTurn / ModelRunAttempt；它直接调用带 revision fencing 的领域命令，
重复扫描不得重复结束 Exchange 或产生 Assistant Event。从 1A.2 开始，完整 Turn
提交可在同一事务中插入 outbox row，先触发 Journal 派生；1A.3 再增加
Entity、Reflection 和 Memory 等消费者。

### 8.2 失败语义

| 失败点 | 领域结果 |
| --- | --- |
| 重复 `client_event_id` | 返回已有 Event，不重复写入 |
| 用户 Event 已提交、模型调用前失败 | Event 保留；attempt 标为 failed；可以技术重试 |
| 尚未展示 token 时模型超时 | Event 保留；同一 command 可以创建新 attempt；1A.4 可在 Policy 允许时执行一次 fallback handover |
| 已有 token 可能展示后流式中断 | Turn / attempt 标为 `interrupted`；不创建 Assistant Event；UI 提供显式 Retry |
| 模型成功但 Assistant Event 提交前进程崩溃 | attempt 标为 `result_unknown`，Turn 由 reconciler 收敛为 `interrupted`；不猜测或补写正文 |
| Provider 429 / 5xx | 受控退避与 jitter；不产生部分领域状态 |
| Schema 非法 | 有限次数修复；随后 `needs_review` |
| 用户删除与生成并发 | `data_epoch` / fencing token 阻止结果提交 |

自动重试只允许发生在“没有任何 token 可能展示给用户”时。其余情况显式告诉用户
回答被中断；不能让新生成内容伪装成用户刚才已经看到的原回答。

系统在没有任何 token 可能展示时的技术重试，继续使用同一 GenerationCommand，
只增加 ModelRunAttempt。

从 1A.4 开始，`conversation.text` 的 Champion 在允许的同配置技术重试后仍失败时，
runtime 可以执行一次 Conversation Fallback Handover：

1. 重新确认没有任何 token 可能展示、Turn 尚无 Assistant Event，且没有其他
   authoritative attempt；
2. 确认当前 `daily_session_id + continuous_exchange_no + conversation.text`
   尚无持久 binding；读取 GenerationCommand 冻结的 Model Routing Policy
   version，只选择其中唯一 eligible fallback，不运行动态 capability search；
3. Provider Egress Port 在发送同一冻结 Context 前重新检查 fallback Provider 的
   policy、consent、source revision 与 `data_epoch`；
4. 在同一数据库事务中串行创建新的 ModelRunAttempt，并以
   `daily_session_id + continuous_exchange_no + conversation.text` 唯一键写入
   `continuous_exchange_model_bindings`；只有取得唯一键并记录 source attempt、
   fallback config 与 handover attempt 的事务可以 dispatch；
5. 当前连续交流的后续 Turn 和进程重启都从持久 binding 冻结相同 fallback config，
   不从最新 attempt 猜测状态，也不逐 Turn 切回 Champion；
6. fallback 完整成功时仍按普通 Complete Assistant Response 原子提交；fallback
   再次失败时显式结束为 failed，交给用户 Retry。

一旦任何 token 可能已经展示，或原 attempt 的结果是否可见无法证明，就不能执行
handover；必须按 Interrupted Response 处理。Handover 只改变执行 attempt 与当前
Continuous Exchange binding，不创建新的 User Event、InteractionTurn 或
GenerationCommand。binding 唯一键冲突、缺失或引用失效时必须 fail closed，不能
发起第二次 handover。

用户可以显式要求“重新回答”；API 先用客户端幂等 key 创建稳定
`retry_request_id`，再创建：

```text
intent_key = conversation-retry/<retry_request_id>
retry_of_interaction_turn_id = <original turn>
```

它创建新的 InteractionTurn、无正文的 User retry action Event 和
GenerationCommand；只有新回答完整成功后才创建 Assistant Event，UI 与历史必须
显示为一次显式 Retry。
重复提交同一 retry request 仍只创建一次，且不会与原
`conversation-response/<user-event-id>` intent 冲突。

### 8.3 在线路径不执行的工作

以下任务不能阻塞首个回复：

- Journal；
- Daily Reflection；
- Weekly Consolidation；
- Profile Projection；
- 全量 Embedding 重建；
- Replay；
- 删除 reconciliation。

1A.1 不触发这些派生任务。从 1A.2 开始，Turn 完成后通过 transactional outbox
按当前 Slice 已启用的消费者触发异步工作。

### 8.4 Conversation Action 契约

当 User Event 同时包含普通表达和用户控制意图时，Conversation Model 仍只能产生
以下两类结果之一：

1. 一个普通 Final Response；或
2. 恰好一个 typed Conversation Action proposal。

这两种结果由 Conversation Agent Harness 组织，但执行权限不属于 Harness 或模型。
当前冻结的 Conversation Harness Policy 最多允许两次逻辑模型判断：第一次返回普通
回复或一个 Action proposal；只有 Action Gateway 已返回 receipt 时，才允许第二次
在工具关闭状态下生成最终回复。普通回复不产生第二次调用；技术重试仍只增加
ModelRunAttempt，不增加 Action 或自主 step。

这两个模型阶段不能共享一个 GenerationCommand：

- Conversation Decision Command 以原始 User Event 与冻结 Context 为 source；
- Action Finalization Command 以创建时最新的已提交 Conversation Action Receipt 为
  新增 source，使用不同 Prompt / Schema 并冻结 `tools_disabled=true`；
- 两个 Command 都引用同一 InteractionTurn，各自拥有 ModelRunAttempt；
- Finalization 不得伪装成 Decision 的 technical retry、schema repair 或 fallback；
- Action 已提交但 Finalization 中断时，从 receipt 恢复，不重新执行 Action。

Conversation Action 必须来自当前已发布的 `Conversation Action Catalog`。Catalog
按产品阶段、用户 capability、运行状态和 Action policy 过滤，只包含用户真正可以
请求的高层产品能力；`update_claim`、`rewrite_journal`、`invalidate_profile`、
`delete_embedding` 或 `start_workflow` 等内部传播机制不向模型暴露。

#### 8.4.1 Action Capability 元模型

Catalog 中每个 ActionDefinition 声明：

```text
action_kind + schema_version
input_schema
target_contract
effect_class
trust_class
confirmation_policy
execution_mode
idempotency_scope
consistency_policy
rate_policy
receipt_contract
availability_policy
handler_binding + handler_contract_version
```

这些字段只描述 Harness、Gateway、权限、执行与 receipt 共同需要的横切契约。它们
不能成为编码 Claim、Journal、Profile、删除或外部 Connector 业务算法的通用 DSL。
具体领域不变量由 action kind 对应的 typed Action Handler 封装。

当前模型可见 Catalog 中的 `confirmation_policy` 只能是 `none`。需要二次确认、
step-up authentication 或不可逆高风险授权的能力通过独立产品入口提供，不编译为
Conversation Function；当前 Harness 不建立 pending confirmation 或跨 Turn challenge。

Action Gateway 的固定执行顺序是：

1. 从 Decision Command 冻结的 Catalog version 读取并锁定 Proposal 引用的
   ActionDefinition；
2. 验证 input Schema、Action Reference / Event locator 与 target contract；
3. 检查 owner、Version、capability、permission、rate、freshness、`data_epoch`、
   deletion fence 与幂等 scope，并获取或创建稳定的 ActionExecution；当前 Catalog
   遇到 `confirmation_policy != none` 的 Definition 必须 fail closed；
4. 产生一次性 Admission 决定；非 `accepted` 结果提交 Admission Receipt 后停止；
5. 对 `accepted` 结果，根据唯一 binding 调用兼容的 typed Action Handler；
6. 同步 Handler 原子提交 Admission Receipt、领域变化与 Completion Receipt；异步或
   外部副作用 Handler 原子提交 Admission Receipt、幂等 Workflow command / outbox
   与初始 `pending` 状态；
7. Gateway 将后续 handler / Workflow outcome 规范化为 immutable Progress /
   Completion Receipt，并更新可重建的 current status projection。

一个 enabled Definition 缺少 handler、绑定多个 handler、contract version 不兼容或
要求 Harness 解释领域规则时，Catalog 不得发布；runtime 遇到漂移必须 fail closed。
新增正常能力不得修改 Harness loop、Provider Adapter、ActionProposal envelope、
GenerationCommand stages 或 Finalization。

Decision Command 的模型侧 Interface 由 Harness 从冻结 Catalog 生成：

- 每个 eligible action kind 暴露为一个名称清晰、strict Schema 独立的 Conversation
  Function；
- Provider Adapter 可以使用原生 function calling 或等价 strict structured output；
- Adapter 必须在 application seam 前把选中的 Function 规范化为统一
  `ConversationActionProposal` discriminated union；
- Harness 设置 `parallel_tool_calls=false` 或 Provider 的等价约束，并在返回多个
  调用时 fail closed，不能替模型挑选一个；
- Finalization Command 的 Function set 为空，任何 tool call 都是协议错误。

Provider Function 名称、arguments envelope、call ID、Framework message 或 Session
类型不能进入 Action Gateway、领域 Module 或 PostgreSQL 产品真源。Proposal 保存
Catalog action kind、Schema version、request Event reference 与 opaque / typed target
reference；执行授权仍完全属于 Action Gateway。为 Admission 崩溃恢复短暂需要的其余
normalized typed arguments 单独加密并带到期时间保存，在 Admission 与同步结果或幂等
异步 command 提交后清除，不能成为长期 Action 审计或日志字段。

Function 参数引用 target 时遵循两条路径：

1. 已存在于冻结 Context 的 Entity、Claim、JournalStatement 等对象，只能使用当前
   Decision Command 的 opaque Action Reference Handle；
2. 当前 User Event 首次表达的新信息，只能使用指向 final / corrected Event revision
   的 typed Current Event Locator。

Context Compiler 通过 typed link 保存 Handle 到 owner-scoped 稳定对象、具体 Version、
source revision 与 eligible action kinds 的映射；Provider 看不到真实 ID。Action
Gateway 解析时仍重新检查 Handle 属于 Proposal 的 CompiledContext、owner 与 Version
仍有效、Action kind 被允许，并执行 scope、Evidence、`data_epoch`、权限和 deletion
fence。Handle 缺失、跨 Command 使用、Version 陈旧、owner 不符或身份有实质歧义时
返回 `clarification_required` 或 fail closed，不能用名称相似度自动改写目标。

Action proposal 不是 Assistant Event、领域写入或执行成功证明，也不能在调用前伴随
可能展示给用户的成功文本。应用代码以 `request_event_revision_id` 为来源，冻结
Catalog version，并验证 Action kind、target、scope、capability、Evidence、当前
revision、`data_epoch` 与幂等键。Action 的受理状态只能是：

```text
accepted
clarification_required
rejected
unsupported
```

受理后的执行状态独立演进：

```text
not_started
pending
running
succeeded
failed
canceled
```

非 `accepted` Action 的执行状态必须保持 `not_started`，不得调用 Handler 或提交部分
领域变化。`clarification_required` 按现有语义影响规则最多自然澄清一次。
`unsupported` 表示当前 Catalog 没有能够准确完成该请求的 Action；模型不能改用名称或
效果相近的 Action、拼接不存在的工具、只用语言模拟执行，或把普通 Conversation
Response 描述成已经发生的产品状态变化。

每个 Proposal 在幂等边界内只解析为一个稳定的 ActionExecution。Admission、
Progress 与 Completion 都追加 immutable Receipt；ActionExecution 上的 current
status 只是可从 Receipt 序列重建的 projection。同步 Action 在同一事务中提交
Admission、权威领域变化与 terminal Completion；异步 Action 在同一事务中提交
Admission、Workflow command / outbox 与 `pending` 状态，后续由 Workflow 追加
Progress / Completion。Terminal state 不能被晚到或乱序结果回退；重复请求返回同一
Execution，不重复产生领域写入、Workflow 或外部副作用。

最终 Assistant Response 冻结并读取创建 Finalization Command 时最新的 committed
Receipt，工具关闭后才能生成。它可以准确说明请求已接受、哪些限制已经立即生效以及
哪些 Journal / Profile 修复仍在处理；只有 `succeeded` Completion Receipt 才能声称
全部完成。异步完成不会自行产生第二个 Agent tool loop 或用户消息，除非该 Action
另有明确 delivery policy。

同一个 User Event 包含两个或以上可以独立接受、拒绝或执行的 Action 时，属于
Compound Conversation Request。一个 Action 为维护 Memory、Journal 与 Profile
一致性而产生的多个确定性下游影响不属于复合请求。

复合请求按以下顺序处理：

1. 若恰好包含一个明确、目标唯一的 Trust-Control Action，并且该 Action 自身的
   scope、授权与安全门槛已经满足，只提出并处理这个 Action；
2. receipt 与最终回复分别记录该信任控制已生效，以及其余 clause 是未执行、
   `clarification_required` 还是 `unsupported`；不得把整轮笼统描述为全部成功；
3. 若没有上述唯一 Trust-Control Action，而请求同时包含受支持与不支持的独立
   Action，本轮不改变产品状态；说明能力边界并询问是否只执行受支持部分；
4. 若有多个彼此独立且受支持的 Action，本轮不自行挑选；询问用户先处理哪一个。

用户对第 3、4 项的选择形成新的 User Event。当前 Catalog 只允许无需二次确认或
step-up 即可安全执行的 Action；Account Deletion 等高风险能力使用独立产品入口，
Trust-Control 优先级不能把它们变成模型可执行 Action，也不允许模型继续调用第二个
Action。

一个 Conversation Action 以用户语义意图为粒度，不以对象或 Workflow 为粒度。例如
“Mike 不是我的哥哥，只是比我年长的朋友”是一次关系纠正：

- 立即停止错误 `sibling_of` Claim 与 `older_brother` Qualifier 的 Recall、Context
  和 Resolver Hint；
- 独立验证并创建或更新 `friend_of` Claim；
- 将“Mike 比 Self 年长”作为独立 Objective Memory assertion 执行正常 Registry
  mapping 与 admission，不能继续编码成 sibling Qualifier；
- 确定性地产生受影响 JournalStatement 的定向复核和一次 Profile trust-boundary
  rebuild。

模型不分别调用 Memory、Journal 与 Profile 工具。一次 Action 可以创建多个
ClaimVersion 与 WorkflowCommand，但所有传播目标都由 lineage、current Version 和
领域规则推导。

### 8.5 延迟观测点

Internal Core 先建立基线，不在架构文档中虚构绝对阈值。

必须分别观测：

- 请求接收 → 用户 Event commit；
- Context Compiler 总耗时；
- retrieval query 与 rerank；
- 模型 time-to-first-token；
- 模型完整生成；
- Conversation Action proposal → 主事务 receipt；
- Action admission receipt → terminal completion receipt；
- receipt → Final Response 首个 token；
- STT 首段与 final transcript；
- Realtime end-of-turn → first audio；
- Barge-in → audio stop；
- Assistant Event 最终 commit。

## 9. Context Compiler

Context Compiler 是正式应用服务，不是散落在 API handler 中的字符串拼接。

### 9.1 输入层

按优先级编译：

1. 不可覆盖的产品、安全与关系边界；
2. Persona 稳定特征；
3. 当前 Daily Session 信息；
4. 当前 Session 滚动摘要（1A.2+）；
5. 最近 committed raw Events（1A.1 起）；
6. 模型生成的当前会话状态和语气（1A.2+）；
7. 相关 Objective Memory（1A.3+）；
8. 少量相关且未过期的 AI Impression（1A.3+）；
9. 必要的 Open Loop（1A.3+）；
10. 实时客户端信号（1B）；
11. 输出格式，以及当前版本化 Conversation Action Catalog 中允许的高层 Action 定义。

Open Loop 只读取 current Version 为 open 且尚未超过 `expires_at` 的少量
projection。当前 Turn 已有新提交的 User Event 时，selector 可以选出一个合适的
Open Loop，让 Assistant 在本轮主动询问进展，不要求 utterance 已先提到相同话题。
没有新 User Event 时，Open Loop 不得单独创建 GenerationCommand、消息或通知；
它也不能触发任务型输出。过期或关闭的 Loop fail closed。

1A.1 只使用 DailySession / InteractionTurn 上的确定性领域状态，例如
`activity_state`、revision 和 closure policy；它不持久化或消费模型生成的
DialogueState projection。

从 1A.2 开始，`DialogueState` 是当前 Session 的短期结构化 projection，可以包括：

```text
current_topic
emotional_intensity
advice_explicitly_requested
current_request_requires_focus
close_intent
follow_up_relevance
user_willing_to_elaborate
proactive_followup_used_in_exchange
safety_state
```

它必须带来源与置信度，不能直接晋升为长期 Profile。
尤其是 `advice_explicitly_requested`，用于落实“默认倾听，只有用户主动询问才给建议”。

Proactive Memory Follow-up selector 在 1A.3+ 必须 fail closed：

1. 当前 Turn 必须有新 User Event，且同一
   `daily_session_id + continuous_exchange_no` 尚未提交 Proactive Follow-up；
2. `current_request_requires_focus=true`、明确直接任务、紧急或高风险状态时不选；
3. target 必须是 active / open、未过期、非 contested、非 dormant、未被 Forget，
   且 current ProactiveFollowupStateVersion 为 eligible；
4. 问候、开放式开场或自然空档可以选出零或一个 target；没有合适 target 时不为
   满足配额强行生成；
5. Generator 必须先回应当前 User Event，再以最多一个温和问题使用 target；
6. 用户简短带过、回避、拒绝或转换话题后，提交 suppressed state。只有用户主动
   重提 target，或新的相关 User Evidence 推进 target version 时才解除；
7. 敏感 target 必须有 direct User Evidence，并生成允许不回答的 framing。

### 9.2 输出

`CompiledContext` 至少包含：

```text
compiler_version
dialogue_revision
source_revision
locale
sections[]
retrieval_manifest
referenced_object_ids
referenced_revisions
referenced_version_ids
referenced_evidence_ids
referenced_entity_version_ids
action_reference_manifest
action_reference_typed_links
token_budget_by_section
total_tokens
degraded_reason
proactive_followup_target_ref
proactive_followup_state_version_id
proactive_followup_selection_policy_version
content_hmac
created_at
```

Context Compiler 在受控 application boundary 内读取源数据，把引用清单以及必要的
加密 rendered payload 写入 `compiled_contexts`，向 Turn、Workflow 和 Replay
调用方只返回 `compiled_context_id + revisions + non-sensitive stats`。
Action Reference Handle 只在该 CompiledContext 与 Decision Command 内有效；manifest
随 Context lineage、retention 和 deletion 处理，不成为新的长期对象身份。
1A.1 的 Provider Egress Port 在实际发送前重新执行 epoch、source 和 policy 检查，
并读取或按引用重建 outbound payload；Gateway 抽离后由 `claim-and-fetch` 承担
同一职责。这样，预编译不构成绕过删除 fence 的第二条 Provider 出站路径。

为支持真实回放，可以保存：

- 不可变对象引用和 revision；
- section keyed HMAC；
- Prompt / policy version；
- 必要时保存加密的 rendered snapshot。

不应为了“可复现”默认复制一份完整明文 Context。任何加密快照都必须进入 lineage，
并随源数据删除。

1A.1 Text 只有完整提交的 Assistant Event revision 可进入 Context；
Interrupted Response 和未播放 Voice 内容一律排除。

### 9.3 Token Budget

每层有独立预算和截断策略：

- 产品与安全边界不可被动态内容挤出；
- 1A.1 按 sequence 从新到旧选择预算内的 committed raw Events；超出预算时在
  CompiledContext 记录 `raw_event_budget_exceeded`，不静默生成临时摘要；
- 从 1A.2 开始，最近原始 turn 优先于陈旧摘要；
- Objective Memory 优先于低置信度 Impression；
- Entity label 按当前 locale 投影，但 Context manifest 保留稳定 `entity_id`；
- 人物卡片由 Entity、选中的 Relationship ClaimVersion 与 localized projection
  在 Context Compiler 中合并渲染；Relationship Resolver Hint 只用于候选解析，
  不能作为事实注入 Context；
- 人物卡片只使用有有效 User Evidence 的 active Relationship Qualifier；Qualifier
  contested / retracted 时停止具体角色称呼。底层关系仍有效且 Registry 提供中性
  fallback 时降级为“家长 / 孩子”“手足”“伴侣”等中性投影；
- 注入 Claim 时保留 `claim_version_id + evidence_id`，不能只发送无来源的自然语言 Memory；
- 检索结果按相关性、置信度、时效和重复度裁剪；
- 不把完整历史持续发送给模型。

### 9.4 Realtime 使用

Realtime Session 打开前预热一次 Context。

之后：

- 每个用户 turn 边界刷新必要记忆；
- 同日新增重要信息可以进入 session-local context；
- 长 Session 按摘要和最近 turn 重新压缩；
- Provider session 到期或断线时，用 SayHear Context 重建；
- Provider session history 永远不是长期真源。

### 9.5 Rolling Summary 与 DialogueState 生命周期

1A.1 不创建 `session_summary_versions` 或 `dialogue_state_versions`。如果 committed
raw Events 超出 Context section budget，Compiler 保留预算内最新 Events，并在
CompiledContext manifest 写入 degraded reason；产品、安全、关系边界和当前用户
输入不能被截断。轻量恢复扫描器不得承担 Summary 或 DialogueState 生成。

从 1A.2 开始：

`session_summary_versions` 至少保存：

```text
daily_session_id
covered_from_sequence_no
covered_through_sequence_no
dialogue_revision
source_revision
prompt_version
model_config_version
summary_policy_version
content
status
created_at
```

初始 `summary_policy` 在未摘要的 confirmed Event 超过 12 个或估算超过
3,000 tokens 时异步创建 Summary；阈值版本化并由真实 Context 指标调整。
Summary 固定一个连续 Event 区间，只在所有引用 Version 仍有效时发布。
晚到的新 Event 在覆盖范围之后，不会改变已冻结的 Summary。

每次 Context 只能采用：

```text
one newest valid SummaryVersion
+ confirmed raw Events where sequence_no > covered_through_sequence_no
```

不得同时加入 Summary 已覆盖的 raw Event。provisional、interrupted、purged、
deleted 和未播放内容不得进入 Summary。Summary 失败时退化为预算内的最近 committed
raw Events，并记录 degraded reason；不阻塞用户回复。

`dialogue_state_versions` 至少保存：

```text
daily_session_id
dialogue_revision
state_policy_version
field_values
field_confidences
source_event_revision_ids
created_at
```

- 每次 confirmed User / Assistant Event 后异步更新；
- Context 读取 `dialogue_revision <= current` 的最新有效 Version；
- State 落后时，Context 同时加入其 revision 之后的 raw Events，不假装状态已经更新；
- 每个 field 有 evidence 和 confidence；
- 它只用于当前 Session，不进入长期 Profile；
- source 修正、删除或 delivery reconciliation 会使受影响版本失效并重建。

## 10. 检索与记忆召回

### 10.1 初期检索

使用 PostgreSQL + pgvector：

- 最近 turns；
- Daily Session summary（1A.2+）；
- structured filters；
- stable entity ID / Claim canonical key；
- localized Entity label / alias；
- validated Relationship Resolver Hint；
- 时间范围；
- semantic vector；
- 必要时 lexical query。

### 10.2 查询构建

不只用用户最后一句话。

查询可以来自：

- 当前 utterance；
- 当前话题；
- 最近数轮中的 EntityMention 和 Episode；
- Dialogue State；
- 当前日期和历史时间表达；
- current Version 为 open、尚未过期，且适合在当前用户发起的对话中使用的
  Open Loop。

多路结果进行去重和 rerank。

### 10.3 精度策略

错误召回比漏召回更伤害信任，因此：

- 高 precision 优先；
- 低置信度内容不主动说“我记得”；
- Impression 的注入数量严格限制；
- Objective Memory 与 AI Impression 使用不同的 recall projection policy；
  kind / epistemic status 与输出 framing 不一致时拒绝交付；
- 已 contested / retracted 的 Claim 不能被召回；
- 跨语言查询先解析到同一 Entity / Claim identity，再比较 localized projection；
- 每次召回保存候选 ClaimVersion、EntityVersion、Evidence ID、最终选择和理由元数据；
- 用户询问或质疑记忆时，从实际选中的 ClaimVersion 和 typed Evidence 生成
  Memory Source Explanation，说明来源日期、相关用户表达以及
  objective / impression 类型；不得从模型自身回答、Journal、Reflection 或
  Profile 反向生成来源；
- Memory Source Explanation 通过正常对话交付，不要求专门的引用 UI；
  Evidence 无法展开到有效 User Event Revision 时必须 fail closed，明确说明无法核实；
- 检索失败时自然继续对话，不强行展示记忆。

### 10.4 向量版本

每个 Embedding 保存：

```text
provider
model
dimension
embedding_policy_version
source_type
source_id
source_version_id
created_at
```

Embedding 必须能从 PostgreSQL 中的当前有效 Version 重建；旧 Version 被
supersede、retract 或 purge 后，其向量立即停止检索。

## References

- [原始 核心架构 v0.1 快照](../archive/architecture/sayhear-core-agent-architecture-v0.1.md)
- [Conversation 数据模型](07-01-06-conversation-data-model.md)
- [Provider 与本地化](15-16-providers-and-localization.md)

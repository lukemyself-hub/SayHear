# 在线对话、Context 与检索

## TL;DR

- 在线 Turn 只提交完整成功的 Assistant Response，并显式处理失败。
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
    participant E as In-process Egress Port
    participant M as Model Provider
    C->>API: Text + client_event_id
    API->>T: Authenticated TurnCommand
    T->>DB: One transaction: InteractionTurn + User Event Revision + command
    T->>CC: Compile context at dialogue revision
    CC->>DB: Committed raw Events (+ 1A.2 projections)
    CC-->>T: Versioned CompiledContext reference
    T->>DB: Create ModelRunAttempt
    T->>E: Attempt + CompiledContext reference
    E->>DB: Check source + epoch + policy; record egress metadata
    E->>M: Stream response with server-only credential
    M-->>E: Response chunks
    E-->>T: Response chunks
    T-->>C: Best-effort text stream
    T->>T: Accumulate full response in request process
    T->>DB: On complete: Assistant Event Revision + authoritative result + settle Turn
```

关键顺序是“先提交 User Event 和运行身份，再调用模型；完整成功后才提交
Assistant Event”。流式 token 是 1A.1 的暂态展示，不是可恢复消息日志。
后续 Context 只消费完整提交的 Assistant Event revision。

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
| 尚未展示 token 时模型超时 | Event 保留；同一 command 可以创建新 attempt |
| 已有 token 可能展示后流式中断 | Turn / attempt 标为 `interrupted`；不创建 Assistant Event；UI 提供显式 Retry |
| 模型成功但 Assistant Event 提交前进程崩溃 | attempt 标为 `result_unknown`，Turn 由 reconciler 收敛为 `interrupted`；不猜测或补写正文 |
| Provider 429 / 5xx | 受控退避与 jitter；不产生部分领域状态 |
| Schema 非法 | 有限次数修复；随后 `needs_review` |
| 用户删除与生成并发 | `data_epoch` / fencing token 阻止结果提交 |

自动重试只允许发生在“没有任何 token 可能展示给用户”时。其余情况显式告诉用户
回答被中断；不能让新生成内容伪装成用户刚才已经看到的原回答。

系统在没有任何 token 可能展示时的技术重试，继续使用同一 GenerationCommand，
只增加 ModelRunAttempt。

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

### 8.4 延迟观测点

Internal Core 先建立基线，不在架构文档中虚构绝对阈值。

必须分别观测：

- 请求接收 → 用户 Event commit；
- Context Compiler 总耗时；
- retrieval query 与 rerank；
- 模型 time-to-first-token；
- 模型完整生成；
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
11. 输出格式和工具定义。

1A.1 只使用 DailySession / InteractionTurn 上的确定性领域状态，例如
`activity_state`、revision 和 closure policy；它不持久化或消费模型生成的
DialogueState projection。

从 1A.2 开始，`DialogueState` 是当前 Session 的短期结构化 projection，可以包括：

```text
current_topic
emotional_intensity
advice_explicitly_requested
close_intent
follow_up_relevance
user_willing_to_elaborate
safety_state
```

它必须带来源与置信度，不能直接晋升为长期 Profile。
尤其是 `advice_explicitly_requested`，用于落实“默认倾听，只有用户主动询问才给建议”。

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
token_budget_by_section
total_tokens
degraded_reason
content_hmac
created_at
```

Context Compiler 在受控 application boundary 内读取源数据，把引用清单以及必要的
加密 rendered payload 写入 `compiled_contexts`，向 Turn、Workflow 和 Replay
调用方只返回 `compiled_context_id + revisions + non-sensitive stats`。
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
- Open Loop。

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

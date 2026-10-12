# 在线对话、Context 与检索

> 当前 1A.3b 执行范围以 [ADR-0141](../adr/0141-g1-only-release-after-g2-retirement.md) 与 [SPEC #193](https://github.com/lukemyself-hub/SayHear/issues/193) 为准：只重发 G1。本文下方涉及 Open Loop、对话内 Proactive Follow-up、Bio 写作或三阶段 G4 的段落保留为历史设计，不授权当前实现、上线或验收。G1 的普通 Memory Recall、Curiosity Stop Signal、Episode、Reflection、治理、Inspector 与共享叙事验证继续适用。

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
提交可在同一事务中插入 outbox row，先触发 Journal 派生；1A.3a 再增加
Entity 和 Memory 等消费者，1A.3b 再增加 Reflection 消费者。

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
| 请求超过整体 30 秒（ADR-0152） | 截止时刻在受理时冻结并由所有步骤共用；超过后不开始新步骤，进行中的调用被取消（取消不了的不再等待），迟到结果不展示、不提交；无 token 展示为 failed(timeout)，已展示为 `interrupted`；技术重试不会越过截止 |
| 新用户消息到达时旧回答仍在途 | 旧回答失去展示与提交资格（同一 Session 存在更新的用户消息，数据库围栏）；进程内另取消其 Provider 调用；新消息是新 Turn，冻结上下文含前一个有效用户问题 |
| Decision 转为 Action 提案后 | 无论受理结果，Decision 的 command/attempt 都被结算；已报告的 Provider 用量无论完成与否入账，未知保持 NULL |

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
- Bio；
- 全量 Embedding 重建；
- Replay；
- 删除 reconciliation。

1A.1 不触发这些派生任务。从 1A.2 开始，Turn 完成后通过 transactional outbox
按当前 Slice 已启用的消费者触发异步工作。

### 8.4 Conversation Action 契约

当 User Event 同时包含普通表达和用户控制意图时，Conversation Model 仍只能产生
以下结果之一（互斥，由 Harness 确定性执行）：

1. 一个普通 Final Response；
2. 恰好一个 typed Conversation Action proposal；或
3. 恰好一个受控只读历史查询提案（#314，见 §8.4.2）。它不是 Conversation Action。

同一 Decision 同时出现 Trust Action 与历史查询提案时，Trust Action 确定性胜出（ADR-0092）。

这两种结果由 Conversation Agent Harness 组织，但执行权限不属于 Harness 或模型。
当前冻结的 Conversation Harness Policy 的第一阶段返回普通主回应或一个 Action proposal。
Action 路径只有在 Action Gateway 已返回 receipt 时，才允许一个 tools-disabled 的 Finalization
判断。历史查询路径在确定性查询完成并冻结结果后，才允许一个 tools-disabled 的 History Answer
判断（§8.4.2）。普通回应路径的 Proactive Follow-up Segment 已随 G2 退役（ADR-0141），不再是现行
第二阶段；Action 与历史查询两条第二阶段路径互斥，普通回应不产生第二次调用。技术重试仍只增加各自 Command 下的 ModelRunAttempt，不增加 Action 或自主 step。

这些不同生成意图不能共享一个 GenerationCommand：

- Conversation Decision Command 以原始 User Event 与冻结 Context 为 source；
- Action Finalization Command 以创建时最新的已提交 Conversation Action Receipt 为
  新增 source，使用不同 Prompt / Schema 并冻结 `tools_disabled=true`；
- Proactive Follow-up Segment Command 以冻结主回应、current DialogueState、target 与 reservation
  为 source，使用窄 Prompt / Schema 并冻结 `tools_disabled=true`；
- History Answer Command 以 Decision 冻结的历史查询结果引用与版本为新增 source，使用独立
  Prompt、冻结 `tools_disabled=true`，并有自己的预算与 ModelRunAttempt；
- 各 Command 都引用同一 InteractionTurn，各自拥有 ModelRunAttempt；
- Finalization 不得伪装成 Decision 的 technical retry、schema repair 或 fallback；
- Action 已提交但 Finalization 中断时，从 receipt 恢复，不重新执行 Action。

Conversation Action 必须来自当前已发布的 `Conversation Action Catalog`。Catalog
按产品阶段、用户 capability、运行状态和 Action policy 过滤，只包含用户真正可以
请求的高层产品能力；`update_claim`、`rewrite_journal`、`invalidate_profile`、
`delete_embedding` 或 `start_workflow` 等内部传播机制不向模型暴露。

#### 8.4.2 受控只读历史查询与 History Answer（#314）

**提案**：函数 `review_conversation_history`（`start_date`、可选 `end_date`、`time_basis`、`source_scope`），
由 Harness 加入 `functions`，不进 Catalog。Egress 把它归一化为独立事件 `history_query_proposal`；
未提供该函数、工具被禁用或参数含任何额外键都 fail closed。

**确定性计划**：`resolveHistoryQueryPlan`——日期范围 ≤ `maxDateSpanDays`（v1 为 3）、不得晚于请求
本地日期；时区取冻结命令的请求时区，缺失则回退 Session 起始时区，再缺失则 `timezone_unavailable`。
日期转换为 UTC 半开区间在 SQL 内完成（DST 安全）；截止时刻为受理请求的输入事件时刻，之后的消息、
当前 Daily Session 的消息（已在原文窗口内）不进入本次读取。

**读取与资格**：`PostgresHistoryRecallSource` 在只读 REPEATABLE READ 事务内读取，先核验 owner 与
Data Epoch；稳定游标 `(created_at, daily_session_id, sequence_no)` 分页，受 `maxPages/pageSize/
maxSourceRows` 约束；资格谓词（active、当前 revision、未 purge、final/corrected、Correction/Forget
明确关联、Assistant 依附于其生成请求）与近期背景共用 `postgres-source-eligibility.ts`。被排除行的
正文不越过读取端口。预算 `maxContextTokens`（v1 为 3,000）与单条上限决定实际注入；未枚举完/未注入的
部分使结果为 `partial`。

**冻结与阶段**：见 ADR-0094 修订。History Answer 编译时重新读取并重验每个引用（失效者丢弃并计入
`droppedAtCompile`）；发送前与提交前的 `contextReferencesAreCurrent` 对 `history_recall_context` 同样
重查 Correction/Forget 与 revision 当前性。**所有路径的来源资格检查在提交前仍完整执行。**

**Inspector**：`GenerationInspectionMetadata` 增加 `generationStage` 与 `historyRecall`（角色、状态、
失败码、计划日期、枚举/注入覆盖、来源 revision 引用与时间），两端命令互相可达；无正文。

**已知边界**：Retry 与恢复路径没有请求 revision，不提供该函数，历史问题退化为普通回复；原文词法检索见 8.4.4（#316）。

#### 8.4.3 按日期回顾主要话题（#315，`history-recall:v2`）

在 8.4.2 的计划与读取上扩展，不改变阶段、冻结与资格结构：

- **两种时间基准**：`time_basis` = `expressed_date`（默认，消息何时说）或 `experienced_date`（经历何时发生）。
  经历时间目前没有任何有来源的列，所以经历日期查询读取 `[开始日, min(结束日+14 天, 请求本地日)]` 内“说过的话”作为
  线索，**结果恒为 `partial`**（`coverage.limits = ["experience_time_not_recorded"]`），回答指引要求只采用原话里
  相对表达时间的说法、否则保持“日期未给出”。表达日期与经历日期的结果从不混用。
- **范围与读取**：日期范围上限 `maxDateSpanDays`（v2 为 92）；≤14 个日期逐日列出，更宽的只列有消息的日期。
  v2 预算：每页 50 行、最多 8 页、400 行、3,000 token、单条 600 token、读取超时 2 秒，版本号
  `history-recall:v2`。读取包含当前 Daily Session 中属于该范围的消息（跨午夜的同一会话仍含“昨天”），只排除
  请求本身；编译时以 revision 去重，同一条不会在原文窗口里再出现一次。截止时刻与游标语义同 8.4.2。
- **覆盖优先的选取**（`selectHistoryRecall`）：先以相邻消息间隔 >30 分钟切成时间块；总量超预算时按“小块先足额、
  大块均分余量”分配每块预算（水位填充），块内先放弃 Assistant 行，再放弃较长的用户行，块的开头一条最后才放弃；
  完全相同的重复用户文本只保留一条。这样最新或最长的话题不能挤掉当天更早的话题。最终仍按时间顺序注入。
- **覆盖记录**（内容无关）：`enumerationComplete`、`readThrough`（未读完时读到哪一刻）、`blocks/blocksCovered`、
  逐日 `state`（empty/complete/partial/unread）、`omitted`（含 `assistant_context_trimmed`、`duplicate_text`，这两类
  不算漏读来源）、`limits`、`timeBasis`。`partial` 当且仅当读取未枚举完、用户来源被预算裁掉或存在 `limits`。
- **回答指引**：完整、完整空日、部分（预算 / 读取提前停止）、读取失败、经历日期各有不同的指引句；均不含内部术语。
  细节追问由 Decision 再次调用同一函数，答案取自原文而不是上一轮助手摘要。

#### 8.4.4 原文经历检索（#316，`history-recall:v3`）

8.4.2/8.4.3 的同一函数增加第二种提案 `search_experience`：`search_terms`（≤ 6 个短词/短语，每个 2–32 字符，含近义与
中英两种写法）、可选 `people`（≤ 3）、可选 `start_date/end_date`。词只是**寻找线索**，不是用户事实，不形成
Claim、Entity 或别名；未知键、控制字符、只给 `people` 一律 fail closed。一轮仍只有一个查询（`maxHistoryQueries: 1`），
模型生成的改写就在这个 Decision 内，没有额外的检索前模型。

**确定性计划**（`resolveExperienceSearchPlan`）：NFKC、小写、空白折叠；每个线索附带有限的繁/简变体
（`maxVariantsPerGroup`）；日期范围 ≤ `maxSpanDays`（search 策略 `history-experience-search:v1` 为 400），起点不得晚于请求本地日期。与日期回顾一样只排除请求本身（不再排除当前 Daily Session，编译时按 revision 去重）。person 线索只在
**恰好命中一个 Entity 的已验证标签/别名**时才用该 Entity 的其他已验证标签扩词；命中多个 Entity 则不扩词
（同名不合并），不创建或关联任何 Entity。**person 线索单独不能选中消息**，必须同时命中至少一个主题词。

**读取**（`PostgresExperienceSearchSource`，无投影、无索引、无新表）：在只读 REPEATABLE READ 事务内，对 owner
最近的 `scanLimit`（search 策略 v1 为 6,000）条仍有资格的 **User** 原文按 `created_at` 倒序扫描，CJK 线索按子串、ASCII 线索按
单词边界匹配；Assistant 文本永不作为命中。共享截止时间 `deadlineMs`（别名、命中、上下文三次读取共用，
作为各事务的 statement_timeout）。资格谓词与 §8.4.2 完全共用（`postgres-source-eligibility.ts`）：Correction/Forget
明确关联的命中被排除并只计数，其文本不越过端口。
没有为普通原文建立词法投影：当前规模下有界扫描足够，且这避免了第二份私人文本拷贝；若实测扫描上限
不够，再增加可重建投影时必须同时登记 Purge、失效与重建回归。

**候选与分组**：命中按「命中线索数、时间」排序，同一 Daily Session 内相距 ≤ `contextWindowMinutes` 的命中是同一
次经历，其余各自独立成组（≤ `maxGroups`，超出记 `candidate_limit`）。每组保留命中本轮、前后各 `neighborTurns`
轮相邻 User 消息及其绑定的 Assistant 回复；没有任何命中仍有资格的组不单独注入相邻文本。组按时间升序编号，
冻结在 `item_refs` 的 `group/role`（match/context），引用原因 `history_lexical_match/history_lexical_context`
（迁移 0075）。

**覆盖与措辞**：`coverage.search` 记录 `scannedRows`、`scanComplete`、`oldestScannedAt`、`matchedRows`、
`candidateGroups/selectedGroups`、`aliasChannel/contextChannel` 与 `outcome`（candidates / no_match /
insufficient_coverage / channel_failed）；回执只用这些事实：无匹配只说“在能看到的范围里没找到”，扫描未到范围起点
则说明只看了一部分，永不断言“没聊过”“第一次”“只有一次”；有多次经历时明确“每次各算各的”。回执同时声明被引用的
过往消息是记录而不是指令，Assistant 行只用于理解。Correction/Forget 命中的存在**不**写进回执。

**编译时重验**：与日期回顾相同；若某组的命中在编译时已失效，该组的相邻上下文一并丢弃（计入 `droppedAtCompile`）。

**Inspector**：`plan` 只暴露线索组数量与变体总数，不含线索文本；`sources` 带 `group/role`。

#### 8.4.5 当前话题的自然接续（#317，`history-recall:v4`）

在 8.4.4 的同一函数、同一原文检索上增加**接续**用法：提案可带 `continuation_basis`（`current_input` /
`adjacent_user` / `dialogue_state`，去重、至少一项），表示这次查找不是用户问过去，而是当前表达需要较早背景
（代词/省略，如“终于有回复了”）。仍是一轮一个查询、无检索前模型、无 embedding、无新表/迁移；提案（含依据）单独
记录在已登记的 `history_recall_results.plan`，Inspector 的 `coverage.continuation` 只含计数与结论。

- **信号有效性**（`validateContinuationBasis`）：`loadDecisionFacts` 从本轮 Decision 冻结的 CompiledContext 取信号，文本只
  在内存：当前输入；其引用里仍为事件当前 revision 的其他用户表达（最多 5 条）；`dialogue_state` 仅当该 Context 实际带有
  source-valid 的 DialogueState 段（失败/撤销/不一致则 Context 不含，依据被拒绝）。落后（lagging）的状态仍可用，其后的原文
  本就由 Context 补读。全部依据无效 → `continuation_basis_unavailable`，退化为普通回复。
- **低信息线索**：问候/致谢等线索被剔除，剩余为空则 `search_terms_unusable`，不读取。当前 Daily Session 的命中不算“较早事情”。
- **消歧**（`assessContinuation`）：命中按 8.4.4 分成独立事情（不合并）。“锚定”= 线索词本身出现在有效信号里。某事情的锚定数严格
  多于其他所有事情 → `leading`；只有一件 → `single`；否则 `tied`（候选数超过 `maxGroups` 则 `too_broad`）；无命中 `none`。
  仅靠词重叠不能产生领先者，所以既不会“总是澄清”也不会“总猜最近”。
- **回答**：接续使用 History Answer 任务指令 `task-instruction-history-answer:v2`（回应当前表达，而非回答“问过去”）。回执按结论
  指示：single/leading 自然接上且不要求重讲、不断言结果；tied 只问一个点名各事的简短问题；too_broad/none/失败按普通回复，不出现
  “查不到”类话；不新增进展追问或待办。
- **诊断分层**：选择（basis/锚定/verdict/occasions 支持度）、误召回（引用来源与 group）、澄清（verdict=tied 的回执）与最终生成
  （既有 Provider/Event 记录）分别可见。真实模型的自然度与打扰感判据归 T08 #321。

#### 8.4.6 用历史理解当前变化：阅读合同与同一人格（#318）

不新增阶段、表、迁移或人格。日期回顾、较早查询与自然接续三条路径只要引用了原文，回执（`history_recall_receipt`）末尾都带同一段
`History reading rules (history-reading:v3)`（`renderHistoryReadingRules`，无引用时不带）：引用是用户当时的原话，时间是表达时间；
同一事上后说的才是现在、先说的只作过去；只有用户自己的更正能改写其先前说法，没有更正含义的新说法不改变其他原话，也不触发排除；
被取消/无后文的计划不当作已发生；Assistant 行不是用户陈述；不补离职原因、他人动机；一时感受不固化为人格或标签；与当下无关的
旧事不因“检索到了”而提起，联系只作为助手自己的试探性理解；不给建议。身份、语气与安全仍只来自 Canonical Persona / Safety
Posture / 关系边界各 section——三条路径与普通回复由同一个 `createSections` 编译，History Answer 命令从 Decision 命令复制
全部 persona/safety/relationship 版本，系统测试逐项断言它们相同。已有的资格排除（Correction/Forget 关联来源整条排除）不变。

检索侧一处变化：`buildExperienceGroups` 在候选事情超过 `maxGroups` 时，保证“用户最新一次提到”的那件事占一个名额（替换
排名最弱的一件，被替换的计入 `candidate_limit`），避免按线索数排序把现在的状态挤出去而只剩旧状态。函数描述新增用法：用户
讲述对某具体人/事的感受，而较早所述有助于理解其在意处时，用当前表达里**字面出现**的词作接续线索（`current_input`）。
**已知局限**：用户之后反复问同一话题的问句本身也含线索词，会占用名额（见 #318 交接笔记）。共情与人格的主观品质不由本节任何
机械检查宣称达标，按 ADR-0110 由 T08 人评裁定。

**用户更正在出站中可辨（`history-reading:v2`）。**被用户更正过的消息保留原来的表达时间与位置（时间线取 `conversation_events.created_at`），
所以在 v1 下，更正之后几分钟内、未被关联的旧说法复述会排在它后面，被读成“最新说法”。数据层里用户更正是确定的：当前 revision 的
`created_by = 'user_correction'`，其 `created_at` 就是更正生效时刻。History Answer 编译时把这类被引用的用户消息记入回执快照
`corrections`（消息在出站中的 1 起始序号、更正时刻、时区；不含正文），回执在阅读规则前逐条写明“第 N 条是用户自己的更正，更正于某本地时间”；
规则增加：用户的明确更正优先于其在该时刻之前就同一事项写下的任何说法，不论这些说法在时间线上的位置；“最新说法为现状”只在没有更正
覆盖时适用。不做语义匹配、不扩大排除范围，复述仍是允许来源（ADR-0149）。规则版本随结果冻结在快照的 `readingRulesVersion`；没有该字段的
在途/历史结果按 v1 原样重放，未知版本失败关闭。Inspector 只给 `correctionMarks` 计数与规则版本。真实模型是否据此把更正后的说法当作现状，
由 C12 的 `S-controls` 裁定（T08）。

**较早原文作为材料块、更正就地说明（`history-reading:v3`，SPEC #301 呈现修复）。**v2 及之前，被引用的较早原文作为普通
user / assistant 消息排在当前对话前面，消息本身没有标记，“哪条是什么时候说的”只在 Times 序号表里；更正标记写在回执末尾、按序号指回消息。
真实模型因此反复确认“回执说 N 条已引用，但认不出是哪些”，有时直接答“内容看不到”，并把更正时刻之前的旧说法复述读成改口。布局由
`eval/continuity-acceptance-301/presentation-bench`（直接调用 Provider 的设计用基准，不是验收证据）在 8 个 fixture、6 种布局上选定：
现状的回答调用推理中位 3,420 token，材料块布局 506，更正方向从 1/5 到 21/21。v3 的呈现（`message-presentation.ts`）：

- **材料块。**History Answer 引用的消息不再进 `messages`。它们由冻结的 `history_recall_context` 事件与已签名的 `time_context` 元数据确定性
  渲染成一个有边界的块，追加在指令末尾：标题 `EARLIER MESSAGES (…)`、一行“Now is …”、按天分组（检索路径在 occasion 计数与实际条数
  对得上时再按 occasion 分组）、逐条编号、每条带说出的时刻、正文逐行以 `> ` 开头（正文里的任何文字都无法冒充条目或块尾）、
  结尾 `END OF EARLIER MESSAGES (N in total).`，计数与可见条目一致。没有引用时不发块，回执也不指向块。
- **时间。**标题用人读的日期与“N 天前”；条目时刻取该消息自己的时区，与当前请求时区不同才写出时区名。同一本地日内出现不同 GMT 偏移
  （夏令时重复的那个小时）时，该日条目带 GMT 偏移；消息没有随请求保存时区时注明 `(time zone assumed)`，对应原来 Times 表的 `s=s`。
  Times 序号表只列真正作为对话轮次发出的消息并重新编号；元数据条目本身仍覆盖全部消息并参与完整性校验。
- **更正。**被用户更正过的条目就地写明这是更正后的说法及更正时刻；“写下时刻早于该更正时刻”的其他用户消息（未更正的取表达时间，已更正的
  取其更正时刻）就地写明它写于该更正之前、不是之后的改口。不比较内容、不判断是否同一件事，不出站更正前的原文，不排除、不重排任何消息；
  Correction / Forget 的既有控制语义（ADR-0149）不变。被更正消息当时生成的 Assistant 回复继续按既有关联排除，所以它后面没有相邻
  Assistant 条目。基准里另一种呈现（按“这句话写下的时刻”重排）方向同样全对，但更常把旧数字带回来，未采用。
- **七天近期背景与同一 Daily Session。**同一问题在那里同样存在（更正后的文字留在原位置、原时间，此前完全没有标记）。两个来源
  （`postgres-recent-context-source.ts`、`loadContextSource`）返回更正时刻，这两类对话轮次以 `[Note. …]` 开头；只有确实发出这类说明时，
  `time_context` 段才追加一行读法规则（预算相应加 128 token）。没有更正的 Context 逐字节不变，功能关闭时的普通聊天基线不受影响。
- **回执与规则。**回执的回答要求指向“指令末尾标题为 EARLIER MESSAGES 的块”，不再引用 Times 表，也不再按序号写“第 N 条是更正”；
  另加一行说明其后的对话是当前对话、不属于该块、照常可用（基准里模型在“被问时段内的消息有的在对话里、不在引用里”处犹豫）。
  阅读规则保持完整版：基准里精简规则没有降低推理量，反而更常复述被更正掉的数字。规则要求不得把标题、编号、方括号说明念出或提及。
- **冻结与重放。**更正时刻冻结在 `time_context` 元数据条目上（可选字段 `correctedAt`，无更正时不存在）。是否用材料块由回执快照里的
  `readingRulesVersion` 决定：v1 / v2 冻结的结果仍把引用消息作为对话轮次、按原样逐字节重放
  （夹具 `history-answer-context-reading-v2-f179b3d.json`）。块文本不进入任何段的 content，段摘要与 HMAC 不变。
- **已知的小额低估。**块的标题、编号与说明行以及 `[Note.]` 行的 token 不计入各段 `selectedTokens`（每条约 10–40 token）。
- **来源围栏不变。**块里的条目就是原来作为轮次发出的那些修订，仍经编译时重新过资格、Egress 重推导与提交前复查；Inspector、Purge 面不变。

**Decision 函数说明（`history-recall:v5`）。**有线索的自然接续里，模型曾把来信归到七天背景里可见的另一件事，依据“较早背景已在对话中就不要用”
而不查。函数说明补充：对话里可见的事与当前消息给出的来信方、到达方式、所涉对象不吻合时，不算已在对话中，用这些细节去查。说明里取自开发
案例的例句已换成不取自任何案例的例子。**启用步骤**：策略版本写在治理授权行里，代码升到 v5 后需要一条 v5 的授权行才启用——部署后由具备
权限的操作者 `POST /api/internal/operator/history-recall {"action":"enable"}`；若环境里已有旧版本的生效行，先 `{"action":"disable"}`
（同一请求排空未结算的 History Answer），`GET` 读到 `historyAnswers.unsettled: 0` 后再 `enable`，并用 `GET` 与 `effective-runtime-config` 的
`policy.history_recall_governance_version` 核对。

#### 8.4.7 历史路径的来源控制、诊断与独立关闭（#320）

**来源控制围栏。**同一批用户控制（Correction 的新 revision / Forget 排除 / Data Epoch 与 Purge）对日期回顾、较早检索、自然接续三个入口
一致生效，围栏点依次为：读取前、读取后冻结前、冻结后编译前（编译时重验引用）、编译后发送前（`claimDispatch`）、发送后首个
可见 token 前（`recordFirstToken`，本票新增：来源引用、Data Epoch、治理再核对一次，失败即结算为 `policy_blocked`，不展示）、
Provider 结果落定（`recordProviderCompletion`）与提交（`commitCompleteResponse`）。**无法撤回**：首个 token 之后才到达的控制只能阻止
提交，已展示的文字不撤回，Turn 记 `interrupted`，用户显式 Retry（见 8.2）。独立允许来源（同日其他消息）不因一个来源被排除而被整体关闭。
范围不变：只排除明确关联的整条消息及绑定的 Assistant 回复；用户自己此后对旧说法的不相关复述不被排除（ADR-0149）。

**独立关闭。**`history_recall_policies`（0081）与 `history_recall_results.governance_policy_version`；操作入口
`/api/internal/operator/history-recall`（GET 状态、POST enable/disable/drain，鉴权与 recent-context 入口一致）。规则见 ADR-0093 的 #320 修订。
关闭（disable）在同一请求里把未结算的 History Answer 命令失败关闭排空，并返回 `historyAnswers: {drained, unsettled}`；`GET` 返回
`historyAnswers.unsettled`；`drain` 只在分支关闭时可用（开启时 409）。回滚到不含历史分支的应用版本前必须读到 `unsettled: 0`
（ADR-0093 / ADR-0094 的 SPEC #301 评审修订）。部署开关关闭或治理撤销后，崩溃遗留的 History Answer 由恢复扫描失败关闭结算，已过请求
截止的不等恢复窗口。

**关闭后的普通回复。**分支关闭、未部署或 Retry 退化时，回复是不带回执的普通回复，Context 与没有历史分支时逐字节相同
（`context-compiler:time:v3` / `recent-time:v3`）。已知缺口：没有确定性约束阻止模型据近期背景断言“没聊过”，见 ADR-0093 的 SPEC #301 评审修订。
`effective-runtime-config` 增加 `switch.history_recall_governance_enabled` / `policy.history_recall_governance_version`，探针缺失时报 `unverified`。

**诊断。**受控 Inspector 增加 `turn`（同一 Turn 全部 command 的阶段、状态、Provider Egress 处置、Provider 请求 id，以及最终处置
`committed|failed|interrupted|in_progress|settled_without_reply`）；History Answer 的回执 reference 对 Inspector 去掉查询线索与人物，仅留计数
（编译冻结的 reference 仍含线索，在已登记的私人面 `compiled_contexts` / `history_recall_results` 内，随 Purge 清除，系统测试按整库扫描证明）。
原文展开沿用 `conversation_content:read` + 近期 step-up：`GET /api/internal/inspection/conversation-content` 对历史 command 额外返回
`historySources`（按模型所见顺序，仅返回当前仍允许的来源；被排除/清除的不返回）；拒绝只给固定原因码，不含查询、人物或范围。
验收 harness 的 `diagnose` 用三处真实边界判定五类问题（无来源 / 选漏 / 时间丢失 / 读取失败 / 生成错误）：权威历史、Inspector、实际出站请求
（含其 `Times:` 列表与指令末尾的较早原文块）；Provider 请求 id 把 Inspector 的 command 与实际 payload 对上；生成错误只能由语义裁定产生，缺裁定为 `undetermined`。

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
新增正常 Conversation Action 不得修改 Harness loop、Provider Adapter、ActionProposal envelope、
GenerationCommand stages 或 Finalization。（#314 的受控只读历史查询不是 Conversation Action：它
按 ADR-0093/0094 修订显式新增了一个 Decision 结果与一个 History Answer stage；这不是 Action 扩展，
也不放宽该约束对 Action 的适用。）

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

显式 Memory Correction、Memory Forget Request 与 Memory Forget Reversal 是同轮
回复前的同步 Trust-Control 步骤。目标唯一时，必须先原子提交新的 ClaimVersion、
fence 与 terminal Receipt，再构建本轮 Memory query；retrieval 只能读取提交后的
current Claim 状态。Action 提交失败时不能声称控制已经生效，本轮三个 Memory section
全部 fail closed。目标仍有实质歧义时不改变 Claim，按规则澄清一次，并同样关闭本轮
Memory，避免在澄清回复中再次注入可能正被纠正或遗忘的内容。普通 Memory extraction、
consolidation 与 Profile rebuild 仍走异步路径，不阻塞当前回复。

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
2. Persona 稳定特征（结构化三块工件，见 15.6 与 ADR-0111）；
3. 当前 Daily Session 信息（含 Safety Posture 状态）；
4. 当前 Session 滚动摘要（1A.2+）；
5. 最近 committed raw Events（1A.1 起）；
6. 当前会话状态与语气（1A.2+），语义字段与确定性投影的拆分见下文；
7. Person Portrait：每轮按当前话题选择的“用户是怎样的人”选集（1A.3a+，ADR-0111）；
8. 相关 Objective Memory（1A.3a+）；
9. 少量相关且未过期的 AI Impression（1A.3a+）；
10. 必要的 Open Loop（1A.3b+）；
11. 实时客户端信号（1B）；
12. 输出格式，以及当前版本化 Conversation Action Catalog 中允许的高层 Action 定义。

Open Loop 只读取 current Version 为 open 且
`followup_eligible_from_at <= now < expires_at` 的少量
projection。当前 Turn 已有新提交的 User Event 时，selector 可以选出一个合适的
Open Loop，让 Assistant 在本轮主动询问进展，不要求 utterance 已先提到相同话题。
没有新 User Event 时，Open Loop 不得单独创建 GenerationCommand、消息或通知；
它也不能触发任务型输出。`now >= expires_at` 时立即 fail closed，不等待 scanner
物化 expired Version；其他关闭状态同样 fail closed。

Open Loop section 还要求 snapshot 前所有 final / corrected User Event 的 formation /
closure processing均已 settled，且不存在 pending source invalidation。watermark有 gap、
timeout 或 unresolved error 时整个 section 为空，不使用 stale cache；Conversation、Journal
与独立 Memory section继续。恢复后只从 authoritative Event / Version重算。

Person Portrait（1A.3a+，ADR-0111）是每轮重新选择的“用户是怎样的人”选集。版本化
selector 只接收适合长期影响理解与交流的 person-describing Predicate，例如性格特质、
理念价值观、交流偏好、长期角色与重要关系；敏感推断、临时情绪、一次性事件和短期
安排不进入 Portrait，只能在符合普通准入与相关性门槛时走 query retrieval。

selector 先比较与当前话题的相关性，再比较对理解用户的重要性、跨情境稳定性与
Evidence 强度。当前有效的 Objective Memory 与 active AI Impression 平等参与这些
排序，不设 Objective-first 规则；`kind + epistemic_status` 只决定召回措辞，不直接
决定名次。同级再以最新有效 Evidence 和 stable ID 打破平局。每条携带
`claim_version_id + evidence_id`，并逐条适用 Correction、Forget、contested 与
dormant fence。Bio 不进入对话 Context，只作为用户可见产物存在；没有合格或相关
条目时该 section 为空，不编造画像。

Person Portrait 不只是隐藏提示。当前 User Event 与 selected trait / value 明确呼应且
表达该观察能增加理解或共情时，Conversation Model 可以主动用自然、朋友式语言连接，
例如“这听上去就很像你，会更在意……”。AI Impression 不要求每次添加来源前缀或
仪式化 hedge；`kind + epistemic_status` 仍通过 recall projection 禁止把推断升级成
用户自述或已核验事实。无 Evidence 的全局人格判断、临时状态永久化、诊断式或敏感
身份标签仍被 behavior contract 拒绝。用户质疑时再进入 Source Explanation、
Correction 或 Forget，不在普通对话里强制展示认识论账本（ADR-0116）。

1A.3a 的 Memory 不合并为叙事段落。Context Compiler 使用三个独立 section key：

```text
person_portrait
objective_memory
ai_impression
```

三个 section 共享原子 `MemoryContextItem`：

```text
context_memory_ref                # CompiledContext-scoped opaque reference
rendered_text
claim_id
claim_version_id
kind
epistemic_status
temporal_status
valid_from
valid_to
entity_version_ids
evidence_ids
recall_framing_policy_version
selection_source                  # person_portrait / query_retrieval
```

Objective Memory 与 AI Impression 不能合并为同一 item 或一句叙事。Prompt 读取
`rendered_text + context_memory_ref + kind-specific framing`，不默认读取 Evidence
原文；稳定 Claim、Entity 与 Evidence ID 保存在 manifest。用户要求 Memory Source
Explanation 时，应用服务再按权限读取仍有效的 User Event Revision。

三个 section 按 `claim_version_id` 全局去重。同一 Claim 同时被 Person Portrait 与
query retrieval 选中时只保留在 `person_portrait`，retrieval manifest 仍记录 query
命中；它只占一次 memory-class 总预算。空 section 省略，不生成占位文本。

1A.1 只使用 DailySession / InteractionTurn 上的确定性领域状态，例如
`activity_state`、revision 和 closure policy；它不持久化或消费模型生成的
DialogueState projection。

从 1A.2 开始，当前会话状态按“谁能确定它”拆成两类（ADR-0111）。

模型异步生成、每个 field 必须带来源与置信度的语义字段
（`dialogue_state_versions`）：

```text
current_topic
emotional_intensity
advice_explicitly_requested
current_request_requires_focus
close_intent
user_willing_to_elaborate
```

`advice_explicitly_requested` 用于落实“默认倾听，只有用户主动询问才给建议”；
`current_request_requires_focus` 是由模型派生、由 Proactive Memory Follow-up 选择器
确定性消费的判据。`true` 拒绝选择；`false` 只通过这一道门。字段为 `null`、
未引用当前 User Event、版本落后或低于版本化置信门槛时，selector fail closed。
DialogueState 只用于当前 Session，不能直接晋升为长期 Profile。

确定性领域投影不经模型生成：Safety Posture（见 9.6）、
`proactive_followup_used_in_exchange`，以及 Curiosity Stop Signal 停止投影——
模型可以带证据提出“用户已回避 / 拒绝 / 转换某方向”，由确定性代码提交并记录
被停止的追问方向；解除服从版本化冷却、用户主动重提、新的实质直接 Evidence 或
target-specific permission。单方向停止可以跨 Session 持续；全量“别再问问题”停止按术语定义
限于当前 Continuous Exchange。

Proactive Memory Follow-up selector 不扫描全部 Memory。它合并两类候选：

- 全部当前 eligible OpenLoopVersion；
- 本轮 Person Portrait 或 query retrieval 已选入、或已明确命中且通过全部
  trust fence 的 current ClaimVersion，按 logical Claim 去重。

裸问候没有 Memory 信号时，Memory 候选可以为空，selector 不为表现连续性另建全量
扫描。两条候选 lane 都必须提供完整、当前 watermark；任一启用 lane 超时、失败或无法证明完整时，
整个 selector 返回零 target。不改用另一条 lane，也不复用上一轮候选或缓存。它在 1A.3b+ 必须
fail closed：

1. 当前 Turn 必须有新 User Event，且同一
   `daily_session_id + continuous_exchange_no` 尚未提交 Proactive Follow-up；
2. 实质性当前话题、明确直接任务、紧急或高风险状态时不选；
   `current_request_requires_focus=true`、`null`、未绑定当前 User Event、版本落后或低于
   policy confidence 时同样不选；
3. target 必须是 active / open、已经到达 `followup_eligible_from_at`、未过期、
   非 contested、非 dormant、未被 Forget；没有 `ProactiveFollowupState` row 时按
   `never_suppressed` 通过此门，有 row 时 current ProactiveFollowupStateVersion 必须在
   read-time 冷却解释后为 eligible；
4. 问候、开放式开场或自然空档可以选出零或一个 target；没有合适 target 时不为
   满足配额强行生成；
5. 用户已在当前 Continuous Exchange 主动提到的 target 不参与；当前 User Event 新形成的
   Open Loop 最早从后续 Turn 参与；
6. Generator 必须先回应当前 User Event，再以一个自然问题或不带问题的关心表达
   使用 target。两种都消耗本段交流唯一一次使用额度；问句与普通 Follow-up Question 共享
   每轮一个问题的硬上限，主回应已有普通追问时本轮不得附加关心陈述；
7. 用户简短带过、回避、拒绝或转换话题后，按 `proactive-followup-suppression:v1` 提交
   suppressed state。未达硬停止上限的 `topic_changed / short_response / evaded` 可在各自冷却边界后
   重新参与选择；`refused`、`ambiguous_closure` 与达到上限的软停止不随时间解除；
8. 敏感 target 必须有 direct User Evidence，并生成简短、允许不回答的 framing。

`proactive-followup-selection:v1` 不使用模型生成的 salience 分数或加权总分。全部候选先按
敏感性分为非敏感、敏感两层，只有前一层为空时才读后一层：

- 问候 / 开放式开场：Open Loop 优先于 Memory Claim。Open Loop 按有时间锚点优先、
  `expected_start_at ASC NULLS LAST`、`expires_at ASC`、source Evidence time、stable ID 排序；
  没有 Open Loop 时按 Claim 在本轮 Person Portrait / retrieval 的 source rank 排序；
- 自然空档：Memory Claim 优先于 Open Loop。Claim 直接复用当前 Person Portrait 的话题
  相关性、理解价值、跨情境稳定性、Evidence 强度字典序，或 query retrieval 的 final rank；
  没有 Claim 时按上述 Open Loop 顺序选择。

两套 profile 的同层候选再按从未提交 use 优先、最久未 use、source Evidence time、stable
ID 排序。这些字段、顺序与方向均由 selection policy version 冻结；后续调整创建新版本，
不重解释旧 CompiledContext。

Conversation Decision 的主 CompiledContext 不含 proactive target。其主回应与当前 User Event 的
DialogueState projection 并发进行；主回应完成时只检查一次已经提交的 current-Event state，不额外等待。
缺失、`null`、低于 confidence、source / version 不匹配或尚未就绪时，本轮以
`state_not_ready_at_main_completion` 返回零 target。

状态就绪、全部门禁通过且主回应没有普通问题时，selector 用 CAS 创建唯一 Command-scoped
reservation，唯一范围是 `(user_id, daily_session_id, continuous_exchange_no)`。并发 loser 以零 target
结束选择。reservation 不是 use，不改变 ProactiveFollowupStateVersion，也不使用可被另一 live
Command 抢占的时间租约。只有持有它的 Proactive Follow-up Segment Command 进入 terminal state，
或 reconciler 证明该 Command 已废弃时才释放。

selector 随后创建一个只供 Proactive Follow-up Segment Command 使用的窄 CompiledContext。它冻结
主回应 result / HMAC、current DialogueStateVersion、target Version、reservation、epistemic kind、
sensitive framing 与 policy bundle；该 Command 强制 tools disabled，只能生成隔离片段，不能改写
主回应。片段失败、过期或重验失败时只提交主回应。成功时服务端把两者合成一个 Complete Assistant
Response；Assistant Event lineage 同时引用 main Decision Command 和 Segment Command，typed use 只引用
Segment Command。Retry 创建新的 Decision Command，并重新取得 state、selection、reservation 与 segment。

### 9.1.1 近期对话背景

> 本节保留七天背景首版的技术范围。新增历史回顾目标及模型回答验收见 §9.1.2 与
> [ADR-0152](../adr/0152-continuity-requires-history-recall-and-response-acceptance.md)，
> 不再将下述“首版不追加正式人评”推广到新连续记忆能力。

首版技术与验收路线见 [ADR-0150](../adr/0150-recent-context-ships-after-deterministic-validation.md)：
在现有来源读取与 Context Compiler 内直接编译原文，不增加模型摘要流水线或自主
历史查询循环；新增路径可单独关闭，读取失败/超时放弃本轮新增背景。上线前验证
真实跨日冻结与出站围栏，不追加正式人评，体验在上线后正常聊天中验收。

[#287](https://github.com/lukemyself-hub/SayHear/issues/287) 与
[ADR-0149](../adr/0149-recent-conversation-context-is-bounded-source-history.md) 已确认
以下设计合同，实现与发布证据见[七天背景 SPEC](https://github.com/lukemyself-hub/SayHear/issues/292)
最新记录。本节补充 §9.1 的跨 Session 来源
输入；它是 Context 中的来源投影，不新增长期 Memory、模型摘要或 Framework 真源。

- 每轮自动读取最近 7 个用户本地日内的有界原文，包含今天和此前 6 天，空日不补足。
  当前 Session 输入仍走既有路径，不迁移 Daily Session 或 Journal，不重复注入同一
  revision。表达时间与经历时间分别保留，不能从 Session 归属推导经历日期。
- 事实只由有效 final / corrected User revision 支持。必要的相邻 Assistant 文本按
  交流顺序与角色带入，只帮助理解用户表达；完整提交与中断排除规则继续适用。
- 原文路径不等待 Claim、Episode、Reflection 或抽取结果；不扩大 Registry，不复活
  rejected Candidate，不把进入背景当作长期 Memory 准入。
- 复用既有 Correction / Forget 记录、Claim / Evidence 与 source revision 关系。
  明确关联到受控内容的旧消息整条不选入，不建立片段级治理、语义匹配或新的来源级
  Trust Action。无法明确关联的旧表达不保证全部排除；整条排除可能连带丢失无关内容。
  不从旧 Assistant 文本补回被排除的用户事实，普通重提不解除既有 Forget。
- 近期 User 与必要 Assistant 文本共用该背景预算。当前输入与今天的对话优先，
  历史尽量分日覆盖，再把剩余预算分配给近期；不保证每日或所有经历均有代表。
  具体总额、分配、单次读取上限与超长消息处置由后续实现 SPEC 确定，不静默生成摘要。
- 源读取、冻结引用与 Provider Egress 继续执行 owner、有效 revision、epoch、删除
  和用户控制检查，不允许新增背景绕过既有边界。Inspector 记录选中来源、日期、
  预算、遗漏及排除或读取失败原因，遵守既有权限与快照保留规则，不新增明文历史副本。
- 读取失败可降级为只依据当前有效输入回应，不复用未经重验的旧背景、不编造连续性。
  用户可见语言遵循 [§15.3.1](../product/15-conversation-behavior.md#1531-近期对话背景)，
  不把内部 degraded reason 直接作为聊天文案。

### 9.1.2 连续记忆的时间、来源与交付约束

[体验 SPEC](https://github.com/lukemyself-hub/SayHear/issues/301)已确认；以下是候选实现
必须满足的技术不变量，具体运行阶段、检索机制与框架由
[路线决议](https://github.com/lukemyself-hub/SayHear/issues/306#issuecomment-6093970042)已确定
首轮验证方向，尚未实现。先独立修复时间输入、验证并部署生产，线上验收完成后才
验证满足完整 SPEC 的组件复用与自建路线；比较全能力及生命周期成本，不能以现状缺少检索作为框架优势证据。最新方向暂不考虑 embedding，先使用常规检索，延续 ADR-0115。最终框架采用仍须效果及整体维护成本证据。当前研究任务止于路线决策，只在必要时做局部原型；路线确认后另行开发集成，再正式验收产品体验。

**时间信息必须到达实际模型输入。** 历史表达时间、原表达的时区语境与本轮当前日期/
时区锚点不能只保存在 Context 引用或 Inspector。日期标签应与实际来源绑定，在最终
Provider Adapter 序列化之后仍可验证。经历时间只能来自支持它的内容或证据；未知保持
未知，不以 event.created_at、Session 日期或当前时间代替。原话“昨天”不得随着读取
日期移动。按消息时间回顾不改变 Session/Journal 的归属。

**默认背景、相关接续和明确回顾具有不同覆盖要求。** 七天有界背景仍可遗漏内容；
明确日期回顾须能覆盖该范围主要话题，不能直接用固定 top-k 或默认背景冒充完整结果。
较早普通经历不以 Claim/Reflection 成功为前提。来源范围、截断和失败状态必须足以
区分部分结果与经核实的无记录；“首次”结论须有相应范围证据。是否采用分页、摘要、
语义索引或工具调用由研究决定，不在本合同预选。

**来源及用户控制一致。** 用户表达、必要 Assistant 上下文与 AI 推断不能混作事实。
任何新摘要、索引、缓存或框架状态若保存私人内容，须有来源 lineage、有效性与 Purge
合同。查找、模型出站、结果提交和续答都遵循适用的 owner/revision/epoch、删除与既有
明确关联来源排除；不复活被禁止使用的来源，也不扩大普通经历 Forget 的语义。
此前同 Session 原文与当前输入的既有处理范围不因本合同被静默改写。

**可选两段式回应受最新用户意图约束。** 第一段只依赖当时有效输入，不预判尚未确认
的历史；补充原问题可影响后续回答，换题/取消阻止旧请求迟到续答。实现须证明有界等待、
重复请求去重、取消竞态、进程恢复和已展示内容的保存规则。是否分别提交 Event、怎样
冻结补充输入与阶段，必须先修订适用的 ADR-0093/0094 契约；不能用 technical retry
隐藏新阶段，也不能挪用已退役的 Proactive Follow-up 自动获得授权。

**诊断与聊天表达分离。** Inspector/研究证据应可区分来源不存在、查找范围不足、
选择遗漏、时间投影丢失与模型生成错误，不新增默认私人正文日志。聊天只呈现自然
回答和适当的不确定性；数据路径成功不等于体验验收成功。实际模型场景门槛见
[行为评测规则](../evaluation/01-behavior-contract-and-rubric.md)。

**实现状态（issue #319）。** 整体请求预算 `SAYHEAR_CONVERSATION_REQUEST_BUDGET_MS`（默认且最大 30 000）与对话
Provider 超时 `SAYHEAR_CONVERSATION_PROVIDER_TIMEOUT_MS` 已与后台角色共用的 `SAYHEAR_PROVIDER_TIMEOUT_MS`
分开，只能收紧不能放宽；截止由受理时冻结在命令上的绝对时刻保证（见 ADR-0083 修订），BFF 在预算后另设兜底。
Portal 在回答准备期间允许继续输入（取代旧回答）或停止，客户端 32 秒后自行停止等待。以上由确定性桩与
真实 BFF/HTTP 边界证明；**实际模型下的 3/10/30 秒表现仍由 T08 复验**，本节不构成时延证据。

**首轮采用单段交付并限制整体等待。** 先取得允许历史，再自然回答，暂缓两段式阶段。
从应用接受输入到可见首个有意义回应不超过3秒，完整回答不超过10秒，整体请求30秒
停止，涵盖查找、排队、生成与传输，不按步骤重置。占位内容不算有意义回应；取消后
迟到结果不能展示或提交。超过门槛须定位原因再讨论方案，不能自行放宽要求。
这些是已确认验收要求，尚不构成当前实现或生产时延证据。

这些约束不要求每轮发送全部历史，不预设增加模型调用，也不限制研究只能保留现有
框架。若候选需要改变长期状态所有权，应显式论证并修订 ADR-0068，不能先产生双重真源。

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
proactive_followup_policy_bundle_version
proactive_followup_selection_policy_version
proactive_followup_selection_manifest
proactive_followup_reservation_id
content_hmac
created_at
```

这些 proactive 字段只存在于 Segment Command 的窄 CompiledContext；Conversation Decision 的主
CompiledContext 中为 null / omitted。`proactive_followup_state_version_id` 可以为 null，此时 manifest
必须记录 `never_suppressed`，不得为此预建 eligible state row。

Segment Generator 使用独立的 `proactive.followup` role，不继承
`conversation.text` 的 Prompt、Schema、model config 或失败语义。它的结构化结果是一个
与主回应分离的 `proactive_followup_segment`：

```text
target_ref
expression_kind                    # question / acknowledgment
content
```

Selector 只选 target，不决定 `expression_kind`。Segment Generator 在版本化 Prompt / Policy 下
选择形式：Open Loop 通常使用简短问题；Memory Claim 默认使用 acknowledgment，只有 Evidence
支持一个具体、自然可回答的新进展时才使用问句。AI Impression 不得虚构“最近又发生”的
相似事件来构造问题。运行时不设问句占比或机械轮换；两种形式都必须在实现验收场景出现，
并由轨迹指标与 Internal Owner 盲评决定是否调整 policy。

主回应可以正常流式展示，但不得主动提及未进入普通对话的 target；segment 在生成期间不展示。
服务端组合最终正文并生成 content locator 前，重验 reservation owner、target current Version、expiry、
trust fence、问题上限与敏感 framing。验证失败时不展示 segment，主回应仍可完成。验证成功后，
在一个事务中写入 Assistant Event revision、typed use
与 exchange usage marker。没有这个原子提交就没有使用；流式 token、interrupted response、
failed / result-unknown Attempt 和模型自报都不消耗额度。Retry 必须新建 Command、重新编译与选择。
`proactive.followup` 自身不执行技术 retry；segment 失败、超时或过期时直接省略，
用户只在显式 Retry 当前 Turn 时才进入新的 Decision Command 和新的选择。

selection manifest 或 reservation 未能权威提交时，本轮 selector 为零。Inspector 自身读取或展示失败不阻塞
对话，但必须产生不含用户正文的运维告警。suppression / release 提交失败时，受影响 target 保持
fail closed；只有 response disposition 未 settled 时封锁该单个 target，不封锁其他 target。

提交 use 后，用户的下一个 User Event 必须得到唯一 response disposition。模型只能以该 Event
的 locator 提议 `short_response / evaded / refused / topic_changed`；确定性代码重验 owner、Event 顺序、
use 和 target Version 后才能提交 suppression。简短但完整的回答仍属于 `short_response`；用户未接
该表达而继续其他内容属于 `topic_changed`。分类缺失、冲突或处理中时，该 target 临时
fail closed，直到唯一 disposition 提交；不伪造 suppression reason，也不允许继续主动提及。

1A.3a 的 `retrieval_manifest` 至少包含：

```text
retrieval_run_id
retrieval_policy_version
query_construction_policy_version
projection_policy_version
query_sources[]                    # source kind + revision refs
normalized_query_terms[]
candidates[]                       # Claim / projection refs only
  retrieval_lane
  matched_fields
  matched_terms
  trust_fence_results
  rank_components
  final_rank
  selected_section
  selection_reason_codes
  rejection_reason_codes
section_budget_vs_actual
timings
degraded_reasons[]
```

Manifest 不复制 User Event、Evidence quote 或完整 retrieval text；它保存稳定引用、
结构化 reason code、必要 keyed HMAC 与非正文指标，并随 CompiledContext lineage、
retention 和删除传播处理。

1A.3b 的 `proactive_followup_selection_manifest` 至少包含：

```text
policy_bundle_version
opportunity_policy_version
selection_policy_version
suppression_policy_version
use_schema_version
expression_prompt_version
expression_policy_version
reason_code_schema_version
opportunity_mode
current_request_requires_focus       # value + confidence + source revision + freshness
opportunity_gate_results[]
lane_watermarks[]                     # lane + source revision + completeness + timing + degraded reason
candidates[]
  target_kind
  target_id
  target_version_id
  sensitivity
  source_lane
  source_rank
  trust_fence_results[]
  mentioned_in_exchange
  formed_from_current_event
  suppression_reason
  proactive_followup_state_version_id
  eligibility_reason                 # never_suppressed / eligible / suppressed
  consecutive_soft_suppression_count
  suppressed_until_at
  last_use_at
  rank_tuple
  selection_reason_codes[]
  rejection_reason_codes[]
selected_target_ref
stable_tie_break
reservation_id
reservation_status
```

Inspector 还要把 selection manifest 与后续的 expression kind / locator、pre-display revalidation、committed
Assistant Event / use、response disposition proposal / result 和 release reason 连成同一条轨迹。Manifest 只保存
引用、枚举、时间、数值、版本和必要 keyed HMAC；Evidence 正文继续通过已有的受权限 source
展开路径读取。

`proactive-followup-policy-bundle:v1` 引用 opportunity、selection、suppression、use schema、
expression Prompt / Policy 与 reason-code schema 的精确版本。组件变化只升级该组件，但必须同时发布
新 bundle；CompiledContext、reservation、use 与 disposition 都冻结 bundle 及所用组件。旧记录不重算。
Internal Core 直接切换整套 bundle，不 dual-write、Shadow selector 或做运行时 A/B；首次上线前无可回退
的旧 selector，因此回滚使用 deployment rollback，不新增长期 feature flag。

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

Internal Portal 提供只读 Context Inspector（照 Reflection Inspector 模式，
ADR-0111）：展示每轮 CompiledContext 的分节内容、预算与实际占用、degraded
reason、检索候选及选中 / 淘汰理由、DialogueState 各字段的证据与置信度、
Person Portrait 条目及 claim 版本、Safety Posture 当前状态与干净 turn 计数。
它不是第二写入口，也不出现在用户界面。

1A.3a 扩展 Inspector，逐条展示三个 Memory section、`context_memory_ref`、Claim /
Entity / Evidence version、query source、lane、matched fields / terms、trust fence、
rank components、selection / rejection reason、预算与 timing。Evidence 原文只通过
既有受权限控制的 source 展开路径读取，Inspector manifest 本身不保存副本。

1A.3b 继续展示 Proactive Follow-up 的 opportunity mode / gates、DialogueState freshness、lane
watermark、全部候选与完整 rank tuple、suppression 计数 / 冷却、reservation、选中 / 淘汰 reason、
expression / locator / pre-display 重验、committed use、response disposition 与 release。该页只读，
失败只告警，不作为另一个 selector 或状态写入口。

### 9.3 Token Budget

每层有独立预算和截断策略：

- 产品与安全边界不可被动态内容挤出；
- 1A.1 按 sequence 从新到旧选择预算内的 committed raw Events；超出预算时在
  CompiledContext 记录 `raw_event_budget_exceeded`，不静默生成临时摘要；
- 从 1A.2 开始，最近原始 turn 优先于陈旧摘要；
- Objective Memory 与 active AI Impression 按各自 selector 排序，并始终使用不同的
  epistemic framing；kind 本身不覆盖相关性、长期重要性、稳定性或 Evidence 门槛；
- Entity label 按当前 locale 投影，但 Context manifest 保留稳定 `entity_id`；
- 人物卡片由 Entity、选中的 Relationship ClaimVersion 与 localized projection
  在 Context Compiler 中合并渲染；Relationship Resolver Hint 只用于候选解析，
  不能作为事实注入 Context；
- 人物卡片只使用有有效 User Evidence 的 active Relationship Qualifier；Qualifier
  contested / retracted 时停止具体角色称呼。底层关系仍有效且 Registry 提供中性
  fallback 时降级为“家长 / 孩子”“手足”“伴侣”等中性投影；
- 注入 Claim 时保留 `claim_version_id + evidence_id`，不能只发送无来源的自然语言 Memory；
- 检索结果按相关性、置信度、时效和重复度裁剪；
- 不把完整历史持续发送给模型；
- 记忆类注入使用版本化预算 v1（ADR-0111）：Person Portrait ≤3 条（其中 AI
  Impression ≤2）、按话题检索注入 ≤2 条、每轮记忆类总注入 ≤5 条，raw Events
  预算 4000 tokens；具体数值由 retrieval manifest 的实际命中与浪费调整；
- Person Portrait 无合格条目时静默省略该 section，不编造；
- persona / locale pack 版本解析失败时编译 fail closed：身份层不允许缺席上线。

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

### 9.6 Safety Posture 生命周期

Safety Posture（ADR-0112）是 DailySession 上的确定性让位状态，不由模型生成或
解除：

- 激活：版本化检测规则识别到明确自伤、伤人或迫在眉睫的危险信号；
- 存活：当天内跨 Continuous Exchange 存活、不过夜；次日新 Session 从默认状态
  开始，新的危险信号随时重新激活；
- 解除：连续 K 个用户 turn 未再出现危险信号即自动解除；K 是版本化参数，当前为
  2。用户明确表示安全计为一个干净 turn，不单独立即解除；再次出现的危险信号
  重置计数；
- 生效：激活期间 Context Compiler 直接渲染缩减版 persona 变体（收起 Playful
  Warmth、普通 Selective Curiosity、外放自我情绪与非必要观点，保留温暖与
  直接感），并保持现实支持锚点与白名单号码，不依赖模型自觉；
- 故障：检测器故障时不激活新姿态、已激活姿态保持并告警；风险行为由 prompt 层
  Minimum High-Risk Response 兜底；
- 它不是 DialogueState 字段，也不是跨日危机跟踪状态。

## 10. 检索与记忆召回

### 10.1 初期检索

1A.3a 使用 PostgreSQL `Structured-Lexical Retrieval Baseline`（ADR-0115）：

- 最近 turns；
- Daily Session summary（1A.2+）；
- 第一优先级：stable Entity ID、Claim canonical key、Predicate、typed value、时间范围
  与 Claim kind 的 structured exact matching；
- 第二优先级：projection policy 生成的 `lexical_terms text[]` 与 query terms 的
  GIN overlap，覆盖中文、英文和 code-switching；
- 第三优先级：`pg_catalog.english` generated `tsvector` + GIN，通过
  `plainto_tsquery` 处理英文词形变化；
- localized Entity label / verified alias；
- validated Relationship Resolver Hint；
- localized Claim retrieval projection 的 lexical query。

初期不激活 Embedding Champion、不安装 pgvector、不创建 vector column，也不实现
生产 Embedding adapter。retrieval manifest、版本化预算、逐条 trust fence 与
Context Inspector 仍完整记录 baseline 的命中、淘汰、漏召回和错误召回。只有
ADR-0115 的证据条件满足后才增加 semantic vector 路径。

初期不启用 `pg_trgm`。它只作为未来 alias typo tolerance 的候选，必须先验证生产
PostgreSQL version、locale、extension availability 与 fixture-calibrated threshold；
任何模糊匹配都不能绕过 Entity / Claim trust fence。

### 10.2 查询构建

1A.3a 不增加 pre-retrieval LLM。Context Compiler 从已提交、可验证的当前输入与
投影确定性构建多路 query：

- 当前 final / corrected User Event 的文本；
- 当前 Continuous Exchange 中最近两个 final / corrected User Event，用于保留代词、
  省略表达和紧邻话题；
- 上述 User Event 中可以通过 Self Entity、stable Entity ID、当前 label、已验证 alias
  或 Relationship Resolver Hint 唯一解析的 Entity；
- 最新 source-valid DialogueState 的 `current_topic`；State 落后、失败或 evidence
  已失效时不使用该字段；
- 用户明确表达的日期、时间范围与“以前 / 最近 / 上次”等时间词；
- 当前 Predicate Registry version 已发布的 lexical alias。

Assistant Event 不能作为用户生活事实的 query source，避免模型自己的旧回答反向
强化 Recall。1A.3a 尚未交付 Episode 与 Open Loop，它们不进入初始 query source；
1A.3b 只能在各自 current Version 仍有效且通过主动使用 policy 时再增加对应输入。

各路 query 单独记录 source kind 与 source revision，结果按 `claim_version_id` 去重并
rerank。没有足够 query signal 时返回零条 query-retrieved Memory；Person Portrait
仍按独立的 topic-aware 版本化选择策略编译。retrieval manifest 必须区分 query
construction 无信号、候选为空与候选被 precision fence 全部淘汰，不能把三者都
记录成普通 miss。

三条 baseline retrieval lane 不归一化成一个跨 lane 总分。排序先按
`structured_exact > lexical_term_overlap > english_fts`；English FTS 的
`ts_rank_cd` 只在本 lane 内排序，不能越过更可靠的 structured / exact lexical
结果。所有 lane 在排序前都重新检查 current Version、Evidence、Entity、Correction、
Forget、contested、dormant 与删除 fence。

本轮 query plan 先确定需要执行的 lane。未被 query plan 启用的 lane 不参与健康判断；
lane 正常执行但返回零条候选属于有效空结果，不是故障。只要任一已启用 lane 报错或
超时，整个 retrieval run 标记为 degraded，本轮三个 Memory section 全部 fail closed，
不能使用其他 lane 的部分结果。

1A.3a 使用版本化的 200ms 共享 retrieval deadline，覆盖 query construction、全部
已启用 lane、去重、排序和 trust fence，不给每条 lane 单独重新计时。request path
内不重试；deadline 到期立即按整轮 Memory fail closed 继续生成回复，并记录
`retrieval_deadline_exceeded`、实际耗时与触发阶段。后续可以根据生产 P95 调整版本化
数值，但不能改成无界等待。

### 10.3 精度策略

错误召回比漏召回更伤害信任，因此：

- 高 precision 优先；
- 1A.3a 不调用 LLM、cross-encoder 或 RRF reranker。先执行全部 trust fence，再按
  `structured_exact > lexical_term_overlap > english_fts` 分 lane 确定性排序；
- lane 内排序依次比较 Entity match、Predicate match、temporal fit、lexical
  coverage、Objective / Impression trust kind、recency tie-break 与 stable ID；
  recency 只在其他条件相同时打破平局，不能覆盖旧事实或降低 Objective Memory
  confidence；
- canonical key 精确命中，或 Entity + Predicate 同时命中，可以通过相关性门槛；
  唯一且已解析的 Entity alias 可以形成 structured anchor；只有普通 lexical term
  时至少命中两个独立 term，只匹配宽泛 topic、情绪词或常见单词时拒绝；
- AI Impression 至少需要 Entity、Predicate、时间或多个 lexical term 中的两个
  独立相关信号，每轮 query-retrieved Memory 最多选择一条 Impression；
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
- 检索失败时自然继续对话，但本轮 Memory fail closed：`person_portrait`、
  `objective_memory` 与 `ai_impression` 都不注入，也不复用上一轮 CompiledContext
  的 Memory 缓存；任一已启用 retrieval lane 报错或超时即视为整轮失败，正常空结果
  与未启用 lane 除外；Inspector、retrieval manifest 与内部告警照常记录故障。只有
  线上故障与体验数据证明“受限缓存复用”的收益大于额外复杂度后，才用新 ADR
  重新讨论。

query-retrieved Memory 沿用 ADR-0111 的每轮两条上限，但这是 ceiling，不是 quota。
只有一条合格就注入一条，没有合格项就注入零条，不能降低门槛填满预算。retrieval
manifest 为每个候选保存 lane、命中字段、排序字段、最终名次，以及 trust fence、
相关性门槛和预算的 selection / rejection reason。

1A.3a 首版不设 Shadow Mode。通过全部准入、相关性和 trust fence 的 selected Memory
直接进入 CompiledContext；Inspector 展示实际注入的 item 及同一 retrieval run 的
候选、选择和拒绝原因。runtime 不维护“已选择但未注入”的第二套 rollout 状态。

### 10.4 后续向量版本

以下是证据触发 Embedding 后必须遵守的合同，不属于初始 1A.3a 实现范围。

每个 Embedding 保存：

```text
provider
model
dimension
embedding_policy_version
source_type                 # claim_retrieval_projection
source_id                   # claim_retrieval_projection_id
source_version_id           # claim_version_id
created_at
```

Embedding 只读取当前可召回 ClaimVersion 的 `claim_retrieval_projection`，不读取
MemoryCandidate、Evidence 原文、Journal、Reflection、Profile 或 Person Portrait。
每个支持的 locale 分别生成 projection；Relationship Claim 可以生成多个观察方向，
但候选最终按 `claim_version_id` 去重。Evidence ID 只保留在 retrieval metadata 中，
不把底层 User Event 正文复制进 embedding 输入。

Embedding 必须能从 PostgreSQL 中的当前有效 Version 重建；旧 Version 被 supersede、
contested、retract、dormant、Forget 或 purge 后，查询路径立即通过 current-Version
与 eligibility fence 排除旧向量，物理删除或重建可以异步完成。Provider、model、
dimension 或 projection policy 变化时发布新的 `embedding_policy_version` 并全量
重建；不同 policy version 的向量不能混合检索。

## References

- [原始 核心架构 v0.1 快照](../archive/architecture/sayhear-core-agent-architecture-v0.1.md)
- [Conversation 数据模型](07-01-06-conversation-data-model.md)
- [Provider 与本地化](15-16-providers-and-localization.md)

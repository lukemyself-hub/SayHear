---
status: accepted
date: 2026-07-27
---

# Conversation Runtime Uses a Replaceable Bounded Agent Harness

SayHear 在应用层定义 `Conversation Agent Harness` 这一深 Module，负责围绕一个冻结的
InteractionTurn 组织 Context、模型判断、高层 Function Calling、Conversation Action
receipt 与最终回复。它弥合开放式自然语言输入与有限、typed 产品能力，但不拥有
Conversation、Memory、Journal、Profile、Entity、权限或删除状态，也不取代任何领域
状态机。

初始实现沿用 SayHear 自有 Provider Port 与 Adapter，不因此引入 Pi、Mastra 或其他
通用 Agent Framework。当前 Conversation Harness Policy 最多允许一次改变状态的
Conversation Action：模型先返回普通回复或一个 Action proposal；Action Gateway
确定性验证并执行后，Harness 最多再调用模型一次，关闭工具并只依据已提交 receipt
生成最终回复。技术重试仍服从 GenerationCommand、ModelRunAttempt 与可见输出规则，
不形成自主工具链。

1A.3b 对非 Action、非直接任务的普通回复增加一个更窄的例外：主回应完成时，若当前
Event 的 DialogueState 已就绪且 Proactive Memory Follow-up 门禁选中 target，Harness
可以创建一个 tools-disabled 的 Proactive Follow-up Segment Command。它只渲染隔离片段，
不能改写主回应、调用工具或触发状态型 Action；片段失败时主回应照常完成。因此它不扩大
“最多一次改变状态的 Conversation Action”，也不改变 Action Finalization 路径。

Harness 的 Interface 由 SayHear application layer 拥有。调用方只提交冻结的
InteractionTurn、GenerationCommand 与 CompiledContext reference，并接收可展示的
最终回复 stream 和 terminal result reference；Provider message、原始 tool-call
对象、Framework session、内部 Action step 与领域 repository 不得越过这个 seam。
Conversation Model Port、Provider Adapter、Action Gateway 与持久化细节是 Module
内部依赖，不由 API handler 或客户端拼装。

初始自有实现与 deterministic test / Replay Adapter 共同服从一套 Interface
conformance suite。未来只有在多轮 Agent Task、多 Provider tool protocol、
Realtime interruption / resume、外部 approval / MCP、compaction 或观测成本形成
真实需求，并通过 Replay 证明收益时，才评估 Framework-backed Adapter。替换不得改变
Conversation Action、receipt、Evidence、幂等、删除 fencing 或长期状态所有权，也
不得要求领域层引用 Framework 类型。

该决定保留未来 Framework 选择权，但不以提前引入依赖、通用 Session store、内部 CRUD
工具箱或多层 pass-through wrapper 购买“扩展性”。扩展通过稳定 Interface、版本化
Harness Policy、Adapter conformance 与领域不变量测试实现。

## 修订（2026-10，issue #314，ADR-0151）：受控只读历史查询是第三种互斥结果

- Decision 的结果现在是三选一且互斥：普通 Final Response、恰好一个 Conversation Action
  Proposal、或恰好一个**受控只读历史查询提案**。查询提案不是 Conversation Action：它不进
  Catalog、不经 Action Gateway、不占用也不扩大“最多一次改变状态的 Action”，不写任何领域
  状态。提案只描述查询意图、时间依据（`expressed_date`，消息何时写下）与来源范围
  （`conversation_text`）及本地日期范围；不接受模型 SQL、owner、对象权限、游标或第二次查询。
  本轮最多一次查询计划，不形成自主工具循环。
- 互斥由 Harness 确定性执行，不靠提示词：回复文本与提案、提案与提案、提案与 tools-disabled
  都互斥（fail closed 为 `invalid_response`）。**ADR-0092 的 Trust-Control 优先由此首次获得
  确定性保证**：同一 Decision 中出现 Trust Action 提案与历史查询提案时，无论顺序，Trust Action
  胜出，历史查询提案被丢弃且不执行（只记录内容无关的 `trust_control_priority` 通知），因此历史查询
  不会暴露刚要求忘记的内容，也不会产生第二次状态 Action。
- 提案只在 Harness Policy `conversation-harness:v4`（`maxHistoryQueries: 1`）、存在请求 revision
  （Retry 与恢复路径没有，故退化为普通回复）且运行时开关 `SAYHEAR_HISTORY_RECALL_ENABLED=true`
  时提供给模型；默认关闭。回滚重新 pin `conversation-harness:v3`。
- 确定性代码解析日期与时区（请求时区优先，其次 Session 起始时区）、核验当前输入 revision、owner
  与 Data Epoch，再通过有界原文查询服务读取；读取、资格检查与覆盖统计见 architecture 08-10 §8.4.2。
- 仍然遵守：ADR-0068（Provider session 不是记忆）、0077、0083（freshness 仍为 `source_valid:v1`，
  本票不引入新的 freshness 语义）、0111、0131、0149。
- 退役注记：本文上方所述 Proactive Follow-up Segment 例外已被 ADR-0141 随 G2 退役，运行时拒绝
  相关开关，应用层 `GenerationCommandStage` 不含它；它**不是**新阶段的前身或借用对象。


## 修订（2026-10，issue #315，ADR-0151）：历史查询提案增加“经历时间”基准，计划按时间块覆盖

- 提案的 `time_basis` 增加 `experienced_date`（经历何时发生）。这不是新的信任边界：经历时间没有有来源的存储，
  所以此类查询读取“说过的话”作为线索，结果恒为 `partial`，不得宣称完整或“没发生”。表达日期与经历日期的
  回答不混用。
- 日期范围上限、读取页数/行数/token 预算与时间块覆盖选取随 `history-recall` 策略版本化（#315 引入时为 `history-recall:v2`，
  此后随 #316–#318 递增，当前代码为 `history-recall:v4`，即 `HISTORY_RECALL_POLICY_VERSION`；architecture 08-10
  §8.4.3）。仍是一次只读查询、不进 Catalog、不扩大 Action；细节追问重新调用同一函数，不依赖助手上一轮摘要。
- 读取范围包含当前 Daily Session 中属于该范围的消息（跨午夜会话），仅排除请求本身，编译时按 revision 去重。

## 修订（2026-10，issue #320，ADR-0151）：历史分支有独立的版本化关闭与运行中停止规则

- 历史分支（受控只读历史查询与 History Answer）除部署开关 `SAYHEAR_HISTORY_RECALL_ENABLED` 外，增加与近期背景治理（ADR-0149 / #295）
  同模式的独立治理：全局、无 `user_id`、无内容的 `history_recall_policies`，最多一个 active 版本；关闭 = 撤销该行，重新启用 =
  新插入一个版本，已撤销版本永不复活。两个开关互相独立：关闭历史分支不触碰七天背景，反之亦然。
- 停止规则：Decision 在无 active 治理时不提供历史函数（回复退化为普通回复，不声称查过历史）；已发出的提案在受理冻结时被拒；History
  Answer 冻结在某一治理版本下，该版本被撤销后，发送前、首个可见 token 前、Provider 结果落定与提交四处围栏都拒绝它（行锁，与撤销串行化）。
  **已经展示给用户的文字无法撤回**：它不会被提交为 Assistant Event，Turn 记为 `interrupted`，由用户显式 Retry；Retry 无历史函数，按普通回复处理。
- 关闭或重开不改写既有 Context、引用与结果；失效来源由来源状态（Correction/Forget/Purge）决定，不由开关决定。
- 同一变更把“首个可见 token 前”并入围栏：来源引用、Data Epoch、治理在展示前再核对一次。
- 这不改变 ADR-0149 的排除范围：只排除与既有 Correction/Forget 明确关联的整条消息及其绑定的 Assistant 回复，不做语义匹配，
  不为用户自己此后对旧说法的不相关复述另设排除。

## 修订（2026-10，SPEC #301 评审）：遗留命令的结算与排空，以及关闭后普通回复的已知缺口

- **已知缺口：关闭后的普通回复没有确定性的诚实约束**。历史分支关闭、未部署，或 Retry 退化为普通回复时，模型只看得到当前对话与
  有界的近期背景，没有查询回执；目前没有任何确定性手段阻止它据此断言“没聊过”或暗示查过。无法确定性识别“这是一个历史问题但函数不可用”，
  而给所有普通回合统一加一句诚实指令会在分支关闭时也改变全部普通聊天，违背“关闭后保留现有普通聊天与七天背景”和独立关闭/回滚语义，
  且没有真实模型证据，所以**没有采用**（该做法实现过并已撤回）。普通聊天的 Context 保持 `context-compiler:time:v3` / `recent-time:v3`，
  与修复前逐字节一致。是否以及如何约束，待 T08 #321 的真实模型证据后决定。
- **遗留的 History Answer 必须能结算，且不受开关控制**。进程在冻结结果之后崩溃会留下未结算的 History Answer 命令。无论部署开关
  关闭（运行时没有历史分支）还是治理被撤销，恢复扫描都把到期的命令失败关闭结算：不发送、不展示、不提交，Turn 进入终态，用户可显式
  Retry；已过请求截止的命令不等恢复窗口即被清扫（`timeout`）。
- **回滚旧应用前先排空**。不含历史分支的旧应用版本，其陈旧 Decision 扫描只排除 `action_finalization`，会把未结算的 `history_answer`
  命令当作普通 Decision 认领并重跑。因此回滚到这类版本之前必须：先关闭治理（`POST /api/internal/operator/history-recall
  {action:"disable"}`，同一请求即排空并返回 `historyAnswers: {drained, unsettled}`），再确认 `unsettled` 为 0（可用 `GET` 读回，或在
  关闭状态下 `{action:"drain"}` 重复排空；分支开启时 `drain` 以 409 拒绝）。排空与恢复扫描共用同一结算路径。这是 T09 #322 的发布前置。


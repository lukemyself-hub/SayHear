---
status: accepted
date: 2026-07-27
---

# Conversation Agent Stages Use Separate Generation Commands

一个 InteractionTurn 是 Conversation Agent Harness 运行的持久父级，不新增与它重叠的
`AgentRun` 对象。Harness 的第一次模型判断使用一个 Conversation Decision Command；
它冻结 User Event、CompiledContext、Conversation Action Catalog 与 Harness Policy，
结果只能是普通 Final Response 或一个 Conversation Action Proposal。

若 Decision Command 直接产生普通回复，该 Command 的 authoritative result 是冻结的主回应。
在 1A.3b 中，只有当前 Event 的 DialogueState 在主回应完成时已经就绪、确定性门禁选中
target 且主回应没有普通问题时，才可创建独立、tools-disabled 的 Proactive Follow-up
Segment Command。它只生成隔离片段；成功时主回应与片段合并为一个 Assistant Event，失败或
过期时只提交主回应。若没有该阶段，主回应直接提交为 Assistant Event，Turn 结束。

若 Decision Command 产生 Action Proposal，Action Gateway 先确定性验证、
受理并按 execution mode 执行或启动 ActionExecution；随后创建独立的 Action
Finalization Command，冻结创建时最新的 committed Receipt reference 并强制
`tools_disabled=true`，其 authoritative result 才是最终 Assistant Response。

两个阶段分别是不同的 GenerationCommand，各自拥有自己的 ModelRunAttempt、Prompt、
Schema、source 与重试。Finalization 不是 Decision 的 technical retry 或 fallback，
因为输入与生成意图已经改变。每个阶段内的同配置技术重试仍只增加
ModelRunAttempt；不得借重试改变阶段、追加 Action 或形成第二次工具往返。

这保留 GenerationCommand 与 ModelRunAttempt 的既有语义，也使进程在 Action commit
后、最终回复前崩溃时，可以从 InteractionTurn、Receipt 和未完成 Finalization Command
恢复，不依赖 Harness 或 Framework Session。未来增加新的受控 Agent Task 阶段时必须
使用新的显式 Command kind 与 Policy 决策，不能复用 `attempt_no` 隐藏多步计划。

Proactive Follow-up Segment 同样是独立 GenerationCommand，而不是 Decision 的第二个
Attempt。它冻结主回应 result、current DialogueState Version、target Version、reservation、
CompiledContext 与 policy bundle，不继承旧 Command 的可变 Session。Retry 从新的 Decision
Command 开始，重新取得状态、选择和 reservation。

## 修订（2026-10，issue #314，ADR-0151）：History Answer Command

- 新增显式 Command kind：**History Answer Command**（`generation_stage = 'history_answer'`）。
  Decision 以历史查询提案结束时，Gateway 在同一事务内：结算 Decision（command 与 attempt 为
  `succeeded`，没有 authoritative result，不留在 `running`）、冻结查询结果引用（表
  `history_recall_results`：计划、状态、内容无关覆盖统计与有序 revision 引用，**不含正文**）、
  创建 History Answer Command 及其第一个 ModelRunAttempt。幂等键 `history-answer/<decision command id>`。
- History Answer 是独立阶段：自己的 Prompt（`task-instruction-history-answer:v1`）、冻结的
  CompiledContext（版本 `context-compiler:history-time:v1`，含 `history_recall_receipt` 与
  `history_recall_context` 两个 section）、预算与 `tools_disabled=true`，沿既有完整 Response 接受点提交
  唯一的 Assistant Event。历史查询**不是** ModelRunAttempt 重试；各阶段内的技术重试仍只增加各自 Command
  下的 ModelRunAttempt（查询不重跑）。重派同一阶段不重复提交 Assistant Event（接受点
  `assistant/<generationCommandId>` 幂等）。
- 恢复：History Answer 不由陈旧 Decision 扫描接管（该扫描排除它），而由 `scanPendingHistoryAnswers`
  依据冻结结果重放。Decision 在“提案已完成、结果尚未冻结”之间崩溃时，由陈旧扫描以无请求
  revision 的普通 Decision 重跑，退化为普通回复。
- 结果状态 `completed | partial | failed` 与两类覆盖（枚举覆盖 vs 实际注入覆盖）分开记录；
  零条命中在“枚举完整”时只表示该日期范围内没有可读原文，不等于无记录。
- **G1 冻结 schema 合同例外**：`generation_commands` 属 G1 受保护关系，守卫原先只允许加可空列或索引。
  新增 stage 取值需要重写其 `generation_stage` CHECK，因此 `scripts/check-schema-extensions.ts`
  增加一个窄例外（先例：提交 06aba80 对 additive migration 的放行）：仅允许对命名约束
  `generation_commands_generation_stage_check` 的 DROP 与带回“全部冻结取值 + 已登记新取值
  `history_answer`”的 ADD，其余对该关系的 DROP/UPDATE/收窄/他值一律拒绝。迁移 0071 只含这两条语句，
  并以 SHA-256 登记；0072 不提及任何受保护关系。不复用已退役的 `proactive_followup`，也不借用
  `action_finalization`。

补充（#316）：原文经历检索（`search_experience` 提案）使用同一个 History Answer stage、同一张
`history_recall_results` 与同一冻结/重验/恢复路径，不新增 stage 或 Command kind；它只在冻结结果中增加
检索计划（线索组，私人字段）、按次经历分组的引用与检索覆盖统计，并在 Context 引用上增加
`history_lexical_match/history_lexical_context` 两个选择原因（迁移 0075，不涉及受保护关系）。
## 修订（2026-10，issue #319，ADR-0151）：新输入、取代与 Decision 结算

- **新输入是新的 User Event / Turn**。“再补充一点”“换个话题”都不追加进旧 Command：新一轮的冻结上下文
  包含前一个有效用户问题与新输入，由新一轮结合当前表达理解。不新增“补充”按钮或另一套意图状态机。
- **取代（supersede）不写旧命令的状态**。“同 Session 存在更新的用户消息”这一事实由新 User Event 在其
  接受事务中本身构成；旧命令的提交围栏（ADR-0083 修订）读取它。因此新输入的接受与旧结果的失效在同一数据库
  事实上原子成立，不依赖客户端隐藏、也不依赖取消信号送达；进程内另会取消旧请求的 Provider 调用。被取代的
  命令以 `aborted` 结算（未展示任何 token 时为 failed，已展示则 interrupted 并保留显式 Retry）。
- **Decision 转为提案后必须结算**。任何已评估的 Conversation Action 提案，无论受理结果，都结算 Decision
  的 command/attempt（#312：误触发的 Trust Action 以 `clarification_required / target_not_found` 结束时
  Decision 曾永久停在 running）。未受理且没有回复可发（无 Finalization）时，同一动作把 Turn 也结算为
  failed，而不是留给恢复窗口。
- **Finalization 与 History Answer 继承请求截止与最新输入围栏**；它们不是 Decision 的技术重试，截止后
  不开始。已知 Provider 用量（含 reasoning/cached/total）无论调用是否完成、提交是否成功都入账；未知保持
  NULL，不填零。

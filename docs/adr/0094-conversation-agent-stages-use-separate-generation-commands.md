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

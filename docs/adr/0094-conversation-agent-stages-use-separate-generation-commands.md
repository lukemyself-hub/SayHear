---
status: accepted
date: 2026-07-27
---

# Conversation Agent Stages Use Separate Generation Commands

一个 InteractionTurn 是 Conversation Agent Harness 运行的持久父级，不新增与它重叠的
`AgentRun` 对象。Harness 的第一次模型判断使用一个 Conversation Decision Command；
它冻结 User Event、CompiledContext、Conversation Action Catalog 与 Harness Policy，
结果只能是普通 Final Response 或一个 Conversation Action Proposal。

若 Decision Command 直接产生普通回复，该 Command 的 authoritative result 提交为
Assistant Event，Turn 结束。若它产生 Action Proposal，Action Gateway 先确定性验证、
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

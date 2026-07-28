---
status: accepted
date: 2026-07-27
---

# Conversation Actions Separate Admission from Execution State

每个通过幂等边界解析的 Conversation Action Proposal 对应一个稳定的
`ActionExecution`。Action 是否被 SayHear 接受，与被接受后的工作是否已经完成，是
两个正交状态，不能继续压缩为 `applied` 或 `failed` 等单一结果。

Admission 是一次性且不可变的决定：

```text
accepted
clarification_required
rejected
unsupported
```

Execution 独立演进：

```text
not_started
pending
running
succeeded
failed
canceled
```

非 `accepted` 的 Action 必须保持 `not_started`，不得调用 handler 或产生部分领域
变化。同步 Action 在同一事务中提交 Admission Receipt、领域变化与 terminal
Completion Receipt；异步或外部副作用 Action 在同一事务中提交 Admission Receipt、
幂等 Workflow command / outbox 与初始 `pending` 状态，后续每次状态变化都追加
immutable Progress / Completion Receipt。

Receipt 序列是权威事实；`ActionExecution` 上的 current admission / execution
status 只是可从 Receipt 重建的 projection。Terminal execution state 不允许被晚到、
重复或乱序事件回退。每条 Receipt 使用由 admission 或执行源产生的稳定 receipt key
去重，sequence 只在锁定 Execution 后分配，不能由外部 Workflow 自报。相同幂等请求
必须返回同一个 ActionExecution 及其已有 Receipt，不能重复执行领域写入、启动
Workflow 或调用外部系统。

Action Finalization Command 冻结创建时最新的 committed Receipt。它可以说明请求已被
接受以及工作仍在处理中，但只有 `succeeded` Completion Receipt 才能声称全部完成；
异步 Completion 不自动开启新的 Agent tool loop，也不自动发送用户消息，除非该
Action 的独立 delivery policy 明确允许。

这样，当前同步纠错与 Journal / Profile 重生成可以共享同一生命周期，同时保持执行
真相、用户可见表述、幂等恢复与 Durable Workflow 状态之间的明确边界。删除或外部
副作用若未来进入 Conversation Action 范围，仍需先完成其独立确认与授权决策。

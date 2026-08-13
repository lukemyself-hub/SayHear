---
status: accepted
date: 2026-07-26
---

# Vercel Workflows v4 Runs Durable Asynchronous Work

从 Core Flow 1A.2 开始，Journal、Reflection、删除、补偿和其他需要持久异步执行的
任务使用 Vercel Workflows stable v4。Core Flow 1A.1 的在线回复、inactivity
timeout 和卡住 Turn 恢复不依赖 Durable Workflow。

Workflow 只负责编排 at-least-once 执行，不拥有业务真源或幂等语义。Workflow payload
只传 ID、revision、policy version 和 allowlisted 状态；权威提交仍需通过 PostgreSQL
中的 command、freshness、deletion fence、唯一约束与事务。

## 实现版本与测试分层

`workflow` npm 包使用 stable v4（4.8.x）。directive API（`'use workflow'` /
`'use step'`、来自 `workflow/api` 的 `start()`、来自 `workflow/next` 的
`withWorkflow()` 插件）在 4.8.x 已存在；v5 beta 是其继续演进，不是独立 API，1A.2
不采用 beta。

业务正确性不下沉到 Vercel 平台运行时。每个 durable 派生任务由一个可直接调用的
**application entrypoint**（如 `runJournalEligibility()`）承载其确定性的领域逻辑、
幂等提交与收敛；`workflow` SDK 的 directive wrapper 只在部署环境中对它做 durable
at-least-once 编排。

因此测试分层：

- **CI 系统测试**驱动真实的 Node/BFF、PostgreSQL、dispatcher、Workflow application
  entrypoint 与可见结果。它不连接 Vercel 平台的托管持久化、队列或重放。
- 平台级 durability / replay / queue 的端到端验证属于架构 24.1 的 Vercel Workflow
  step 集成层与 End-to-end 层，在部署环境中验证，不进入 CI 系统测试范围。1A.2 的这
  一层在「Reconcile and prove the complete 1A.2 Journal lifecycle」（issue #29）
  完成证明。

该分层与「正确性只依赖数据库 lease、idempotency 和下一次扫描」（架构 13.3）一致：
平台被当作会重复触发、会失败、会恢复的 at-least-once 载体，其自身 durability 行为
不需要被业务测试验证。

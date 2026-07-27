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

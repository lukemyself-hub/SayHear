---
status: accepted
date: 2026-07-26
---

# Replay Is Non-Authoritative and Cannot Write Product State

所有 Replay output 都是 `non_authoritative` eval artifact。Replay 不得创建、更新、
纠正、发布或删除正式 Conversation、Evidence、Entity、Episode、Journal、Reflection、
Memory Claim、Profile 或 Model Routing Policy。

Initial Replay 不能读取 production domain source；Private Replay 使用隔离身份、
job-scoped immutable snapshot 且没有正式数据库凭据或写权限。评估结果可以形成报告、
比较和人工审核的建议，但任何产品状态变化都必须通过正式领域命令与独立授权。

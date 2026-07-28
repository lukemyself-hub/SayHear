---
status: accepted
date: 2026-07-27
---

# Conversation Action Audit Does Not Duplicate User Content

Conversation Action 的长期 Proposal、Execution 与 Receipt 记录只保存执行和审计所需的
最小 envelope：Action / Schema / Catalog version、原始 User Event revision reference、
typed target reference、状态、时间、allowlisted authoritative change reference 与错误
代码。它们不长期保存用户原话、Provider tool-call object、模型解释、自由文本 target
或可还原私人请求的重复正文。

Action Gateway 为崩溃恢复而必须冻结的 normalized typed arguments 使用独立加密
payload 保存，并绑定 Proposal、payload Schema、retention policy、`expires_at` 与
`content_purged_at`。Payload 只允许 Gateway recovery capability 在 Admission 尚未
settled 且期限有效时读取；同步 Action 在 Admission / Completion 事务结束后清除，
异步 Action 在 Admission 与幂等领域 / Workflow command 原子提交后清除。后续 Workflow
只能依赖 ID、revision、policy 与已经提交的领域 command，不能依赖或复制 Proposal
payload。

如果 Proposal 未能完成 Admission，超过版本化恢复期限后必须 fail closed 并清除
payload。Receipt、Finalization source、普通日志、Trace、Workflow history、Replay
fixture 和错误体都不能成为 payload 的旁路副本；Receipt 只允许 typed reference、
状态与 allowlisted error code。

原始 User Event、Memory、Journal、Profile 等权威内容继续遵循各自的 retention 与删除
规则。Action envelope 不是第二份内容真源，也不能用 payload fingerprint、Embedding
或摘要延长其含义。Internal Owner Full Purge 与 Account Deletion 必须清除 owner-scoped
Action envelope、payload、Execution 与 Receipt；只有既有删除规则明确允许的去关联化
运行元数据可以按字段白名单和 TTL 保留。

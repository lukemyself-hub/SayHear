---
status: accepted
date: 2026-07-26
---

# Domain Transactions Use Node and Pooled PostgreSQL Connections

BFF domain API、Workflow step、outbox dispatcher 与 migration 固定使用 Node
runtime、Neon pooled PostgreSQL endpoint，以及支持 interactive transaction 的
Node PostgreSQL driver；领域事务不使用 Edge runtime 或只能执行单条 HTTP SQL 的
连接模式。

锁、fencing guard、业务写入和 outbox insert 必须在同一连接、同一事务中完成。
禁止 session-scoped advisory lock；模型、STT、TTS、对象存储和其他网络调用不能在
数据库事务内等待，以免连接占用和事务时间失控。

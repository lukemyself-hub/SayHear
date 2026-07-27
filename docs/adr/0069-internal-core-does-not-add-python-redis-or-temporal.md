---
status: accepted
date: 2026-07-26
---

# Internal Core Does Not Add Python, Redis, or Temporal

Internal Core 的生产路径不建设 Python Worker、Redis 或 Temporal。TypeScript 模块化
单体、PostgreSQL 锁与唯一约束、pgvector，以及从 1A.2 开始的 Vercel Workflows 与
transactional outbox 足以承担当前领域一致性、异步派生和检索需求。

Python 可用于 notebook 和离线探索，但只有出现 Python-only 模型库、GPU 批处理或
TypeScript 无法承担的评估工作才引入生产 Worker。Redis、Temporal 或专用向量基础
设施也只能在已有架构出现可量化的锁争用、延迟、SLO 或工作流演进问题后引入，且不能
成为长期产品状态的真源。

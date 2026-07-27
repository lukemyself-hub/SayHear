---
status: accepted
date: 2026-07-26
---

# PostgreSQL Is the System of Record and pgvector Is Rebuildable

PostgreSQL 保存 SayHear 的 canonical records、正式产物、状态机、版本、lineage 与
审计，是产品唯一 System of Record。模型 Session、Workflow history、LiveKit Room、
cache 和向量索引都不能替代 PostgreSQL 中的权威状态。

pgvector 只保存可由当前有效 source、ClaimVersion、Entity、Episode 或 Profile
projection 重建的敏感检索索引。索引必须服从 source validity、删除和 Recall fence；
索引缺失可以重建，不能反向成为生活事实或权威状态。

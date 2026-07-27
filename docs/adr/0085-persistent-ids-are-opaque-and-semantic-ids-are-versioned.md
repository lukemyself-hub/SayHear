---
status: accepted
date: 2026-07-26
---

# Persistent IDs Are Opaque and Semantic IDs Are Versioned

SayHear 持久实例使用服务端生成的 opaque UUIDv7。实例 ID 不编码名称、语言、用户输入、
租户、Provider、模型、对象种类或状态；每个 row 显式保存 owner boundary，TypeScript
使用 branded ID type，PostgreSQL 使用真实 foreign key 防止不同对象 ID 混用。

Entity kind、Claim predicate 等机器语义使用独立、版本化的 `sh.*` namespace。
display label 与翻译变化不改变 semantic ID；语义实质变化创建新 ID 并通过
`replaced_by_id` 演进。外部公共 ID 只进入可撤销 mapping，不成为 SayHear 主键。

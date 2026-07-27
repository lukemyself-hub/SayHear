---
status: accepted
date: 2026-07-26
---

# TypeScript Modular Monolith Is the Domain Kernel

SayHear 以自有 TypeScript 模块化单体承载 application 与 domain kernel。Conversation、
Evidence、Entity、Journal、Memory、删除和出站规则在同一领域边界内实现，并通过模块
接口保持依赖方向；不因 Replay、Voice 或 Provider Egress 出现独立运行时就把领域内核
拆成分布式微服务。

当前核心复杂度来自领域一致性、证据血缘和删除 fencing，而不是团队边界或独立扩缩容。
模块化单体允许关键写入共享 PostgreSQL 事务，降低跨服务 Schema、部署和调试成本，
同时保留未来按明确的权限或运行特征抽离 adapter / worker 的空间。

---
status: accepted
date: 2026-07-26
---

# Versioned Domain Artifacts Require Lineage

Entity、Episode、Journal、Reflection、Memory Claim 以及删除状态都必须使用稳定 logical
identity、不可变 Version / Revision 和可追溯 lineage 表达变化。修正、merge、
split、supersede、撤回和策略重跑创建新版本或显式状态，不原地改写历史含义。

Lineage 必须能从派生产物追溯到具体 source revision、policy、command 和 run，并参与
freshness、Replay 与删除传播。保留历史版本不凌驾于 privacy erasure：删除时必须清除
不再允许保留的正文，同时留下满足 fencing 所需的最小无正文记录。

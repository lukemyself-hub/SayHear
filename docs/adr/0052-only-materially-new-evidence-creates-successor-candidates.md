---
status: accepted
date: 2026-07-26
---

# Only Materially New Evidence Creates Successor Candidates

Terminal MemoryCandidate 不因出现一条新消息而重新取得准入资格。只有新增 User
Evidence 实质改变长期 Memory admission 条件，例如从推断变为用户直接陈述、首次
满足独立跨 Session Evidence 门槛，或唯一消除 Entity、scope、时间或引用歧义时，
才可以创建新的 Successor Memory Candidate。

Successor 必须引用新增 Evidence 与 terminal predecessor，重新执行完整
eligibility、mapping、admission 和 deadline；predecessor 的 status、期限、
purged content 与 audit envelope 保持不变。重复表达、相同 Session 派生项、模型
confidence、时间经过或 Registry version 更新都不能创建 successor。

人工以“没有产品价值”等产品治理理由作出的 rejection 只能通过显式、版本化重新
评估重开，普通新 Evidence 不足以覆盖。当前 policy 禁止的敏感分类性推断也不能
靠更多相似 Evidence 变成 Materially New Evidence；用户之后直接明确陈述时，
按新的 Objective Candidate 重新准入。无法安全确认 terminal predecessor identity
时 fail closed，不能只用 free-text similarity 建立 successor lineage。ADR-0053
使用不含用户内容的 rejected ProposalVersion 保存概念级产品治理 identity。

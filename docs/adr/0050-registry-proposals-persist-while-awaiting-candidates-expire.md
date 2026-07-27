---
status: accepted
date: 2026-07-26
---

# Registry Proposals Persist While Awaiting Candidates Expire

Predicate Change Proposal 和关联 MemoryCandidate 使用独立的生命周期。Proposal
不因等待时长自动过期；它持续存在，直到 Registry version 发布或由授权人工明确
取消。ADR-0053 扩展了 Proposal version 状态：概念级产品拒绝使用
`status=rejected`，保持到授权人工显式创建新的 reconsideration version。

Candidate 进入 `awaiting_registry_release` 时设置独立的 90 天 deadline。到期仍
没有对应 Registry version 发布时，Candidate 幂等转为 `stale`，但 Proposal 保持
不变。Proposal 以后发布时，只能重新处理仍处于
`awaiting_registry_release` 的 Candidate，不能自动复活、mapping 或 admit
已经 stale 的 Candidate。

是否在期限内发布以 `published_at <= registry_release_due_at` 判断，不能依赖
Registry reconciliation 与 Candidate 到期扫描的实际执行顺序。已经超期但扫描
尚未运行的 Candidate 也不具备 admission 资格。

Materially New Evidence 或显式、版本化的重新评估可以按 ADR-0052 产生新的
Successor Memory Candidate，但必须保留原 stale lineage。ADR-0051 另行规定
terminal Candidate 派生语义的 7 天清理期限。

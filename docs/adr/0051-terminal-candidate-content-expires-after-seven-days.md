---
status: accepted
date: 2026-07-26
---

# Terminal Candidate Content Expires After Seven Days

MemoryCandidate 转为 `rejected` 或 `stale` 后，LLM 派生语义只在活跃系统中保留
7 天，用于经过 step-up 与 access audit 的内部排错；它在这段时间内也不能进入
Recall、Profile、模型 Context、Embedding、自动 admission 或 Registry Proposal。
期限从人工 rejection 的 commit time，或导致自动 stale 的原 policy deadline
计算，不能因 sweeper 延迟而顺延。

到期后所有读取立即 fail closed，活跃系统清除 proposed concept、typed value、
Entity / Predicate binding、解释、review draft 以及其他可还原提案含义的字段。
系统只保留字段白名单内的 Terminal Candidate Audit Envelope：terminal
disposition、reason、policy / model / Registry version、时间、无正文 Evidence
lineage，以及 keyed exact-match dedupe fingerprint。

Fingerprint 只用于阻止相同 Evidence 与语义目标绕过原 terminal disposition，
不能用于检索、聚类、分析标签、Embedding、模型输入或还原提案。相关 Evidence
全部删除、Internal Owner Full Purge 或 Account Deletion 时，Evidence link 与
fingerprint 一并清除。底层 Evidence 继续遵循自己的生命周期；Candidate 终局本身
既不删除 Evidence，也不授权重新准入。ADR-0052 只有在新 Evidence 实质改变
admission 条件时才允许创建新的 successor，并且不恢复这里已清除的正文。

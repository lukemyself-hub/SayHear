---
status: accepted
date: 2026-09-07
---

# Every private data surface registers its purge contract

1A.3b introduces a closed Purge Surface Registry as the authoritative inventory of owner-scoped database rows, object-store prefixes, caches, indexes, generated artifacts, Provider objects, and access grants. Every entry declares ownership, Full Purge disposition, private content fields, clear handler, verifier, receipt destination, deadline behavior, and restore-marker reapplication behavior. A schema migration or runtime integration that creates an owner-scoped private data surface without a registry entry fails its automated acceptance gate.

The registry owns coverage, not deletion orchestration or business data. Existing domain repositories and destination adapters still perform idempotent clear and verify work under the advanced Data Epoch; the purge workflow walks the frozen registry version and cannot report Active-System Deletion while any required active destination is unverified. This adds maintenance to each private-data change, but prevents a hand-maintained purge SQL list from silently omitting a new table or external destination.

## 修订（2026-10，SPEC #301 评审）：历史查询线索的存放位置与保留

- **如实的存放位置**。历史查询（日期回顾、原文经历检索、自然接续）的检索线索——关键词、人物、接续依据——不含消息正文，但源自用户
  自己的话，属于私人内容，**不是“无内容”数据**。它存在两处，均为已登记的私人面、由 Owner Full Purge 覆盖：
  `history_recall_results.plan`（冻结的计划与提案），以及 `compiled_contexts.sections` 中 `history_recall_receipt` 的 reference
  （History Answer 冻结 Context 携带同一份计划，其渲染出的回执也含线索）。受控 Inspector 对两处只返回计数（architecture 08-10 §8.4.7）。
- **不新增保留机制**。决定：检索线索与其所属 compiled context **同生命周期**，不为它单独设置更短的保留期。理由：线索源自当轮用户
  消息，而该消息本身作为 User Event 永久保存（直至用户更正、遗忘或 Purge）；`compiled_contexts.sections` 及其引用的 revision 本就
  保存了发给模型的完整正文，线索只是其中很小的子集；单独缩短线索的期限不减少暴露面，却会破坏 replay（冻结的 History Answer
  Context 由 section reference 重渲染并校验完整性）。今后若为 compiled context 决定更短的保留期，线索随之适用。

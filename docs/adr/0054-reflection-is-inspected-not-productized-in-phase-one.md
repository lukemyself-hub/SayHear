---
status: accepted
date: 2026-07-26
---

# Reflection Is Inspected, Not Productized, in Phase One

Phase 1 不建设独立的用户式 Reflection 页面。Reflection 继续作为 1A.3 的非权威、
版本化派生层，只用于提出 Memory Candidate；Candidate 经过独立准入成为 active
Claim 后才可能影响 Bio。Reflection 不拥有、触发或阻塞 Bio 生成；Conversation、
Journal 与 Bio 保持为体验面。

Internal Core 的 Web 开发者工具提供只读 Reflection Inspector，用于查看 Daily /
Weekly ReflectionVersion、Evidence lineage、Candidate disposition，以及 Candidate
经有效 ClaimVersion 对 Bio 产生或未产生的影响。Inspector 不创建、
编辑、发布或覆盖 ReflectionVersion，不批准 Candidate，也不写入 Claim 或 Bio。

Internal Core 的目标是验证跨日 Agent Core、领域不变量和信任边界，而不是验证
消费者 UI。提前产品化 Reflection 会扩大 Phase 1 范围，并容易让非权威派生产物被
误解为用户事实或第二个 Journal；只有内部验证证明 Reflection 本身具有独立用户价值
后，才重新评估独立用户体验。

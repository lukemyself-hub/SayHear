---
status: accepted
date: 2026-07-26
---

# Derived Artifacts Are Versioned and Projections Are Rebuildable

Journal、Reflection、Memory Claim 与 Episode 是需要保留稳定 logical identity、
不可变 Version 和历史状态的派生产物。相同 source revision 与 generation policy
必须幂等；source、policy 或结论变化创建新 Version，不能把旧结果当普通 cache 覆盖。

Profile、Embedding、Relationship Resolver Hint 和其他索引是从当前有效领域状态构建的
可重建 projection，不是事实或长期判断的真源。projection 必须在 source invalidation、
Correction、Forget、Entity 变化和删除时立即停止使用，并从仍有效的 Version 重建。

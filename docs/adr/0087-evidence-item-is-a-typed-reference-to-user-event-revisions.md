---
status: accepted
date: 2026-07-26
---

# EvidenceItem Is a Typed Reference to User Event Revisions

`EvidenceItem` 是一等、类型化、不可变的 source 引用；Core Flow 中只有有效的 final /
corrected User `ConversationEventRevision` 可以成为用户生活事实的 primary evidence
root。EvidenceItem 通过 locator 精确指向 whole revision、segment、text span 或
time range，不复制或创造底层事实。

Assistant / System Event、Reflection、Journal、Summary 和模型推断不能反向证明用户
事实。Claim、Journal Statement、Reflection 与 Episode 的认识论依据使用 typed
Evidence link；运行依赖另用 lineage 表达，不能以“有 lineage”替代合格 Evidence。

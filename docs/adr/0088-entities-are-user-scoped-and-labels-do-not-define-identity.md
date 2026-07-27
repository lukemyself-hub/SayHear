---
status: accepted
date: 2026-07-26
---

# Entities Are User-Scoped and Labels Do Not Define Identity

私人 `Entity` 默认属于单个用户作用域。名称、别名、语言、关系称呼、external
identifier mapping 与模型 confidence 都不能单独决定 Entity identity，也不能让不同
用户或同名对象自动合并。

identity 由 Mention Evidence、明确引入、用户澄清及版本化 merge / split 决定。
label 和 external mapping 是可撤销、可更新的辅助数据；解析不充分时宁可保留未绑定
Mention 或独立 unresolved Entity，也不能污染长期 Memory 的身份连续性。

---
status: accepted
date: 2026-07-26
---

# Generation Commands Use Versioned Freshness Policies

每个异步或可恢复 `GenerationCommand` 必须冻结一个版本化 `freshness_policy` 和具体
source revision / coverage。提交前按命令语义使用 `exact_head`、`source_valid` 或
`monotonic_projection` 判断结果是否仍可写入，不能由各 Workflow 临时手写新鲜度规则。

Journal publish、current Reflection 等要求 exact head；只要原 Evidence 仍有效即可
追加的派生物使用 source valid；Summary、DialogueState 等投影只能单调推进 coverage。
任何删除、epoch 变化或 source invalidation 都优先 fail closed，旧 command 不能覆盖
新 revision 或复活数据。

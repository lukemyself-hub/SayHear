---
status: accepted
date: 2026-07-26
---

# Generation Command Is Separate from Model Run Attempt

`GenerationCommand` 表达一次逻辑生成意图并冻结 subject、source revision、Prompt、
Schema、policy、routing 与 freshness；`ModelRunAttempt` 表达该 command 的一次具体
Provider 调用及其运行结果。一次 command 可以因安全技术重试或已批准 fallback 拥有
多个串行 attempt，但只有一个 authoritative result。

分离两者可以在不重复用户意图或产品写入的前提下记录 Provider 故障、成本、模型版本
与重试。attempt 不能投票、合并结果或改变 command 已冻结的业务语义；提交结果仍需
通过相同 validator、freshness、deletion fence 与幂等约束。

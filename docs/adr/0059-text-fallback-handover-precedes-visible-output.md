---
status: accepted
date: 2026-07-26
---

# Text Fallback Handover Precedes Visible Output

从 1A.4 开始，`conversation.text` Champion 失败时可以按人工发布的 Model Routing
Policy 执行一次串行 Conversation Fallback Handover，但前提是没有任何回答 token
可能对用户可见、Complete Assistant Response 尚未提交，且 fallback Provider 已通过
Provider Egress policy 与 consent 检查。

Primary 与 fallback 不并行 Shadow，也不级联尝试更多模型。Fallback 一旦接管，就
固定到当前 Continuous Exchange 的后续 Turn，不能逐 Turn 切回 Champion。Handover
复用原 GenerationCommand，只创建新的 ModelRunAttempt，并记录 source attempt、
Policy version、model config 与 egress disposition。

任何 token 已经或可能已经展示、输出可见性无法证明，或 fallback 再次失败时，系统
必须显式失败并等待用户 Retry，不能在同一 Turn 中静默生成另一份回答。这个边界在
获得单次容灾能力的同时，避免重复回答、人格来回切换、私人对话 Shadow 和无界
Provider 扩散。

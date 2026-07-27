---
status: accepted
date: 2026-07-26
---

# Private Replay Output Expires After Thirty Days

读取真实私人 source 的 Replay output 默认保留 30 天。每次 Private Replay 必须记录
`retention_policy_id` 与 `expires_at`；Provider 原始响应、合成输出、评分备注和真实
eval dataset item 使用相同或更短的期限。

Source 删除或失效优先于 30 天 TTL，并立即阻断读取和在途结果提交。Private Replay
output、dataset item 和关联 artifact 必须进入 lineage、删除传播与 reconciliation，
不能复制 source 或音频来绕过原始 retention。

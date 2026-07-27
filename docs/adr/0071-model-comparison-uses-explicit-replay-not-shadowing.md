---
status: accepted
date: 2026-07-26
---

# Model Comparison Uses Explicit Replay, Not Shadowing

SayHear 比较模型、Prompt 和工作流时使用显式创建、固定 source 与 policy 的 Replay，
不在真实私人对话上自动 Shadow 到其他模型或 Provider。真实私人 Replay 必须由授权
内部用户明确选择 source 和 Provider。

自动 Shadow 会扩大私人内容的出站目的地、成本与删除面，也难以向用户解释。显式
Replay 保留可复现比较的价值，并让每次额外推理都有可审计授权、版本、retention 和
删除传播。

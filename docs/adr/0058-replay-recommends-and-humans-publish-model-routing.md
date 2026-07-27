---
status: accepted
date: 2026-07-26
---

# Replay Recommends and Humans Publish Model Routing

Replay rating、comparison 与自动指标是 non-authoritative eval output。它们可以形成
Challenger promotion recommendation，但不能直接改变真实流量。Challenger 成为
Champion 或 eligible fallback，必须由授权人工显式审核并发布新的版本化 Model
Routing Policy。

每个 Policy version 必须引用支撑决定的 Replay run、dataset、rubric 与安全评估，
并记录 role、Champion、eligible fallback、发布者、原因和 predecessor。自动阈值、
线上故障率、成本变化或 Replay Runner 都不能自行晋升、降级、回滚或修改 Policy；
runtime 只能执行已经发布的路由决定。

这个边界防止单一指标在没有产品、人格、隐私出站与安全判断的情况下改变真实模型
行为，同时保留 Replay 自动分析、告警和准备晋升建议的价值。

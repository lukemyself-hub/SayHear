---
status: accepted
date: 2026-07-26
---

# Vercel Hosts Web, BFF, and Durable Workflows

Vercel 承载 SayHear 的 Web、BFF、请求型 API 与从 Core Flow 1A.2 开始的 Durable
Workflow step。正式实时音频 media plane 和常驻 LiveKit Agent Worker 不放在普通
Vercel Function 中。

这一部署选择让早期 Web、服务端授权、模型请求和异步派生保持在同一主部署面，并减少
独立运维系统。Vercel 不是业务真源；所有权威状态、幂等、lease、freshness 和删除
fencing 仍由 PostgreSQL 与确定性领域代码控制。

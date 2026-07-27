---
status: accepted
date: 2026-07-26
---

# LiveKit Cloud Agents Hosts the Core Flow 1B Worker

Core Flow 1B 默认使用 LiveKit Cloud Agents 的托管 Agent deployment 运行 Node.js
Voice Worker。1B.1 Realtime Transport Baseline 与 1B.2 Delivered-Prefix
Correctness 复用同一部署拓扑。

Voice Worker 需要常驻进程、Room dispatch、并发扩缩与媒体延迟控制，不适合普通
Vercel Function。托管部署只拥有 Room 与受限 service identity；SayHear 的领域状态、
Provider Egress policy、凭据边界和长期数据仍由正式服务控制。

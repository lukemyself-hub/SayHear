---
status: accepted
date: 2026-07-26
---

# Voice Session and Turn Are Runtime Mappings

`VoiceSession` 与 `VoiceTurn` 持久化 Room、Provider item、重连和 delivery 的运行映射，
但不是 Daily Session、产品长期记录或生活事实 Evidence。每个 VoiceTurn 必须映射一个
跨渠道 `InteractionTurn`，canonical 内容仍由 `ConversationEventRevision` 表达。

这些映射允许崩溃恢复、去重和审计，但 Provider / LiveKit session 过期后可以从
SayHear CompiledContext 重建。Room ID、Provider item ID 或 resume token 不能替代
产品对象 ID，运行秘密必须使用短 TTL、加密和访问审计。

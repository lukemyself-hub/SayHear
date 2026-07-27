---
status: accepted
date: 2026-07-26
---

# LiveKit Agents Is the Realtime Media and Voice Session Layer

正式 Realtime Voice 使用 LiveKit Cloud 与 LiveKit Agents 作为 WebRTC media
transport、Room、Agent dispatch、弱网处理、打断和播放同步层。LiveKit Agent Worker
通过受认证的 SayHear domain API 访问产品能力，不持有产品长期状态。

Daily Session、InteractionTurn、canonical ConversationEventRevision、Evidence、
Journal、Memory、隐私和删除仍由 SayHear 领域内核与 PostgreSQL 管理。LiveKit Room、
AgentSession 和 Provider session 都是临时运行时，不能成为产品 Session、Context 或
长期记录的真源。

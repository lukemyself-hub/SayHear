---
status: accepted
date: 2026-07-26
---

# Interaction, Voice, and Event Identities Are Distinct

`InteractionTurn`、`VoiceTurn` 与 `ConversationEventRevision` 使用独立 ID、状态机和
职责边界。InteractionTurn 组织一次跨渠道交互；VoiceTurn 映射 LiveKit / Provider
运行；ConversationEventRevision 才记录可以进入历史或 Evidence 的具体内容版本。

三种身份不能复用或互相推导。重连、Retry、barge-in、转写修正和 Assistant delivery
可能分别改变其中一层而不创建其他层的新身份；显式 foreign key 与唯一约束负责关联和
去重，trace correlation ID 不能承担领域身份。

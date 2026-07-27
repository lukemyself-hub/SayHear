---
status: accepted
date: 2026-07-26
---

# Agent Frameworks Do Not Own Long-Term Product State

SayHear 不使用模型或 Agent Framework 的 Session、Memory、thread 或 tool state 保存
Conversation 真源、长期 Memory、Profile、Journal、Entity 或用户控制状态。每轮运行
都从 SayHear 的版本化领域数据编译 Context。

Framework 可以作为 Provider 或 Realtime adapter 提供调用、流式传输和工具编排能力，
但其内部状态必须可丢弃。这样可避免供应商状态与产品事实、删除、Replay 和跨模型迁移
发生双重真源冲突。

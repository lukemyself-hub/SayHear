---
status: accepted
date: 2026-07-27
---

# Models See Focused Functions and the Domain Sees One Action Proposal Union

Conversation Agent Harness 根据当前冻结的 Conversation Action Catalog，为 Decision
Command 向模型暴露多个名称清晰、Schema 独立的高层 Conversation Functions。每个
Function 精确对应一个 Catalog action kind；不使用不断扩张的
`propose_conversation_action(kind, payload)` 万能 Function，也不暴露 Claim CRUD、
Journal rewrite、Profile invalidation、Workflow 或其他内部传播操作。

Provider Adapter 可以把这些 Functions 编码为原生 function calling，或在 Provider
不支持等价工具协议时使用 strict structured output。无论 Provider 表达为何，越过
application seam 前都必须规范化为同一个 provider-independent
`ConversationActionProposal` discriminated union，携带 Catalog action kind、Schema
version、request Event reference 与 typed candidate arguments。领域 Module、
Action Gateway、数据库与测试不得引用 Provider 或 Framework 的 tool-call 类型。

当前 Conversation Harness Policy 禁止 parallel tool calls，并且一个 Decision Command
最多接受一个 Function selection。模型返回多个调用、Catalog 外名称、错误 Schema、
额外自主 step 或要求继续调用时，Harness fail closed；不能挑选“看起来最合理”的一个。
Action Finalization Command 不暴露任何 Function。

这种双层 Interface 让模型获得清晰的选择与参数提示，同时保持 SayHear 的领域契约和
持久记录稳定。未来新增、下线或按权限过滤能力只改变版本化 Catalog 与 Provider-facing
Function set，不改变 Action Gateway 的授权责任，也不要求领域层跟随某个 Provider
协议迁移。

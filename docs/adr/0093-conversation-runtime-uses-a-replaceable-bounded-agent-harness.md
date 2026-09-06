---
status: accepted
date: 2026-07-27
---

# Conversation Runtime Uses a Replaceable Bounded Agent Harness

SayHear 在应用层定义 `Conversation Agent Harness` 这一深 Module，负责围绕一个冻结的
InteractionTurn 组织 Context、模型判断、高层 Function Calling、Conversation Action
receipt 与最终回复。它弥合开放式自然语言输入与有限、typed 产品能力，但不拥有
Conversation、Memory、Journal、Profile、Entity、权限或删除状态，也不取代任何领域
状态机。

初始实现沿用 SayHear 自有 Provider Port 与 Adapter，不因此引入 Pi、Mastra 或其他
通用 Agent Framework。当前 Conversation Harness Policy 最多允许一次改变状态的
Conversation Action：模型先返回普通回复或一个 Action proposal；Action Gateway
确定性验证并执行后，Harness 最多再调用模型一次，关闭工具并只依据已提交 receipt
生成最终回复。技术重试仍服从 GenerationCommand、ModelRunAttempt 与可见输出规则，
不形成自主工具链。

1A.3b 对非 Action、非直接任务的普通回复增加一个更窄的例外：主回应完成时，若当前
Event 的 DialogueState 已就绪且 Proactive Memory Follow-up 门禁选中 target，Harness
可以创建一个 tools-disabled 的 Proactive Follow-up Segment Command。它只渲染隔离片段，
不能改写主回应、调用工具或触发状态型 Action；片段失败时主回应照常完成。因此它不扩大
“最多一次改变状态的 Conversation Action”，也不改变 Action Finalization 路径。

Harness 的 Interface 由 SayHear application layer 拥有。调用方只提交冻结的
InteractionTurn、GenerationCommand 与 CompiledContext reference，并接收可展示的
最终回复 stream 和 terminal result reference；Provider message、原始 tool-call
对象、Framework session、内部 Action step 与领域 repository 不得越过这个 seam。
Conversation Model Port、Provider Adapter、Action Gateway 与持久化细节是 Module
内部依赖，不由 API handler 或客户端拼装。

初始自有实现与 deterministic test / Replay Adapter 共同服从一套 Interface
conformance suite。未来只有在多轮 Agent Task、多 Provider tool protocol、
Realtime interruption / resume、外部 approval / MCP、compaction 或观测成本形成
真实需求，并通过 Replay 证明收益时，才评估 Framework-backed Adapter。替换不得改变
Conversation Action、receipt、Evidence、幂等、删除 fencing 或长期状态所有权，也
不得要求领域层引用 Framework 类型。

该决定保留未来 Framework 选择权，但不以提前引入依赖、通用 Session store、内部 CRUD
工具箱或多层 pass-through wrapper 购买“扩展性”。扩展通过稳定 Interface、版本化
Harness Policy、Adapter conformance 与领域不变量测试实现。

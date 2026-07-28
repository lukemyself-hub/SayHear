---
status: accepted
date: 2026-07-27
---

# Conversation Actions Use Descriptors, a Gateway, and Typed Handlers

Conversation Action 能力使用统一扩展架构，而不是按用户示例向 Harness 增加特殊分支。
版本化 Conversation Action Catalog 由 `ActionDefinition` 组成；每项声明 action kind、
input Schema、target contract、effect class、trust class、confirmation policy、
execution mode、idempotency scope、consistency policy、rate policy、receipt contract、
availability policy 与唯一 typed handler binding。

Conversation Agent Harness 只从本轮 eligible definitions 生成 Functions，并把模型
结果规范化为 ActionProposal。`Action Gateway` 是所有 Proposal 的共同执行入口；它
负责冻结 Definition、Schema 校验、Action Reference 解析、owner / Version /
capability / permission / confirmation / rate / freshness / `data_epoch` / deletion
fence、幂等 ActionExecution 获取、handler dispatch 和 immutable receipt commit。

每个 `Action Handler` 是实现具体领域语义的 deep Module。它只接收 Gateway 已验证的
action context 与该 action kind 的 typed input，随后在一个领域事务中提交权威变化，
或创建幂等 Durable Workflow command，并返回结构化 handler outcome。Handler 不能
处理 Provider message、Framework Session、Function selection 或最终 Assistant
Response；Harness、Provider Adapter 和 API handler 不能复制 handler 的领域规则。

ActionDefinition 不是万能业务规则 DSL。Descriptor 只承载 Gateway、Harness、权限、
可观测性和 receipt 所需的横切契约；Claim、Journal、Profile、删除、导出或外部副作用
的算法、状态机与不变量继续封装在 typed handler 及其领域 Module 中。一个 enabled
definition 必须恰好绑定一个兼容 handler；缺失、重复或 Schema / handler version
不匹配时，Catalog version 不得发布或 runtime 必须 fail closed。

新增 Action 的标准扩展路径是：发布 ActionDefinition、实现 typed handler、注册唯一
binding，并通过 Catalog、Gateway、handler、receipt 与 Replay conformance。正常新增
能力不得修改 Harness loop、Provider Adapter、ActionProposal envelope、
GenerationCommand stages 或 Finalization 流程。具体用户例子只作为 conformance
fixture；只有现有元模型无法表达新的跨能力不变量时，才修改主架构。

Action Gateway 的通用生命周期分离一次性 Admission 与后续 Execution 状态；Receipt
序列是权威事实，ActionExecution 上的 current status 只是可重建 projection。具体
Handler 不能另造 action-local 的“已受理 / 处理中 / 已完成”状态机。

当前模型可见 Definition 的 `confirmation_policy` 只能是 `none`。Catalog 发布检查
拒绝任何需要二次确认或 step-up 的 Definition；该字段是显式安全声明，不表示当前
Harness 已实现跨 Turn confirmation workflow。

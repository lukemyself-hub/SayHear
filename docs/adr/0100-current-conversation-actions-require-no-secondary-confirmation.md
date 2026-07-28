---
status: accepted
date: 2026-07-27
---

# Current Conversation Actions Require No Secondary Confirmation

当前 Conversation Action Catalog 只发布用户在已认证会话中明确提出后，可以安全直接
执行的 Action。所有 enabled ActionDefinition 的 `confirmation_policy` 必须为
`none`；需要二次确认、step-up reauthentication 或不可逆高风险授权的能力不能进入
模型可见 Catalog，Catalog 发布检查与 runtime 都必须 fail closed。

因此当前 Conversation Agent Harness 不实现 pending confirmation、
ConfirmationChallenge 或跨 Turn 确认绑定。模型不能通过自然语言触发 Account
Deletion 等高风险操作；此类产品能力使用独立设置入口和专用确定性流程。用户在对话中
提出这类要求时，SayHear 说明当前不能在对话中执行，并在存在正式入口时引导用户前往，
不得创建近似 Action、挂起待确认操作或声称已经开始。

这不取消 Action Gateway 对 target、owner、权限、Version、freshness、`data_epoch`、
deletion fence 与幂等的校验，也不降低 Memory Correction、Memory Forget Request 或
Derived Artifact Regeneration 等当前 Action 的领域安全要求。它只明确：当前 Catalog
中不存在“理解无歧义但必须再次确认后才能执行”的 Action。

未来若确实要让自然语言 Agent 发起需要二次确认的高风险操作，必须先以新的产品范围与
ADR 定义确认身份、目标冻结、过期、拒绝、重放和审计语义，再发布新的 Catalog /
Definition version；不能把该能力作为现有生命周期中的隐藏分支加入。

---
status: accepted
date: 2026-07-27
---

# Conversation Actions Come From a Versioned Allowlist

Conversation Model 只能从当前已发布、版本化并按阶段、权限与运行状态过滤的
`Conversation Action Catalog` 中提出一个高层产品 Action。Catalog 描述用户真正可以
要求 SayHear 完成的能力；Claim 写入、Journal 修复、Profile 重建、索引失效和
Workflow 启动等内部传播机制不作为独立模型工具暴露。

当前 Catalog 还只允许在已认证会话中无需二次确认或 step-up 即可安全直接执行的
Action。需要额外确认的高风险能力使用独立产品入口，不暴露给 Conversation Model。

如果用户请求无法由当前 Catalog 中某个 Action 准确实现，SayHear 必须明确返回
`unsupported`，不能发明工具、选择语义相近但不同的 Action、模拟执行结果或声称未来
派生工作已经完成。这样牺牲开放式自动化范围，换取可验证的产品承诺、权限边界和用户
信任；每个高层 Action 内部仍可按确定性规则维护所有受影响权威对象与派生产物的一致性。

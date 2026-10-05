# G1 token 用量记录与预算监控

Luke 要求给充分上限，完整跑任务，记录实际消耗，再检查冗余和优化。临时 100000 摸底已记录 11 次调用，但第三天 Daily 数据库提交失败，尚未完整通过。生产仍 G1-off。

独立调查确认 G1 role attempt 没有持久化 input/output；ModelRoleCallUsage 仅在 Provider 进程内可见。现有 generation Inspector query 依赖 interaction_turns 和 compiled_contexts，无法显示 G1 role attempts。现有 input_tokens/output_tokens 列可复用，reasoning/cache/total 需要新增可空列。未知用量不等于零。

实施范围是内容为空的计数监控，不修改 Prompt、语义判断、模型路由、准入或重试规则。每次实际 attempt 记录成功及失败用量；本次 ProviderResponseFailure 的用量优先于 callback，不复用别的调用。四角色分别记账，Validator 独立 attempt。数据库新列使用 forward migration，不修改发布过的 migration。保持对话和 Journal 的原路径兼容。

报告按角色、命令及 attempt 汇总，包括失败、discarded、result_unknown 和重试。输出已知用量之和以及未知计数。输出/冻结配置上限达到 80% 或 95% 时标注观察提示，不把提示变成发布或业务门禁。报告不包含请求、响应、Evidence、正文、reasoning 原文、凭据或数据库 URL。

验收覆盖正常、schema/截断失败、未知 usage、独立两次调用不串用、技术重试总用量、重复结果记录与 fencing、四角色实际数据库持久化及只读报告。由 OpenCode 实现和独立 Review，父代理复查相关测试和全量回归，再完整跑隔离真实 Provider。

永久上限在完整任务和实际用量分析后决定，不能从单轮宣称 P95。保留每轮失败证据，生产启用沿原冻结/manifest/pins/部署检查流程执行。

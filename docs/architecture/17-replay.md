# Replay 评估架构

## TL;DR

- Replay 比较模型、Prompt 和工作流，但永不写回正式产品状态。
- Initial Replay 仅使用 synthetic、匿名化或独立授权数据。
- 读取真实私人 source 前必须启用隔离运行时、受限 snapshot 与出站审查。

## Status

Proposed

## 17. Replay 评估系统

### 17.1 目的

Replay 用于比较：

- 模型；
- Prompt；
- Context Compiler；
- Retrieval；
- Journal policy；
- Memory extraction；
- 中文 / 英文与 code-switching 表现；
- 延迟与成本。

### 17.2 隔离边界

Replay 分为两个安全级别。

**Initial Replay** 用于先验证 Replay 数据模型、rubric、比较流程和失败语义：

- 只读取 synthetic、匿名化或独立授权且已放入 eval dataset 的输入；
- 可以在本地、CI 或 `sayhear-app` 的受控进程中运行；
- 使用 eval-only repository / database role，输出只进入 `eval` schema；
- 不读取正式领域表，不接收正式数据库 credential，不调用有业务副作用的工具；
- 所有输出标记 `non_authoritative`；
- 不触发正式 outbox、通知或后续工作流；
- 不要求先部署 `sayhear-eval`、job-scoped snapshot API 或 Provider Egress Gateway。

**Private Replay** 从第一次读取 Internal Owner 的真实私人 source 前开始。它使用
独立部署的 Replay Runner，以及 PostgreSQL 中独立的 `eval` schema 和数据库角色：

- 无权写 Conversation、Evidence、Entity、Journal、Reflection、Claim、Profile；
- 无权调用具有业务副作用的工具；
- 输出只能写 `eval` schema；
- 所有输出标记 `non_authoritative`；
- 不触发正式 outbox、通知或后续工作流。

Private Replay 强隔离要求：

- Replay Runner 使用独立部署、队列和环境变量；
- 其运行环境中不存在正式领域写凭据；
- 真实私人 Replay 只通过 job-scoped snapshot API 取得 source；
- Replay Runner 不持有正式数据库凭据，连静态只读全库凭据也不持有；
- snapshot API 同时校验 `replay_run_id + source_revision + expected_data_epoch`，
  只返回本次用户显式选择的不可变输入；
- synthetic / 匿名化 / 独立授权 eval dataset 才允许从隔离的 eval 数据库直接读取；
- ToolRegistry 结构上不注册任何有副作用的工具；
- Provider egress 只允许本次显式选择的 Provider；
- 数据库 grant、RLS 和“无法正式写入”测试属于部署门禁。

### 17.3 数据模型

```text
replay_runs
replay_provider_attempts
replay_outputs
replay_ratings
replay_comparisons
eval_dataset_items
eval_rubric_versions
replay_retention_policies
```

每个 Replay 固定：

```text
source_revision
source_event_revision_ids
evidence_ids
referenced_entity_version_ids
referenced_claim_version_ids
compiled_context_version
prompt_version
model_config_version
provider
data_region
parameters
rubric_version
```

### 17.4 隐私规则

- Initial Replay 的 dataset ingress 必须验证数据类别和授权状态，禁止把正式领域
  source 复制进 eval dataset 来绕过 Private Replay 门禁；
- Private Replay 必须由内部用户显式选择 source 和 Provider；
- 不自动发送给多家供应商；
- Source 删除后 Replay 立即不可读取；
- 提交结果前再次检查 source revision 和 `data_epoch`；
- 原始音频只可在 72 小时窗口内 Replay；
- 不复制一份音频绕过原 TTL；
- 自动化回归只使用合成数据或独立授权的数据集；
- v0.1 的真实 Replay output 默认保留 30 天；
- 每次真实 Replay 必须绑定 `retention_policy_id` 和 `expires_at`；
- 合成音频、Provider 原始响应和评分备注使用同一或更短 TTL；
- 真实 `eval_dataset_items` 同样必须有 consent、lineage、TTL 和删除传播；
- Replay 同样进入 lineage 和删除传播。

Source 删除优先于 Replay TTL。任何在途 Replay 在提交前都必须通过
source revision 和 `data_epoch` guard；失败时丢弃结果。

### 17.5 盲测

Review UI 隐藏 Provider 名称，独立评分：

- 被理解感；
- 是否擅自建议；
- 追问是否必要；
- 是否虚假认同；
- 事实与推断边界；
- 记忆自然度；
- Journal 证据支持；
- 语言自然度；
- 声音和停顿；
- 延迟；
- 成本。

## References

- [原始 核心架构 v0.1 快照](../archive/architecture/sayhear-core-agent-architecture-v0.1.md)
- [Provider 与本地化](15-16-providers-and-localization.md)
- [隐私、安全与生命周期](18-20-privacy-security-lifecycle.md)

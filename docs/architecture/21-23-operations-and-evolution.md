# 运维、部署与演进

## TL;DR

- 日志、诊断、紧急开关和成本观测不能泄漏私人正文。
- 部署从模块化单体开始，只在明确触发条件下拆分运行边界。
- Schema、Prompt、Workflow、ID namespace 和模型下线都需要版本化演进。

## Status

Proposed

## 21. 可观测性与内部运维

### 21.1 运行元数据

`generation_commands`：

```text
operation_type
intent_key
subject_type
subject_id
input_revision_kind
input_revision
freshness_policy
model_config_version
expected_data_epoch
status
authoritative_result_id
created_at
settled_at
```

`model_run_attempts`：

```text
generation_command_id
attempt_no
operation_type
subject_type
subject_id
input_revision_kind
input_revision
provider
model
model_snapshot
provider_request_id
prompt_version
context_compiler_version
started_at
completed_at
first_token_at
input_tokens
output_tokens
audio_seconds
cost
finish_reason
status
error_code
```

两张表都只保存运行元数据，不保存 Prompt、输入、输出或未交付全文。
1A.1 不保存用于恢复的流式正文；如果后续 Voice delivery ADR 引入短期 buffer，
必须同时定义加密、活跃存储 TTL、备份窗口与删除传播。
独立 `model_run_artifacts` 在 v0.1 默认关闭。

`workflow_runs`：

```text
workflow_type
subject_type
subject_id
input_revision
policy_version
external_run_id
attempt
status
started_at
completed_at
error_code
```

### 21.2 日志红线

Vercel、Sentry、OpenTelemetry、AI SDK telemetry 和 LiveKit tracing 不得采集：

- request / response body；
- Transcript；
- Journal；
- Reflection；
- Entity label / alias；
- Evidence locator；
- Memory statement；
- Prompt rendered content；
- Provider 原始错误体中的用户内容；
- 签名 URL；
- Audio bytes。

日志只记录：

- correlation ID；
- object ID；
- revision；
- 状态；
- 延迟；
- token / audio usage；
- retry count；
- error category。

### 21.3 内部诊断界面

内部工具应支持：

- 查看 Daily Session、InteractionTurn 和 Event revision；
- 查看 EvidenceItem、typed Evidence link 与底层 source；
- 查看 Entity、EntityVersion、Mention、label 和 merge / split 历史；
- 查看 Context 各层引用与 token；
- 查看检索候选及最终选择；
- 查看 Claim 与 typed Evidence；
- 查看 Journal Statement Evidence 与运行 lineage；
- 查看 ReflectionVersion、Statement Evidence 和 Candidate lineage；
- 查看 Workflow 状态和重放；
- 查看删除回执；
- 查看 AudioAsset 到期状态；
- 创建显式 Replay；
- 盲评 Replay 输出。

查看正文和音频属于敏感访问，必须记录 access audit。

### 21.4 紧急开关

至少保留：

```text
provider_enabled
audio_retention_enabled
memory_writes_enabled
evidence_extraction_enabled
entity_resolution_enabled
journal_publish_enabled
reflection_commit_enabled
replay_enabled
realtime_voice_enabled
```

紧急关闭写入不应影响用户导出和删除。

### 21.5 成本观测

按能力拆分成本，不只观察总账单：

- Realtime Voice 分钟；
- 独立 STT 分钟；
- TTS 字符或音频分钟；
- conversation token；
- Journal / Reflection token；
- Evidence / Entity extraction token；
- Embedding 与重建；
- Replay 额外调用；
- LiveKit Room / Agent；
- PostgreSQL compute / storage；
- S3 storage / request / KMS。

每个 ModelRunAttempt 和 ReplayRun 记录估算成本。预算超限时可以停止 Replay
或降级非关键后台任务，但不能静默切换到未经评估的对话模型。

## 22. 部署拓扑

### 22.1 Core Flow 1A

```text
Vercel project: sayhear-app
  - Next.js Web
  - BFF / API
  - lightweight scheduled recovery scanner (1A.1)
  - Vercel Workflows (1A.2+)
  - Cron / outbox dispatcher (1A.2+)
  - in-process Provider Egress Port
  - server-only Provider credentials

US single region
  - Neon PostgreSQL + pgvector
  - AWS S3 + KMS

External model APIs
  - one configured Conversation provider (1A.1)
  - additional approved OpenAI / Anthropic / Qwen endpoints (1A.4+)
```

1A.4 的 Initial Replay 可以在本地、CI 或 `sayhear-app` 受控进程内运行，不新增
部署。第一次执行 Private Replay，或 1B 引入 LiveKit Agent Worker 前，必须完成
Provider Egress trust-boundary review。

Private Replay 门禁要求新增：

```text
Vercel project: sayhear-eval
  - isolated Replay Runner
  - Replay Workflows
  - job-scoped calls to sayhear-app snapshot API

Vercel project: sayhear-egress
  - extracted Provider Egress Gateway
  - only runtime with general Provider static credentials
  - no product database credential
  - authorization / claim-and-fetch / result-ingest contract
```

选择单一美国区域，Web、数据库、对象存储尽量邻近。
Internal Core 允许数据库 scale-to-zero，但需要接受冷启动。

领域实现只依赖标准 PostgreSQL、SQL migration 和 `RetrievalStore`，
不把 Neon 分支、代理或管理 API 写入业务逻辑，以保留数据库迁移能力。

### 22.2 Core Flow 1B

新增：

```text
LiveKit Cloud
  - WebRTC media
  - Agent dispatch

LiveKit Agent Worker
  - LiveKit Cloud Agents managed deployment
  - Node.js
  - provider plugins
  - authenticated SayHear API client
```

Core Flow 1B 默认使用 LiveKit Cloud Agents 的托管 Agent deployment。
原因是 Voice Worker 需要常驻进程、Room dispatch、并发扩缩和媒体延迟控制，
不适合普通 Vercel Function。

1B.1 与 1B.2 复用同一部署拓扑；1B.2 是 delivery correctness 增量，不创建另一套
媒体服务。

进入 1B 前用真实中英文长会话验证：

- 目标 Region 和端到端延迟；
- warm / cold dispatch；
- secret 与 service identity；
- autoscaling 和并发上限；
- log / trace redaction；
- rolling deploy、crash recovery 和成本。

只有托管部署无法满足其中的硬门槛时，才通过新的 ADR 迁往常驻容器平台；
领域 API、VoiceTransport 和 RealtimeVoiceProvider 接口保持不变。

### 22.3 External MVP 面向真实用户前

- 关闭数据库 scale-to-zero；
- 开启 PITR 和受控备份；
- 进行恢复演练；
- 为数据库和 LiveKit Worker 设置容量与告警；
- 明确 Provider 数据地区和 retention；
- 评估至少两个关键 Provider 的故障处理；
- 配置成本预算与 kill switch；
- 完成正式认证与权限；
- 完成危机与高风险内容处置策略。

## 23. Schema、Prompt 与 Workflow 演进

### 23.1 数据库迁移

- 所有迁移进入版本控制；
- 生产迁移向后兼容优先；
- 大表 backfill 与在线读写分开；
- 删除列分阶段；
- 每次迁移包含 rollback 或 forward-fix 方案；
- 对 Memory / Journal 认识状态变化做显式数据迁移。

### 23.2 ID 与 Namespace 演进

- Predicate Registry 的命名、映射、发布和治理以 7.10.1 为准；
- 已发布的对象 ID 永不复用，也不改变对象种类或 owner；
- `sh.*` kind / predicate 定义保存独立 registry、schema version、status 和
  `replaced_by_id`；
- display label、翻译或 Prompt 文案变化不改变 namespace ID；
- predicate 语义发生实质变化时创建新 ID，旧 ID 标记 deprecated，不静默改义；
- Entity merge / split 创建 EntityVersion 和显式 mapping，不批量覆写历史 Evidence；
- external identifier mapping 记录来源、置信度和核验版本，可撤销但不改变内部 ID；
- ID backfill 必须建立旧键到新 ID 的映射和 lineage，并通过删除传播测试。

### 23.3 Workflow 版本

- 已开始的 run 固定原部署版本；
- 新 command 使用新版本；
- 业务写入仍检查 source revision；
- 不让旧 Workflow 覆盖新状态；
- 需要重处理时创建新 command，不修改历史 run。

### 23.4 模型下线

- ModelRunAttempt 永久记录原模型标识；
- 新请求由 Model Registry 切换；
- 历史内容不因模型下线自动重生成；
- 通过 Replay 验证候选替代模型；
- 迁移以 role 为单位，不全系统同时切换。

### 23.5 Prompt migration

- Prompt 层独立版本；
- 同一 Session 的在线人格策略保持稳定；
- 新版本先跑 synthetic eval，再跑显式 Replay；
- 通过质量门槛后才成为 Champion；
- 历史 Journal 不自动覆写。

## References

- [原始 核心架构 v0.1 快照](../archive/architecture/sayhear-core-agent-architecture-v0.1.md)
- [架构概览](01-06-overview.md)
- [隐私、安全与生命周期](18-20-privacy-security-lifecycle.md)

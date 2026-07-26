# Durable Workflow 可靠性

## TL;DR

- 可靠异步派生从 1A.2 开始，使用 Durable Workflow 与 transactional outbox。
- 业务幂等、新鲜度、并发控制、重试分类和 reconciliation 由确定性代码控制。
- Workflow payload 使用 ID 与版本引用，不携带不必要的私人正文。

## Status

Proposed

## 13. Durable Workflow 可靠性

### 13.1 选择

从 Core Flow 1A.2 开始使用 Vercel Workflows stable v4。1A.1 不用 Durable
Workflow 承载在线回复、inactivity timeout 或卡住 Turn 的恢复。

原因：

- 与 Next.js / Vercel 一体；
- TypeScript 控制流；
- durable step；
- 自动重试；
- 部署版本隔离；
- 无需长期运行通用 Worker；
- 内建运行可观测。

### 13.2 业务幂等

Workflow run ID 不能作为业务幂等键。

建议唯一约束：

```text
interaction_turns(user_id, client_turn_id)
conversation_events(user_id, client_event_id)
journal_versions(journal_id, source_revision, generation_policy_version)
reflection_versions(reflection_id, source_revision, policy_version)
evidence_items(source_type, source_version_id, locator_key, extraction_policy_version)
entity_mentions(event_revision_id, start_offset, end_offset, resolver_policy_version)
generation_commands(operation_type, intent_key)
model_run_attempts(generation_command_id, attempt_no)
workflow_commands(command_type, subject_type, subject_id, source_revision, policy_version)
outbox_events(aggregate_type, aggregate_id, aggregate_revision, event_type)
```

`interaction_turns.client_turn_id` 和 `conversation_events.client_event_id` 应实现为
只覆盖非空值的 partial unique index。
`generation_commands` 的稳定 intent key 控制一个逻辑生成任务，不能因 model config、
部署滚动或 fallback policy 改变而产生第二个 command；`model_run_attempts` 不按业务
字段去重，因为同一个 command 可以合法发生多次真实 Provider 调用。

### 13.3 Transactional Outbox

从 1A.2 开始，领域状态更新和 outbox insert 在同一数据库事务中完成。

Outbox dispatcher：

- 可以重复读取；
- 发布成功后记录 receipt；
- 未确认事件持续重试；
- 不把用户正文放进 payload；
- payload 只包含 aggregate ID、revision、event type。

可运行拓扑：

1. 领域事务 commit 后，请求路径 best-effort 调用一次短生命周期 dispatcher；
2. Vercel Cron 周期调用同一个 dispatcher，补捞所有到期且未确认的 row；
3. dispatcher 在短事务中用 `FOR UPDATE SKIP LOCKED` 领取 batch，
   写入 `lease_owner / lease_expires_at / attempt_count` 后提交；
4. 事务外启动对应 Vercel Workflow；
5. 只有取得 Workflow start receipt 后，才在新事务中标记 `dispatched`；
6. 超时或失败根据 `next_attempt_at` 重试，过期 lease 可由其他 invocation 接管；
7. `workflow_commands` 的稳定 intent key 吸收重复 dispatch；
8. dead-letter 只停止自动重试，不删除 outbox 或领域状态。

1A.1 已有的轻量定时恢复扫描器直接处理 `next_evaluation_at_utc` 和卡住 Turn，
不创建 WorkflowCommand 或 outbox row。1A.2 引入 dispatcher 后，可以由同一 Cron
route 先运行恢复扫描，再补捞 outbox；不要建设第二套调度服务。异步派生的即时
best-effort 提供低延迟，Cron + lease 才提供最终启动保证。

部署要求：

- `sayhear-app` 使用支持 minute-level Cron 的 Vercel plan；
- Cron route 使用独立 `CRON_SECRET` / service scope；
- Vercel Cron 可能重复触发且失败不自动重试，因此正确性只依赖数据库 lease、
  idempotency 和下一次扫描；
- 如果当前 plan 只能按日触发，Core Flow async reliability gate 不通过；
  应升级 plan 或在本地使用同一 dispatcher runner，不能把每日补捞当成正式方案。

`outbox_events` 至少保存：

```text
status
next_attempt_at
lease_owner
lease_expires_at
attempt_count
workflow_receipt_id
last_error_code
```

Workflow step 必须使用同样的数据最小化模式：

1. step 参数只接收 command / attempt / source ID、revision 和 policy version；
2. step 调用同一 application service，由服务端 repository 读取冻结 source，
   并通过 in-process Provider Egress Port 完成 policy check 与 Provider 调用；
3. Workflow history 不接收正文或 Provider credential；credential 只存在于
   执行 Egress Port 的 server runtime；
4. application service 校验 attempt、Schema 和大小上限，把结果写入
   role-specific 非权威结果表，例如 Journal Draft、Reflection Draft、
   Entity resolution candidate、Memory Candidate 或 Replay Output；
   1A.1 Conversation streaming 不经过该异步 ingest，也不写 delivery chunk；
5. ModelRunAttempt 只保存结果 ID 和运行元数据；Workflow 只接收结果 ID、状态和
   非敏感统计，再由领域 Service 执行 commit fence 和 authoritative CAS；
6. 不把 Transcript、Journal / Reflection Draft、Entity label、Memory statement
   或完整模型结果作为
   step input / output 返回给 Workflow history；
7. 禁止 step closure 捕获 Prompt、Transcript、Journal、Reflection、Entity label
   或 Memory 正文；
8. Provider 原始异常必须先清洗成 allowlisted `error_code`，再抛给 Workflow；
9. step 间只能传递 ID、revision、状态和错误代码；
10. content HMAC 也不得进入 Workflow history；需要比对时由受控 API
    在数据库事务内按 ID 完成。

Provider Egress Gateway 抽离后，第 2–4 步再替换为 authorization、
`claim-and-fetch` 和受控 `result-ingest`，不提前把这套网络协议塞进 1A.1。

实现时提供统一 `safeWorkflowStep()` wrapper 和窄类型，
并以 canary 集成测试扫描 Workflow history。该约束不能只依赖人工 code review。

### 13.4 并发控制

Vercel Workflows v4 原生 keyed concurrency 不作为前提。

使用：

- PostgreSQL unique constraint；
- `SELECT ... FOR UPDATE`；
- advisory lock；
- compare-and-set；
- source revision；
- `data_epoch` fencing token。

`users.data_epoch` 使用 `bigint not null`。`workflow_commands`、`generation_commands`
和 `replay_runs` 保存启动时的 `expected_data_epoch`。

每次 authoritative write 必须在同一个数据库事务中：

1. 锁定 User / Aggregate；
2. 检查主体仍为 `active`；
3. 检查 `data_epoch = expected_data_epoch`；
4. 检查没有有效 tombstone；
5. 按 Command 的 `freshness_policy` 检查版本；
6. 写入结果及后续 outbox；
7. 一次性 commit。

`freshness_policy` 是版本化领域契约，不能由每个 Workflow 临时手写：

| Policy | 适用 | Commit 条件 |
| --- | --- | --- |
| `exact_head` | Journal publish、current Reflection、current Profile Projection | aggregate head 必须仍等于 expected revision |
| `source_still_valid` | Evidence / EntityMention extraction、Event Memory extraction、Embedding、Assistant delivery、frozen Episode | 所有具体 source version 仍有效；aggregate head 可以前进 |
| `monotonic_projection` | Rolling Summary、DialogueState | 冻结覆盖区间仍有效，且 current pointer 只能向更高 coverage / revision 前进 |

示例：

- 新 User turn 到来后，旧 Journal Draft 可以完成但 `exact_head` 禁止发布；
- 新 User turn 不会淘汰前一 Event 的 Memory extraction / Embedding；
- Summary 可以在 Session 继续增长后提交其冻结 prefix；
- barge-in 后 confirmed Assistant prefix 可以提交，即使后续 User Event 已增加
  Session revision；
- 较晚完成的旧 DialogueState 可以留作历史，但不能把 current pointer 回退。

禁止在事务外“先检查、后写入”。该 guard 下沉为共享 repository /
application primitive，覆盖 Evidence、Entity resolution、Journal、Reflection、
Claim、Embedding、Summary、Transcript finalization 和 Replay。

删除事务必须先把主体设为 `deleting` 并增加 epoch，再发布删除 command。
旧部署或旧 Workflow 因此不能覆盖新 revision 或复活删除数据。

该 commit guard 不能保护已经发生的第三方网络副作用。
所有 Provider dispatch 还必须执行 15.8 的 Egress Authorization fence。

### 13.5 重试分类

| 类型 | 策略 |
| --- | --- |
| 网络错误、429、5xx | 指数退避 + jitter |
| Provider 超时、结果未知 | 新建 attempt 并保留旧审计；command 只 CAS 一个 authoritative result |
| 鉴权与配置错误 | terminal failure |
| Schema 错误 | 有限次数 repair |
| 无效业务状态 | 不重试，记录 rejected |
| 删除或 revision 失效 | fail closed |
| 超过最大次数 | needs_review / dead-letter |

### 13.6 Reconciliation

1A.1 的轻量定时恢复扫描器只周期检查：

- 到期且 revision 仍匹配的 inactivity evaluation；
- 超过恢复窗口仍未 settled 的 `responding` InteractionTurn / ModelRunAttempt；
- Provider 调用成功但 command 没有 authoritative result 的孤立 ModelRunAttempt。

从 1A.2 开始建立通用异步 reconciliation，并只检查当期 Slice 已存在的数据面：

- 1A.2：未发布或卡住的 outbox、超过时限的 Workflow、重复 published Journal、
  引用已删除 Evidence 的 active Journal、未完成 deletion request；
- 1A.3：重复 current ReflectionVersion、无源 Embedding、引用已删除 Evidence
  的 active Claim / Reflection、无有效 Mention / Evidence 的 active Entity label；
- 1A.4：已失效 source 的 Replay；
- 1B.1：过期未删除音频、卡住的 Transcript finalization 和 Voice runtime cleanup；
- 1B.2：卡住或无法收敛的 delivery receipt / buffer。

## References

- [原始 核心架构 v0.1 快照](../archive/architecture/sayhear-core-agent-architecture-v0.1.md)
- [隐私、安全与生命周期](18-20-privacy-security-lifecycle.md)
- [测试与交付](24-29-testing-and-delivery.md)

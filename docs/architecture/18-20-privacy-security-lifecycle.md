# 隐私、安全与数据生命周期架构

## TL;DR

- 隐私、权限、删除和审计是领域能力，不是部署后的补充配置。
- 内部音频 72 小时后不可访问，并由应用删除与独立 Lifecycle 兜底。
- 删除能力随数据面扩展，所有读取、召回、Replay 与 Provider Egress 都必须 fence。
- Conversation Action 长期审计只保存最小 envelope，临时参数加密短存且不进入日志或 Workflow history。
- External MVP 的 Account Deletion 要求完整 ledger、Provider reconciliation 与备份防复活验证。

## Status

Proposed

## 18. 隐私、安全与数据生命周期

### 18.1 数据分类

| 级别 | 示例 | 处理 |
| --- | --- | --- |
| Highly Sensitive Content | 对话、Journal、Profile、Memory、音频、Replay 输出、临时 Action payload | 严格权限、加密、禁止普通日志 |
| Sensitive Derived Data | Embedding、Summary、Episode、Memory Candidate 语义、分类结果 | 与源数据同等删除和访问控制 |
| Operational Metadata | ID、状态、延迟、token、错误类别 | 可进入脱敏观测 |
| Public / Static | 产品策略版本、无用户内容 Schema | 正常版本管理 |

### 18.2 认证与权限

#### Core Flow 内部身份

默认实现使用 Auth.js、GitHub OAuth 和 PostgreSQL database session。
这不是长期消费者登录的永久决定，但足以给 Foundation 一个可实施且可撤销的身份边界。

```text
auth_identities(issuer, subject, user_id, status)
auth_sessions(id, user_id, expires_at, revoked_at)
```

- Phase 1 部署配置只允许一个明确的 `(issuer, subject)`，并绑定到预置且稳定的
  Internal Owner `user_id`；email 不作为 owner key；
- Internal Owner 进入 1A.3 时幂等创建唯一 Self Entity 与
  `user_self_entities` binding；1A.1 / 1A.2 的 Auth identity 仍只映射到
  `user_id`，不提前充当或建设 Entity identity；
- 任何其他人类身份都拒绝登录，不建设注册、邀请、账号恢复、角色管理或用户后台；
- Browser 只持有 HttpOnly、Secure、SameSite cookie；
- BFF 校验 database session，再从服务端 identity mapping 得出 `user_id`；
- API 不接受客户端提交的 owner ID；
- 单一 Internal Owner 可以使用诊断、Replay 和授权音频检查能力，但这些敏感操作
  仍需独立 capability check，不能因只有一个用户而绕过；
- 查看完整对话、Candidate review 中的完整 Evidence、下载音频、创建真实 Replay
  需要 10 分钟内完成的 step-up reauthentication，并写 access audit；
- Candidate review audit 至少记录 reviewer、Candidate、Evidence revision、
  disposition、reason、policy version、Proposal ID、predecessor Candidate、
  successor trigger 与时间，但不复制私人正文；
- terminal Candidate 的 7 天派生内容只允许 step-up 后的 Internal Owner 排错读取；
  不能因仍在 grace period 就进入普通开发者列表、Recall、Profile 或模型 Context；
- session 支持服务端撤销，删除账号时在同一 command 中先撤销全部 session。

#### LiveKit Client Token

- 只允许已认证 BFF 签发；
- 使用 LiveKit server credential 签名，`iss` 为对应 API key；
- `sub` 使用不可猜测的 session-scoped participant identity；
- grant 只允许加入一个确定 Room，不给 room admin / recording / egress 权限；
- TTL 不超过 5 分钟；
- Room 名称和 Daily Session 映射由服务端生成；
- LiveKit token 只以 LiveKit SDK 定义的 issuer、signature、expiry 和 grant
  作为校验契约；不虚构 SDK 不支持的通用 `aud` claim。

#### Service Identity

Agent Worker 不复用用户 cookie。它使用 deployment-specific 非对称 client assertion
调用内部 token exchange，再获得短期 service JWT；bootstrap private key 只存在于
托管 Agent secret store，SayHear 只保存公钥和 deployment status：

```text
iss = sayhear-identity
aud = sayhear-domain-api
sub = voice-agent/<deployment-id>
scope = voice:session:read voice:turn:write voice:delivery:write
voice_session_id = <authorized session>
room_id = <authorized room>
expected_data_epoch = <epoch at dispatch>
iat = <issued at>
exp <= iat + 5m
jti = <unique token id>
kid = active signing key
```

SayHear API 同时验证 issuer、audience、signature、expiry、deployment status 和 scope。
它还必须验证 route 中的 `voice_session_id / room_id` 与 resource grant 完全相同，
并再次检查该 Session 的 owner、active status 和 `data_epoch`。
Voice identity 不能调用 Journal publish、Memory mutation、Replay 或任意用户查询 API。

Token exchange 只接受已经由 BFF 授权并由 LiveKit dispatch 证明的 Voice job。
client assertion 带一次性 `jti`；exchange 在 PostgreSQL 中原子消费该 `jti`，
重复 assertion 失败。短期 access token 也有唯一 `jti`，支持 job 撤销，
但可在同一个已授权 Voice job 内调用多个窄 API。

Private Replay Runner 使用不同的
`aud = sayhear-eval-api` 和 `scope = replay:snapshot:read replay:result:write`，
并绑定不可变的 `replay_run_id`、`source_revision` 和 `expected_data_epoch`。
该 token 对正式 domain write endpoint 无效；真实数据只能通过 job-scoped snapshot API
读取，Runner 没有正式数据库 credential。

#### 本地开发与轮换

- 本地只使用 `.env.local` 中未提交的开发 signer 和 seed identity；
- 只有 `NODE_ENV=test` 可以启用固定 test principal；
- Preview / Production 启动时发现 test principal 或 development key 必须失败；
- 非对称签名 key 通过 `kid + JWKS` 轮换，新旧 key 重叠时间大于 token TTL；
- 轮换、撤销、错误 audience、过期 token 和越权 scope 都有集成测试；
- secret、JWT 和 OAuth code 不进入日志、Trace 或 Workflow history。

External MVP 面向真实用户前：

- 正式 OIDC / Sign in with Apple 等认证；
- 消费者注册、账号恢复、撤销和生命周期；
- 多用户并发与跨账号越权测试；
- session rotation 和撤销；
- 数据库 tenant scoping；
- RLS 或等效 defense-in-depth；
- step-up authentication；
- 管理员访问审计。

### 18.3 加密

Internal Core 最低要求：

- TLS；
- 数据库和对象存储静态加密；
- S3 SSE-KMS；
- 密钥仅在服务端；
- Secret 不进入仓库或日志；
- 签名 URL 极短有效期；
- 敏感字段与运行元数据分表。

External MVP 面向真实用户前：

- 引入 `ContentCipher` abstraction；
- 评估每用户 envelope encryption；
- 保存 key version；
- 执行 key rotation 演练；
- 明确 Embedding 的访问与删除边界。

这仍不等于严格 E2EE，因为应用和第三方模型推理时需要读取明文。

### 18.4 第三方 Provider

Provider Registry 记录：

- 数据处理地区；
- 是否用于训练；
- abuse monitoring / retention；
- ZDR 或同类能力；
- DPA 与政策版本；
- 支持的关闭开关；
- 最后核验时间。

SayHear 自身的 72 小时策略不能被描述为第三方同步删除承诺。

### 18.5 Conversation Action 数据最小化

Conversation Action 的 Proposal、Execution 与 Receipt 长期只保存 Action / Schema /
Catalog version、原始 User Event revision、typed target reference、状态、时间、
allowlisted authoritative change reference 与错误代码。它们不能复制用户原话、
Provider tool-call object、模型解释、自由文本 target 或完整 typed arguments。

Gateway 为 Admission 崩溃恢复必须冻结的 normalized typed arguments 使用独立加密
content row，并记录 payload Schema、retention policy、`expires_at` 与
`content_purged_at`。该 payload 只允许 Gateway recovery capability 在 Admission
尚未 settled 且期限有效时读取：

- 同步 Action 在 Admission / Completion 事务结束后清除；
- 异步 Action 在 Admission 与幂等领域 / Workflow command 原子提交后清除；
- 未完成 Admission 的 Proposal 到期后立即 fail closed，并由 sweeper 清除 ciphertext。

后续 Workflow 只读取已经提交的 ID、revision、policy 与领域 command，不得延长或复制
Proposal payload。Receipt、Finalization source、普通日志、Trace、Workflow history、
Replay fixture 和 Provider 原始错误体都不能成为旁路副本，也不得保存 payload 的
fingerprint、Embedding 或摘要来保留其含义。

## 19. 内部音频 72 小时保留

### 19.1 允许条件

只有同时满足以下条件才创建长期超过处理时间的 AudioAsset：

- 内部账号；
- 明确 opt-in；
- 保存 consent version；
- 目的限定为质量分析；
- 签发上传授权前先创建 `AudioAsset(status=upload_pending)`；
- 由数据库写入 `retention_started_at = transaction_timestamp()`；
- 写入 `expires_at = retention_started_at + 72h`；
- 客户端 capture time 只作非权威诊断元数据，不能延长 TTL。

撤回授权时，现有音频立即进入删除流程。

### 19.2 AudioAsset

```text
id
user_id
conversation_event_id
retention_policy_id
consent_version
client_captured_at
retention_started_at
expires_at
status
staging_object_key
object_key
expected_data_epoch
checksum
delete_attempt_count
deleted_at
deletion_verified_at
```

状态机：

```text
not_retained

upload_pending
  → finalizing
  → available
  → expired
  → deleting
  → deleted

异常：
  upload_failed
  delete_failed
```

### 19.3 存储约束

- 服务端先生成随机 `upload_session_id` 和 staging object key；
- 浏览器只通过 60 秒内有效的 presigned POST 上传到私有 staging prefix；
- POST policy 固定 object key、最大尺寸、Content-Type、private ACL 和 SSE-KMS 条件；
- Finalizer 在同一事务中重新检查 owner、consent、`data_epoch`、status 和 `expires_at`，
  再验证 S3 Head / size / checksum；
- Finalizer 把对象复制到不同的、客户端从未获得写权限的 immutable final key，
  随后删除 staging object；
- Finalize 时已过期、已撤回或 epoch 不一致，必须拒绝激活并立即删除 staging object；
- `upload_pending`、`upload_failed`、multipart 和晚到 staging object 都进入 sweeper；
- 过期 upload session 在 15 分钟内主动清理，staging Lifecycle 仅作兜底；
- 禁止 public access；
- 使用 SSE-KMS；
- 不启用 Object Lock；
- 不做跨区复制；
- 关闭 bucket versioning；若无法关闭，Lifecycle 必须同时清理 noncurrent version
  和 delete marker；
- 原始音频 Bucket 不进入普通内容备份；
- 关闭不必要的媒体 recording / egress；
- 配置 `AbortIncompleteMultipartUpload` 清理失败上传；
- 签名 URL 不落日志；
- v0.1 不签发 presigned GET；内部音频读取通过每个 Range request 都校验
  AudioAsset status、owner、role、step-up 和 `expires_at` 的认证读取网关；
- 已签发的 presigned POST 不能撤销，但它只能写 staging key；
  删除或 epoch 变化后 Finalizer 永不把晚到对象提升为可读 AudioAsset；
- 已经发送到客户端的 bytes 无法“收回”，产品承诺指停止服务端后续读取；
- 临时转码文件使用相同或更短 TTL。

### 19.4 72 小时语义

S3 Lifecycle 不是精确到第 72 小时的调度器。

因此：

1. 以数据库时间为准，`retention_started_at + 72h` 后读取网关立即拒绝读取；
2. Workflow 的物理删除目标是到期后 15 分钟内；
3. 高频 sweeper 补捞删除失败；
4. S3 配置 4-day Lifecycle rule；实际 eligibility / execution 遵循 AWS
   documented UTC day boundary，只作为最后兜底；
5. `oldest_accessible_audio_age` 不得超过 72 小时；
6. `oldest_existing_audio_age` 超过 72 小时 15 分钟立即告警；
7. 主动 sweeper 在 `expires_at + 24h` 仍发现对象时升级为隐私 incident，
   该阈值不依赖 Lifecycle 日期；
8. reconciliation 以 Head / List 验证对象和所有 version 已不存在。

v0.1 的准确承诺是：

- 72 小时后音频不可再访问；
- 正常情况下 15 分钟内完成物理清除；
- 极端应用故障下，4-day 存储 Lifecycle 提供独立清理路径。

S3 Lifecycle 的 eligibility 和执行都不是精确时钟，因此不能把 96 小时描述成
云存储保证的物理删除上限；真实删除时间由 reconciliation 和对象不存在回执记录。

如果未来需要承诺“72 小时后即使存储故障也不可恢复”，
应使用每对象 envelope key，并在到期时销毁密钥材料，
不能只依赖 Lifecycle。

## 20. 删除架构

本节描述完整目标架构，但其交付按实际出现的数据面分级，而不是 Foundation
一次建完：

| 阶段 | 必须具备 | 明确不做 |
| --- | --- | --- |
| Foundation / 1A.1 | stable `user_id`、`data_epoch`、owner / active / epoch 读取与 Egress fence、deletion-compatible lineage、日志脱敏、传输与静态加密、已核验 `backup_policy_version` | 删除 API、通用 deletion workflow、完整 ledger、恢复演练、消费者 UI |
| 1A.2 | operator-only Internal Owner Full Purge；撤销 session / Egress、增加 epoch、清理 Conversation、Evidence、Summary、DialogueState、Conversation Action envelope / payload / Execution / Receipt 与 Journal，生成 active-system receipts；在业务 DB 备份之外保存单 owner 最小 purge marker | 单条 Conversation / Journal 删除、消费者账号生命周期、对所有未来数据类型预建 handler |
| 1A.3 | Full Purge 扩展到 Entity、Episode、Open Loop、Proactive Follow-up State、Reflection、Memory、Profile、Embedding 与相关索引 | 提前建设 Replay 或 Voice 删除 |
| 1A.4 | Full Purge 扩展到 Replay input / output 与相关 eval artifact | 提前建设 Voice 删除 |
| 1B.1 | Full Purge 扩展到 AudioAsset、Transcript revision / segment、Voice runtime metadata 与临时对象 | 提前建设 delivered-prefix buffer |
| 1B.2 | Full Purge 扩展到 delivery metadata、confirmed prefix 与短期 buffer | 改变 1B.1 的 turn-only 语义 |
| External MVP Gate | 用户可触发的 Account Deletion、完整多用户 deletion ledger、Provider destination reconciliation、备份恢复防复活演练、retention 说明 | 单条内容删除仍可按 ADR-0002 延后 |

1A.2 的最小 purge marker 只保存 Internal Owner 的 deletion epoch、时间和无正文
receipt，位于业务数据库备份之外；它用于阻止旧备份直接恢复上线，不提前建设
多 subject keyed reference、HMAC key 轮换和完整 destination 状态机。Internal Core
最多报告 `active_system_deleted` 或 `retention_pending`，不能在 External MVP
级 ledger 与恢复验证完成前对外声称 `fully_expired`。

### 20.1 对象

```text
deletion_requests
deletion_tasks
deletion_receipts
deletion_tombstones
data_lineage_edges
```

### 20.2 状态机

```text
requested
  → access_revoked
  → propagating
  → verifying
  → active_system_deleted
  → retention_pending
  → fully_expired

异常：
  needs_attention
```

`active_system_deleted` 表示在线产品已经不可读取和召回相关内容。
它不等于备份和第三方 retention window 已全部届满。

1A.2 的 Internal Owner Full Purge 可以只实现
`requested → access_revoked → propagating → verifying → active_system_deleted
→ retention_pending` 子集。完整 Account Deletion 状态机和 `fully_expired`
判定属于 External MVP Gate。

### 20.3 执行顺序

1. 单一事务中把主体或源数据标为 `deleting`；
2. 增加 `data_epoch`；
3. 在同一事务撤销所有尚未 dispatched 的 Provider egress authorization；
4. 写入 outbox 并 commit；
5. 所有正常查询、读取网关、召回和 Replay 立即排除该数据；
6. 撤销认证 Session，并停止签发新的读取 / 上传授权；
7. 对象存储立即开始删除；晚到 staging upload 因 epoch fence 只能被清理；
8. 取消可取消 Workflow，并尽力 cancel 已 dispatched Provider request / Realtime session；
9. 通过 fencing token 阻止在途结果提交；
10. 根据 lineage 失效或删除派生数据；
11. 每个存储层和 Provider destination 生成无正文 receipt；
12. reconciliation 再次验证；
13. 在线系统完成后标记 `active_system_deleted`；
14. 记录 Provider 与备份剩余 retention window；
15. 所有允许的保留窗口届满并复核后标记 `fully_expired`。

Deletion receipt 至少区分：

```text
active_system_deleted_at
destination_disposition
provider_disposition
provider_retention_until
backup_retention_until
fully_expired_at
```

用户可见说明必须区分“活跃系统已删除”和“所有允许保留窗口已到期”，
不能在只清理在线数据库后声称所有位置都已物理删除。

Memory Forget Request 不进入 content deletion 状态机。它保留原 Conversation、
Journal 与 EvidenceItem，但创建 Memory-scoped admission / retrieval fence；
Qualifier-level Forget 还会阻止同一旧 Evidence 继续支撑具体角色，或在它是唯一
底层 Evidence 时降级保留中性关系。该 fence 必须覆盖 Extraction、Consolidation、
Profile、Embedding、Context 与 repair，不能因派生物重建而失效；Replay 对历史
source 的只读授权仍遵循其既有隔离规则，不能写回正式 Memory。
Forget fence 提交时，任何 narrative-support link 命中该内容的 current
ProfileVersion 必须立即停止展示，并自动触发不受普通刷新间隔限制的安全重建；
重建失败时保持 Profile 不可用，不能等每周 Cron 或恢复旧 Bio。
Memory Forget Reversal 使用同一个 final / corrected User Event 作为新 Evidence
并创建新 ClaimVersion；旧 Evidence exclusion 继续有效，不能通过备份恢复、Replay、
repair 或重新索引把旧 ClaimVersion、Embedding、Profile 或 Context projection
重新标为 current。

### 20.4 删除范围

Internal Owner Full Purge 以整个 Internal Owner 为 scope，直接清除该 owner 当期存在的
全部正文与派生数据，不执行“删除一条 source 后保留其余证据”的部分重建。下面的对象
清单适用于 Full Purge；其后的单条 Event / Revision 传播算法只保留为未来 granular
content deletion 的设计目标，不属于 Internal Core 或当前 External MVP Gate。

- 原始音频；
- transcript；
- InteractionTurn；
- Conversation Event；
- EvidenceItem 与 typed evidence link；
- 除无正文 Self Entity envelope 与 `user_self_entities` binding 外的
  EntityMention、Entity label、EntityVersion 与 Entity；
- Session Summary；
- Episode；
- Journal；
- Reflection；
- Memory Candidate / Claim / Claim localized projection / Relationship Resolver Hint；
- Predicate Change Proposal 与 Candidate 的 link；不含任何用户内容的 Proposal
  identity、通用定义和治理版本不属于 owner-scoped purge；
- Profile Projection；
- Embedding；
- Context snapshot；
- Conversation Action Proposal envelope、临时 payload、Execution、Receipt 与 typed
  target / authoritative change link；
- cache；
- Replay input / output；
- Replay 生成的音频和授权评语；
- 后续 Voice delivery buffer（如果通过 ADR 引入）与可选 `model_run_artifacts`；
- Provider egress authorization 和其可关联字段；
- 对象存储临时文件；
- Auth Session、step-up credential 与访问能力；Internal Owner 的无正文
  auth identity mapping、User envelope 和 Self Entity binding 保留，
  Account Deletion 才删除；
- VoiceSession、VoiceTurn 和 `voice_runtime_secrets`；
- LiveKit Room、recording 和 egress；
- Provider 端显式创建的 file、batch、conversation 或 vector-store；
- 外部错误处理和观测 Processor 中的内容。

#### 20.4.1 Terminal Candidate 内容过期

`rejected` 与 `stale` Memory Candidate 的派生语义在
`terminal_effective_at + 7 days` 后必须从活跃系统读取面立即失效，并由清理任务
置空或删除。自动 stale 的 effective time 使用原 policy deadline，不能使用延迟
sweeper 的执行时间延长保留期。

清理后只保留字段白名单内的 Terminal Candidate Audit Envelope：ID、terminal
status、reason、policy / model / Registry version、时间、无正文 Evidence lineage、
`content_purged_at` 与 keyed dedupe fingerprint。Fingerprint 只用于阻止相同
Evidence 与语义目标重建同一 terminal proposal，不得用于检索、聚类、分析标签、
Embedding、模型输入或 Proposal 内容。相关 Evidence 全部删除或执行 Full Purge /
Account Deletion 时，Evidence link 与 fingerprint 一并清除。

Predicate Change Proposal 只有在不包含 subject `user_id`、Evidence、具体 value、
用户原话、Entity 或其他可识别私人信息时，才能作为产品治理记录跨 Candidate
purge 保留；reviewer principal 只作治理审计，不得被解释为概念来源。
Proposal–Candidate link 始终属于 owner-scoped lineage，必须随 Full Purge 或
Account Deletion 清除。

7 天是活跃系统的内容可读期限，不等于宣称数据库备份已物理过期。恢复旧备份时必须
先重新应用当前 deadline 与 purge state；已过期正文保持不可读并再次清理，完成前
不能开放流量。

单条 Event / Revision 删除时使用确定性传播规则：

1. 先使该 source revision、EvidenceItem、EntityMention 和所有 typed evidence link
   不可读；同一 InteractionTurn 中包含该 source 独有内容的 Assistant Event /
   delivery 也按 lineage 停止展示并清除正文；
2. 清除仅由该 source 支撑的 Entity label / alias / external mapping；
   Entity 有其他有效来源时保留稳定 ID，否则创建 `unresolved / deleted` EntityVersion；
3. Memory Claim 没有剩余有效 Evidence 时，新建 `retracted` ClaimVersion；
   Relationship Claim 的旧 Resolver Hint 同步失效并在读取时 fail closed；
4. Claim 仍有其他 Evidence 时，先新建 `review_due` Version，再从剩余证据重新计算正文、
   epistemic status 和 confidence；Relationship Claim 在复核通过前不生成或使用 Hint；
   如果被删 source 只使某个 Relationship Qualifier 失去支持，新版本 retract
   或 contest 该 Assertion，并在底层关系仍有有效 Evidence 时只重建中性 projection；
   如果同一 source 也是底层关系的唯一 Evidence，则必须 retract 整条 Claim；
5. 即使存在另一条证据，只要原 Claim 文本包含被删来源独有的细节，
   旧 Version 也不能继续展示或召回；
6. 任何 JournalStatement 引用失效 Evidence 时，整个 JournalVersion 立即停止展示，
   再用剩余事件生成 superseding version；不得只删除 evidence edge 后保留原正文；
7. 任何 ReflectionStatement 引用失效 Evidence 时，整个 ReflectionVersion
   停止驱动 Candidate / Profile，并从剩余 Evidence 重建新版本；
8. 相关 SummaryVersion 和 EpisodeVersion 整体失效并重建；
9. 相关 Embedding 先删除，再从仍有效的新版本生成；
10. Profile Projection、Compiled Context snapshot、Replay input / output 和 cache
   按 lineage 同步失效；
11. InteractionTurn 没有剩余内容 Event 时删除；仍有审计必要时只留无正文 envelope；
12. 所有新版本和重建任务仍受 `data_epoch + source_revision` fencing。

删除传播不能只检查“派生对象是否还有至少一条证据”，还必须检查派生正文是否包含
来自被删 source 的信息。

Append-only 与 privacy erasure 的边界：

- 正常修正和 supersede 保留历史正文 Version；
- Source / Account 删除会物理清除所有受影响 Version 的正文或 ciphertext；
- 覆盖 Event Revision、Transcript Segment、Evidence locator、EntityMention / label、
  Journal Version / Statement、Reflection Version / Statement、Memory Claim Version /
  Relationship Qualifier Assertion / evidence link、localized projection、
  Relationship Resolver Hint、
  Summary、Episode、Profile Projection、Compiled Context snapshot、Replay、Draft、
  Validation artifact、可选 Voice delivery buffer 和 model artifact；
- 可以保留无正文的 identity envelope、revision number、状态、purged lineage 和
  `content_purged_at`，用于证明删除和防止旧任务复活；
- Internal Owner Full Purge 保留无正文的 User、Self Entity 与一对一 binding，
  但清除 Self Entity 的 label、Relationship Memory Claim 和所有内容派生物；
  Account Deletion 才删除该 binding 与 Self Entity；
- 被清除的正文列设为 `null` 或移除对应 content row，不能只标记 hidden；
- 与被删正文相关的 content HMAC、embedding、token offset 和可逆 locator 同时清除；
- deletion ledger 的 keyed subject reference 属于独立防复活机制，
  不能拿来保存正文指纹。

允许在删除后继续保留的例外只能是无正文的必要元数据，例如：

- deletion ledger；
- access audit；
- 安全事件最小记录；
- 财务和用量元数据；
- Workflow 的 ID、状态和错误代码。

每项例外都必须有用途、字段白名单和 retention policy。

删除完成时，允许保留的运行元数据必须去关联化：

- `generation_commands`、`model_run_attempts`、`workflow_runs`、
  `provider_egress_events`、access audit 和费用记录不再保留原始
  `user_id / subject_id / correlation_id`；
- 需要跨备份防复活的记录只使用 deletion-scoped keyed reference；
- `provider_request_id` 只保留到 Provider 删除已验证或其核验过的 retention
  window 到期，随后清除；
- access audit、费用、Workflow、egress 和安全事件分别定义字段白名单与 TTL，
  不能用一个“运营元数据”例外无限保留；
- destination receipt 状态必须是
  `verified_deleted / policy_expired / not_applicable / unknown`；
- 任一必要 destination 为 `unknown` 时，删除只能停在 `retention_pending`，
  不能进入 `fully_expired`。

### 20.5 Tombstone

Tombstone 只保存防复活所需的：

- 无内容标识；
- keyed subject hash / ID；
- subject_hash_key_version；
- source revision；
- deleted_at；
- data epoch。

不得把原文保存在 tombstone。

### 20.6 备份

Foundation / 1A.1 只核验最长备份窗口并以此约束真实私人内容写入，不建设完整
deletion ledger。1A.2 的单 owner purge marker 位于业务数据库备份之外；任何
Internal Core 备份恢复都保持 operator-gated，必须先重新应用该 marker 才能开放读取。
以下独立 ledger、key 轮换和恢复演练规则是 External MVP 的完整目标：

- 备份有固定最长保留期；
- 活跃系统立即不可访问已删除内容；
- 最新 deletion ledger 位于独立恢复域，不能只存在于业务数据库及其备份中；
- ledger 可以使用专用控制数据库或独立追加式对象存储；
- ledger 只保存 keyed subject hash、`subject_hash_key_version`、revision、epoch、
  删除时间和 receipt；
- ledger 不保存对话、Evidence locator、Entity label、Journal、Reflection、
  Memory 或其他正文；
- ledger HMAC key 位于独立于业务数据库和其备份的恢复域；
- 每个 key version 至少保留到使用它的 ledger 与最长可能业务备份全部过期；
- key 轮换期间双写新旧 keyed reference，或在验证后安全重算 ledger；
- ledger 至少保留到所有可能包含相关数据的备份过期；
- 恢复旧备份后，拉取恢复点之后的最新 deletion ledger；
- 清除领域表与派生层、重建索引并验证后，才允许开放流量；
- 重建向量和 Profile 时排除 tombstone；
- 恢复演练必须覆盖“删除发生在备份快照之后”的场景，
  并验证已删除内容不会重新进入召回；
- 恢复演练还必须覆盖业务 DB、应用 signing key 和 ledger HMAC key 已经轮换的场景。

External MVP 面向真实用户前必须把备份保留窗口写入用户可理解的数据说明。

在第一条真实私人对话写入前，必须完成 `backup_policy_versions`：

```text
provider
database_project
pitr_or_wal_window
snapshot_retention_window
longest_confirmed_window
evidence_url_or_record
verified_at
next_review_at
```

`backup_retention_until` 根据删除时生效的最长已核验窗口计算。
如果供应商窗口未知、配置漂移或证据过期：

- Core Flow 的真实数据写入门禁失败；
- 已有删除请求最多进入 `retention_pending`；
- 不允许写 `fully_expired_at`；
- 先核验平台设置和供应商政策，再恢复真实数据实验。

## References

- [原始 核心架构 v0.1 快照](../archive/architecture/sayhear-core-agent-architecture-v0.1.md)
- [产品隐私与数据承诺](../product/19-privacy-and-trust.md)
- [Replay 架构](17-replay.md)

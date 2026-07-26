# 测试、交付顺序与升级门槛

## TL;DR

- 测试覆盖领域不变量、集成、端到端、Replay、隐私与故障注入。
- Internal Core 按 Foundation、1A.1–1A.4、1B.1–1B.2 顺序交付。
- Definition of Done 同时覆盖产品闭环、领域正确性、可靠性、Voice、隐私和 AI 质量。
- Redis、Python Worker、Temporal、专用向量库和微服务只在量化触发条件满足后升级。

## Status

Proposed

## 24. 测试与故障注入

### 24.1 测试层

#### Unit

- Daily Session 日期与时区；
- 状态机合法迁移；
- InteractionTurn / ConversationEvent / VoiceTurn 映射；
- opaque ID、logical ID / Version ID 分离与 namespace 稳定性；
- Context budget；
- Claim promotion；
- evidence actor gate；
- EvidenceItem source / locator gate；
- Entity merge / split 与 user-scoped resolution；
- Journal eligibility；
- ReflectionVersion stale / supersede；
- publication policy；
- 1B.2 delivery prefix calculation；
- delete fencing；
- Replay 写权限。

#### Integration

- PostgreSQL transaction / lock；
- 1A.1 scheduled recovery scanner；
- 1A.2+ outbox；
- 1A.2+ Vercel Workflow step；
- 1A.1 single Conversation Provider adapter；
- 1A.4+ multi-Provider adapters and fallback policy；
- typed Evidence link foreign key 与 deletion propagation；
- Entity alias / external mapping；
- GenerationCommand / ModelRunAttempt retry；
- Text stream interruption、explicit Retry 与 incomplete response exclusion；
- Auth.js session 与 service JWT scope；
- pgvector retrieval；
- S3 upload / delete；
- LiveKit event mapping。

#### Replay / Eval

- synthetic multi-day conversations；
- model and Prompt comparison；
- Journal evidence grader；
- memory retrieval precision；
- voice long-pause / interruption scenarios。

通过 Private Replay 部署门禁后，再加入中英文真实授权样本。

#### End-to-end

- Text；
- Realtime；
- same-day resume；
- cross-midnight；
- cross-day memory；
- bilingual Entity resolution / cross-language Claim recall；
- Journal；
- Reflection；
- deletion；
- Replay。

### 24.2 必须执行的故障注入

| 场景 | 必须结果 |
| --- | --- |
| 同一客户端 Event 提交 10 次 | 只有一个 Conversation Event |
| 同一 `client_turn_id` 通过 Text / Voice 重试提交 | 只有一个 InteractionTurn；VoiceTurn 只作运行映射 |
| 1A.3 Self Entity migration 或 External Account provisioning 重试 | 同一 User 仍只有一个 active Self Entity 与一个 binding |
| 用户说“我和小王是同事” | “我”确定性绑定 Self Entity；小王绑定独立人物 Entity；关系进入 Relationship Memory Claim |
| 尝试把 Self Entity 与普通人物 Entity merge / split | 领域约束拒绝；不改变 Account–Self Entity binding |
| 另一用户提到当前用户本人 | 创建或解析为对方 user scope 内的私人 Entity；不跨用户绑定到 Self Entity |
| “妈妈 / Mom / 我妈”指向同一人物 | 通过同一 Relationship Memory Claim 辅助解析到同一 Entity；称呼不写入 Entity label |
| “我之前那个同事”对应多个候选 Entity | 保持 EntityMention ambiguous；不能仅凭“同事”完成绑定 |
| 同一人物同时是同事和朋友 | 保留同一 Entity、两个 Predicate 与两个可独立 Correction / Forget 的 logical Claim |
| 伴侣关系结束 | 同一伴侣 Claim 创建 `temporal_status=ended` 的新 ClaimVersion；已知时保留 `valid_to`，并投影“前任” Hint，不创建 `former_partner` Claim |
| 用户只说“他以前是我同事” | `temporal_status=ended`，`valid_to=null` 且精度 unknown；仍可投影“前同事” |
| 用户说“她是我妈妈”但未提供开始日期 | `temporal_status=current`，`valid_from=null`；不根据年龄或生日补日期 |
| 用户说“大概 2023 年夏天在一起” | 保存 approximate 时间边界与原始 Evidence；不得归一化成伪精确日期 |
| 关系 `temporal_status=unknown` | 不生成暗示 current / former 的确定性 Resolver Hint |
| 与同事发展为伴侣，但没有 Evidence 表明同事关系结束 | 新增伴侣 logical Claim；原同事 Claim 保持 active |
| 稳定“母亲”关系反复被提及 | 复用同一 `valid_to = null` logical Claim；按版本规则纳入新 Evidence，不创建重复 logical Claim |
| Relationship Claim 被纠正、Forget 或进入 `review_due` | 对应 Resolver Hint 立即 fail closed 并失效；不得继续绑定 Mention |
| Resolver Hint 投影任务晚到 | 读取时发现 source 不是 current ClaimVersion 并拒绝 Hint，不恢复旧称呼 |
| Context 召回“妈妈” | 由 Entity 与有效关系 Claim 渲染一张人物卡片；Hint 不作为第二条记忆注入 |
| 用户说“Tom 是我姐姐 Lily 的丈夫”，双方身份已绑定 | 创建 user-scoped `Lily —伴侣→ Tom` Relationship Claim |
| 上述表达中的 Lily 或 Tom 仍 unresolved / ambiguous | Candidate 进入 `needs_entity_resolution`；不创建 active Claim，也不为补图强行追问 |
| 已有 Self–Lily 姐妹 Claim 与 Lily–Tom 伴侣 Claim | 不自动创建 Self–Tom 姐夫 Claim 或 Resolver Hint |
| 用户后来明确说“Tom 是我姐夫” | 以新 User Evidence 创建或确认 Self–Tom 直接 Relationship Claim |
| Mention 为“Lily 的丈夫” | 只有 Lily anchor 已解析时才使用对应 Hint；“丈夫”不作全局唯一绑定 |
| 两条第三方关系可以推导出另一种亲属或组织关系 | 不执行传递闭包；没有直接 User Evidence 就没有新的 active Claim |
| 两个用户都提到同名人物 | 不跨用户自动合并 Entity |
| 用户明确介绍“新同事小王”，已有另一个“小王” | 创建新的 user-scoped unresolved Entity，不按同名复用 |
| “小王今天抢功，我很憋屈”，具体身份不影响理解 | 不为数据完整追问；保留 Mention，并按证据回应和写 Journal |
| “她又那样对我了”，身份歧义实质影响理解 | 紧扣当前表达澄清一次；未回答时停止追问并保持 Mention 未绑定 |
| 用户明确说明“小王就是昨天提到的新同事” | 依据新的 User Evidence 绑定 Mention；保留解析 lineage |
| 两个 Entity merge，但关联 Statement 仍由同一人物 Evidence 支撑 | impact review 为 `no_change`；不生成新 JournalVersion |
| Entity split 证明旧 Statement 把行为归给错误的人 | impact review 为 `deterministic_error`；创建新的 Journal command |
| Entity 变化后无法确定旧 Statement 是否误归属 | 只检查受影响 Statement 并进入 `needs_review`；不静默改写 |
| `needs_review` Statement 所在 Journal 被打开 | Journal 保持可见并显示低调提示；相同 revision 不重复检查或提问 |
| `needs_review` 后没有新 Evidence | 不按 timer 重跑；相关 Statement 持续排除 Entity / Recall 使用 |
| 新 Evidence 证明原 Statement 仍成立 | review 进入 `no_change`，清除 retrieval fence，不生成新 Journal |
| 新 Evidence 仍无法判断身份 | review 进入 `still_ambiguous`，等待未来 Evidence，不创建用户待办 |
| Entity merge / split 后旧 Claim 仍在 retrieval candidate 中 | Retrieval 因 EntityVersion 失效立即拒绝，不等待异步 Workflow |
| Entity merge 使两条同 predicate Claim 冲突 | 逐 Evidence 去重和复核；不相加 confidence；只提交一个验证后的 canonical result |
| Entity split 后 Claim 无法确定归属 | 新 ClaimVersion 为 `review_due`，排除 Recall / Profile / Embedding |
| Claim impact Workflow 晚到 | EntityVersion / Evidence revision fence 拒绝旧绑定重新激活 |
| Entity 改名或 external mapping 撤销 | Entity ID 不变；创建新 Version / mapping 状态 |
| Claim 中文投影切换为英文且语义未变 | Claim / ClaimVersion ID 不变，只新增 ClaimLocalizedProjection revision |
| Reflection Candidate 只引用 Reflection 自身 | validator 拒绝；必须提供底层 Evidence ID |
| Source Revision 被 corrected | 旧 Evidence 失效，新 Evidence 指向新 Revision |
| 同一 Journal Workflow 并发启动 | 只有一个正式 published 版本 |
| Journal / Reflection 对同一 source 重新生成 | logical ID 不变；产生新的不可变 Version ID |
| 1A.1 已显示部分 text 后崩溃 | Turn 标记 `interrupted`；无 Assistant Event；显式 Retry |
| 模型完成但 Assistant revision 提交前崩溃 | `result_unknown` 后收敛为 `interrupted`；不猜测正文 |
| Provider timeout 后重试成功，旧结果晚到 | 两个 attempt 可审计，只有一个 authoritative result |
| Model config 在同一 turn 中途切换 | 已创建 command 与后续技术重试仍使用冻结 config；新配置只影响新 command |
| Journal 生成时新增 turn | 旧 Draft 可审计但不能发布；新 revision 创建新 command |
| Journal / Claim / Reflection 试图用 Assistant Event 支撑生活事实 | 程序化 validator 拒绝 |
| Future granular deletion 清除多证据 Claim 的一条证据 | 旧正文立即不可用；retract 或从剩余证据重建 |
| Internal Owner Full Purge 完成 | 保留无正文 User–Self Entity binding；清除 Self Entity label、关系 Claim 与全部内容派生物 |
| Account Deletion 完成 | User、Self Entity 与 binding 一起删除，旧任务不能重新创建 |
| Future granular deletion 清除 Entity 唯一 Mention / Evidence | label 与 mention 被清除，Entity 进入 unresolved / deleted Version |
| Future granular deletion 清除 Entity 的一条非唯一 Evidence | 保留稳定 Entity ID，只从剩余 Evidence 重建投影 |
| Future granular deletion 清除被历史 Version 引用的 source | 正文/ciphertext 物理 purge，仅留无正文 envelope |
| 1A.2 Full Purge 与 Journal 并发 | 在途结果被 fencing，内容不复活 |
| 1A.3 Full Purge 与 Reflection / Memory 并发 | 在途结果被 fencing，Claim 与 Profile 不复活 |
| Source 已读取到内存，随后删除先于 Provider dispatch | Egress claim 失败，Provider 收不到正文 |
| Egress 已标记 dispatched，随后删除 | 记录 Provider disposition，尽力 cancel，删除停在 retention_pending |
| 1B.1 Workflow 服务超过音频到期时间不可用 | 到期后不可读取，兜底策略最终删除 |
| 客户端提交未来 `captured_at` | `expires_at` 仍只按 DB retention start 计算 |
| 1B.1 Full Purge 发生在 upload finalize 前，旧 POST 晚到 | staging object 不可提升并被 sweeper 删除 |
| External MVP 从删除前备份恢复 | deletion ledger 后无可见、可召回数据 |
| External MVP ledger HMAC key 已轮换后恢复 | 用 key version 匹配并清除删除数据 |
| backup policy 未知或过期 | 真实写入门禁失败；删除不能进入 fully_expired |
| Provider 返回非法 JSON / 429 / 5xx / timeout | 正确分类，无部分状态 |
| Realtime 断线并重复 final transcript | 不重复创建 turn |
| LiveKit 和 Provider 同时报告 turn end | 只有配置的 owner 可以 commit / response |
| Provider item ID 晚于 speech start 返回 | 正确绑定已预留 voice_turn，不产生第二个 Event |
| Provisional 与 final 含义明显不同 | 记录 divergence；长期派生只使用 final / corrected |
| Canonical STT 永久失败 | turn 进入 review；不触发 Evidence / Entity / Journal / Reflection / Claim |
| 1B.2 Voice Assistant receipt 永久丢失但 User STT final | 用户 Event 仍触发 evidence pipeline；Assistant delivery 保守终止 |
| 1B.1 AI 被打断 | 立即停止生成和播放；Provider state 被截断或重建；无 Assistant 正文，只有 interruption marker |
| 1B.2 AI 被打断 | Context 只保留可证明的 delivered prefix；无法证明时按 `interrupted` 处理 |
| Source revision 被删 | Replay fail closed，输出被清除 |
| Summary 覆盖前 20 个 Event、Context 继续 | 只加入 Summary + sequence 20 之后 raw Event |
| Summary 生成失败 | 对话使用有限 recent raw turns 继续 |
| 1A.1 committed raw Events 超出 Context budget | 只选择预算内最新 Events；manifest 记录 `raw_event_budget_exceeded`；不可覆盖边界和当前输入仍保留 |
| Canary 私密字符串通过完整链路 | 普通日志、Trace、Workflow history 中搜不到 |
| 非 owner / Replay role 请求正式写入 | API 与数据库均拒绝 |
| Voice / Replay token 换成另一个 job ID | API 因 resource grant 不匹配拒绝 |
| Voice Worker 绕过 Egress Gateway 调 Provider | 无 credential / grant，调用失败 |
| 错误 JWT audience / scope / expired key | API 拒绝且日志无 token |
| Outbox dispatch 后进程在 receipt 前崩溃 | lease 到期后重派；WorkflowCommand 吸收重复 |
| 多个 dispatcher 同时扫描 | `SKIP LOCKED` 确保同一 lease 只有一个 owner |
| 连接池耗尽 / transaction 中断 | 无部分业务状态或孤立 outbox，有限重试 |
| 删除 Worker 被关闭 | 监控告警，存储兜底仍生效 |
| 旧 Workflow 恢复执行 | 不能覆盖新 revision 或 tombstone |

## 25. Phase 1 Internal Core 交付顺序

### Foundation

目标：建立不会被后续 Voice 和模型替换推翻的领域底座。

- Monorepo；
- TypeScript domain / application / ports；
- 1A.1 所需 PostgreSQL Schema；
- migrations；
- User / DailySession / InteractionTurn / ConversationEventRevision；
- Prompt / Model versions；
- GenerationCommand / ModelRunAttempt；
- stable `user_id` / `data_epoch`、读取与 Provider Egress fence、
  deletion-compatible lineage fields；
- redacted observability；
- Auth.js internal authentication 与 server-only Provider credential；
- verified `backup_policy_version`。

退出条件：

- Event 幂等；
- User / DailySession / InteractionTurn / ConversationEventRevision 的身份边界、
  revision 和外键约束通过；
- Session 时区测试通过；
- Node pooled interactive transaction、lock 与冷启动测试通过；
- 实际数据库 backup / WAL / snapshot 最长窗口已核验；
- 越权用户请求被拒绝，Browser 与普通领域模块不能直接调用 Provider adapter；
- 只有配置的 Internal Owner 能登录和写入真实内容，其他人类身份全部拒绝；
- 用户正文未进入普通日志；
- Foundation 不建设删除 API、通用 deletion workflow、完整 ledger 或恢复演练。

### Core Flow 1A.1：Text Vertical Slice

- Text 多轮；
- InteractionTurn / ConversationEventRevision；
- Context Compiler；
- bounded committed raw Events + versioned CompiledContext manifest；
- structured GenerationCommand / ModelRunAttempt；
- one configured Conversation Text Champion + single Provider adapter；
- no automatic model / Provider fallback；
- best-effort text stream、完整 Assistant Response 原子提交与 interrupted 状态；
- in-process Provider Egress Port；
- lightweight scheduled recovery scanner；
- internal inspection；
- Minimum High-Risk Response policy、检测路径与最小回放集。

退出条件：

- 同日续聊和跨日新 Session 正确；
- 跨午夜连续交流保持同一 Daily Session 和不可变 `logical_date`，交流结束后的
  下一次新日期交流才创建新 Session；
- 用户明确结束或版本化 inactivity timeout 能确定性进入 `quiescent`；
  新 Event 会使旧 timeout 因 revision fencing 失效，模型收尾不能直接关 Session；
- recovery scanner 重复执行不会重复结束 Exchange；卡住 Turn / ModelRunAttempt
  能从 PostgreSQL 权威状态收敛，不依赖 Workflow history；
- Context 可解释、可版本化；
- raw Events 超出 Context budget 时只发生显式、可观测的降级，不临时生成
  未追踪 Summary，也不截断产品、安全、关系边界或当前用户输入；
- 模型失败不会破坏 Session；
- 技术重试保持同一冻结 model config；Provider 失败不会静默切换模型；
- 测试 fixture 把 owner 标为 deleting 或推进 `data_epoch` 后，真实正文不会
  越过 Provider Egress fence；
- 流式中断不会创建 Assistant Event 或进入 Context，UI 显示中断并允许显式 Retry；
- 明确自伤、伤人和迫在眉睫危险样例不会继续普通倾听或非安全必要的追问，
  不会诊断、冒充治疗师或承诺绝对保密。

### Core Flow 1A.2：Journal Vertical Slice

- Workflow versions、WorkflowCommand / WorkflowRun Schema；
- transactional outbox + Cron dispatcher；
- Vercel Workflows stable v4；
- SessionSummary / SessionSummaryVersion、DialogueStateVersion；
- Rolling Summary 与 DialogueState Workflow；
- Role-based Model Registry 的 Journal / Evidence role 与 Champion config；
- Evidence / Journal Schema 与 migrations；
- EvidenceItem / typed Evidence links；
- Journal logical ID 与 immutable JournalVersion ID；
- 派生对象 lineage；
- Journal Workflow；
- JournalStatement evidence + lineage；
- Journal Eligibility、No Journal Notice 与自动发布；
- operator-only Internal Owner Full Purge；
- Conversation、Evidence、Summary、DialogueState、Journal 与全部当期派生数据的
  active-system deletion propagation；
- 位于业务数据库备份之外的单 owner 最小 purge marker。

退出条件：

- Turn / Event / Evidence 的身份边界和外键约束通过；
- Event / Journal 的历史 revision 可精确读取；
- 所有 JournalStatement Evidence 都能展开到 final / corrected User Event Revision；
- Journal logical ID 与 JournalVersion ID 不混用；
- 用户生活事实 0% 由 Assistant / System Event 支撑；
- 验证通过的 Journal 按 v0.1 policy 自动发布，失败结果不发布；
- 日常琐事和事务性内容不会因“缺少重要性”被拒绝；
- 无 Conversation 的日期无占位，有 Conversation 但不足以支撑一条真实记录的日期
  显示 No Journal Notice，且该状态不进入 Memory / Reflection；
- 重复和并发执行没有重复正式产物；
- Summary / DialogueState 只引用有效 committed Event Revision，晚到结果不能回退
  current projection；生成失败时继续使用预算内 raw Events；
- outbox 在重复 dispatch、receipt 前崩溃和 Workflow 暂时不可用后能恢复；
- 晚到 turn 生成新 Journal revision；
- Full Purge 演练覆盖 Conversation 与所有 1A.2 派生层，产生 active-system
  receipts，旧任务不能复活内容；
- Internal Core 不提供单条 Conversation / Journal 删除，也不声称 `fully_expired`。

1A.2 验收的是 Evidence 完整、可自动交付的同日第三人称 Journal。Entity、Episode
与长期 Memory 尚未出现，不阻止 Journal 发布，也不能由临时文本推断伪造稳定实体；
跨日人物连续性和“与过去记忆的联系”由 1A.3 验收。

### Core Flow 1A.3：Entity 与长期 Memory

- Entity / EntityVersion / EntityMention / bilingual alias；
- Episode / EpisodeVersion；
- Reflection / Claim logical ID 与 immutable Version ID；
- `sh.*` semantic namespace registry；
- Entity / Reflection / Memory role Champion config；
- fast memory candidate；
- Daily / Weekly ReflectionVersion；
- Weekly Consolidation；
- Memory Claim / ClaimVersion / localized projection；
- Relationship Resolver Hint 与人物卡片 projection；
- Profile Projection；
- Embedding 与 pgvector retrieval；
- Memory retrieval 与后续对话召回；
- Memory Correction、Memory Forget Request 与 Memory Source Explanation；
- Full Purge 扩展到 Entity、Episode、Reflection、Memory、Profile、Embedding
  与相关索引。

退出条件：

- Entity / Episode / Claim / Reflection 的历史 revision 可精确读取；
- 每个 User 在进入 1A.3 后恰好拥有一个 active Self Entity；migration /
  provisioning 幂等，Self Entity 不参与 merge / split，第一人称引用可确定性绑定；
- 所有 Claim / ReflectionStatement Evidence 都能展开到 final / corrected
  User Event Revision；
- Entity label 变化不改变 ID，同名不自动合并，跨语言 alias 可以解析为同一 Entity；
- 人物关系 100% 由有效 User Evidence 支撑并保存为具有时间有效性的 Objective
  Memory Claim；每种可独立成立的关系拥有一个 logical Claim，同一关系的状态变化
  只推进 ClaimVersion；
- 关系 `current / ended / unknown` 状态不依赖精确日期；未知或近似边界保留精度，
  0% 使用 Evidence 时间、创建时间或常识补成关系开始 / 结束日期；
- Relationship Resolver Hint 可从 Claim 确定性重建并在 stale source 上 fail closed；
  关系称呼不进入 Entity label，Hint 不成为事实、Evidence 或第二份 Context Memory；
- 同一 Entity 可以同时或先后具有不同关系；关系变化不创建、复制或替换 Entity，
  结束一条关系也不影响同一 Entity pair 上的其他关系 Claim；
- 两个非 Self Person Entity 可以有直接 Relationship Claim，但双方必须可绑定且
  100% 有直接 User Evidence；0 条 Claim 或 Hint 由亲属、朋友或组织关系传递闭包生成；
- 第三方 Relationship Resolver Hint 必须带已解析 anchor，只由单条 ClaimVersion
  重建；Context 不加载或推导完整社交图；
- 未解析 Mention 不强行创建或绑定 Entity；只有身份歧义实质影响理解、回应、
  Journal 或未来 Memory 时才澄清一次，用户不回答时停止追问并保留未绑定状态；
- Entity merge / split / correction 通过反向血缘只检查受影响 JournalStatement；
  只有用户明确纠正或确定性误归属才生成新的 JournalVersion；
- `needs_review` 不使整篇 Journal 下架；受影响 Statement 暂停 Entity / Recall
  使用，并只在版本化新 Evidence、用户纠正或用户查看时幂等重检；
- Entity 身份变化立即使受影响 Claim 退出 Recall / Profile；只有新的
  ClaimVersion 通过 Entity 与 Evidence 复核后恢复，merge 不机械累加 confidence；
- 高置信度 Claim 100% 有有效 Evidence，用户生活事实 0% 由 Assistant /
  System Event 支撑；
- Reflection 提出的 Candidate 100% 继承底层 Evidence ID；
- Entity、Claim、Reflection 的 logical ID 与 Version ID 不混用；
- Objective Memory 与 AI Impression 使用不同召回语言；
- 从第一条可召回 Claim 起，Correction、Forget 与 Source Explanation 即时成立；
- Profile 只从当前有效 ClaimVersion 重建；
- 跨日召回准确、克制，不因同名或低置信度推断制造错误连续性；
- Full Purge 演练覆盖全部 1A.3 数据面，旧 Claim、Embedding 或 Workflow
  结果不能复活。

### Core Flow 1A.4：Replay

- Replay schema 和权限；
- Initial Replay harness：synthetic / anonymized / independently authorized eval dataset；
- Capability Registry 与额外 Provider adapters；
- Champion / Challenger Replay 和版本化 fallback policy；
- Private Replay gate：独立 `sayhear-eval`、job-scoped snapshot API、无正式数据库
  credential；使用真实私人数据前完成 Provider Egress trust-boundary review；
- 中英文盲评。

退出条件：

- Internal Owner Full Purge 覆盖 Replay input / output 与相关 eval artifact；
- Replay 对正式状态无副作用；
- Initial Replay 能在不建设独立部署的情况下完成合成数据比较，且不能读取正式 source；
- Private Replay 部署门禁通过前，任何 Replay 都不能读取 Internal Owner 的真实私人 source；
- Private Replay role 无正式写权限；
- 未通过 Replay 门槛的 Challenger 不能成为 fallback，真实对话不自动 Shadow；
- 独立 Replay runtime 不持有通用 Provider credential 或产品数据库写权限。

### Core Flow 1B.1：Realtime Transport Baseline

- LiveKit；
- VoiceSession / VoiceTurn；
- Node Agent Worker；
- scoped service identity 与 Provider Egress Gateway 抽离门禁；
- OpenAI Realtime baseline；
- Voice Preflight Harness；
- independent canonical STT；
- Transcript revision / segment；
- 内部 opt-in 72 小时 AudioAsset 与临时音频删除；
- Realtime output audio；
- barge-in stop + Provider truncation / session rebuild；
- `delivery_precision=turn_only`；
- 无正文 interrupted marker；
- reconnect；
- Text fallback；
- Qwen3-Omni 受控 Replay 或实验。

退出条件：

- Text 与 Realtime 共用 Daily Session、InteractionTurn 和下游工作流；
- Voice Preflight Harness 只产生 non-authoritative eval artifact，不创建产品
  Conversation 或新的用户输入渠道；
- 每个 VoiceTurn 映射一个跨渠道 InteractionTurn；
- 长停顿、打断、断线和重复转写测试通过；
- Provider Session 到期可以透明重建；
- provisional 与 canonical transcript 分离，低置信度转写不会进入高置信度 Memory；
- 内部音频到期后不可读取并实际删除，Full Purge 覆盖 AudioAsset、Transcript
  与 Voice runtime metadata；
- Evidence / Entity / Journal / Reflection / Claim 不消费 provisional transcript；
- 被打断或交付未知的 Assistant 回答不保存正文，也不进入后续 Context；
- Provider runtime 不会继续携带未听到的剩余回答；
- 通用 Voice Worker 不持有产品数据库权限或通用 Provider static credential；
- Champion 能证明完整播放终态，并安全截断或重建中断后的 Provider session；
- 中英文长对话、code-switching、长停顿与情绪表达 eval 达标。

### Core Flow 1B.2：Delivered-Prefix Correctness

- 客户端 monotonic playout receipt；
- confirmed playout cursor；
- output transcript 与 token / segment timestamp 映射；
- `exact_prefix` 或 `timestamp_estimated` delivery precision；
- `partially_delivered` Assistant Event；
- delivery metadata、短期 buffer、删除和审计规则；
- receipt 丢失、late event、断线和重连故障恢复。

退出条件：

- 被打断时，下一轮 Context 只包含可证明用户听到的 Assistant 前缀；
- 无法证明任何前缀时仍保守收敛为无正文 `interrupted`；
- receipt 重复、乱序、永久丢失或重连不会扩大 delivered prefix；
- 未交付 remainder 不进入 Conversation、Journal、Reflection 或 Memory，并按
  已定义的 retention / deletion policy 清除；
- 1B.2 通过后，Core Flow 1B 才正式完成。

### Phase 2 External MVP Entry Gate

不属于 Internal Core 完成条件，但 External MVP 面向真实用户前必须完成：

- 正式 Auth；
- 正式多用户账号生命周期与跨账号隔离；
- PITR 和恢复演练；
- Provider retention / data region 核验；
- 用户可触发的 Account Deletion；
- 完整多用户 deletion ledger、Provider destination reconciliation 和回执；
- 删除后备份恢复防复活演练；
- 用户可理解的删除阶段、备份窗口与第三方 retention 说明；
- field / envelope encryption 决策；
- error / trace 数据审计；
- 正式危机处置；
- 地区化危机资源与安全事件运营；
- 低调、异步的 Account Data Export；
- 用户数据透明说明；
- 容量、成本和告警；
- 隐私与安全评审。

## 26. Core Flow Definition of Done

### 26.1 产品闭环

英文和中文都能完成：

```text
Talk
  → Understand
  → Journal
  → Reflection
  → Memory
  → Future Recall
```

### 26.2 领域正确性

- Daily Session 符合用户时区和跨午夜规则；
- Text 与 Realtime 使用同一领域模型；
- 每次交互有稳定 InteractionTurn ID，VoiceTurn 不代替领域 Turn；
- 每个 User Event、Evidence、Entity、Episode、Claim、Journal、Reflection
  都有独立稳定 ID；
- logical object ID 与 immutable Version ID 不混用；
- 每次正文修正保留 immutable revision；
- 每个 Journal 绑定 source revision；
- JournalStatement、ReflectionStatement 和每个高置信度 Claim 都有 typed Evidence；
- 生活事实 Evidence 最终只来自 final / corrected User Event Revision；
- Reflection / Journal / Profile 不会成为 Claim 自证来源；
- Entity label、语言和 external mapping 变化不改变 Entity ID；
- Claim 的 localized Statement 变化不改变 Claim identity；
- 推断与事实不会互相升级；
- Profile Projection 可以重建；
- Provider Session 不是长期状态。

### 26.3 可靠性

- 重复触发只增加成本，不增加重复业务结果；
- 进程崩溃和 Provider timeout 可恢复且每次 attempt 可审计；
- 1A.1 Provider 失败不会触发未经评估的模型切换；
- 1A.1 流式中断不会被静默当作完整回答；
- 1A.1 inactivity timeout 与卡住 Turn 可由数据库扫描恢复；
- 1A.1 Context 超出预算时显式降级且仍可追溯；
- Journal 晚到事件规则通过；
- 在途任务不能复活删除数据；
- 从 1A.2 开始，outbox、Workflow 和 deletion 有 reconciliation；
- 关键故障注入测试通过。

### 26.4 Voice

- 1B.1 支持长停顿、用户打断、停止播放和断线重连；
- 1B.1 中断后不保留 Assistant 正文，Provider session 不携带未听到 remainder；
- 1B.2 能持久化可证明的 delivered prefix；
- 1B.2 receipt 丢失、乱序和重连不会把未播放内容写入历史；
- 支持 Text / Voice 切换；
- provisional 和 canonical transcript 分离；
- 未实际播放的 AI 内容不进入对话事实；
- 只有 1B.2 通过后，Core Flow 1B 才完成；
- 中英文语音、转写、回应与 code-switching 达到 Core Flow 基线。

### 26.5 隐私

- 内部音频明确 opt-in；
- 到期后立即不可读取；
- Foundation / 1A.1 在真实私人内容写入前核验 backup window，并通过
  owner / active / `data_epoch` 读取与 Egress fence；
- Canary 扫描确认正文不在普通日志和 Workflow history；
- Replay 无正式写入权限；
- 1A.2 Internal Owner Full Purge 有 active-system receipt，并传播到
  Conversation、Evidence、Summary、DialogueState、Journal 与全部当期派生层；
- 1A.3、1A.4、1B.1 和 1B.2 分别把 Full Purge 覆盖扩展到长期 Memory、
  Replay、音频 / transcript 与 delivery 数据；
- 最小 purge marker 能阻止 Internal Core 旧备份未经重新应用删除状态就恢复上线；
- Internal Core 不提供单条 Conversation / Journal 删除，也不对外声称
  `fully_expired`；完整 Account Deletion 与备份恢复演练按 External MVP Gate 验收。

### 26.6 AI 质量

通过 SayHear 自有中英文盲测：

- 用户感到被理解；
- 回应准确抓住用户真正介意的部分，并区分事实、用户判断与 AI 推断；
- 通过真诚关心和好奇让用户感到重要、被尊重和重视；
- 不擅自给建议；
- 每轮最多一个契合当前表达的问题，且追问服务于理解；
- 用户简短回应、回避、拒绝或转换话题后停止原方向追问；
- 不盲目认同事实判断；
- 不夸张安慰；
- 记忆准确、自然、克制；
- Journal 有证据且具有当日独特性；
- Voice 的停顿、语气和打断自然。

共情质量阈值在形成第一版内部 baseline 后确定，
不使用通用 benchmark 代替 SayHear 产品判断。

## 27. 触发式升级门槛

### Redis

出现以下实测问题后：

- 跨实例 presence / rate limit；
- 热状态读取明显压迫 PostgreSQL；
- PostgreSQL 锁争用影响延迟；
- 需要独立短期 pub/sub。

### Python Worker

出现：

- Python-only 模型或关键库；
- GPU 批处理；
- 大规模聚类；
- TypeScript 无法承担的评估或数据处理。

### Temporal

出现两个以上信号后重新评估：

- 工作流跨多个独立服务；
- 等待外部 signal 数天或数周；
- 复杂 cancel / compensation / schedule backfill；
- 多运行时 Worker；
- Vercel Workflow SLO 不满足；
- 数据驻留或审计要求更强；
- PostgreSQL 锁和补偿逻辑正在演化为自研工作流引擎；
- 需要长期运行 Workflow 的精细版本迁移。

### 专用向量数据库

只有 pgvector 在压测中出现：

- P95 / P99 不达标；
- 索引维护影响主数据库；
- 数据量和成本不合理；
- 查询能力明确不足。

迁移通过 `RetrievalStore` 接口和可重建 Embedding 完成。

### 微服务

只有模块需要：

- 独立扩缩容；
- 独立故障域；
- 独立部署节奏；
- 不同运行时；
- 明确团队所有权。

不因文件数量或“看起来更正式”拆分。

### 自托管模型或媒体服务

由以下信号触发：

- 数据驻留；
- 供应商 SLO；
- 单位成本；
- 定制 Voice / turn-taking；
- 模型可控性；
- 离线或端侧需求。

不提前双写两套系统“为未来做准备”。

## 28. 主要风险与缓解

| 风险 | 影响 | 当前缓解 |
| --- | --- | --- |
| 错误转写进入长期记忆 | 破坏信任 | 双轨转写、confidence、final-only |
| Journal 无依据创作 | 核心交付失真 | frozen revision、typed Evidence、validator |
| Impression 升级为事实 | 错误 Profile | epistemic status、代码状态机 |
| Reflection / Journal 输出反向成为自身证据 | 自证循环与错误记忆强化 | EvidenceItem root gate、typed link validator |
| 同名人物被错误合并 | 错误召回并伤害信任 | user-scoped Entity、Mention evidence、merge / split version |
| 中英文表达生成重复 Claim | 记忆冲突和召回重复 | language-independent Claim identity、localized projection |
| InteractionTurn 与 VoiceTurn / Event ID 混用 | 重连、Retry 与 lineage 错乱 | branded ID、外键、独立状态机 |
| 实时 Session 成为真源 | 重连后丢上下文 | Context Compiler + PostgreSQL |
| 用户没听到的回答进入历史 | 对话状态错误 | delivery status、delivered text |
| Workflow 重复执行 | 重复 Journal / Reflection / Claim | unique key、lock、CAS |
| 删除期间派生物复活 | 严重隐私事故 | data epoch、fencing、tombstone |
| Workflow / Trace 泄漏正文 | 隐私事故 | ID-only payload、canary scan |
| Replay 写回正式状态 | 污染用户记忆 | 独立 schema / role、non-authoritative |
| 72 小时音频未物理删除 | 承诺失效 | 访问拒绝、Workflow、sweeper、Lifecycle |
| 多模型切换破坏人格 | 体验不稳定 | role champion、Session pinning |
| 供应商地域不明 | 隐私与合规风险 | Provider Registry、人工准入 |
| Vercel 绑定 | 迁移成本 | domain ports、PostgreSQL System of Record、ID-only Workflow |
| LiveKit 绑定 | Voice 迁移成本 | VoiceTransport / RealtimeProvider ports |

## 29. 仍待实现前确认的非阻塞问题

以下问题不改变总体架构，但应在对应模块实施前确认：

1. 第一版 Champion 的具体模型和声音；
2. Daily Session `quiescent` 的无活动时长；
3. External MVP 的正式 Auth Provider；
4. field-level envelope encryption 的实施阶段；
5. 正式用户音频处理临时对象的最大技术存活时间；
6. ADR-051 边界内，Entity Resolver 自动复用、创建和进入人工复核的具体置信度阈值；
7. ReflectionVersion 在 Internal Core 仅作为内部产物，还是需要用户可见的独立界面；
8. 正式 iOS 客户端是否进入 External MVP；Web 已确定必须包含。

## References

- [原始 核心架构 v0.1 快照](../archive/architecture/sayhear-core-agent-architecture-v0.1.md)
- [产品范围与路线](../product/18-and-26-scope-and-roadmap.md)
- [正式 ADR 索引](../decisions.md)

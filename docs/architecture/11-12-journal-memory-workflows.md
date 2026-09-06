# Journal、Reflection 与 Memory 工作流

## TL;DR

- Journal 生成、验证和发布是版本化、幂等且可追溯的工作流。
- 用户请求 Journal Regeneration 复用同一生成与发布 pipeline，不产生自由编辑或审批分支。
- Reflection 是近期派生层，Memory promotion 只能回到原始 User Evidence。
- Entity 变化只复核受影响的 JournalStatement 和 Memory Claim。
- Relationship Correction 只复核明确表达或依赖受影响关系的 JournalStatement。

## Status

Proposed

## 11. Journal Workflow

1A.2 的 Journal Workflow 对 Entity、Episode、Reflection 和 Memory 没有硬依赖。
它必须只用冻结的 User Event Revision 与 EvidenceItem 完成可信的同日 Journal。
1A.3 启用后可以增加稳定 Entity / Episode enrichment 和过去 Memory 联系，但 enrichment
缺失、低置信度或失败时必须降级到 Evidence-only，不能阻止发布或临时编造身份关系。

### 11.1 触发条件

- 用户明确结束交流后触发 eligibility evaluation；
- Session 进入 `quiescent` 后触发 eligibility evaluation；
- 每日后台扫描发现发生过 Conversation 但尚未完成 evaluation；
- 同日新事件使已发布 Journal 过期。

Cron 只负责触发扫描，不决定业务 eligibility。
active Session 即使跨过 `logical_date` 的午夜也不能被扫描器提前评估。
模型生成的收尾语句不能单独触发 eligibility；必须先由确定规则提交
Continuous Exchange End。

每个 Session 保存或派生 `next_evaluation_at_utc`。一个全局 UTC scheduler
周期扫描到期记录并创建幂等 command，而不是为每个用户创建一条 Cron。
用户时区只在领域层计算，Cron 漏触发后由下一次扫描补捞。

Journal Eligibility 只判断有效 User Event Evidence 是否足以支撑至少一条真实
Journal Statement。阈值必须很低，不能包含“重要性”“情绪深度”或“是否值得记录”
一类价值判断；日常琐事和事务性内容可以 eligible，仅有 “Hi” 等问候可以
`insufficient_expression`。

三种日期产品状态必须区分：

```text
no_activity               # 没有 Conversation；不创建 Journal 或 UI placeholder
insufficient_expression   # 有 Conversation，但不足以支撑真实 Statement；显示 No Journal Notice
journal_available         # 通过 eligibility 并完成 Journal Workflow
```

`no_activity` 不进入 eligibility evaluation，也不持久化成 Journal 任务。
No Journal Notice 是 Daily Session 的派生展示状态，不是 JournalVersion，
不进入 Journal 导出、Profile、Reflection 或 Memory。

### 11.2 状态机

`publication_policy` 是版本化配置：

```text
auto_after_validation
manual_approval
```

Core Flow v0.1 默认使用 `auto_after_validation`，因为内部阶段也必须实际验证
“交流后自动形成 Journal”的核心体验。任何程序或模型校验失败的结果都不自动发布。
用户不需要提交生成命令或在发布前审核批准；明确结束意图与后台 eligibility
都由系统转化为幂等 Journal command。
内部诊断环境可以把某一 Session / eval dataset 切到 `manual_approval`，但必须记录
policy version，不能静默改变同一 run 的规则。

```text
evaluation_pending
  ├→ insufficient_expression
  └→ queued
  → drafting
  → validating
  → validated

auto_after_validation:
  validated → published

manual_approval:
  validated → awaiting_review → approved → published
                             └→ rejected

published
  → superseded / deleted

异常：
  retryable_failed
  terminal_failed
  needs_review
```

用户请求 Journal regeneration 不改变 publication policy，也不进入
`awaiting_review`。它通过 Conversation Action Gateway 创建幂等 Journal command，
冻结 target current JournalVersion、当前有效 source snapshot、generation /
validation contract、rate policy 与 request Event revision。新版本校验并 fenced
commit 成功后原子替换 current；失败时仍安全的旧版本继续显示。

### 11.3 执行步骤

1. 锁定 `daily_session_id + source_revision + eligibility_policy_version`；
2. 评估 eligibility，只以可支持真实 Statement 的 Evidence 充分性为准；
3. `insufficient_expression` 保存日期状态并结束；
4. 对 eligible Session 创建或取得 `journal_id`，冻结输入 EventRevision 范围和
   EvidenceItem 集合；
5. 直接从 Evidence 构建 factual substrate；1A.3+ 如有可验证 Entity / Episode，
   只作为 optional enrichment；
6. 生成结构化 Draft；
7. 校验 Schema、语言、Statement ID 和 Evidence ID；
8. 校验事实支持和认识状态；
9. 检查删除、tombstone 和 `data_epoch`；
10. 建立 statement-level Evidence link 与运行 lineage；
11. 根据固定的 publication policy 自动发布或等待批准；
12. 通过 fencing guard 原子发布 JournalVersion；
13. supersede 旧版本；
14. 发送完成事件。

同一 Journal generation Module 接受不同的版本化 trigger：

```text
automatic_delivery
source_advanced
understanding_correction
user_regeneration
```

trigger 只决定 source snapshot、policy 与幂等 scope，不复制 Journal generation
pipeline。`user_regeneration` 必须来自已验证的 Derived Artifact Regeneration Action，
以 Journal Action Reference Handle 定位 target，并服从 Catalog 中声明的 rate policy；
模型不能直接启动 draft、validation、publish 或 Version mutation step。

Manual 模式的 reviewer 只能 approve / reject。若需要编辑正文，必须创建新的
human-edited JournalVersion，保留原 Draft 和编辑者审计，避免把人工修改算成模型质量。

### 11.4 晚到事件

如果 Journal 生成过程中出现新 turn：

- 当前生成可以继续完成旧 `source_revision` 的 Draft / Validation，供审计和 eval；
- 新 turn 不混入正在生成的 Draft；
- publish CAS 必须检查 Session 当前 `source_revision`；
- revision 已变化时，旧 run 标记 `stale`，不得成为 published / current；
- 为新 revision 创建新的 Journal command；
- 如果旧 Journal 在新 turn 到来前已经发布，可以暂时显示为 `outdated / updating`，
  直到新版本通过后 supersede；
- 不允许生成中的旧版本在晚到事件后短暂发布；
- 旧版本不原地修改。

### 11.5 验证

程序化验证：

- 每个 EvidenceItem 必须指向冻结范围内的具体 Event revision；
- factual / subjective Evidence 的 source actor 必须是 `user`；
- User source revision 必须为 `final` 或 `corrected`；
- Assistant / System Event 只允许 `interaction_context`，不得支撑生活事实；
- 如果使用 Episode enrichment，其引用必须能继续展开到底层有效 User Event revision；
- 证据没有被删除或撤回；
- 必填字段和 Schema 有效；
- 语言与目标 locale 一致；
- 没有空 Journal 或重复段落。

模型诊断：

- 只对已通过 Publish Gate、并且已经引用的 Evidence 做 Statement-local review；
- 以固定 Code / detail Code 产出第三人称、Evidence 支持、叙事安全、确定性或赞同
  表达方面的非阻断 Finding；
- 不使用固定词、正则、词汇重叠、uncertainty token 或全量 Evidence 覆盖判断；
- 诊断器不可用或返回未知 Code 时，记录 `diagnostic_status=unavailable`，不改变
  Journal 发布结果。
- 是否符合第三人称观察视角。

未通过验证的结果进入 `needs_review`，不静默发布。

### 11.6 Entity 身份变更的 Journal 影响检查

Entity merge、split 或用户身份纠正不能触发全部历史 Journal 的文本扫描或批量重生成。
系统使用 `journal_statement_entity_links`、EntityMention、Evidence link 和 lineage
反向定位受影响的 JournalStatement，并只对这些 Statement 执行版本化影响检查：

1. 冻结触发本次检查的 EntityVersion 变化、受影响 Statement、原始 Evidence 和
   纠正后的 User Evidence；
2. 如果只是补全姓名、别名或统一两个实际相同的身份，且原 Statement 仍由同一
   Evidence 支撑，结果为 `no_change`；
3. 如果纠正后的 Evidence 能确定 Statement 把行为、关系或跨日联系归给了错误的人，
   结果为 `deterministic_error`；
4. 如果现有 Evidence 不能确定原 Statement 是否错误，结果为 `needs_review`，
   不得静默改写已发布 Journal；
5. 用户明确纠正身份，或结果为 `deterministic_error` 时，为受影响日期创建新的
   Journal command；生成新的 JournalVersion，而不是原地修改旧 Version；
6. 未引用受影响 Entity 的 Statement 和 Journal 不进入本次检查；
7. 影响检查、判定依据、新旧 EntityVersion、Evidence 与生成结果全部保留 lineage。

Entity impact model 只能提出分类和修订 Draft。程序必须校验反向引用、User Evidence、
`data_epoch`、source revision 和 publication policy，才能发布新的 current
JournalVersion。

影响检查使用独立状态对象，不修改旧 JournalStatement：

```text
journal_identity_impact_reviews
  id
  journal_statement_id
  triggering_entity_id
  triggering_entity_version_id
  evidence_revision
  review_policy_version
  status                    # identity_review_pending / no_change
                            # correction_required / still_ambiguous / corrected
  last_evaluated_at
  correction_journal_version_id
  created_at
  updated_at
```

`needs_review` 的运行语义：

- 只有受影响 Statement 创建 `identity_review_pending`；其所在 JournalVersion
  继续保持 current 和可见，不能因一个未确定身份整体下架；
- 所有 Journal-to-Entity enrichment、跨日叙事连接与 Recall query 排除存在
  `identity_review_pending` 或 `still_ambiguous` review 的 Statement；
  Journal 本身仍不能成为 Claim 的事实 Evidence；
- 不设置周期性 retry timer。新相关 User Evidence、用户身份纠正或用户打开该
  Journal 时，才按当前 Entity / Evidence revision 触发或取得一次幂等检查；
- intent key 至少包含
  `journal-identity-impact/<statement-id>/<entity-version-id>/<evidence-revision>/<policy-version>`；
  相同 revision 下重复打开 Journal 只读取已有结果，不重复调用模型；
- 用户打开受影响 Journal 时，产品只显示非技术化提示
  “这篇记录中有一处人物指代暂时无法确认”，不弹窗、不自动提问、不创建用户待办；
- `no_change` 清除 retrieval fence；`correction_required` 创建新的 Journal command，
  成功发布 superseding JournalVersion 后标记 `corrected`；
  `still_ambiguous` 保持 retrieval fence，等待新的触发 Evidence；
- Internal Core 诊断界面可以列出 pending / ambiguous Statement、EntityVersion
  和 Evidence，供受控复核；它不是消费者 Review Inbox。

### 11.7 Relationship Correction 的 Journal 影响检查

Relationship Memory Claim 或 Relationship Qualifier 被明确纠正时，不扫描或重新
生成全部历史 Journal。主 Correction Action 提交后立即失效错误 ClaimVersion、
Qualifier、Resolver Hint、Recall、Context 与 Profile，并通过
`journal_statement_relationship_links`、Entity link、Evidence link 和 lineage
反向定位受影响 JournalStatement：

1. 只选择明确表达或以 `relationship_context` 依赖旧 canonical Entity pair、
   Predicate 或 Qualifier 的 Statement；
2. 纠正后的 User Evidence 证明原关系表达仍成立时返回 `no_change`；
3. 能确定原 Statement 表达了错误关系时返回 `correction_required`，为每个受影响
   Journal 创建独立、幂等的 Journal command 和 superseding JournalVersion；
4. 关系目标或历史语义仍不明确时返回 `still_ambiguous`，只暂停该 Statement 的
   relationship enrichment、跨日连接与 Recall，不静默重写正文；
5. 未引用受影响关系的 Statement 和 Journal 不进入检查；
6. 一个 Conversation Action 可以确定性地产生多个 Journal command，但模型不能
   选择日期、逐篇调用工具或把 Workflow 启动当成修复完成；
7. Profile 只按 correction 后新的 current Claim set 触发一次 trust-boundary rebuild，
   不为每篇受影响 Journal 重建一次。

例如用户纠正“Mike 不是我的哥哥，只是比我年长的朋友”时，错误的 sibling Claim 与
`older_brother` Qualifier 立即停止使用；`friend_of` 与相对年龄分别按各自 Predicate
准入。反向血缘只复核表达 Mike 为哥哥的 JournalStatement，不因两篇 Journal 和一个
Profile 需要更新就把一次用户纠正拆成三个 Action。

## 12. Reflection 与 Memory Workflow

### 12.1 两速系统

#### 快速路径

每个 committed final / corrected User Event 都通过 outbox 创建异步命令，不先增加
“是否重要”的模型分类步骤。命令幂等身份绑定
`event_revision_id + extraction_policy_version + data_epoch`；Correction 产生新 revision
与新命令，并使旧 revision 的派生产物停止使用。

- 创建或复用 EvidenceItem；
- 由一次 `memory.extract` 调用提出 Evidence locator、EntityMention 与
  MemoryCandidate；
- 先确定性执行 user-scoped resolution，仍有多个合理候选时才调用
  `entity.resolve`；
- 轻量去重；
- 标记人物、事件、偏好、情绪和开放状态；
- 已完成的结果允许为同日后续交流提供 session-local context，但不能作为
  Memory Claim、Recall、Person Portrait、Profile 或 Embedding 使用；
- 当前回复和后续 Context 编译都不等待快速路径。目标是 Event commit 后 30 秒内
  P95 可见；未完成时继续使用 committed raw Events，并记录
  `fast_path_pending` degraded reason；
- 不使用 quiescence debounce。Worker 可以批量读取同一 Session 尚未处理的 Event
  以减少 Provider 调用，但 Evidence、结果、幂等与失效关系仍按 Event revision
  分别提交。

#### 慢速路径

1A.3a Daily Memory consolidation：

- 直接读取有效 EvidenceItem、EntityMention、MemoryCandidate、current ClaimVersion
  与当前 Predicate Registry version，不以 Reflection 为前置条件；
- 聚合或提出 Objective / Impression Candidate；
- 冲突和重复检查；
- Objective Candidate 按 Registry policy 晋升或暂存；
- Impression Candidate 只有在聚合既有 Evidence 后满足跨两个 Daily Session
  的默认门槛时才可晋升，否则继续暂存。

1A.3a Weekly Memory consolidation：

- 多日证据聚合；
- 重新验证 Impression 的独立 Evidence、Daily Session 数与冲突状态；
- Claim merge / supersede；
- 按 Registry review policy 将缺少 fresh Evidence 的 Impression 推进为 dormant。

1A.3b 再增加 Reflection 与 Profile 派生：

- Daily 运行 Episode Builder，并创建新的 Daily ReflectionVersion；
- Weekly 创建新的 Weekly ReflectionVersion、识别趋势和变化，并把新理解送入
  Candidate 层；Profile Projection 的重建由 §12.6 的 Profile workflow 独立拥有，
  不由 Weekly Reflection 触发或等待；
- Reflection 可以从底层 Evidence 提出额外 MemoryCandidate，但不是 Candidate
  创建、Memory admission 或 Claim promotion 的必经步骤；
- Reflection 提出的 Candidate 保存 `reflection_version_id` 作为可空 lineage，
  同时直接引用底层 Evidence。Reflection 文本不能成为 primary evidence。

1A.3b 的 Episode Builder 遵循保守 Candidate 流程：

1. 模型只能从具体 EvidenceItem 提出 Episode Candidate、现实事件 kind、时间 /
   Entity anchor 和可选 existing Episode；
2. 代码拒绝把 Conversation、Daily Session、一般话题、地点词、情绪或关系事实
   直接提升为 Episode；
3. 新建 Episode 至少需要 Evidence 明确表达一次现实事件或持续过程；
4. 续接 existing Episode 需要用户直接连续性表达，或足以唯一指向同一事件的
   时间、地点与 Entity anchor；仅语义相似不能 merge；
5. 明确为不同 occurrence 时创建新 Episode；仍不确定时 Candidate 保持
   `unresolved`，不创建错误连续性；
6. accepted Candidate 创建 Episode / EpisodeVersion 并冻结 Evidence link；
   后续补充只创建新 EpisodeVersion，不改写旧版本；
7. Episode 缺失或 unresolved 不阻止 Journal、Reflection Candidate 或基础
   Memory Claim，也不触发面向用户的数据补全追问。

### 12.2 Reflection 的提交边界

1. 锁定 `reflection_id + source_revision + policy_version`；
2. 冻结 EvidenceItem、EpisodeVersion 和必要 SummaryVersion；
3. 生成结构化 Reflection Draft 与 ReflectionStatement；
4. 校验每条 Statement 的 Evidence link 能展开到底层 User Event Revision；
5. 通过 `data_epoch + source_revision` fence 把新的 ReflectionVersion 提交为 current；
6. source 已变化时旧 Draft 可以保留审计，但标记 `stale`，不能成为 current；
7. Reflection 提出的 MemoryCandidate 保存 `reflection_version_id` 作为 lineage，
   同时复制底层 `evidence_id` 作为认识论依据；
8. Memory promotion 只读取 Candidate 的底层 Evidence，不能把 Reflection 文本
   作为自证循环。

同一 `reflection_id + source_revision + policy_version` 最多一个 current
ReflectionVersion。Daily 与 Weekly Reflection 使用不同 logical Reflection ID，
不得互相覆盖。

Reflection Inspector 只读取已保留的 ReflectionVersion、Evidence lineage、
Candidate disposition，以及 Candidate 经有效 ClaimVersion 对 Profile Projection
产生或未产生的影响。它可以展示 draft / stale / superseded 状态供诊断，但不能推进
current pointer、触发 Memory promotion 或绕过 Candidate Review Module 写入处置。

### 12.3 更新规则

模型返回显式 diff：

```text
propose_new
reinforce_existing
contest_existing
supersede_existing
mark_review_due
no_change
```

代码验证：

- 引用的是具体 EvidenceItem，并能展开到 Event revision；
- factual Evidence 只来自 `actor=user` 且 `final` / `corrected` 的 transcript；
- Assistant / System Event 不能创建、reinforce 或提高用户生活 Claim 的置信度；
- Reflection / Journal / Profile 不能替代底层 Evidence；
- Episode / Summary 作为中间输入时仍可展开到底层 User Event evidence；
- Entity reference 属于当前 user scope，merge / split version 仍有效；
- confidence 达到策略阈值；
- kind 和 epistemic status 合法；
- Objective Candidate 的 predicate、value 与 scope 来自直接、明确的 User
  Evidence；Registry evidence policy 允许时，一条 EvidenceItem 即可晋升为
  `confirmed`，不设置重复次数门槛；
- 用户没有直接陈述、而是模型从表达模式形成的 Candidate 只能是
  `kind=impression + epistemic_status=inferred`；
- Impression Candidate 至少有两条独立 User Evidence，来自两个不同
  Daily Session，且共同支持同一 Predicate、typed value 与 scope；
- 单 Session 重复、同一 Event 的多个派生项或模型 confidence 不得绕过
  Impression 准入门槛；Registry 只能设置更严格的 Evidence policy；
- 用户直接、明确、自我指向的敏感事实只有在 Registry 对应 Predicate 允许
  `objective` 时才能创建 `confirmed` Claim；诊断、身份或风险归类不得由
  `impression` 路径创建；
- 敏感领域的 Impression Candidate 只能映射到意义、影响、支持或压力来源、
  交流偏好等解释性 Predicate；症状、伴侣关系、宗教活动、政治观点或相似经历
  不能被用来推断诊断、性取向、宗教或政治身份、创伤或受虐标签、财务或法律风险；
- Candidate 已有 recorded `rejected` disposition 时，Registry 更新、重复抽取、
  时间经过、模型 confidence、Consolidation 或 repair 都不能把原 Candidate
  改为 accepted，也不能用相同 Evidence 与语义目标创建新 Candidate 绕过 rejection；
- `ambiguous / unmapped` 只由模型提出概念、Evidence 和 mapping alternatives；
  版本化确定性 policy 检查 Evidence、稳定跨日问题、现有 Predicate 可表达性、
  长期 Memory 边界与 schema 可定义性，只有通过时才写入
  `needs_predicate_review`；
- LLM 的 product-value 评分、排序或建议不能批准 review eligibility、Predicate
  Change Proposal 或 Registry Entry；只有授权人工 reviewer 可以映射已有
  Predicate、批准形成 Proposal 或拒绝，新 Predicate 发布后 Candidate 仍需按该
  Registry version 重新通过正常 admission；
- 写入 `needs_predicate_review` 时确定性设置 30 天 `review_due_at`；到期仍没有
  人工 disposition 时幂等转为 `stale`，并停止 mapping、admission、promotion
  与 Registry release 后的自动重试；
- Internal Candidate Review Tool 只调用 Candidate Review Module 的一个 review
  interface，提交 `map_existing`、`reject` 或 `approve_for_registry_change`
  command；该 Module 统一执行 capability、step-up、Evidence revision、
  deadline、并发状态和 access audit 检查，Web 不直接写 Candidate、Proposal、
  Registry 或 Claim 表；
- `map_existing` 只提交 Predicate mapping 并重新走正常 admission；`reject`
  写入终局 disposition；product-value rejection 还通过 Registry Governance
  Module 创建或关联不含用户内容的 `rejected` ProposalVersion，其他
  candidate-specific rejection 不创建 Proposal；`approve_for_registry_change`
  原子创建或关联 Predicate Change Proposal，并把 Candidate 转为
  `awaiting_registry_release`，同时设置独立的 90 天 Registry release wait deadline；
- Predicate Registry Governance Module 独立拥有 Proposal version、代码库 Registry
  release、mapping tests 与 migration；发布完成后只触发关联 Candidate 在新
  Registry version 下重新 mapping / admission，不接受 Web 直接发布；
- `awaiting_release` Predicate Change Proposal 不自动过期，直到发布或授权人工
  明确取消；`rejected` Proposal 保持到显式版本化重新评估；等待发布的 Candidate
  到达 90 天 deadline 时转为 `stale`，Proposal 保持不变，之后的 Registry 发布
  不能自动复活该 Candidate；发布资格按
  `published_at <= registry_release_due_at` 判断，不能依赖发布任务与到期扫描的
  执行顺序；
- Candidate 转为 `rejected` 或 `stale` 时，以人工 disposition commit time 或原
  policy deadline 设置 `terminal_effective_at`，生成只供 exact-match 防绕过的
  keyed dedupe fingerprint，并设置 7 天内容期限；到期后所有读取立即 fail closed，
  sweeper 清除 LLM 派生语义，只保留无正文审计外壳；
- Terminal Candidate 内容在 7 天 grace 内也不能进入 Recall、Profile、Context、
  Embedding、自动 admission 或 Registry Proposal；完整内容只允许 step-up 后的
  Internal Owner 排错读取并写 access audit；
- 新 User Evidence 命中 terminal semantic target 时，Candidate Review Module
  必须先执行版本化 material-change policy；只有直接陈述状态、独立 Session
  Evidence 门槛、Entity / scope / time resolution 或语义目标出现实质变化时，
  才插入带 predecessor lineage 的 Successor Memory Candidate，并重新走完整
  eligibility、mapping、admission 和 deadline；
- 重复表达、相同 Session 派生项、confidence、时间或 Registry 更新不能创建
  successor；`explicit_reconsideration_only` 的人工产品价值 rejection 也不能
  被普通新 Evidence 覆盖；无法安全确认 predecessor identity 时 fail closed；
- 后续 unmapped 概念可以映射到不含用户内容的 Proposal identity；命中 current
  `status=rejected` 时立即停止 review / admission。显式重新考虑只创建新的
  ProposalVersion，不修改旧 rejection；
- Relationship Qualifier 符合 Registry 的 canonical side、typed value、
  cardinality 与 compatibility policy，并有可展开到底层 User Event Revision
  的 qualifier-specific Evidence；
- 同一 Evidence 可以同时支撑底层关系与具体 Qualifier，但两类 typed link
  必须分别存在；不能因为模型提出了“母亲”就隐式补出无 Evidence 的全局 Entity 属性；
- 不把一次性状态晋升为长期特征；
- 不因 omission 删除；
- 删除与 tombstone 检查通过。

`confirmed` 的含义是“用户曾直接、明确这样陈述”，不是对外部世界事实完成独立
核验，也不表示每条明确陈述都适合长期记忆。长期准入仍独立检查 Registry policy、
时间与 scope、Entity 绑定、Evidence 有效性、一次性状态和 Forget fence。
`observed` 不是 Claim epistemic status；尚未通过这些检查的内容停留在 Evidence /
MemoryCandidate。该语义必须进入 Schema 注释、Prompt 和 Review UI。

Claim conflict routing 必须按以下顺序执行：

1. 使用 Registry 的 `scope_schema`、`temporal_semantics` 和 `value_cardinality`
   判断新旧值是否可以同时成立；
2. 用户明确表达新的有效时间或状态变化时，在同一 logical Claim 上创建新的
   `confirmed` ClaimVersion，旧版本只作为历史保留；
3. 用户明确纠正前一表达时，创建新版本并 supersede / retract 错误版本；
4. 不同 scope 或 Registry 允许并存的值分别保留，不进入冲突状态；
5. 只有同一 Predicate、normalized scope 与有效时间内仍互斥，且 Evidence 无法
   判断是变化还是纠正时，才创建
   `epistemic_status=contested + status=review_due` 的新 ClaimVersion；
6. contested Claim 立即退出 Recall、Profile、Embedding 与 cross-day narrative。
   冲突实质影响当前理解或回应时只自然澄清一次；否则等待新 User Evidence；
7. 新的可判定 User Evidence 通过另一条 ClaimVersion 解决冲突。模型 confidence、
   Evidence 新旧顺序或定时任务都不能直接选择胜者。

Claim lifecycle review 遵循：

1. Objective Memory 不按未提及时长降低 confidence；只依据 Registry temporal
   semantics 和 User Evidence 创建表达变化、结束或纠正的新 ClaimVersion；
2. AI Impression 的 current ClaimVersion 到达 Registry review deadline 时，
   检查 policy window 内是否有新的合格 User Evidence；
3. 没有 fresh Evidence 时创建
   `epistemic_status=inferred + status=dormant` 的新 ClaimVersion，CAS 更新
   current pointer，并失效 Profile、Recall、Embedding 与 cross-day projection；
4. dormant 不 retract 或删除历史，也不作为反向 Evidence；
5. 后续 fresh Evidence 必须重新满足至少两条独立 Evidence、两个 Daily Session
   及 Predicate-specific policy，才能创建新的 active ClaimVersion；不能把旧
   ClaimVersion 原地改回 active；
6. 出现反向 Evidence 时进入 contested routing，不以 dormancy 代替冲突处理。

Relationship Qualifier 的增加、细化、纠正或 conflict resolution 使用同一
logical Claim 的新 ClaimVersion。冲突只影响具体角色时，代码将对应 Assertion
标记为 `contested`，使具体角色 projection fail closed；底层关系仍由有效 Evidence
支撑时可以重建 Registry 定义的中性 projection。冲突改变 Predicate、Entity
或底层关系时，不能降级掩盖，必须进入整条 Claim 的 correction、`review_due`
或 retraction。

同一 canonical Entity pair + Relationship Predicate 从 `ended` 再次变为
`current` 时，更新规则必须命中原 logical Claim 并创建新 ClaimVersion，不创建
relationship occurrence ID 或第二条 Claim。新版本保存新的时间边界与 Evidence，
旧 current / ended interval 继续由历史 ClaimVersion 精确读取；Resolver Hint
只从新的 current version 重建。

Memory Forget Request 使用确定性 target 与 Evidence eligibility fence：

1. 明确指向 whole Claim 时，立即提交新的不可召回 ClaimVersion，并失效该
   canonical Claim 的全部 projection；
2. 明确指向 Relationship Qualifier 时，在同一事务创建 applied request、
   Evidence exclusion 和新 ClaimVersion，retract 目标 Qualifier，并失效该角色
   的所有方向、locale projection；
3. 只从 active exclusion 之外的 User Evidence 重新验证底层关系；仍有独立支持时
   可以生成 Registry neutral fallback，没有剩余支持时 retract 整条 Claim；
4. Forget Request Event 是用户控制命令，不创建 `counter` Evidence，也不表示
   原 Claim 为假；
5. scope 会实质改变结果但仍不明确时，只澄清一次，请求保持 `pending_scope`，
   在用户确认前不改变 Claim；
6. 后续 Extraction、Consolidation 与 repair job 都必须检查 active
   exclusion；旧 Evidence 不能把被 Forget 的 Claim 或 Qualifier 自动恢复。

在线对话中的显式 Correction、Forget 与 Reversal 必须在当前回复的 Memory retrieval
之前同步提交。成功后 retrieval 只读取新的 current ClaimVersion；提交失败或 target
仍有实质歧义时，本轮 Memory 全部 fail closed，回复不能声称操作已完成。由此触发的
Journal 定向复核、Profile rebuild 和普通 extraction 仍异步执行。

Forget 后的重新开放遵循显式 Memory Forget Reversal：

1. applied Forget 关闭 target-level admission；后续自然重复仍可参与当前回应与
   Journal，但相应 MemoryCandidate 保持 rejected / ineligible，不能 promote；
2. 重复次数、时间经过、模型置信度、Consolidation 和 repair 都不能自动创建
   Reversal，也不主动向用户追问是否恢复；
3. 只有明确且 target 唯一可确定的 final / corrected User Event 可以创建
   Reversal；同一事务创建或复用该 Event 的 EvidenceItem、Reversal 与新
   ClaimVersion；
4. Reversal Event 始终同时作为该 target 的新 User Evidence，不保留
   permission-only 或“等待下一条 Evidence”的中间状态；
5. 旧 Evidence exclusion 继续有效，旧 ClaimVersion 不改回 active；后续新
   User Evidence 可以按正常规则 reinforce 新版本；
6. 用户再次 Forget 时创建新的 Forget Request，并 supersede 当前 admission
   authorization，不改写前序控制记录。

### 12.4 Open Loop

Open Loop 与长期 Memory / Profile 分开：

1. 模型只从 direct User Evidence 提出瞬时 `OpenLoopProposal`，不创建或持久化
   Candidate；Proposal 可以包含 kind、Evidence locator、pending anchor、用户时间
   表达与可选 source reference；
2. 代码确定性验证一个可独立关闭的 pending state、封闭 kind、非任务边界、现实
   pending anchor、唯一 source binding、dedupe identity，并要求 `expires_at` 来自
   用户时间表达或版本化 policy；任一 gate 未通过只记录结构化 skip reason，
   不保存 Proposal 语义、不进入 Context，也不主动澄清；
   expected time 以形成时冻结的 start / exclusive end、精度与 IANA timezone 保存；
   exact instant 不伪造 end，date-only / bounded range 按 source Daily Session timezone
   做 calendar 解析，approximate / unknown 不伪造边界；`expires_at` 表示 selector
   最晚可用时间，有范围时从 exclusive end、exact instant 从 start、无时间 anchor
   时从 Evidence 时间增加版本化有限期限；
   bounded range 超过 31 个当地日历日时不创建 Open Loop；模糊自然语言只有命中
   版本化 lexical near-term allowlist 才按无 anchor policy 继续，模型不能自行放宽；
   v1 的 anchored grace 为 upcoming 7 日 / awaited 14 日，无 anchor 两类都为 14 日，
   且 `expires_at` 不得晚于 Evidence time + 360 个当地日历日；超过 horizon 的 Proposal
   不创建，policy 更新也不重算历史 Version；
   anchored upcoming 的 `followup_eligible_from_at` 是 expected start 前 14 日，
   anchored awaited 是 expected start，无 anchor 两类都是 Evidence time；到达该时间
   只开放 selector 资格，不形成询问配额；
3. 同一事项已有 time-bound Objective Claim 或 Episode 时，OpenLoopVersion
   始终保留自己的 direct Evidence，并引用精确表达同一事实的 active Objective
   ClaimVersion 与安全绑定的 EpisodeVersion；两个引用可以同时存在但不继承其
   其他 Evidence / 推断，缺少 enrichment 也不阻止形成；`localized_summary` 只作
   可重建 rendering，不复制第二条事实；
4. 到达 expected time / range 不改变状态；用户明确表达 upcoming event 已发生时创建
   `occurred` Version，awaited outcome 的结果已出时创建 `resolved` Version，事项取消
   时创建 `canceled` Version；kind 与 terminal status 不匹配时拒绝。terminal status
   不编码成功、失败、结果好坏或满意度；
   closure Evidence 可以是明确终态陈述，或只有终态成立才可能知道的亲历内容；
   假设、可能、未来、条件表达、时间到达、沉默或 Assistant / System 内容均拒绝，
   `canceled` 必须由明确取消、撤回、放弃或确定未发生支持；
   如果 resolver 返回多个合理 target，则关闭零个，为全部候选提交
   `ambiguous_closure` suppression，并只记录 Evidence / candidate ID、proposed status、
   policy version 与 disposition 的无正文 audit；closure workflow 不强制追问；
   读路径在 `now >= expires_at` 时立即 fail closed；全局 recovery scanner 查询到期
   open Version，以 `open_loop_id + expiring_version_id + expired + policy_version`
   保证幂等并创建 expired Version；`terminal_effective_at=expires_at`，`processed_at`
   记录实际提交时间；
5. 只有 current Version 为 open、已经到达 `followup_eligible_from_at`、尚未过期，
   且当前 Turn 已有新 User Event 时，
   Context Compiler 才能选入；它可以支持 Assistant 在本轮主动询问进展，不要求
   utterance 已先提到相同话题。closed / expired Loop 不进入当前 Context；
6. Open Loop 不进入 Profile；用户没有发起当前对话时不创建消息或通知，也不形成
   目标、任务列表、完成率或催促式输出；
7. 关闭不删除底层 Evidence、Objective Claim、Episode 或历史 Journal。

通过全部 gate 的 Proposal 必须在同一 owner `data_epoch` 与 source-revision fence
事务中创建 logical Open Loop 和首个 Version。单条不合格 Proposal 不阻止同一 run
中的其他合格 Proposal。新的 User Evidence 可以在后续 run 中重新提出。

同一 `event_revision_id + proposal_index + extraction_policy_version` 的 formation 必须
幂等。跨 Evidence resolver 先用 Episode、Entity、时间与语义相似召回 candidate，但
只有明确唯一的 existing-loop reference，或同一 canonical Objective Claim + 同 kind +
兼容时间，才创建 existing logical Loop 的新 Version。没有 candidate 通过时创建新
Loop；相似 candidate 存在但无法唯一证明时记录 `ambiguous_loop_identity` 并跳过。

expiry scanner 复用全局 recovery route，不为每个 owner / Loop 创建 Cron。它按稳定
顺序分批领取 `status=open AND expires_at <= now`，用 row lock / CAS 在事务内重验
owner、`data_epoch`、current Version、status 与 deadline；失败留给下轮补捞。scanner
只物化 Version 与 current pointer，不能创建 GenerationCommand、Assistant Event、
消息、通知或任务输出。

Closure / expiry 并发由 Closure Evidence Event 的 `committed_at < expires_at` 唯一裁决。
边界前 Event 即使处理较晚，也可以通过 CAS 为 scanner 先写的 expired Version 创建
kind-specific terminal successor；expired 中间 Version 保留历史。边界后 Event 不改写
expired Loop，只继续其他 Evidence 派生流程。closure 的 `terminal_effective_at` 使用
Event committed time，`processed_at` 使用实际提交时间；worker 顺序与模型解析的现实
发生时间都不能改变结果。

source revision、Forget / deletion fence 或 identity binding 失效后，所有读取先立即
fail closed，再由幂等 impact command revalidate。corrected Evidence 仍支持同一
pending state 时，为同一 logical Loop 创建新 open Version 并重新计算时间、eligibility、
expiry 与 enrichment references；不再支持、变成 Task / 宽范围或仍有歧义时创建
`retracted` Version。Claim / Episode Version 变化不能直接决定 Loop 状态，只能触发
基于直接 Evidence 的 revalidation。失败保持 fenced；Full Purge走删除流程而非 retraction。

现实终态 `occurred / resolved / canceled` 永不 reopen；之后的新事件或结果等待创建新
logical Loop。`expired / retracted` 只在新 direct User Evidence 唯一重申同一 pending
state 且通过当前全部 gate 时，才为同一 logical Loop 创建新 open Version，并用新
Evidence / policy 重新计算所有时间字段。kind 变化始终创建新 Loop；旧 Evidence、时间、
confidence、repair 与 reconciliation 都不能复活 terminal Version。

Version 退出 current open 后，以 supersede time 或 terminal effective time 开始 30 日
Content Grace；sweeper 清除 `localized_summary` 并保留受保护的结构化 lineage。
grace 内正文不进入 Context，只供受控排错与仍有权限的精确 Replay；清理后 Replay
fail closed。Forget不延长 grace，source deletion立即清除受影响正文、时间、关联与
fingerprint，Full Purge删除整个 Open Loop 数据面。恢复旧备份时先重放 retention /
purge state，过期正文清理完成前不能开放读取。

Failure policy：

- provider timeout / transport error / 顶层 Schema 无法解析：run=`retryable_failed`，
  不提交 Proposal；
- response 合法但单条 Proposal 语义不合格：只记录结构化 skip reason，其他合格条目
  继续；
- 合格条目的领域写入与 run settlement 在同一 source-revision-fenced transaction提交，
  事务失败全部回滚并幂等重试；
- owner / `data_epoch` / source revision 变化：`stale_source`，旧输入不重试；
- source revalidation失败：保持旧 Version read-fenced；expiry scanner失败：读取仍按
  deadline fail closed并由下轮补捞；
- 超过 retry threshold：保持 fenced / ineligible，发出无正文 operator alert，不猜
  terminal或默认状态。

selector 只有在 snapshot 前全部 final / corrected User Event 的 formation / closure均
settled且无 pending source invalidation时运行；否则本轮 Open Loop lane整体为空，不能
复用 stale output。基础 Conversation、Journal 与独立 Memory lane 继续。恢复只从
authoritative Event / Version重算，失败模型输出不得续用。

同一 User Event 的 multi-effect processing 按固定顺序执行：

1. 冻结并验证 source、owner与 `data_epoch`；
2. 应用 Correction、Forget与 source invalidation；
3. 只对事务开始前已存在的 open Loop解析 closure并写 terminal或 ambiguous suppression；
4. 基于更新后的 current state 执行新 formation 与 dedupe；
5. 把全部通过 gate 的 effects和 run settlement原子提交。

新形成的 Loop 不能成为同一 Event closure candidate。独立 Proposal 语义失败只 skip 该条；
事务失败则所有 effects回滚。若 closure唯一但新 awaited outcome身份歧义，可以只提交
closure；不能把两个 independently closable pending state原地改成同一 Loop的 kind变化。

formation capacity 在 closure / retraction 后计算：每 Event 最多 4 个新 Loop，每 user
最多 128 个 current open Loop，suppressed open 也计入。超出 per-Event cap 时按 eligibility、
expiry、Evidence locator升序保留；达到 user cap时新条目以 `capacity` skip。不得让模型
决定 importance，不得因容量驱逐或伪造 terminal state，也不自动重试或通知用户。

Proactive Follow-up 的停止信号通过 Conversation Behavior projection 提交：

- User Event 同时启动普通 Conversation Decision 与 current-Event DialogueState projection；Decision 的
  主 CompiledContext 不含 proactive target，主回应可以正常流式生成；
- 主回应完成时只读取一次已提交 DialogueState，不额外等待。未就绪、null、低 confidence 或 source /
  version 不匹配时以 `state_not_ready_at_main_completion` 返回零 target；
- 状态和门禁通过、且主回应没有普通问题时，selector 以 CAS 为当前 Continuous Exchange 取得唯一
  Command-scoped reservation；并发 loser 不选 target。没有 Follow-up State row 的候选按
  `never_suppressed` 通过，不为此 backfill 或预建 eligible row；
- selector 创建独立、tools-disabled 的 Proactive Follow-up Segment Command 及窄 CompiledContext；它只
  读取冻结主回应、DialogueState、target、reservation、framing 与 policy bundle，不能改写主回应；
- segment 失败或 pre-display 重验失败时只提交主回应；成功时合成一个 Complete Assistant Response，
  Assistant Event 引用 main 与 Segment Command，typed use 引用 Segment Command；Retry 从新的 main
  Decision Command 重新开始，不继承旧 state、reservation 或 segment；
- reservation 只能由 Segment Command terminal transition 或证明 Command 已废弃的 recovery
  reconciliation 释放，不用时间租约重新分配；
- 只有 committed Complete Assistant Response 的 typed use 才建立待观察的 target；选中 Context、
  流式输出、interrupted response 或 failed Attempt 都不建立 use；
- use 之后的首个 User Event 由模型提议带 locator 的 response disposition，确定性代码验证
  owner、Event 顺序、target current Version 与 locator；在 disposition 唯一提交前 target fail closed；
- 用户对主动问题简短带过、回避、拒绝或转换话题时，为该 Open Loop / Memory
  target 创建 suppressed ProactiveFollowupStateVersion；缺少 logical state 时第一次 suppression
  惰性创建它，release 只追加新的 eligible Version；
- 简短但完整的回答仍使用 `short_response`；未接主动表达而继续其他内容使用
  `topic_changed`；全量停止问题信号在当前 Continuous Exchange 另行提交 Curiosity Stop Signal，
  如同时回应该 target 则也提交 `refused` suppression；
- 后续 selector 必须同时检查 target current Version 与 Follow-up State Version；
- `topic_changed` 按 1 / 7 / 30 当地日历日递增冷却，第四次后不再按时间解除；
  `short_response` 按 7 / 30 日递增，第三次后不再按时间解除；`evaded` 首次 30 日，
  第二次后不再按时间解除；`refused` 不设时间解除；
- 有限冷却到期在 read path 立即恢复选择资格；scanner 只幂等补写 eligible 历史，不生成
  Command、Assistant Event 或消息。用户主动且唯一地重提、新的实质直接 User Evidence 推进
  仍 eligible 的 target Version，或 target-specific 询问许可会立即创建 eligible Version 并清零软停止
  次数；当前 Event 本身仍不作为 proactive use；
- 普通 Version / policy / index / rendering 变化、技术 Entity 修复、单纯 Correction / Forget / Reversal
  与模型 confidence 都不能释放或清零；全量询问许可只解除 exchange-wide Curiosity Stop
  Signal，不清除 target-level suppression；
- `ambiguous_closure` 只有新的唯一识别 Evidence 才能关闭目标并释放已证明为非目标的
  候选；未澄清候选保持 suppressed 直到各自 expiry；
- 同一 `daily_session_id + continuous_exchange_no` 已有 committed Assistant
  Event 使用 Proactive Follow-up 时，本段交流不再选择第二个 target。

合并 selector 的 Open Loop / Memory 任一启用 lane 缺少当前完整 watermark，或候选构造、
排序、reservation、selection manifest 失败时，本轮返回零 target，不用健康 lane 或旧缓存
替代。Conversation、Journal 与其他独立 Memory 路径继续。Inspector 展示失败只告警；权威 manifest
未提交则不得选 target。

### 12.5 Entity 身份变化的 Claim 影响检查

Memory Claim 会主动进入未来回应，因此 Entity merge、split 或身份纠正对 Claim
采用“先暂停 Recall，验证后恢复”的策略。

1. EntityVersion 变化提交后，Retrieval 立即排除引用旧或不再有效
   `subject_entity_version_id / object_entity_version_id` 的 ClaimVersion；
   Profile Projection 同样只读取 EntityVersion 仍有效的 Claim；
2. 通过反向 Entity / Claim / Evidence link 只定位受影响的 current ClaimVersion，
   创建版本化 impact command，不扫描全部 Memory；
3. 对每个受影响 logical Claim 创建新的 `review_due` ClaimVersion 并 CAS
   `current_version_id`；旧 ClaimVersion 保持不可变，不能原地替换 Entity、
   Statement、confidence 或 epistemic status；
4. Validator 从每条 ClaimVersion 的原始 User Evidence 重新判断 Entity 归属、
   predicate、typed value、scope、认识状态和 confidence；Relationship Claim
   必须按当前 Registry 重新 canonicalize directed subject / object 或 symmetric
   Entity pair，并逐个复核 Relationship Qualifier Assertion 及其 Evidence，
   不能沿用 Evidence 的 Mention 顺序或无来源角色投影；
5. 如果 Entity ID 未改变且 Claim 仍成立，创建引用 current EntityVersion 的新
   active ClaimVersion；
6. 如果 merge / split 改变 subject / object Entity，导致 `canonical_key`
   改变，创建新的 logical MemoryClaim 与 ClaimVersion，并通过 lineage
   supersede 或 retract 旧 Claim；不得改写旧 Claim identity；
7. 多个旧 Claim 因 Entity merge、inverse direction 或 symmetric pair normalization
   发生 canonical-key collision 时，必须逐 Evidence 去重和重新验证；不能把
   Evidence count 或 confidence 机械相加，只能提交一个 canonical result；
8. 仍无法确定身份时，current ClaimVersion 保持 `review_due`，继续排除 Recall、
   Profile、Embedding 和 cross-day narrative；
9. 通过验证的新 ClaimVersion 提交后，重建 localized projection、Embedding 和
   Profile Projection，再允许 Recall；
10. 所有提交仍受 `data_epoch + EntityVersion + Evidence revision` fencing；
    晚到 Workflow 不能把旧 Entity 绑定重新激活。

推荐 intent key：

```text
claim-identity-impact/<claim-id>/<entity-version-id>/<evidence-revision>/<policy-version>
```

影响检查只读取底层 User Evidence。Reflection、Journal、Profile 和模型自己的旧回答
不能用于证明 Claim 在新 Entity 身份下仍然成立。

### 12.6 Profile Projection Workflow

Profile Refresh Policy 区分三种 trigger：

1. `manual`：由用户在前端发起；服务端按版本化最短间隔接受或返回
   `next_manual_refresh_at`；
2. `weekly_scheduled`：全局 Cron / scheduler 每周扫描到期 Profile，幂等创建重写
   command，并推进用户可见的 `next_scheduled_refresh_at`；
3. `trust_boundary`：Correction、Forget、`contested`、`dormant`、Entity 失效或
   删除立即使 current ProfileVersion 不可展示，并创建绕过普通限流的安全重建
   command。

普通 Claim 变化不单独触发日内自动重写；manual 与 weekly trigger 会读取触发时最新
eligible Claim set。`trust_boundary` trigger 的失效必须在读取路径同步成立，不能
等待 Workflow 或 Cron 才停止展示旧内容。

`manual` 只表达用户请求重新生成，不创建发布审批。三种 trigger 都使用同一验证与
fenced commit 契约：生成结果只有在验证通过且提交成功后才原子成为 current
ProfileProjectionVersion；Workflow 不等待用户预览、批准、正文编辑或候选版本选择。

Profile Projection 重建遵循：

1. 冻结全部当前有效 ClaimVersion 组成的 eligible input 与 selection policy version；
2. 排除 Candidate、`contested`、`review_due`、`dormant`、被 Forget 的内容、
   Open Loop 和 Reflection 原文；敏感 active Claim 不使用第二层 Profile 授权；
3. 使用版本化 Profile Prompt 与冻结的 model config 生成自然语言 Bio Draft，
   输入完整 eligible set，同时返回正文 statement 与 ClaimVersion 的 support link；
4. 校验每项 support Claim 都属于 eligible set，事实判断由 active Objective
   Memory 支撑，心理、情感与价值观判断由 active AI Impression 支撑，正文可展开
   到底层 User Evidence，且没有改变 confirmed / inferred 认识状态；
5. 记录 Prompt、model attempt、selection policy 与
   `profile_projection_claim_links` 的 eligible-input / narrative-support role，
   再以 `source_claim_set_revision + data_epoch` fence 提交新的
   ProfileProjectionVersion，并在同一提交中推进 current pointer；
6. 模型可以语义压缩而不逐条复述，但不能与 active Memory 实质矛盾或遗漏到形成
   失真人物画像；普通 refresh 失败时保留上一有效 Profile，不用条目列表降级替代；
   trust-boundary rebuild 失败时保持 Profile 不可用，不能恢复旧版本。

Profile 写作可以组织和深入表达 Claim 已支撑的用户经历、关系、情感与价值观，但
不能从叙事连贯性反向创造只存在于 Bio 的推断，也不能把 Profile 正文作为下一轮
Memory Evidence。用户认为内容不准确时，写操作进入底层 Memory Correction 或
Memory Forget Request，再由 trust-boundary workflow 重建 Profile；不存在直接修改
Profile 正文的写路径。

## References

- [原始 核心架构 v0.1 快照](../archive/architecture/sayhear-core-agent-architecture-v0.1.md)
- [Session 与 Journal 产品规则](../product/12-13-session-and-journal.md)
- [Memory 与 Entity 产品规则](../product/14-memory-and-entities.md)

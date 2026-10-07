# Evidence、Entity、Journal 与 Memory 数据模型

## TL;DR

- Evidence、Entity、Journal、Reflection、Memory Claim 与 Profile 拥有不同身份和职责。
- 派生对象保留不可变版本与反向血缘，当前指针不是历史真源。
- Predicate Registry 提供跨模型、跨语言的稳定 Claim 语义。
- Profile 与索引是可重建投影，不是权威事实层。
- Action 长期记录只保存最小 envelope 与 Receipt；完整参数只加密短存到 Admission checkpoint。

## Status

Proposed

### 7.7 Evidence 与 Entity

#### EvidenceItem

Evidence 是可复用、可删除传播的类型化 source reference，不保存第二份自然语言事实。

```text
evidence_items
  id
  user_id
  source_type              # conversation_event_revision in Core Flow
  source_id
  source_version_id
  locator_type             # whole_revision / segment / text_span / time_range
  locator_key              # normalized, non-content idempotency key
  start_offset
  end_offset
  source_actor
  source_status
  extraction_policy_version
  status                   # active / superseded / invalid / purged
  supersedes_evidence_id
  created_at
  content_purged_at
```

规则：

- Core Flow 的 factual / subjective Evidence 只能指向 `actor=user` 且
  `final` / `corrected` 的 ConversationEventRevision；
- 未来引入外部数据时，为其定义独立 immutable SourceRevision 类型、owner、
  consent 和 evidence policy；不能伪装成 User ConversationEvent；
- Assistant / System Event 只能创建 `interaction_context` Evidence；
- EvidenceItem 不复制 source quote；UI 需要展示时按权限读取 source revision；
- text offset、time range、keyed HMAC 等 locator 都是敏感派生数据，随 source 删除；
- EvidenceItem 创建后不可原地改 source；纠正创建新的 EvidenceItem，并使旧项失效；
- Evidence ID 可以被 MemoryCandidate、Claim、Episode、JournalStatement 和 ReflectionStatement
  共同引用；
- 物理表使用带外键的 typed link table，不依赖无法约束的任意 polymorphic target：

```text
claim_evidence_links
memory_candidate_evidence_links
episode_candidate_evidence_links
episode_evidence_links
journal_statement_evidence_links
reflection_statement_evidence_links
```

每个 link 至少保存：

```text
id
evidence_id
target_id
target_version_id           # versioned target 时必填
evidence_role              # factual_support / subjective_report / counter / context
strength
status
created_at
```

Evidence 与 `data_lineage_edges` 不同：

- Evidence 回答“这条 Statement / Claim 凭什么成立”；
- lineage 回答“这个对象由哪些输入和运行步骤生成”；
- 两者都必须存在，不能用一张无语义的依赖表互相替代。

#### Entity 与 EntityMention

```text
entities
  id
  user_id
  current_version_id
  created_at
  deleted_at

user_self_entities
  user_id                  # primary key
  entity_id                # unique
  created_at

entity_versions
  id
  entity_id
  revision
  entity_kind_id           # sh.entity.person / place / project / ...
  status                   # active / merged / split / unresolved / deleted
  merged_into_entity_id
  supersedes_version_id
  created_at
  content_purged_at

entity_labels
  id
  entity_id
  locale
  label
  label_kind               # primary / alias
  source_evidence_id
  created_at
  content_purged_at

entity_mentions
  id
  event_revision_id
  evidence_id
  locator_type
  start_offset
  end_offset
  resolved_entity_id
  resolution_status          # resolved / unresolved / ambiguous
  confidence
  resolver_policy_version
  created_at
  content_purged_at

entity_external_identifiers
  entity_id
  namespace
  external_id
  mapping_status
  confidence
  mapping_evidence_id
  verified_at
```

规则：

- 每个 User 在写入第一条 1A.3a Entity 或 Memory Claim 前必须恰好绑定一个
  `sh.entity.person` Self Entity；`user_self_entities` 的双向唯一约束建立
  Account 与领域身份的一对一关系；
- 现有 Internal Owner 在进入 1A.3a 时幂等创建 active Self Entity 与 binding；
  1A.1 / 1A.2 不为此提前建设 Entity 子系统。External MVP 的新 Account
  provisioning 在同一事务创建 Self Entity 与 binding；
- provisioning 或 migration 重试必须收敛到同一 `user_id + entity_id`，
  不能产生第二个 Self Entity；
- `user_id` 负责认证、授权、租户隔离和删除 scope；Self Entity 负责作为 Memory Claim
  与人物关系的 subject / object，二者不能互相替代；
- Self Entity 的角色来自 `user_self_entities`，不编码进 Entity label、名称或
  `entity_kind_id`；第一人称“我”可以确定性解析到当前 User 的 Self Entity；
- Self Entity 不能 merge、split、绑定到其他 Account 或由普通 Entity promotion
  产生；另一 User 对同一现实人物的 Mention 仍解析为其作用域内的私人 Entity，
  不与该人物自己的 Self Entity 跨用户合并；
- label 改名或语言变化不改变 `entity_id`；
- Entity label 只保存名称与不表达关系事实的 alias；同事、朋友、伴侣、前任、
  妈妈等关系称呼不进入 `entity_labels`；
- 人物关系保存为有 User Evidence 和时间有效性的版本化 Objective Memory Claim；
  ClaimVersion 冻结相关 EntityVersion，关系变化不创建新 Entity；
- 同一关系事实只保存一个 canonical logical Claim；有向关系按 Registry 约定统一
  subject / object，对称关系按稳定 Entity pair 归一化，不能因 Mention 顺序或
  相反观察方向创建重复 Claim；
- 同一个 Entity 可以同时参与多个关系 Claim，也可以在不同时间具有不同关系状态；
- 关系称呼由 Relationship Memory Claim 的 current ClaimVersion 与时间状态投影为
  `relationship_resolver_hints`；Hint 不具权威性、不决定 identity、不直接写回
  `entity_labels`，也不能成为 Memory / Journal / Reflection 的 Evidence；
- “妈妈 / Mom / 我妈”等跨语言称呼可以通过同一 Relationship Memory Claim
  辅助 Mention 解析到同一 Entity；“我之前那个同事”等多候选称呼仍保持 ambiguous；
- Entity merge / split 创建新 EntityVersion，不覆写历史映射；
- 同名不等于同一实体；不得跨用户自动合并私人 Entity；
- 现有身份唯一且置信度高时，Mention 可以绑定已有 Entity；
- 用户明确介绍一个新的人、地点或项目时，创建 user-scoped
  `status=unresolved` Entity；仅凭同名不得复用或合并已有 Entity；
- 代词、多名候选或仍不清楚的指代只创建未绑定的 EntityMention，
  `resolved_entity_id` 保持为空，不强行创建 Entity；
- 是否向用户澄清由身份歧义的语义影响决定，不由“存在 unresolved Mention”
  或置信度阈值单独决定；只有歧义会实质改变对经历和想法的理解、当前回应、
  Journal 含义或未来 Memory 归属时，Conversation 才能紧扣当前表达自然追问一次；
- 用户明确回答后可以完成 Entity 新建或绑定；promotion、merge 或 split
  还可以由稳定重复 Evidence 或用户纠正触发；
- 用户简短回答、回避、拒绝或转换话题后，不得继续身份追问；
  EntityMention 保持 unresolved / ambiguous，不能因此创建错误连续性；
- 未解析身份不阻止 Understanding Response 或 Journal。回应和 Journal
  使用 Evidence 支持的原称呼或中性关系描述，不编造具体身份、关系或跨日联系；
- External ID 只是可撤销映射，不决定 SayHear 内部身份；
- `EntityMention` 是解析结果，不是生活事实 Claim；
- `EntityMention.evidence_id` 必须指向同一个 `event_revision_id`，防止跨 source 误绑；
- 删除唯一 source 时，相关 label、mention 和映射立即不可见；
  Entity 是否 retract / unresolved 由剩余 Evidence 决定。

### 7.8 Journal

建议拆分：

```text
journals
journal_versions
journal_statements
journal_statement_relationship_links
journal_validation_results
```

`journals` 是一个 Daily Session 的稳定 Journal 身份：

```text
id
user_id
daily_session_id
current_version_id
created_at
deleted_at
```

`journal_versions` 关键字段：

```text
id
journal_id
daily_session_id
source_revision
generation_policy_version
status
locale
content
generation_command_id
authoritative_model_attempt_id
prompt_version
schema_version
validator_version
publication_policy_version
created_at
published_at
supersedes_version_id
deleted_at
content_purged_at
```

`journal_statements` 只保存 Statement 本身；证据和 Entity 引用分别使用有类型的
`journal_statement_evidence_links` 与 `journal_statement_entity_links`。明确表达或
依赖人物关系的 Statement 还必须保存 `journal_statement_relationship_links`：

```text
journal_statements
  id
  journal_version_id
  statement_index
  statement_text
  validation_status
  content_purged_at

journal_statement_evidence_links
  id
  journal_statement_id
  evidence_id
  evidence_role          # factual_support / subjective_report / interaction_context

journal_statement_entity_links
  id
  journal_statement_id
  entity_id
  entity_version_id
  entity_mention_id      # nullable; inferred observation may use multiple Evidence items
  evidence_id
  entity_role            # actor / target / relationship_context / reference

journal_statement_relationship_links
  id
  journal_statement_id
  canonical_subject_entity_id
  canonical_object_entity_id
  predicate_id
  relationship_claim_id          # nullable；Journal 可能早于 Claim admission
  relationship_claim_version_id  # nullable
  qualifier_key                  # nullable
  qualifier_typed_value          # nullable
  evidence_id
  link_role                      # asserted_relationship / relationship_context
```

JournalStatement 不再持久化 `inferred_observation` 认识状态。每条 Statement 仍必须
通过结构与 Evidence provenance 的 Publish Gate；第三人称视角、观察与事实的表达
边界，以及语义 Evidence 支持关系由 `journal.validate` 以固定 Code / detail Code
产出非阻断 Journal Diagnostic Finding。Finding 与对应 Statement 和 published
JournalVersion 关联，Portal 转换为自然语言展示；诊断器不可用不阻止发布。详见
ADR-0107。

每条使用 Entity enrichment 的 JournalStatement 必须保存生成时采用的
`entity_id + entity_version_id + entity_role`。Entity link 只用于身份引用、
反向影响分析和精确 Replay，不能替代 Statement 的 typed Evidence。

Relationship link 同样不是 Evidence 或第二条 Memory。它保存 Statement 当时明确
表达或作为语义上下文使用的 canonical Entity pair、Predicate 与可选 Qualifier，
使后续 Relationship Correction 可以定向定位真正受影响的 Statement。Claim 尚未
admit 时 link 仍保留 typed relationship assertion；Claim 形成后可以补充稳定
Claim / ClaimVersion 引用，但不能改变原 Statement 的 Evidence lineage。

同一 `journal_id + source_revision + generation_policy_version`
最多只能有一个正式 published 版本。

### 7.9 Reflection

Reflection 是独立、非权威派生产物，不能只作为 Workflow 日志或直接覆盖上一次结果。

```text
reflections
  id
  user_id
  scope_type               # daily_session / episode_set / date_range
  scope_id
  reflection_kind          # daily / weekly
  current_version_id
  created_at
  deleted_at

reflection_versions
  id
  reflection_id
  revision
  source_revision
  status                   # draft / validated / committed / stale / superseded / deleted
  locale
  content
  generation_command_id
  authoritative_model_attempt_id
  prompt_version
  schema_version
  policy_version
  created_at
  committed_at
  supersedes_version_id
  content_purged_at

reflection_statements
  id
  reflection_version_id
  statement_index
  statement_text
  epistemic_status
  content_purged_at
```

规则：

- 每次生成创建新的 ReflectionVersion，旧版本不原地覆盖；
- ReflectionStatement 必须通过 `reflection_statement_evidence_links`
  回到 EvidenceItem；
- Reflection 是“当时基于哪些证据形成的观察”，不是新的 primary evidence；
- Reflection 可以提出 MemoryCandidate，但 Candidate 必须继承底层 Evidence ID；
- Claim validator 拒绝以 `reflection_version_id` 代替底层 Evidence；
- source revision 变化后旧版本可保留审计，但必须标记 stale / superseded，
  不能继续驱动当前 Profile；
- 因模型、Prompt 和 policy 会演进，ReflectionVersion 即使可重新生成，
  也不能假定能精确重建；
- Internal Core 的 Reflection Inspector 通过只读 query 展示 Daily / Weekly
  ReflectionVersion、状态、source revision、Statement Evidence lineage，以及
  Candidate 经 admitted ClaimVersion 进入 User Profile 的资格，再到具体 BioVersion
  的 eligible input、coverage disposition 与 narrative support；没有显式持久 lineage
  时只显示无记录，不能用文本相似度推测影响；
- Inspector 必须明确区分 current committed version 与 draft / stale /
  superseded version；其领域查询在数据库只读事务中执行，且不持有 Reflection、
  Candidate、Claim、Proposal、Registry 或 Bio 的写能力。敏感 Evidence 访问所需的
  无正文 access audit 由独立写入能力追加，不把 Inspector 变成领域状态写入口；
- current committed 正文默认可读；validated-but-uncommitted / draft / stale /
  superseded 正文只能主动展开，并持续标记为非当前。`content_purged_at` 存在时只返回
  tombstone，不允许从其他派生产物恢复正文；
- Candidate predecessor 与 successor 是两个独立分页方向；successor 保留自身 identity、
  trigger 与 materially-new-evidence 理由，不能显示成 predecessor disposition 被改写；
- owner-scope authorization 后使用 `target_not_found`、`content_purged`、
  `source_invalidated` 与 `access_denied` 区分失败；鉴权失败先于目标探测。
- Inspector 只读取 typed Reflection、validation finding 与 lineage rows；展示冻结的
  Prompt / Schema / policy / model config、GenerationCommand 和 authoritative
  ModelRunAttempt identity，但不返回 Provider 原始请求或响应。每个 atomic proposition
  单独展开自己的 Evidence support，不能把整条 Statement 的 Evidence 合并成模糊集合；
- User Profile 影响只由当前有效 ClaimVersion eligibility 表达；Bio 影响只由具体
  BioVersion 的 eligible-input、coverage disposition 与 narrative-support link 表达。
  两段状态分别返回，不能合并成一个推测性布尔值。
- logical Reflection 没有 current committed version 时返回带原因的
  `no_current_version`，不能选择 superseded 或 draft 正文作为替代。固定 failure / empty
  outcome 由 Portal 映射文案，不接受模型生成的错误说明。
- 每条 lineage edge 分别返回 persisted-at-the-time outcome 与 current validity；后续
  supersede、Forget、dormancy、Entity invalidation 或 Bio 替换不能改写历史 outcome。
  未持久化 Candidate identity 的 generator output 是 Memory Candidate Proposal，只能作为
  该 ReflectionVersion 的诊断输出，不能连接 disposition、Claim 或 Bio lineage。

### 7.10 Memory

建议对象：

```text
memory_candidates
memory_candidate_evidence_links
predicate_change_proposals
predicate_change_proposal_versions
predicate_change_proposal_candidate_links
memory_claims
memory_claim_versions
relationship_qualifier_assertions
relationship_qualifier_evidence_links
memory_forget_requests
memory_forget_evidence_exclusions
memory_forget_reversals
claim_localized_projections
claim_retrieval_projections
claim_evidence_links
relationship_resolver_hints
bios
bio_versions
bio_statements
bio_atomic_propositions
bio_claim_links
bio_coverage_units
bio_coverage_members
bio_validation_findings
retrieval_runs
retrieval_run_candidates
```

`memory_candidates` 是有独立 ID、短期保留的非权威提案：

```text
id
user_id
candidate_kind
subject_entity_id             # nullable until resolved
subject_entity_mention_id     # nullable
predicate_id                # unresolved 时为空
predicate_registry_version
predicate_resolution_status # mapped / ambiguous / unmapped
proposed_concept             # 仅 ambiguous / unmapped 使用
mapping_confidence
proposed_object_entity_id     # nullable until resolved
proposed_object_entity_mention_id # nullable
proposed_typed_value
proposed_relationship_qualifiers # [{canonical_side, qualifier_key, typed_value, evidence_ids}]
proposed_temporal_status
proposed_valid_from
proposed_valid_from_precision
proposed_valid_to
proposed_valid_to_precision
source_reflection_version_id
generation_command_id
authoritative_model_attempt_id
status                    # proposed / needs_entity_resolution / needs_predicate_review
                          # awaiting_registry_release / accepted / rejected / stale / deleted
extraction_policy_version
predicate_review_policy_version # nullable; review eligibility 已检查时填写
review_eligibility_reason_codes # nullable
review_eligible_at        # nullable
review_due_at             # nullable; needs_predicate_review 时必填
registry_release_wait_started_at # nullable
registry_release_due_at   # nullable; awaiting_registry_release 时必填
disposition_reason_code   # nullable; rejected / stale 时必填
disposition_policy_version # nullable; rejected / stale 时必填
decided_at                # nullable
terminal_effective_at     # nullable; rejected / stale 时必填
terminal_content_expires_at # nullable; terminal_effective_at + 7 days
reproposal_policy         # nullable; material_change_allowed /
                          # explicit_reconsideration_only /
                          # blocked_while_policy_active
predecessor_candidate_id  # nullable; Successor Candidate 时填写
successor_trigger         # nullable; materially_new_evidence /
                          # explicit_reconsideration
material_change_reason_codes # nullable
dedupe_fingerprint        # nullable; keyed exact-match fence, not plaintext
dedupe_fingerprint_key_version # nullable
created_at
content_purged_at
```

Candidate 与 EvidenceItem 通过 `memory_candidate_evidence_links` 连接。
`source_reflection_version_id` 只表示运行 lineage，不能替代 Evidence。

`status=rejected` 是当前 Candidate 的终局处置。Registry version 更新、相同
Evidence 被 Extraction / Consolidation 再次看到、时间经过或模型 confidence
变化，都不能把该行改为 accepted 或据此创建 active Claim。代码必须在写入前检查
同一 Evidence 集合与语义目标已有的 rejected disposition，避免用重复 Candidate
绕过终局状态。

Rejected Candidate 不删除底层 Evidence，也不把 Evidence 标记为反向或虚假。
未来重新考虑必须由显式、版本化操作创建新的评估结果并保留原 rejection lineage；
普通 Registry 发布或后台 repair 不构成重新评估授权。

`rejected` 与 `stale` Candidate 进入 terminal 状态时必须设置
`terminal_content_expires_at = terminal_effective_at + 7 days`。人工 rejection 的
`terminal_effective_at` 是 disposition commit time；自动 stale 使用原
`review_due_at` 或 `registry_release_due_at`，不能因 sweeper 延迟而延长内容窗口。
到期后所有读取路径立即拒绝读取 Candidate 派生语义，清理任务将以下字段置空或删除：

- `candidate_kind`、subject / object Entity 与 Mention binding；
- `predicate_id`、`proposed_concept`、mapping confidence 与 alternatives；
- proposed typed value、Relationship Qualifier 与 temporal value；
- LLM explanation、review draft 及其他可还原提案含义的字段。

保留的 Terminal Candidate Audit Envelope 只允许包含 Candidate ID、terminal
status、reason、policy / model / Registry version、时间、无正文 lineage 与
Evidence link ID，以及清理前生成的 keyed `dedupe_fingerprint`。Fingerprint 绑定
`user_id + canonical semantic target + sorted Evidence revision IDs + policy
version`，只能做 exact-match terminal fence；不得进入日志、Embedding、检索、
聚类、统计标签、模型 Context 或 Registry Proposal。只要任一关联 Evidence 仍在
活跃系统中，它可以阻止相同 Evidence 重建同一提案；相关 Evidence 全部删除、
Internal Owner Full Purge 或 Account Deletion 时必须一并清除。

`content_purged_at` 证明活跃系统的语义清理已经完成。旧备份恢复后仍以原
`terminal_content_expires_at` fail closed，并在开放读取前重新执行清理，不能因
恢复点较早而重新暴露已过期 Candidate 内容。

Terminal disposition 同时由版本化 policy 写入 `reproposal_policy`：

- `material_change_allowed`：只有新增 User Evidence 实质改变 admission 条件时，
  才能创建 Successor Memory Candidate；
- `explicit_reconsideration_only`：人工产品价值 rejection 等治理决定只能由显式、
  版本化重新评估产生 successor，普通新 Evidence 不足以覆盖；
- `blocked_while_policy_active`：当前 policy 明确禁止的语义目标不能由更多同类
  Evidence 重提；Evidence mode、Claim kind 或语义目标实质改变时按新的准入问题
  判断，原 Candidate 仍保持 terminal。

Material change evaluator 是确定性 write-side policy，不接受 LLM 的“这是新信息”
结论。它至少比较新旧 Evidence revision、直接陈述状态、独立
`daily_session_id`、Entity / scope / temporal resolution 与 semantic target：

- `inferred → directly_stated`、首次满足跨 Session Evidence 门槛、唯一消除
  Entity / scope / time ambiguity，或 Evidence 明确细化、纠正原目标，可以通过；
- 只增加重复表达、相同 Session 派生项、模型 confidence、时间或 Registry version，
  必须拒绝；
- 未直接陈述的诊断、性取向、宗教或政治身份等分类性推断，不能靠更多相似
  Evidence 变成 materially new；用户之后直接明确陈述时，按新的 Objective
  Candidate 重新准入。

通过时必须插入新 Candidate，设置 `predecessor_candidate_id`、
`successor_trigger=materially_new_evidence` 与结构化
`material_change_reason_codes`，并重新执行全部 eligibility、mapping、admission
和 deadline。Predecessor 的 status、deadline、content purge 与 audit envelope
保持不变。无法通过 Predicate ID、Proposal identity 或其他受治理的语义身份安全
确认 predecessor 时 fail closed；free-text similarity 不能单独建立 successor
lineage。

`memory_claims` 是稳定身份：

```text
id
user_id
canonical_key             # structured, language-independent identity
subject_entity_id
object_entity_id          # Relationship Predicate 时必填
predicate_id              # versioned sh.* namespace
scope_key
current_version_id
created_at
deleted_at
```

`memory_claim_versions` 是 append-only 状态与正文历史：

```text
id
memory_claim_id
revision
kind                   # objective / impression
subject_entity_version_id
object_entity_id
object_entity_version_id
typed_value
epistemic_status       # confirmed / inferred / contested
confidence
status                 # active / review_due / dormant / superseded / retracted
temporal_status        # current / ended / unknown
valid_from             # nullable normalized bound
valid_from_precision   # exact / month / year / approximate / unknown
valid_to               # nullable normalized bound
valid_to_precision     # exact / month / year / approximate / unknown
last_observed_at
supersedes_version_id
created_by
model_version
prompt_version
predicate_registry_version
created_at
content_purged_at
```

Relationship Qualifier 是 ClaimVersion 内可单独验证的角色细化，不进入
`memory_claims.canonical_key`：

```text
relationship_qualifier_assertions
  id
  claim_version_id
  canonical_side             # subject / object
  qualifier_key
  typed_value
  epistemic_status           # confirmed / contested
  status                     # active / contested / retracted
  predicate_registry_version
  created_at
  content_purged_at

relationship_qualifier_evidence_links
  id
  qualifier_assertion_id
  evidence_id
  evidence_role              # support / counter
  status
  created_at
```

Qualifier Assertion 归属于 immutable ClaimVersion；增加、细化、纠正或 contest
Qualifier 都创建新的 ClaimVersion 与 Assertion，不原地修改旧行。同一 Evidence
可以同时通过 `claim_evidence_links` 支撑底层关系，并通过
`relationship_qualifier_evidence_links` 支撑具体角色。若某条 Evidence 是底层关系
的唯一依据，删除它时不能只去掉 Qualifier 后保留一个无来源的中性关系。

可召回 Claim 的正常认识状态只有两种合法组合：

- 用户一次或多次直接、明确陈述且通过长期 Memory 准入校验：
  `kind=objective + epistemic_status=confirmed`；
- SayHear 从用户表达中形成、但用户没有直接陈述的长期理解：
  `kind=impression + epistemic_status=inferred`。

`confirmed` 只确认用户曾明确这样陈述，不表示外部世界事实已核验。表达仍有引用、
假设、转写、Entity、Predicate、scope 或时间歧义时继续停留在 Evidence /
MemoryCandidate，不创建较弱的 `observed` Claim。`contested` 只用于已经存在的
Claim 或 Qualifier 遇到证据冲突，不是正常准入状态。

`impression + inferred` 的默认 Evidence policy 要求至少两个不同
`daily_session_id` 下的两条独立 User Evidence，共同支持相同 Predicate、typed
value 与 scope，且不存在实质冲突。单个 Daily Session 内的重复、同一 Event 的
多个派生项或更高模型 confidence 都不能满足该门槛；Registry 可以要求更多
Evidence 或更长时间跨度，但不能允许单 Session Impression 晋升。

敏感领域不做 domain-wide 禁止。用户直接、明确、自我指向的敏感事实可以在
Registry 允许时形成 `objective + confirmed` Claim；模型未获用户直接陈述时，
不得把医学或精神诊断、性取向、宗教或政治身份、创伤或受虐标签、财务或法律
风险归类形成 active Claim。敏感领域的 `impression + inferred` 只能使用单独的
解释性 Predicate，描述某项经历对用户的意义、影响、支持或压力来源、交流偏好，
不能把分类性 Predicate 改写后绕过限制。

Memory Forget Request 是用户控制命令，不是反驳事实的 Evidence：

```text
memory_forget_requests
  id
  user_id
  request_event_revision_id
  target_claim_id              # nullable while pending_scope
  target_scope                 # nullable while pending_scope;
                               # whole_claim / relationship_qualifier
  canonical_side              # qualifier scope 时必填
  qualifier_key               # qualifier scope 时必填
  qualifier_typed_value       # nullable
  status                       # pending_scope / applied
  applied_claim_version_id
  created_at

memory_forget_evidence_exclusions
  id
  forget_request_id
  evidence_id
  exclusion_scope              # whole_claim / relationship_qualifier
  canonical_side
  qualifier_key
  status                       # active
  created_at

memory_forget_reversals
  id
  user_id
  forget_request_id
  request_event_revision_id
  reversal_evidence_id
  status                       # active / superseded
  applied_claim_version_id
  created_at
```

`request_event_revision_id` 记录用户控制命令的来源，但该 Event 不能成为
`counter` Evidence。`memory_forget_evidence_exclusions` 是 Memory admission /
retrieval fence：原 Conversation、Journal 与 EvidenceItem 仍可按既有权限保留，
但被排除的 Evidence 不能再次 promote、reinforce 或重建目标 Claim / Qualifier。
如果 target scope 不明确，请求保持 `pending_scope`，澄清前不提交新 ClaimVersion。

Applied Forget Request 同时关闭 target-level future admission；用户自然重复、
后台 Consolidation、时间经过或模型置信度都不能解除。只有明确的
`memory_forget_reversals` 才能恢复。target 唯一可确定时，同一个 final /
corrected User Event 同时创建 Reversal、`reversal_evidence_id` 和新 ClaimVersion，
不保留 permission-only 中间状态。旧 `memory_forget_evidence_exclusions` 保持 active，
旧 ClaimVersion 与 projection 不重新激活。

自然语言表达单独保存：

```text
claim_localized_projections
  id
  claim_version_id
  locale
  projection_revision
  statement
  projection_policy_version
  status
  supersedes_projection_id
  created_at
  content_purged_at
```

同一 `claim_version_id + locale` 只有一个 current projection。

向量检索使用独立、可重建的 Claim retrieval projection，不直接索引 Evidence、
Candidate 或叙事产物：

```text
claim_retrieval_projections
  id
  user_id
  claim_version_id
  locale
  view_direction              # self / forward / inverse / symmetric
  retrieval_text
  lexical_terms               # deterministic text[] for zh / en / code-switching
  english_search              # generated pg_catalog.english tsvector
  projection_policy_version
  status                      # active / stale / deleted
  created_at
  content_purged_at
```

`retrieval_text` 从 ClaimVersion 的 Predicate、typed value、必要 Entity label 与时间
表达确定性生成，不复制底层 User Event 正文。Objective / Impression、时间状态与关系
观察方向必须保留在结构化 metadata；同一 Relationship ClaimVersion 可以按 locale
生成多个观察方向，但检索结果最终去重到同一 `claim_version_id`。

`lexical_terms` 由同一版本化 projection policy 从 stable Entity label、已验证 alias、
Predicate Registry lexical alias、typed value 与时间表达生成；query construction
使用同一 policy，不能让模型现场补同义词。它使用 PostgreSQL `text[]` GIN overlap，
作为中文、英文和 code-switching 的可解释精确 term path。`english_search` 只对英文
retrieval text 使用显式 `pg_catalog.english` configuration 生成，并通过 GIN 支持
英文词形匹配。首版不启用 `pg_trgm`；alias 拼写容错只有在生产 locale、extension
可用性与 fixture 阈值经过验证后才重新评估。

只有被 `memory_claims.current_version_id` 指向、可召回且通过全部 Evidence、Entity、
Correction、Forget、contested、dormant 与删除 fence 的 ClaimVersion 才能产生 active
retrieval projection。MemoryCandidate、EvidenceItem 原文、JournalStatement、
Reflection、ProfileProjection 与 PersonPortrait 不进入 Memory vector index。
Entity label / alias、canonical key 与时间范围使用 structured / lexical path，不依赖
向量完成精确匹配。同日 raw Event 继续由当前 Session Context 消费，不写入长期索引。

每次 Context memory query 保存无正文的 retrieval 运行与候选决策：

```text
retrieval_runs
  id
  user_id
  daily_session_id
  source_event_revision_id
  compiled_context_id             # nullable until compile commit
  retrieval_policy_version
  query_construction_policy_version
  projection_policy_version
  query_source_refs
  normalized_query_terms
  deadline_ms                    # policy snapshot; initial value 200
  status                          # running / completed / degraded / failed
  degraded_reason_codes
  duration_ms
  deadline_exceeded_stage
  started_at
  completed_at

retrieval_run_candidates
  id
  retrieval_run_id
  claim_version_id
  retrieval_projection_id
  retrieval_lane
  matched_fields
  matched_terms
  trust_fence_results
  rank_components
  final_rank
  selected_section
  selection_reason_codes
  rejection_reason_codes
  created_at
```

`retrieval_runs` 与 candidate rows 不保存 User Event 正文、Evidence quote 或完整
retrieval text；只保存 typed reference、normalized term、结构化 reason code、必要
keyed HMAC 和非正文 timing。它们随 CompiledContext retention、source deletion 与
Full Purge 处理，不能成为另一份长期用户画像。

`relationship_resolver_hints` 是可删除、可重建的解析投影，不是关系真源：

```text
id
user_id
source_claim_version_id
anchor_entity_id
target_entity_id
view_direction             # forward / inverse / symmetric
locale
phrase
normalized_phrase_key
temporal_view              # current / former / historical
status                     # active / stale / deleted
projection_policy_version
created_at
content_purged_at
```

`anchor_entity_id` 表示当前称呼从哪一方观察，`target_entity_id` 表示该称呼要解析
到哪一方；`view_direction` 只描述 projection 视角，不参与 Claim identity。

只有被 `memory_claims.current_version_id` 指向、非 contested / retracted /
review_due 的 Relationship ClaimVersion 且双方 EntityVersion 仍有效时才能生成
Hint。具体角色 Hint 还要求其依赖的 Qualifier Assertion 为 `active`、Evidence
仍有效并满足 Registry policy。Resolver 读取时必须再次核验
`source_claim_version_id` 仍是 Claim current version；异步投影落后时 fail closed，
不能使用 stale Hint 完成绑定。伴侣 Claim 的 current version 已结束时可以按
Registry temporal policy 投影“前任 / ex-partner”，但不能因此创建第二条关系事实。
`temporal_status=unknown` 时不得生成暗示 `current` 或 `former` 的确定性 Hint。
如果冲突仅限于 Qualifier，依赖该 Qualifier 的具体角色 Hint 失效；只要底层关系
仍由有效 Evidence 支撑且 Registry 定义了 neutral fallback，就可以从同一 ClaimVersion
生成“家长 / 孩子”“手足”“伴侣”等中性 Hint，不能因此把整个 Claim 标为已否定。
一条 directed ClaimVersion 可以生成正向与反向本地化 Hint；symmetric ClaimVersion
可以为两个 anchor 生成语义等价的 Hint。所有 Hint 仍引用同一个
`source_claim_version_id`，不能成为反向 duplicate Claim。
第三方 Hint 必须保留 anchor Entity；例如“Lily 的丈夫”只能在 Lily 已解析时把
Tom 作为候选，不能把“丈夫”当作 user scope 内的全局唯一称呼。每个 Hint 只由一条
Relationship ClaimVersion 生成，不执行多边传递推导。

`claim_evidence_links` 保存 ClaimVersion 与 EvidenceItem 的多对多关系，并区分
`support / counter / subjective_report / context`。状态变化通过新 ClaimVersion 表达；
不原地改写旧 Statement、对象、置信度或认识状态。
`relationship_qualifier_evidence_links` 只回答哪条 Evidence 支撑或反驳哪个具体
角色 Qualifier，不能替代底层关系的 `claim_evidence_links`。
`memory_claims.current_version_id` 仅作为经过 CAS 更新的读取指针。

规则：

- `user_id + canonical_key` 是数据库唯一键；Relationship Candidate promotion
  必须先按 Predicate Registry 归一化 subject / object，再以该唯一键插入或锁定
  logical Claim。`current_version_id` 的 CAS 只控制版本推进，不能替代 Claim identity
  去重；
- `subject_entity_id` 与 Relationship Claim 的 `object_entity_id` 使用真实 foreign
  key；Relationship Predicate 缺少任一 canonical Entity 时不得创建 Claim；
- `canonical_key` 由 user scope、canonicalized subject / object Entity pair、
  predicate 和业务 scope 生成，不能由 Mention 顺序、观察方向或某一种语言的
  自然语言 Statement 直接 hash；
- 人物关系必须是 `kind=objective`、由 User Evidence 支撑并具有 Registry 定义的
  subject / object 方向与 temporal semantics；不同关系可以同时有效；
- directed Relationship Predicate 必须按 Registry 的 canonical subject / object
  约定重排 Candidate；从 inverse phrasing 提取的 Evidence 仍进入同一个 logical
  Claim。symmetric Predicate 必须按稳定 Entity ID 顺序归一化 pair；
- Relationship Qualifier 只细化 canonical subject / object 的角色与本地化投影，
  不进入 Predicate ID、`canonical_key` 或 Entity label，也不能从姓名、声音、
  locale 或未证实的 Entity 属性推导；
- Qualifier 冲突必须停在最小可证伪边界：只有具体角色冲突时将对应 Assertion
  标为 `contested` 并禁止具体投影；底层关系仍有效时可使用 Registry 中性 fallback。
  冲突改变 Predicate、Entity 或底层关系时，整条 Claim 进入 correction /
  `review_due` / retraction 流程；
- applied Qualifier-level Forget 创建同一 logical Claim 的新 ClaimVersion，
  retract 目标 Qualifier，并使其所有 localized projection 与 Resolver Hint
  立即 fail closed。只有 active exclusion 之外仍有 User Evidence 支撑底层关系时，
  新版本才能保留 neutral fallback；否则整条 Claim 必须 retracted；
- Forget Request 不产生 counter Evidence。Memory promotion、consolidation、
  Profile 与 Retrieval 必须检查 active `memory_forget_evidence_exclusions`，
  不能从仍保留的原 Conversation 或 Journal 重新学回被 Forget 的内容；
- applied Forget 在 target level 关闭新的长期 Memory admission；普通重复提及
  可以用于当前回应和 Journal，但 Candidate 不得 promote，也不触发自动权限追问。
  只有显式 Memory Forget Reversal 恢复；同一个 Reversal Event 必须作为新
  User Evidence 提交新 ClaimVersion，不能复用旧 Evidence、旧 ClaimVersion
  或旧 projection，也不创建 permission-only 状态；
- 用户本人的人物关系使用当前 User 的 Self Entity 作为一端；例如“我和小王是同事”
  绑定 Self Entity 与小王 Entity，而不是把 `user_id` 填入 Entity reference；
- Relationship Claim 也可以连接同一 user scope 内的两个非 Self Person Entity；
  Claim 的 `user_id` 表示 owner boundary，不表示 User 必须是 subject；
- active Relationship Claim 要求 subject / object EntityVersion 都是可绑定的 current
  Person EntityVersion。任一 Mention 仍 unresolved / ambiguous 时，Candidate 进入
  `needs_entity_resolution`，保留 Mention 与 Evidence，但不得 promote；
- 第三方关系只接受直接 User Evidence。一个或多个现有 Claim、Resolver Hint、
  Journal、Reflection 或 Profile 不能通过传递闭包生成新的 Objective Memory Claim；
- 每种可以独立成立、拥有独立 Evidence、有效时间、Correction 或 Forget 状态的关系
  使用独立 Predicate 与 logical Claim；同事和朋友可以同时成立，不能折叠为一个
  omnibus `relationship_type[]` Claim；
- 同一稳定关系所回答的问题未改变时，状态或有效时间变化创建新 ClaimVersion；
  关系结束后再次成立也复用同一 logical Claim，并以新 ClaimVersion 开启新的
  temporal interval；另一种可独立关系才创建新 logical Claim。结束一条 Claim
  不得 supersede 同一 Entity pair 上的其他关系 Claim；
- Relationship `canonical_key` 不包含 occurrence / interval ID。同一 pair +
  Predicate 的多个 current / ended 周期由 append-only ClaimVersion 历史表达，
  Resolver Hint 只读取 current version；当前不建设 period-scoped Forget；
- “前任”由已结束伴侣 Claim 的时间状态投影，不为同一事实创建独立
  `former_partner` Claim；稳定亲属关系可以长期保持一个 `valid_to = null`
  ClaimVersion，只有纠正、反向 Evidence 或状态变化才推进版本；
- `temporal_status` 与 Claim `status`、epistemic status 分离：前者回答关系当前仍成立、
  已结束或未知，后两者回答该 Claim 是否可用以及系统如何知道；
- `valid_from / valid_to` 允许为空，且各自记录时间精度。`current` 不要求已知
  `valid_from`，`ended` 不要求已知 `valid_to`，不能用 Evidence 创建时间、
  `created_at` 或 `last_observed_at` 猜测关系边界；
- Relationship Candidate 必须携带 `temporal_status`、可用时间边界与各自精度；
  Extraction 没有得到时间信息时显式返回 `unknown`，不得省略后由 server 猜测；
- “2023 年夏天左右”等表达只保存 policy-normalized 的近似边界与原始 User Evidence，
  不能升级成精确日期；Memory Source Explanation 必须区分 Evidence 日期与关系日期；
- Relationship Memory Claim 的 logical identity 必须包含双方 Entity 的稳定身份；
  directed Predicate 的 `scope_key` 纳入 canonical direction，symmetric Predicate
  使用 normalized unordered pair。观察方向、关系称呼和 locale 不进入 identity，
  但不能把同一 predicate 下涉及不同人物的关系折叠为一个 Claim；
- 中文与英文 Statement 可以是同一 ClaimVersion 的不同 localized projection；
- ClaimVersion 冻结 subject / object 的具体 EntityVersion；Entity 不由 Claim 文本
  派生身份；
- Retrieval 必须 fail closed：ClaimVersion 引用的 EntityVersion 已 merged、split、
  deleted、unresolved 或不再满足 resolver policy 时，该 Claim 立即停止 Recall，
  不能等待异步 consolidation；
- “用户说过”不自动等于客观世界事实；
- Objective Memory 的召回语言可以归属于用户先前陈述，但不能暗示系统已独立核验；
- AI Impression 的召回语言必须显式保留观察性和不确定性，不能使用
  “我记得你就是……”等事实化 framing；
- Claim 的 factual evidence 必须通过 EvidenceItem 回到有效的
  final / corrected User Event revision；
- Assistant / System Event 不能创建或 reinforce Objective / Impression Claim；
- ReflectionVersion、JournalVersion、ProfileProjection 不能作为 Claim 的底层 evidence；
- AI Impression 永远不升级为 Objective Memory；
- 一次情绪不形成稳定人格判断；
- 新状态不能覆盖并抹去历史状态；
- 新 Evidence 与 current Claim 不一致时，先按 Registry 的 scope、时间语义和
  value cardinality 判断：明确时间变化创建新版本，明确纠正 supersede 错误版本，
  允许并存的值分别保留；
- 只有同一 Predicate、normalized scope 与有效时间内仍互斥且意图不明时，才创建
  `epistemic_status=contested + status=review_due` 的新 ClaimVersion，并立即排除
  Recall、Profile 与 Embedding；最新 Evidence 或更高 confidence 不能自动获胜；
- `confirmed` Objective Memory 不因 `last_observed_at` 变旧而降低 confidence 或
  转为 dormant；时间敏感值只通过 Registry temporal semantics 与新 ClaimVersion
  表达当前是否仍适用；
- AI Impression 到达 Registry review deadline 且没有新的合格 Evidence 时，创建
  `epistemic_status=inferred + status=dormant` 的新 ClaimVersion，并立即排除
  Recall、Profile、Embedding 与 cross-day narrative；
- dormant Impression 只有在 fresh Evidence 重新满足跨 Session admission 后，
  才能创建新的 active ClaimVersion；旧版本、旧 Evidence 和模型 confidence
  不能直接恢复。反向 Evidence 进入 contested，不通过 dormancy 隐藏冲突；
- 模型只能提出 candidate 或 diff；
- 代码执行 claim promote、supersede、retract；
- 模型遗漏旧 Claim 不得产生删除；
- Bio 只读取有效 Claim，可随时重建。

Bio 是 LLM based、可重建的叙事产物，不是 User Profile 或 Memory Claim 的完整导出；
不可变版本统一称为 BioVersion。每个 owner 的单调 `bio_source_revision` 在 Bio
eligibility 或解释 eligible Claim 所需内容发生提交变化时推进：

- Projection Worker 先按版本化 policy 冻结 eligible set，只包含 current、active、
  未被 Forget 且 EntityVersion 仍有效的 ClaimVersion；
- `contested`、`review_due`、`dormant` Claim，MemoryCandidate、OpenLoopVersion
  与 ReflectionVersion 不进入 eligible set；
- 全部 eligible ClaimVersion 都进入 LLM 输入；`sensitivity_class=sensitive`
  不创建第二层 Profile authorization，也不能仅因敏感而从输入集合中排除；
- LLM 基于版本化 Prompt 对完整 eligible set 做语义压缩和叙事组织，形成对用户、
  经历、关系、情感与价值观的自然语言讲述；
- 每个 GenerationCommand 冻结一个 `presentation_locale`、Self Entity version、
  canonical display label 与可选的用户明确声明代词；没有明确代词时生成器必须重复
  名字或改写，不能推断性别。一个 BioVersion 只保存一种已生成并校验的 locale，
  Basis quotation 保留原语言；
- `bio_claim_links` 使用 `link_role=eligible_input /
  narrative_support`，同时冻结完整输入集合和正文实际依赖的 ClaimVersion；
  validator 拒绝 eligible set 外的引用，并检查正文陈述能由 narrative support
  Claim 展开到底层 User Evidence；
- 版本化 Bio Coverage Policy 将每个 eligible ClaimVersion 确定性映射到一个 Bio
  Coverage Unit，并根据 Predicate Registry metadata 与 current temporal scope 标注
  `required`、`compressible` 或 `background`；未发布 class 默认 `required`，敏感性
  不改变 class。一个 logical Claim 的 current ClaimVersion 默认形成一个 unit；只有
  共享已发布 `bio_composition_key`，且 subject、Entity、时间与认识类型兼容时可
  合并，Objective 与 Impression 不合并，composite 采用最严格 class。`required`
  决定本版 coverage plan 的稳定优先级。进入计划的 `required` 必须有可独立定位的
  忠实表达，`compressible` 必须能从更宽的 supported proposition 推得；
  `background` 可携带 policy reason 显式 absent。完整 User Profile 超出可读预算
  时，policy 把未选 unit 记为 `deferred_by_budget`，不让 Bio 生成失败；只有计划内
  前两类缺失才是 `material_absence`。生成器返回 statement、atomic
  proposition、Claim support 与 coverage disposition，`narrative.validate` 独立重拆
  最终正文并比较 manifest，实质差异不能发布；
- 一个 proposition 可以由多条 Claim 联合支持，也允许一条 Claim 支持多个
  proposition；每个 link 必须有实际贡献，支持集合必须联合充分，validator 拒绝无关
  padding link，并允许多个等价的最小充分集合；
- active Claim 之间存在叙事张力但未进入 contested 时，Bio 保留双方；只有 active AI
  Impression 可以支持进一步的动机或人格解释。无法由时间、scope 或认识类型解释的
  直接矛盾阻止发布，Bio 不得自行选择一边；
- Prompt、model config、generation command、authoritative attempt 与 selection
  policy version 必须随 BioVersion 可审计；
- 语义压缩不要求每条 eligible Claim 逐条出现在正文中，但不能与 active Memory
  实质矛盾或遗漏到形成失真的人物画像；压缩不改变 Claim lifecycle、
  Recall eligibility 或 Memory identity；
- 每个可独立成立的事实判断必须由 active Objective Memory 支撑，每个可独立成立的
  心理、情感或价值观判断必须由 active AI Impression 支撑；LLM 不能在 Bio
  内创建只存在于 Bio 的新推断、修改认识状态或把叙事文本写回 Claim；
- BioVersion 不能成为 Journal、Reflection 或 Memory 的 Evidence。

eligible set 为空时不调用模型，也不创建空 BioVersion。存在至少一条 eligible Claim
时允许生成短 Bio，但不能为了填满章节补写人格判断。

第一条 eligible Claim 不自动触发模型调用；有 Claim 但无 Bio 时 aggregate 为
`ready_to_build`，manual 首次生成不受成功发布冷却限制，weekly 仍可创建首版。
章节、标题、statement 与 proposition identity 只在所属 BioVersion 内稳定，标题中的
用户判断也进入 proposition 与 support 校验。

Bio aggregate 还必须记录 Bio Refresh Policy 的当前状态：

```text
refresh_state                 # current / regenerating / trust_invalidated
last_generated_at
next_manual_refresh_at
next_scheduled_refresh_at
refresh_policy_version
trust_invalidated_at
trust_invalidation_revision
bio_source_revision
```

`bio_versions` 保存正文、locale、冻结 source revision 与 manifest hash、Self Entity
version、display label、可选 declared pronoun、GenerationCommand、authoritative
ModelRunAttempt，以及 Prompt、Schema、generation、validation、coverage、refresh 和
schedule policy versions。`bio_statements`、`bio_atomic_propositions`、
`bio_claim_links`、`bio_coverage_units`、`bio_coverage_members` 与
`bio_validation_findings` 保存 validator 接受的 typed structure；产品读取不解析
ModelRunAttempt 原始 JSON。

- 普通 active Claim 增加或更新只推进 eligible Claim-set revision，不立即使当前 Bio
  不可见；用户手动刷新或每周 schedule 读取最新 eligible set 重建；
- 手动 refresh command 由服务端以 `next_manual_refresh_at` 和 policy version 限流，
  前端只镜像服务端允许时间，不能成为唯一控制；
- `manual` 与 `weekly_scheduled` 生成结果通过 Bio validator 和提交 fence 后，
  原子创建新的 BioVersion 并推进 current pointer；数据模型不增加
  `awaiting_approval`、用户编辑稿或多候选版本选择状态；
- 一个全局 Cron / scheduler 扫描到期的 `next_scheduled_refresh_at`，按用户本地
  schedule policy 创建幂等 weekly refresh command，不为每个用户维护独立 Cron；
- Correction、Forget、`contested`、`dormant`、Entity 失效或删除提交时，必须同步
  标记受影响 Bio `trust_invalidated`；读取路径也要复核 narrative-support
  ClaimVersion 仍有效，不能依赖异步任务及时性；
- trust-invalidated Bio 没有可展示的旧版本，安全重建绕过普通手动间隔与 weekly
  schedule；失败时保持不可用，不能回退到包含失效内容的 BioVersion。

Manual 与 weekly trigger 冻结同一个 `bio_source_revision` 时复用一个
GenerationCommand，并分别保留 trigger 记录。Trust-boundary transaction 在同一提交
中隐藏 current Bio、推进 source revision 并创建幂等 rebuild intent；普通 command
不能替代 trust rebuild。读取路径每次复核 owner、data epoch、current pointer、
BioVersion readable state 与所有 narrative-support ClaimVersion fence，失效时同步
拒绝返回并幂等补发 rebuild intent。普通新增 Claim 只使 Bio 变旧，不使它不可读。

发布后被 supersede 的 BioVersion 与 typed lineage 保留到 Full Purge，但普通产品读取
只返回 current。失败、stale 或 `needs_review` draft 的正文、proposition、support
与 finding 最多保留七天，之后只留不含内容的 command、attempt、错误类别与时间。

Bio 没有用户直接写正文的命令。用户对 Bio 内容的 Correction 或 Forget 必须先
作用于底层 Memory Claim，再由 trust-boundary rebuild 生成新的 BioVersion。

#### 7.10.1 Predicate Registry

Predicate Registry 是 SayHear 自有、版本化的受控语义词表。模型负责把自然语言
映射到 Registry，不能创建或修改 Predicate ID。`canonical_key` 只能保证相同
Predicate ID 的 Claim 去重，不能修复 Registry 自身存在的同义 Predicate，因此
词表治理是 Claim identity 的一部分。

##### Predicate ID 命名

使用稳定的：

```text
sh.<semantic_domain>.<concept>
```

约束：

- 使用小写 ASCII 与 `snake_case`，不把 display label 当作 ID；
- ID 表达“这个 Claim 在回答什么稳定问题”，不表达某一次答案；
- object value、正负方向、置信度、`objective / impression`、认识状态、时间、
  locale 和模型不得编码进 ID；
- 同义词、翻译和自然语言别名进入 localization，不创建第二个 Predicate；
- 具体人物、地点、项目和 Episode 使用 Entity / Episode ID，不扩张成 Predicate；
- 发布后的 ID 永不复用，也不静默改变语义。

例如：

```text
# 推荐
predicate_id = sh.preference.relationship_horizon
typed_value  = { type: enum, value: long_term }

predicate_id = sh.preference.business_travel
typed_value  = { type: sentiment, value: negative }

predicate_id     = sh.value.relationship_continuity
kind             = impression
epistemic_status = inferred

# 禁止
sh.preferences.long_term_relationships
sh.preference.dislikes_business_travel
sh.impression.probably_values_relationships
sh.zh.preference.business_travel
```

##### Registry Entry

每个 Predicate 至少定义：

```text
predicate_id
registry_version
status                         # draft / active / deprecated / retired
definition_version
allowed_subject_kind_ids
allowed_claim_kinds
sensitivity_class              # standard / sensitive
object_value_schema
scope_schema
value_cardinality              # one / many per normalized scope and effective time
temporal_semantics
relationship_semantics         # nullable; directed / symmetric、canonical roles、pair normalization
evidence_policy_id
review_policy_id               # required when allowed_claim_kinds includes impression
replaced_by_predicate_id
created_at
deprecated_at
```

`evidence_policy_id` 除定义允许的 Evidence actor、revision 与 typed link 外，
还必须定义 Impression 的最小独立 Evidence 数、最小 Daily Session 数、冲突处理
和可选时间跨度。所有允许 `kind=impression` 的 active Registry Entry 都必须至少
满足全局两条 Evidence、两个 Daily Session 的下限。

`sensitivity_class=sensitive` 的 active Entry 还必须用 `allowed_claim_kinds`、
Evidence policy、正反例和 `confusable_with` 明确敏感边界：

- 医学或精神诊断、性取向、宗教或政治身份、创伤或受虐标签、财务或法律风险
  归类 Predicate 只允许来自用户直接、明确、自我指向陈述的 Objective Candidate；
- 允许 AI Impression 的敏感 Predicate 必须回答意义、影响、支持或压力来源、
  交流偏好等解释性问题，不得回答用户属于哪一种诊断、身份或风险类别；
- 症状、伴侣关系、宗教活动、政治观点和相似经历不能作为敏感归类的替代 Evidence；
- 高风险概念可以要求更多 Evidence、更长时间跨度和更短复核周期，但这些门槛
  不能把禁止的分类性推断变成允许。

`value_cardinality`、`scope_schema` 与 `temporal_semantics` 共同决定两个值是否
真正冲突。不同 scope、不同有效时间或允许同时存在的多个值不能进入 `contested`；
Registry 必须为 single-value Predicate 定义可比较的 normalized scope 和时间规则。

`review_policy_id` 为 AI Impression 定义复核周期、新 Evidence 的有效窗口与
到期动作。全局默认到期动作是创建新的 dormant ClaimVersion；Registry 可以缩短
周期或要求更多 fresh Evidence，但不能让 Impression 永久跳过复核。Objective
Memory 不使用该周期降低 confidence，其当前适用性只由 temporal semantics 决定。

Relationship Predicate 的 `temporal_semantics` 必须声明允许的
`temporal_status`、边界精度、缺失边界规则，以及 current / former Resolver Hint
投影条件。Registry 不得要求模型为了满足 Schema 伪造精确日期。

Relationship Predicate 的 `relationship_semantics` 必须声明：

- 关系是 `directed` 还是 `symmetric`；
- directed 关系的 canonical subject / object 角色约定；
- symmetric 关系的稳定 Entity pair normalization；
- 是否允许生成 forward / inverse / symmetric projection。
- `qualifier_schema`：允许的 canonical side、typed value、cardinality、
  compatibility / refinement 规则、Evidence policy、中性 fallback 和 projection
  使用条件。

模型表达中的主语、Mention 顺序或当前观察者不能覆盖这些规则。

自然语言资料与机器身份分开：

```text
predicate_localizations
  predicate_id
  locale
  label
  definition
  positive_examples
  negative_examples
  localization_version

relationship_projection_localizations
  predicate_id
  locale
  view_direction              # forward / inverse / symmetric
  role_projection_schema      # localized phrases / templates and constraints
  localization_version

predicate_relations
  predicate_id
  related_predicate_id
  relation_type              # confusable_with / broader / narrower / replaced_by
```

中文、英文和 code-switching 输入必须映射到同一个 Predicate ID；模型选择时看到
目标 locale 的定义，并在高混淆场景同时看到正例、反例和 `confusable_with`。

##### 运行时映射

模型不得返回任意字符串形式的 Predicate：

1. Extraction 运行固定 `predicate_registry_version`；
2. Registry 较小时提供完整 allowed list；增长后先按 Evidence 类型、Entity kind
   和语义检索得到有限候选；
3. 模型只能从候选中选择，或返回 `ambiguous / unmapped`；
4. 输出必须包含 `predicate_id`、Registry version、typed value、scope、
   Evidence ID、mapping confidence 和必要 alternatives；Relationship Candidate
   还必须包含 Evidence 表达中的双方角色、Qualifier typed value 及其 Evidence ID、
   temporal status、可用边界与各自 precision；
5. 服务端重新校验 ID 状态、subject / object Schema、scope、temporal semantics、
   relationship / qualifier semantics、sensitivity class、allowed claim kind、
   Evidence policy 和版本；随后按 Registry canonicalize directed roles 或
   symmetric pair，并独立验证每个 Qualifier Assertion，不信任模型的字符串、
   Mention 顺序、角色猜测或补造缺失时间；
6. `ambiguous / unmapped` Candidate 进入确定性的 Predicate Review Eligibility
   检查；只有通过检查的 Candidate 才进入 `needs_predicate_review`，且不得创建
   active MemoryClaim；
7. 模型输出的 product-value 判断、排序或 review 建议不参与 eligibility 决策；
8. 拼写错误、未知 ID、deprecated ID 的新写入和不匹配 typed value 一律 fail closed。

Registry 没有合适概念时，模型只可提交：

```text
predicate_id = null
predicate_resolution_status = unmapped
proposed_concept = {
  description,
  suggested_object_schema
}
```

Review 只能将其映射到已有 Predicate、批准新 Predicate，或拒绝长期记忆化；
模型不能在生产运行中自动扩充 Registry。

Predicate Review Eligibility 由版本化确定性 policy 判断：

- Candidate 引用可展开到有效 User Event Revision 的 Evidence，Entity、scope 与
  proposed kind 足以复核；
- proposed concept 回答一个可能跨日使用的稳定问题，而不是一次性状态、普通话题、
  临时 Context、Episode、Open Loop 或 Reflection 自身；
- 该差异不能由已有 Predicate 的 value、scope、时间、locale、Claim kind 或
  Relationship Qualifier 表达；
- Candidate 不违反 sensitive classification、Forget fence、删除或其他长期
  Memory policy；
- proposed concept 足以让 reviewer 定义 value schema、Evidence policy 与正反例。

通过检查只得到 Predicate Review Eligible 与 `needs_predicate_review`，不表示已
证明产品价值。授权人工 reviewer 才能把 Candidate 映射到已有 Predicate，或批准
一个包含 Registry Entry draft、正反例、confusable relations 与回归测试要求的
Predicate Change Proposal。LLM 可以聚类、排序、寻找相近项和生成 review 草稿，
但不能改变 eligibility、批准 Proposal 或发布 Registry version。

写入 `needs_predicate_review` 时必须同时设置
`review_due_at = review_eligible_at + 30 days`。到期扫描使用条件更新把仍未获得
明确人工 disposition 的 Candidate 转为 `stale`；stale Candidate 不参与 mapping、
admission、Claim promotion 或 Registry approval 后的自动重试。Terminal Candidate
正文按 7 天 Content Grace 清理；Materially New Evidence 只能按版本化
`reproposal_policy` 创建新的 Successor Memory Candidate，不能从 30 天 deadline
或新的 Registry version 自行推导。

Predicate Change Proposal 与 MemoryCandidate 分离保存，避免把 Registry 治理状态
塞进 Memory admission 对象：

```text
predicate_change_proposals
  id
  current_version_id
  created_at

predicate_change_proposal_versions
  id
  proposal_id
  revision
  base_registry_version
  proposed_predicate_id
  proposed_entry_draft
  status                       # awaiting_release / published / rejected / canceled
  decision_scope               # registry_change / product_value_rejection
  decision_reason_code
  reviewer_principal_id
  review_reason
  published_registry_version  # nullable
  published_at                # nullable
  supersedes_version_id        # nullable
  created_at

predicate_change_proposal_candidate_links
  proposal_version_id
  memory_candidate_id
  link_role                    # source / matched_governance
  created_at
```

一个 Proposal 可以聚合多个语义相同的 Candidate，但不能复制底层 Evidence 正文；
reviewer 通过 Candidate 的 Evidence link 受控读取来源。`Approve for Registry Change`
原子创建 awaiting-release ProposalVersion、link 和
`status=awaiting_registry_release` Candidate disposition，并设置
`registry_release_due_at = registry_release_wait_started_at + 90 days`。该状态
不受原 `review_due_at` 到期扫描影响，但在 `published_registry_version` 出现前
不参与 mapping、admission 或 Claim promotion。

`Reject` command 仍是 Candidate Review Module 的单一 interface。Candidate-specific
reason 只写 terminal Candidate disposition；只有
`decision_scope=product_value_rejection` 时，该 Module 才委托 Predicate Registry
Governance Module 创建或关联 `status=rejected` ProposalVersion，并写入
`link_role=source`。Rejected Proposal 只能保存通用概念定义、value schema 草案、
人工编写或审核的合成正反例、结构化 reason 与 reviewer rationale；不得包含
subject `user_id`、Evidence ID / locator、具体 typed value、用户原话、Entity、
时间地点或可从关联 Candidate 复制出的私人细节。`reviewer_principal_id` 只记录
产品治理责任人，不表示概念来自该 reviewer 的个人 Evidence。

`awaiting_release` Predicate Change Proposal 不自动过期，直到 Registry 发布或授权
人工明确取消；`rejected` Proposal 保持到显式版本化重新评估。独立的 Candidate
deadline 到期扫描使用条件更新，把到达 `registry_release_due_at` 且没有在该时点前
发布对应 Registry version 的 Candidate 转为 `stale`，但不取消或删除 Proposal。资格取决于
`published_at <= registry_release_due_at`，不能取决于发布 reconciliation 与到期
扫描哪个任务先执行。

Registry 发布仍只由代码库 TypeScript / YAML、mapping tests 与 migration 驱动。
发布流程创建 `status=published` ProposalVersion 后，reconciliation 只能把仍处于
`awaiting_registry_release` 且 `published_at <= registry_release_due_at` 的关联
Candidate 送回新 Registry version 下的正常 mapping 与 admission；不能把 Proposal
本身当作 Predicate、Evidence 或 Claim，也不能自动复活已经 stale 或已超期但扫描
尚未运行的 Candidate。新 Evidence 或显式、版本化的重新评估可以产生新的
admission 结果，但必须保留原 stale lineage。

Rejected ProposalVersion 是概念级产品治理结果，不因新 Candidate、Evidence、
模型 confidence 或 Registry version 自动改变。后续模型可以从受治理的 Proposal
identity 中选择 `matched_governance`，服务端必须验证 Proposal current version；
命中 rejected 时不得进入 review queue、mapping、admission 或 Claim promotion。
授权人工重新考虑时创建 superseding ProposalVersion，不能改写旧 rejection。
Internal Owner Full Purge 或 Account Deletion 删除 Proposal–Candidate link，但只要
Proposal 内容通过上述无用户内容约束，Proposal identity 与版本化治理历史可以保留。

##### 相同与相近 Predicate 的判定

新增前必须回答：

- 两者是否在回答同一个稳定问题？
- 新值是否应该 supersede 旧值？如果是，使用同一 Predicate 和新 ClaimVersion；
- 两者是否可以同时独立成立？如果是，可以使用不同 Predicate；
- 差异是否只是 value、scope、时间、locale、kind、epistemic status 或
  Relationship Qualifier？
  如果是，不创建新 Predicate；
- 该内容是否更适合 Entity relation、Episode、Open Loop 或 Reflection？

例如，“重视关系的长期延续”与“偏好长期浪漫关系”可以同时独立成立：

```text
sh.value.relationship_continuity
sh.preference.relationship_horizon
```

它们不得仅凭字符串相似度合并。相反，“喜欢工作出差”与“不喜欢工作出差”
是在回答同一个问题，应使用 `sh.preference.business_travel` 的不同 typed value。

##### 发布、演进与验证

- Internal Core 使用代码库内版本化 TypeScript / YAML Registry，并通过 migration 同步数据库；
- 新 Predicate 必须经过同义项搜索、正反例、confusable pair、中英文与
  code-switching mapping test，并由授权人工 reviewer 批准；
- display label、翻译或不改变语义的定义澄清只增加 definition /
  localization version，不改变 Predicate ID；
- 语义实质扩大、缩小或改变时创建新 Predicate，旧项标记 deprecated 并设置
  `replaced_by_predicate_id`；
- deprecated Claim 保留历史引用；迁移必须逐 Claim revalidate，不假定批量等价；
- Extraction、MemoryCandidate、ClaimVersion、Replay 和 Eval 固定 Registry version；
- 回归测试至少覆盖同义跨语言映射、高混淆 Predicate 分离、未知概念返回
  `unmapped`、非法 value 拒绝，以及旧 Registry version 的可重放性。

#### 7.10.2 Open Loop Projection

Open Loop 是有期限的 Context projection，不是 Memory Claim 或 Profile：

`OpenLoopProposal` 是单次 extraction run 内的瞬时结构化建议，不是持久化
Candidate。模型可以提出 `loop_kind`、Evidence locator、pending anchor、用户时间表达
以及可选 Claim / Episode source reference；代码独占 Evidence 资格、原子 pending state、
kind / 非任务边界、时间规范化、有限 `expires_at`、唯一 source binding 与 dedupe identity
的决定。v1 不建立 `open_loop_candidates`、review queue 或等待以后解析的模糊状态。

```text
open_loops
  id
  user_id
  current_version_id
  created_at
  deleted_at

open_loop_versions
  id
  open_loop_id
  revision
  loop_kind                    # upcoming_event / awaited_outcome
  source_evidence_id
  source_claim_version_id      # nullable
  source_episode_version_id    # nullable
  localized_summary             # rebuildable rendering, never a factual source
  expected_start_at            # nullable; exact instant or inclusive range start
  expected_end_at              # nullable; exclusive range end; null for exact instant
  expected_time_precision      # exact / day / bounded_range / approximate / unknown
  anchor_timezone              # nullable frozen IANA timezone used for local interpretation
  followup_eligible_from_at     # required deterministic selector time gate
  expires_at                   # required
  expiry_source                # user_anchor / policy
  status                       # open / occurred / resolved / canceled / expired / retracted
  closed_by_event_revision_id  # nullable
  projection_policy_version
  supersedes_version_id
  created_at
  terminal_effective_at         # nullable; expiry uses the original expires_at
  processed_at                  # nullable; terminal Version commit time
  content_retention_started_at  # nullable; superseded or terminal semantic time
  content_purged_at

proactive_followup_states
  id
  user_id
  target_kind                   # open_loop / memory_claim
  target_id
  current_version_id
  created_at
  deleted_at

proactive_followup_state_versions
  id
  proactive_followup_state_id
  revision
  target_version_id
  eligibility_status            # eligible / suppressed
  suppression_reason            # short_response / evaded / refused / topic_changed / ambiguous_closure
  consecutive_soft_suppression_count
  suppressed_until_at           # nullable; null for non-time-releasable suppression
  release_reason                # nullable; cooldown / user_reopened / material_evidence / target_permission / ambiguity_resolved
  last_prompt_daily_session_id
  last_prompt_continuous_exchange_no
  last_prompt_assistant_event_revision_id
  last_response_user_event_revision_id
  release_trigger_event_revision_id
  policy_bundle_version
  suppression_policy_version
  supersedes_version_id
  created_at
  content_purged_at

proactive_followup_selection_reservations
  id
  user_id
  daily_session_id
  continuous_exchange_no
  main_generation_command_id
  segment_generation_command_id          # nullable until Segment Command is created
  target_kind                       # open_loop / memory_claim
  target_id
  target_version_id
  policy_bundle_version
  selection_policy_version
  status                            # active / committed / released / abandoned
  created_at
  terminal_at

proactive_followup_uses
  id
  user_id
  daily_session_id
  continuous_exchange_no
  assistant_event_revision_id       # unique; only a committed Complete Assistant Response
  main_generation_command_id
  segment_generation_command_id
  compiled_context_id
  selection_reservation_id
  target_kind                       # open_loop / memory_claim
  target_id
  target_version_id
  expression_kind                   # question / acknowledgment
  content_locator                   # segment/span inside the committed Assistant Event
  policy_bundle_version
  selection_policy_version
  expression_prompt_version
  expression_policy_version
  created_at

proactive_followup_response_dispositions
  id
  proactive_followup_use_id
  response_user_event_revision_id
  disposition                       # no_stop_signal / short_response / evaded / refused / topic_changed
  evidence_locator
  policy_bundle_version
  suppression_policy_version
  created_at
```

`proactive_followup_uses` 以 `(user_id, daily_session_id, continuous_exchange_no)` 为唯一使用边界，并与
Assistant Event revision、exchange usage marker 在同一事务提交。它保存真实 target identity / Version，
不把 Command-scoped Handle 当成持久对象身份，也不复制 Assistant 正文。

`proactive_followup_selection_reservations` 对 `(user_id, daily_session_id, continuous_exchange_no)` 只允许一个
active row。它冻结 main / Segment Command 和 target Version，不表示已使用，不创建 suppression，也不以普通时间
过期。持有 reservation 的 Segment Command terminal transition 或 recovery reconciliation 是唯一释放权威；
提交 use 时将它原子转为 `committed`。

没有 `proactive_followup_states` row 的 target 解释为 `never_suppressed`，选择门禁通过并在 manifest
记录 null state Version；系统不 backfill 或预建 eligible row，committed use 也不创建它。第一次有效
suppression 才惰性创建 logical state 与 suppressed Version；后续 release 追加 eligible Version。若并发
第一次 suppression，logical target 唯一约束与 CAS 只允许一条 current lineage。

一个 use 之后的首个 User Event 在 response disposition 未 settled 前，该 target 在 selector 中临时
fail closed。`no_stop_signal` 只表示本 Event 没有产生 target suppression，不是用户生活事实。
`short_response / evaded / refused / topic_changed` 必须与新的 suppressed State Version 原子提交。

`proactive-followup-suppression:v1` 按 logical target 计算连续软停止次数。`topic_changed` 的前三次
分别冻结 1 / 7 / 30 个当地日历日，第四次 `suppressed_until_at=null`；`short_response` 前两次
分别冻结 7 / 30 日，第三次为 null；`evaded` 首次冻结 30 日，第二次为 null；`refused`
与 `ambiguous_closure` 始终为 null。null 表示不可由时间解除，不表示没有 suppression。

对有限冷却，read path 在 `now >= suppressed_until_at` 时将它视为恢复选择资格，不等待 scanner。
后台 scanner 只用 CAS 幂等补写 `release_reason=cooldown` 的 eligible Version，不创建 GenerationCommand、
Assistant Event 或消息。Open Loop expiry / terminal fence 始终优先。用户主动且唯一地重提、实质新
Evidence 推进仍 eligible 的 target，或 target-specific 询问许可时，创建 eligible Version 并清零
软停止次数。普通 Version / policy / index / rendering 变化、技术 Entity 修复与单纯 trust-control
Action 都不能释放或清零。

每个 OpenLoopVersion 必须直接引用 final / corrected User Event 对应的 EvidenceItem。
模型只能提出瞬时 OpenLoopProposal；代码只有在 Evidence 明确表达具体待发生事项或待确认结果，
且 `expires_at` 来自用户时间 anchor 或版本化 policy 时才能创建 Open Loop。
v1 的 `loop_kind` 是封闭 catalog，只允许 `upcoming_event` 与 `awaited_outcome`。
`upcoming_event` 必须有独立现实事件锚点；用户需要完成的动作、义务或待办即使带有
日期也必须拒绝，不能把它们包装成 Event 绕过非任务边界。
普通未聊完话题、情绪、模型计划的后续问题和没有现实 pending anchor 的内容一律拒绝。

只有通过全部 gate 的 Proposal 才能在同一 owner `data_epoch` 与 source-revision
fence 事务中创建 `open_loops` 与首个 `open_loop_versions` row。单条 Proposal 语义
不合格、source binding 不唯一或重复时只在 extraction run 中记录结构化 skip reason，
不保存其语义正文、不进入 Context，也不触发澄清；后续新的 User Evidence 可以产生
新的 Proposal。

Open Loop Expected Time 使用冻结的 `expected_start_at / expected_end_at /
expected_time_precision / anchor_timezone`，表达 Evidence 支持的现实事件或结果时间：

- exact datetime 只保存 instant，`expected_end_at=null`；
- date-only 与 bounded local range 以 Evidence 所属 Daily Session 的 IANA timezone
  解析一次，保存 inclusive start 与 exclusive end；DST 边界使用 timezone calendar
  运算，不能按固定 24 小时推进；
- approximate 或无时间 anchor 时不伪造边界，start / end 保持 null；
- timezone 后续变化不重算历史窗口；用户纠正或细化时从新 Evidence 创建 Version。

v1 只有宽度不超过 31 个当地日历日的 bounded range 可以成为 expected anchor。
更宽范围即使可以解析，也必须拒绝 Open Loop Proposal；同一 Evidence 仍可按独立规则
形成 Objective Memory 或 Episode。没有精确边界的自然语言只有命中版本化 lexical
policy 的 near-term allowed set 时，才按无 anchor 14 日 policy 创建；模型输出不能
自行把模糊或远期表达归为 near-term。之后只有新的、更精确 User Evidence 才能形成
Open Loop，不从被拒 Proposal 或旧宽范围自动激活。

`source_evidence_id` 永远是当前 OpenLoopVersion 的直接事实根。只有 active Objective
ClaimVersion 精确表达同一事实时才设置 `source_claim_version_id`；只有 pending state
安全属于一个现实 Episode 时才设置 `source_episode_version_id`。两者角色不同，可以
同时存在；引用必须固定具体不可变 Version，但 Open Loop 自己拥有 open / terminal
lifecycle。Claim / Episode 不存在或未解析不阻止直接 Evidence 足够的 Proposal。
Open Loop 不能继承被引用对象的其他 Evidence、推断或属性。

`localized_summary` 是从合格 Evidence 与绑定 Version 生成的可重建 rendering，不是
事实或新的 Evidence，不能引入 source 未支持的信息。重建 rendering 不改变 logical
Open Loop 或其 Version；语义事实、source binding 或 lifecycle 变化必须创建新 Version。

Open Loop 的技术幂等与领域 identity 分开：同一 `event_revision_id + proposal_index +
extraction_policy_version` 只能提交一次。跨 Evidence 只有新表达被 resolver 明确且
唯一绑定到一个已有 `open_loop_id`，或新旧 Version 指向同一 logical Objective Claim、
`loop_kind` 相同且 expected time 不存在实质冲突时，才能复用 logical Open Loop 并创建
新 Version。相同 Episode、Entity、时间窗口、localized summary、embedding 相似度或
模型 confidence 只能召回 identity candidate，不能授权 merge。

没有 candidate 通过全部 identity gate 时创建新 logical Open Loop；存在相似 candidate
但没有恰好一个可以被证明时，Proposal 以 `ambiguous_loop_identity` fail closed，既不
merge，也不创建可能重复的新 Loop。identity policy 与 resolver policy 必须版本化。

`expires_at` 是 current open Version 最后允许被 selector 使用的确定性边界，不是
expected time、due date 或 completion assertion。有用户时间范围时从 exclusive end
计算 finite grace period；exact instant 从 start 计算；没有时间 anchor 时从 Evidence
时间计算版本化 kind-specific 期限。到达 expected window 不推进 Version；只有合格
关闭 Evidence 或到达 `expires_at` 才改变 open 状态。

v1 `projection_policy_version` 的期限矩阵使用形成时冻结 timezone 的 calendar day：

| kind | 有 expected anchor | 无 expected anchor |
| --- | --- | --- |
| `upcoming_event` | expected instant / range end + 7 日 | Evidence committed time + 14 日 |
| `awaited_outcome` | expected instant / range end + 14 日 | Evidence committed time + 14 日 |

计算出的 `expires_at` 必须不晚于 Evidence committed time + 360 个当地日历日；超过
该 open horizon 的 Proposal 不创建 Open Loop，但不影响同一 Evidence 按独立规则形成
Objective Memory 或 Episode。期限 policy 更新只影响新 Proposal / Version，不重算历史。

`followup_eligible_from_at` 与 Open Loop 形成时间分开：anchored `upcoming_event` 从
expected start 前 14 个当地日历日开始，anchored `awaited_outcome` 从 expected start
开始，无 anchor 两类都从 Evidence committed time 开始。`now` 早于该值时，Version
仍参与 dedupe、Correction、closure 与 source invalidation，但 Context Compiler 不得
把它作为 Proactive Follow-up target。该时间 gate 与 ProactiveFollowupStateVersion
的 target-level suppression 同时检查，任何一层不允许都 fail closed。

selector 的时间区间是半开区间：`followup_eligible_from_at <= now < expires_at`。
`now >= expires_at` 时读取立即 fail closed，即使 current pointer 尚未物化到 expired
Version。expiry scanner 只补写历史：查询 `current status=open AND expires_at <= now`，
稳定排序、分批、row lock / CAS，并在事务内重验 owner、`data_epoch`、current Version、
status 与 deadline。幂等 identity 是 `open_loop_id + expiring_version_id + expired +
projection_policy_version`。新 expired Version 的 `terminal_effective_at` 使用原
`expires_at`，`processed_at` 使用实际提交时间；扫描延迟不延长语义资格。

Closure / expiry race 只比较 Closure Evidence 的 authoritative User Event
`committed_at` 与 current open Version 的 `expires_at`：

- `committed_at < expires_at` 时 closure 胜出；如果 scanner 已先写 expired Version，
  closure worker 可以在重验 source / owner / current chain 后创建 kind-specific terminal
  successor 并推进 current pointer；中间 expired Version 保持不可变历史；
- `committed_at >= expires_at` 时保持 expired。晚到 Evidence 仍进入其他合格派生流程，
  但不改变 Open Loop terminal state；
- closure Version 的 `terminal_effective_at` 使用 Event `committed_at`，`processed_at`
  使用实际事务提交时间；用户描述的现实发生时间不能倒推覆盖 expiry；
- 除边界前 Closure Evidence 纠正竞态 expired 外，terminal Version 不互相覆盖。

worker 必须通过 row lock / CAS 重读 current Version；不能使用 worker 完成顺序决定赢家。

source Evidence revision、Forget / deletion fence 或 identity binding 失效时，读路径立即
排除旧 open Version 并触发幂等 revalidation：

- corrected Evidence 仍支持同一个 independently closable pending state 时，为同一
  logical Loop 创建新的 open Version，重新计算 frozen expected window、eligibility、
  expiry 与可选 source references；
- Evidence 不再支持、变成 Task / 宽时间范围或身份仍歧义时，创建 `retracted` Version；
- `retracted` 表示派生资格失效，不表示现实取消、未发生或结果为假；
- ClaimVersion / EpisodeVersion 变化只触发从直接 Evidence 重新判断并更新或移除
  enrichment reference，不能把 derived source 的状态复制给 Loop；
- active Forget fence 必须立即阻止旧 Evidence 通过 Open Loop 继续进入 Context；
- revalidation 失败时保持 read fence，不能继续使用旧 Version或靠模型 confidence 保活。

Full Purge 仍删除 Open Loop logical row、Versions、proactive state、audit 与索引，不创建
`retracted` 作为替代。

`occurred / resolved / canceled` 是不可重开的现实终态；新的事件、重新预约或新结果
等待创建新的 logical Open Loop，即使它引用同一 Episode。`expired / retracted` 只有
新的 direct User Evidence 唯一重申同一个 pending state，并通过当前 formation、
identity、temporal 与 Forget gate 时，才能在同一 `open_loop_id` 上创建新的 open
Version。新 Version 使用新 Evidence 与当前 policy 重新计算 expected window、
`followup_eligible_from_at` 和 `expires_at`；旧 terminal Version保持不可变。

时间经过、旧 Evidence、模型 confidence、相似表达、reconciliation 或 repair 都不能
reopen。`loop_kind` 变化表示另一个 independently closable pending state，必须创建新
logical Loop，不能在同一 identity 内从 upcoming 转 awaited 或反向转换。

current open Version 可以保留 `localized_summary`。Version 被 supersede，或 current
Version 进入 `occurred / resolved / canceled / expired / retracted` 时，从对应的
supersede time 或 `terminal_effective_at` 写入 `content_retention_started_at`，并在
30 日后清除 `localized_summary`、写 `content_purged_at`。grace 内正文只允许受控排错
与仍满足全部权限的精确 Replay，不能重新进入 current Context。清理后，引用该正文的
Replay fail closed，不能用 current Version近似。

普通 terminal content expiry 后保留并按 Sensitive Derived Data 保护：logical / Version
ID、revision、kind、status、policy / resolver version、supersedes lineage、仍有效的
Evidence / ClaimVersion / EpisodeVersion reference、expected window / timezone、eligibility、
expiry、terminal / processed timestamps 与 closure-attempt disposition。source deletion
立即清除受影响 `localized_summary`、时间窗口、对象关联、locator / fingerprint，只留
fencing 必需的无正文 identity / revision / status / policy / timestamps / purged lineage。
Forget 立即 read-fence / retract，正文仍不得超过 30 日 grace。Full Purge 删除 logical
row、所有 Version、envelope、audit、proactive state 与索引。

Open Loop processing 为每个 authoritative source revision 记录 run outcome 与 policy
version。顶层 provider timeout / transport error / 无法解析的 response Schema 记为
`retryable_failed`，不提交任何 Proposal；整体 response 合法时，单条 semantic Proposal
可以以结构化 reason skip，其他合格 Proposal继续。所有合格 Proposal 的领域写入与 run
settlement 在 source-revision-fenced transaction 中原子提交；事务失败不留下 partial
Loop / Version / link。owner、`data_epoch` 或 source revision 已变化时记
`stale_source`，旧输入不重试或写状态。

Context Compiler 只在 snapshot 前所有 final / corrected User Event 的 formation / closure
run 均 settled、且没有 pending source invalidation 时读取 Open Loop。任何 gap、timeout
或 unresolved failure 令整个 `open_loop` section 为空，不能复用前一 snapshot 或 stale
projection。source revalidation failure 保持旧 Version read-fenced；expiry scanner failure
不影响 read-time deadline。超过 retry threshold 后保持 fenced / ineligible并产生无正文
operator alert，不能猜默认状态。observability 只记录 run / revision ID、stage、reason
code、attempt count与 latency。

一个 source Event 可以产生多个独立有效效果，例如将既有 `upcoming_event` 推进为
`occurred`，同时形成新的 `awaited_outcome`。同一 source-revision-fenced transaction
使用固定顺序：先应用 Correction / Forget / source invalidation；再针对 transaction
开始前已存在的 open snapshot 解析并物化 closure / ambiguous suppression；最后基于更新
后的 current state 执行新 formation / dedupe。新形成的 Loop 不得成为同一 Event closure
resolver 的候选。单条语义不合格只 skip 该效果；所有通过 gate 的 effects 与 run settlement
原子提交，事务失败全部回滚。

v1 formation capacity 为每个 User Event 最多 4 个新 logical Loop、每个 user 最多 128 个
current `status=open` Loop；suppressed open target仍计入。multi-effect transaction先处理
closure / retraction，再按 post-closure current count计算容量。单 Event合格 Proposal超过
4 个时，按 `followup_eligible_from_at ASC, expires_at ASC, evidence_locator ASC` 选择；
不得读取模型 importance。

达到 user cap 的新 Proposal 以 `capacity` skip，只记录无正文 reason 与计数，不持久化
Proposal、不通知用户、不自动重试。容量压力不能创建任何现实或系统 terminal state，
因此不得驱逐、retract、expire 或覆盖已有 Loop。只有新的 User Evidence 可再次提出；
capacity policy版本化，后续调整不重算历史。

同一个 plan 同时符合 Objective Memory 准入时，Open Loop 只引用该 ClaimVersion，
不能复制为第二条事实。用户明确表达 upcoming event 已发生时创建 `occurred` Version，
awaited outcome 的结果已出时创建 `resolved` Version，事项取消时创建 `canceled` Version；
validator 必须拒绝 `awaited_outcome + occurred` 与 `upcoming_event + resolved`。这些
terminal status 只结束 pending state，不表达成功、失败、结果好坏或用户满意度；
到期扫描创建 expired Version，重复执行必须幂等。closed / expired Version 不进入
当前 Context，但保留底层 Evidence 与按 retention policy 所需的版本历史。

Closure Proposal 必须给出 target reference、kind-specific terminal status 与 locator，
并由 final / corrected User Event 的 EvidenceItem 直接支持。Evidence 可以明确陈述
终态，也可以陈述只有终态成立才可能知道的亲历事件或结果内容；不要求固定关键词。
假设、可能、未来时、条件表达、expected time 到达、用户沉默与 Assistant / System
内容全部拒绝。`canceled` 还要求明确取消、撤回、放弃或确定未发生，不能从缺少后续
推断。模型只提出 semantic assertion；代码验证 actor / revision、modality gate、唯一
target、kind / status compatibility、source fence 与 current open Version 后提交。

Closure Evidence 通过语义 gate 但 resolver 返回多个合理 current open target 时，创建
最小 closure-attempt audit：Evidence ID、候选 Open Loop / Version ID、proposed terminal
status、resolver / policy version 与 `ambiguous` disposition，不复制 User Event 正文。
任何候选都不创建 terminal OpenLoopVersion；每个候选创建
`suppression_reason=ambiguous_closure` 的 ProactiveFollowupStateVersion。closure workflow
不触发澄清问题。新的唯一识别 User Evidence 关闭目标，并为已证明非目标的其他候选
创建 released State Version；没有澄清时各候选保持 open + suppressed 直到正常 expiry。

`proactive_followup_states` 是行为 projection，不是新的用户事实。用户简短带过、
回避、拒绝或转换话题后，对该 target 创建 suppressed Version；后续 Context
Compiler 必须按 `proactive-followup-suppression:v1` 的冷却或硬停止边界 fail closed。有限冷却
到期、用户主动且唯一地重新提起同一事项、新的实质 User Evidence 推进仍 eligible 的
target Version，或 target-specific 询问许可可以创建新的 eligible Version。每段
Continuous Exchange 是否已经提交过 Proactive Memory Follow-up，以带 target
reference 的 committed Assistant Event 及其冻结
`daily_session_id + continuous_exchange_no` 为准，不能仅依赖模型自报。

### 7.11 派生对象的历史版本

需要被未来 Context 或 Replay 精确引用的派生对象必须保留不可变版本：

```text
session_summaries
session_summary_versions
dialogue_state_versions
episode_candidates
episodes
episode_versions
open_loops
open_loop_versions
proactive_followup_states
proactive_followup_state_versions
profile_projections
bio_versions
```

`session_summary_versions` 和 `dialogue_state_versions` 从 1A.2 开始创建；1A.1
不为了 Context 压缩提前建设模型生成的持久化 projection。

`Episode` 表示“一次旅行、一次搬家、一个项目阶段”等可跨 Turn / Session
持续补充的生活事件，不等于 ConversationEvent 或 InteractionTurn：

```text
episode_candidates
  id
  user_id
  proposed_episode_kind_id
  proposed_existing_episode_id
  proposed_temporal_anchor
  proposed_entity_anchor_ids
  resolution_status             # new / matched / unresolved
  status                        # proposed / accepted / rejected / stale
  policy_version
  created_at

episodes
  id
  user_id
  episode_kind_id
  current_version_id
  status
  created_at
  deleted_at

episode_versions
  id
  episode_id
  revision
  source_revision
  content
  status
  policy_version
  supersedes_version_id
  created_at
  content_purged_at
```

Episode Candidate 是短期、非权威提案，通过
`episode_candidate_evidence_links` 指向 EvidenceItem。模型不能直接创建或 merge
Episode；代码至少验证：

- Evidence 是否明确表达一次现实事件或持续过程，而不是聊天边界、一般话题、地点词、
  情绪或关系事实；
- proposed temporal / Entity anchor 是否来自 User Evidence；
- 续接 existing Episode 是否有用户直接连续性表达，或时间、地点和 Entity anchor
  的唯一组合；仅地点或主题相同不够；
- Evidence 明确支持不同 occurrence 时创建新 Episode；仍无法判断是否同一事件时，
  Candidate 保持 `unresolved`，不得 merge。

EpisodeVersion 通过 `episode_evidence_links` 引用 EvidenceItem。新信息追加新 Version；
不得为了补充一次旅行而改写旧 Version，也不得把“一次聊天”自动建模成 Life Episode。
Episode 是可选 enrichment；没有 Episode 或 Candidate 尚未解析时，Understanding
Response、Journal 与基础 Memory Claim 仍继续运行，也不为补齐 Episode 主动追问。

稳定主对象只保存 identity、owner 和 `current_version_id`。版本表至少保存：

```text
id
logical_object_id
revision
source_revision
policy_version
content
status
supersedes_version_id
created_at
content_purged_at
```

EpisodeVersion 必须通过 EvidenceItem 展开到底层 User Event Revision，不能只引用 Summary。
BioVersion 必须引用具体 Memory Claim Version。

派生对象分为：

- 可重建 Projection：ProfileProjection、Embedding、VectorIndex、cache；
- 可替换但历史需按引用保留的 Context Projection：SummaryVersion、
  DialogueStateVersion、OpenLoopVersion、ProactiveFollowupStateVersion；
- 必须保留历史的 Derived Artifact：EpisodeVersion、JournalVersion、
  ReflectionVersion、ClaimVersion。

“可重新运行模型”不等于“可精确重建旧产物”。后者受当时的 Evidence、模型、
Prompt、policy、随机性和用户确认影响，必须保留原 Version ID 和 lineage。

`CompiledContext.referenced_versions` 保存所有 Event、Evidence、Entity、Summary、
Episode、Open Loop、Proactive Follow-up State、Journal、Reflection、Claim 和
Profile 的具体 version / identity ID。这是全部消费者的并集：对话 Context 只引用
对话输入层（08-10 §9.1）声明的对象，Profile、Journal、Reflection 只在各自派生
workflow 的 Context 中被引用。Bio 不进入对话 Context；对话中的
“用户是怎样的人”由 Person Portrait 逐条 Claim 承载（ADR-0111）。
需要向 Conversation Functions 暴露已有对象 target 时，CompiledContext 另外保存
Command-scoped Action Reference manifest。每个 Handle 通过 typed link 指向同一
owner 下的具体对象与 Version，并记录允许使用它的 Catalog action kinds；不得只保存
无法用外键约束的任意 `target_type + target_id`。Entity、Claim 与 JournalStatement
等 target 使用各自 typed link，Provider 只看到 opaque Handle。
只要任一版本已过 TTL、删除或无法读取，
历史 Replay 就 fail closed；不得用“当前最新版”近似重建过去的 Context。

### 7.12 运行、版本与 lineage

建议对象：

```text
compiled_contexts
prompt_versions
model_configs
generation_commands
model_run_attempts
conversation_action_proposals
conversation_action_payloads
conversation_action_executions
conversation_action_receipts
workflow_commands
workflow_runs
outbox_events
data_lineage_edges
provider_egress_authorizations
provider_egress_events
access_audit_events
```

Catalog 的 immutable published manifest 至少在逻辑上包含：

```text
conversation_action_catalog
  catalog_version
  published_at
  definitions[]

action_definition
  action_kind
  action_schema_version
  input_schema_ref
  target_contract_ref
  effect_class
  trust_class
  confirmation_policy_ref     # current Conversation Catalog: none
  execution_mode            # synchronous / durable_workflow / external_side_effect
  idempotency_scope
  consistency_policy_ref
  rate_policy_ref
  receipt_contract_ref
  availability_policy_ref
  handler_binding
  handler_contract_version
  status
```

Internal Core 可以先把 manifest 作为随应用发布、内容寻址的 versioned artifact，不为
单一 writer 提前建设数据库管理 UI 或动态发布系统。无论 manifest 存在代码、配置
artifact 还是未来治理表中，GenerationCommand、Proposal 与 Replay 都必须记录其稳定
Catalog / Definition reference，且历史版本不可被原地改写。

这些字段是横切执行契约，不是领域规则 DSL。Definition 不能描述如何更新 Claim、
生成 Journal、删除数据或调用外部系统；具体语义由 `action_kind +
handler_contract_version` 唯一绑定的 typed Action Handler 实现。Catalog 发布验证必须
证明每个 enabled Definition 恰好存在一个兼容 binding，且没有未被 Definition 引用的
模型可见 handler。

当前 Conversation Catalog 的 enabled Definition 还必须满足
`confirmation_policy_ref=none`。需要二次确认、step-up 或不可逆高风险授权的能力不
进入模型可见 Catalog；当前数据模型不增加 pending confirmation 或跨 Turn challenge
对象。

逻辑任务和真实 Provider 调用必须分开：

```text
generation_commands
  id
  interaction_turn_id         # nullable for non-conversation roles
  operation_type
  intent_key
  conversation_stage          # nullable / decision / action_finalization
  predecessor_command_id      # nullable；finalization points to decision
  action_receipt_id           # nullable；finalization only
  conversation_harness_policy_version # nullable for non-conversation roles
  tools_mode                  # nullable / catalog_enabled / disabled
  subject_type
  subject_id
  input_revision_kind
  input_revision
  freshness_policy
  model_role
  model_config_version
  continuous_exchange_model_binding_id # nullable；conversation.text 接管后必填
  model_routing_policy_version # nullable before 1A.4
  fallback_mode                # disabled / single_attempt
  validator_contract_version
  expected_data_epoch
  status
  authoritative_result_id
  created_at
  settled_at

model_run_attempts
  id
  generation_command_id
  attempt_no
  attempt_kind            # champion / technical_retry / schema_repair /
                          # conversation_handover / role_fallback
  source_attempt_id       # nullable
  model_config_version
  provider
  model
  provider_request_id
  provider_egress_event_id
  status                 # started / succeeded / failed / result_unknown / discarded
  error_code
  started_at
  completed_at
```

`generation_commands` 的 `operation_type + intent_key` 承担业务幂等；
`intent_key` 不包含模型或部署配置，例如：

```text
conversation-decision/<interaction-turn-id>
proactive-followup-segment/<interaction-turn-id>/<reservation-id>
conversation-action-finalization/<interaction-turn-id>/<action-receipt-id>
conversation-retry/<retry-request-id>
journal-eligibility/<daily-session-id>/<source-revision>/<policy-version>
journal-draft/<journal-id>/<source-revision>/<policy-version>
reflection-draft/<reflection-id>/<source-revision>/<policy-version>
evidence-extract/<event-revision-id>/<policy-version>
entity-resolve/<event-revision-id>/<policy-version>
memory-extract/<event-revision-id>/<policy-version>
```

Conversation Decision、可选 Proactive Follow-up Segment 与 Action Finalization 是不同逻辑生成意图，
因此必须创建不同的
GenerationCommand。Decision 直接生成普通回复时不会创建 Finalization。Decision
生成 Action Proposal 时，只有 Action Gateway 已提交 immutable receipt，才能以
`interaction_turn_id + action_receipt_id` 唯一创建 Finalization；该 Command 必须
引用 Decision predecessor 并冻结 `tools_mode=disabled`。两者由 InteractionTurn
组织，不新增 `AgentRun` 表。

普通主回应只有在当前 Event DialogueState 于主回应完成时已经就绪、确定性 selector 已取得
reservation 且不存在普通问题时，才能以 `interaction_turn_id + reservation_id` 唯一创建 Segment
Command。它引用 Decision predecessor，冻结窄 CompiledContext 与 `tools_mode=disabled`。Action Proposal
路径因直接任务门禁不创建 Segment。合并后的 Assistant Event 以 Decision 为 primary Command，并通过
`conversation_event_generation_command_links` 同时引用 Segment；Action 路径仍以 Finalization 为 primary。

`conversation_action_proposals` 是无重复正文的长期 envelope：

```text
conversation_action_proposals
  id
  user_id
  generation_command_id
  request_event_revision_id
  compiled_context_id
  catalog_version
  conversation_harness_policy_version
  action_kind
  action_schema_version
  handler_contract_version
  candidate_target_ref       # opaque Handle or typed Current Event Locator
  created_at
```

Proposal 不是执行成功证明，也不保存 Provider-specific tool-call object、用户原话、
模型解释、自由文本 target 或完整 candidate arguments。Provider request identity 仍由
对应 ModelRunAttempt 记录。Gateway 为崩溃恢复必须冻结的其余 normalized typed
arguments 使用独立内容行：

```text
conversation_action_payloads
  id
  proposal_id                # unique
  payload_schema_version
  ciphertext
  encryption_key_version
  retention_policy_version
  expires_at
  content_purged_at
  created_at
```

Payload 只允许 Gateway recovery capability 在 Admission 尚未 settled 且未到期时读取。
同步 Action 在 Admission / Completion 事务结束后清除；异步 Action 在 Admission 与
幂等领域 / Workflow command 原子提交后清除。未完成 Admission 的 Proposal 到期后读取
fail closed，由 sweeper 置空 ciphertext 并记录 `content_purged_at`；Full Purge 再删除
整个 content row。Receipt、日志、Trace、Workflow history 或 Replay 不能复制
payload；不得保存 payload fingerprint、Embedding 或摘要替代正文。

Proposal 必须引用稳定的 `catalog_version + action_kind + action_schema_version +
handler_contract_version`；Gateway 不能按当前最新 Catalog 重新解释历史 Proposal。
已有 target 的 candidate target 只保存 Action Reference Handle；Action Gateway
从 Proposal 绑定的 CompiledContext typed link 解析真实对象，并重新检查 owner、
current Version、scope、Evidence、`data_epoch` 与 deletion fence。当前 User Event
中的新信息只使用 typed Event locator；locator 不能被解释为已有对象身份。

每个 Proposal 在 Definition 声明的幂等 scope 内最多解析为一个稳定的
`conversation_action_executions`：

```text
conversation_action_executions
  id
  user_id
  proposal_id
  catalog_version
  action_kind
  action_schema_version
  handler_contract_version
  idempotency_key
  resolved_target_refs       # allowlisted typed references
  admission_status          # accepted / clarification_required / rejected /
                            # unsupported
  execution_status          # not_started / pending / running / succeeded /
                            # failed / canceled
  current_receipt_id
  workflow_command_id       # nullable
  expected_data_epoch
  created_at
  settled_at                # nullable
```

`admission_status + execution_status` 是由 Receipt 维护的 current projection，不是
独立权威事实。非 `accepted` execution 必须保持 `not_started`；terminal execution
不能回退。`idempotency_key` 在 action kind 定义的 scope 内唯一，重复请求返回同一个
Execution，不能创建第二个 Workflow 或外部副作用。

```text
conversation_action_receipts
  id
  action_execution_id
  sequence_no
  receipt_key              # execution 内稳定幂等 key
  receipt_kind              # admission / progress / completion
  admission_status          # admission only
  execution_status          # not_started / pending / running / succeeded /
                            # failed / canceled
  authoritative_change_refs # allowlisted typed references, nullable
  workflow_command_id       # nullable
  error_code                # allowlisted, nullable
  created_at
```

Receipt 以 `(action_execution_id, sequence_no)` 和
`(action_execution_id, receipt_key)` 分别唯一并只追加。`receipt_key` 由 Admission
或权威执行源的稳定事件身份产生；Gateway 在锁定 Execution 后校验合法状态迁移并分配
下一 sequence，不能信任 Workflow 自报 sequence。每个 Execution 恰好有一个
Admission Receipt，Progress 可以有多个，Completion 最多一个；projection 必须能从
序列完全重建。同步 Handler 在同一领域事务中提交 Admission、权威变化与 Completion；
异步或外部副作用 Handler 在同一事务中提交 Admission、Workflow command / outbox
与初始 `pending` 状态，后续提交 Progress / Completion。

Action Finalization Command 的 `action_receipt_id` 冻结创建时最新的 committed
Receipt。Finalization 不从模型原始 tool result、Framework Session 或可变 projection
推断执行状态；只有 `succeeded` Completion Receipt 可以支持“全部完成”的用户可见
表述。

Command 创建时冻结 `model_role + model_config_version`。从 1A.4 开始，
`conversation.text` 创建 Command 前先读取当前 Continuous Exchange 的持久
binding；存在时必须冻结其 fallback config、Policy version 与
`continuous_exchange_model_binding_id`，不存在时才按已发布 Policy 选择 Champion。
其他 role 支持 fallback 时，再同时冻结已通过 Replay、由授权人工发布的
`model_routing_policy_version`、role-specific `fallback_mode` 与
`validator_contract_version`。配置版本不属于幂等键。
Command 同时冻结 `freshness_policy` 和具体 source version / coverage range。
一次 command 可以有多个
`model_run_attempts`。1A.1 的 timeout 或结果未知只允许使用同一冻结 model config
做有限技术重试；Schema repair 和 1A.4+ 的已验证 fallback 也创建新 attempt，
不覆盖旧 attempt。只有 command 在 fencing 检查后通过 CAS 设置的
`authoritative_result_id` 可以进入正式领域对象；晚到结果标记 `discarded`。

后台 Role-Scoped Generation Fallback 还必须满足：

- Capability Registry 的 `enabled_roles` 只表示能力候选，不自动把模型变成 fallback；
- 只有 Command 冻结的 Model Routing Policy 对该 role 设置
  `fallback_mode=single_attempt` 时，Champion 失败后才可串行创建一个
  `attempt_kind=role_fallback`；
- fallback 复用同一冻结 source revision、Prompt、Schema、业务 policy 与 validator
  contract，不把两个 attempt 的输出合并、投票或择优拼接；
- fallback 结果仍需通过相同 validator、freshness / deletion fence 和
  authoritative-result CAS；失败后 command 进入 failed / needs_review，不继续级联；
- fallback 只作用于当前 GenerationCommand，后续 command 重新按其冻结的 Model
  Routing Policy 选择 Champion，不形成跨任务 pin；
- `embedding`、`stt`、`tts`、`safety` 等兼容性敏感 role 默认
  `fallback_mode=disabled`，只有独立验证向量空间、声音、交付或安全语义后才能发布
  新 Policy 开放。

`data_lineage_edges`：

```text
id
user_id
source_type
source_id
source_version_id
derived_type
derived_id
derived_version_id
relation
created_at
purged_at
```

所有 Entity resolution、Journal、Reflection、Summary、Episode、Open Loop、
Proactive Follow-up State、Memory、Profile、Embedding 和 Replay 输出都必须建立
lineage。Lineage edge 使用独立 ID，
便于删除回执和故障审计，但不得保存 source / derived 正文。

`data_lineage_edges` 记录运行依赖；Claim / Journal / Reflection 的认识论依据仍通过
typed Evidence link 表达。一个 derived object 可以有 lineage 而没有资格把其
source 当作 factual evidence。

`users.data_epoch` 是用户级 fencing token：

- 会创建派生内容的 command 在开始时保存当前 epoch；
- 所有异步写入在 commit 前再次比较 epoch；
- 删除或全局数据失效操作会原子增加 epoch；
- epoch 不一致时，任务只能放弃提交并进入 `canceled` / `stale`；
- source-level revision 检查仍然保留，不能只依赖用户级 epoch。

`provider_egress_events` 记录敏感内容曾发送到哪里，但不保存内容本身：

```text
user_id
egress_authorization_id
source_type
source_id
source_revision
provider
model
provider_request_id
data_region
retention_mode
policy_version
disposition
sent_at
```

它用于数据透明、供应商审计和删除调查。

## References

- [原始 核心架构 v0.1 快照](../archive/architecture/sayhear-core-agent-architecture-v0.1.md)
- [Memory 与 Entity 产品规则](../product/14-memory-and-entities.md)
- [产品与领域术语](../../GLOSSARY.md)

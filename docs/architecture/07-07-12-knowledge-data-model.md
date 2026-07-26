# Evidence、Entity、Journal 与 Memory 数据模型

## TL;DR

- Evidence、Entity、Journal、Reflection、Memory Claim 与 Profile 拥有不同身份和职责。
- 派生对象保留不可变版本与反向血缘，当前指针不是历史真源。
- Predicate Registry 提供跨模型、跨语言的稳定 Claim 语义。
- Profile 与索引是可重建投影，不是权威事实层。

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

- 每个 User 在写入第一条 1A.3 Entity 或 Memory Claim 前必须恰好绑定一个
  `sh.entity.person` Self Entity；`user_self_entities` 的双向唯一约束建立
  Account 与领域身份的一对一关系；
- 现有 Internal Owner 在进入 1A.3 时幂等创建 active Self Entity 与 binding；
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
`journal_statement_evidence_links` 与 `journal_statement_entity_links`：

```text
journal_statements
  id
  journal_version_id
  statement_index
  statement_text
  epistemic_status
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
```

每条 JournalStatement 必须区分用户明确表达与 `inferred_observation`。
`inferred_observation` 必须有充分 User Evidence，并在正文中使用与认识状态一致的
自然不确定性语言；技术状态不直接展示给用户。程序校验认识状态与 Evidence，
模型校验文字是否把推断说成事实。

每条使用 Entity enrichment 的 JournalStatement 必须保存生成时采用的
`entity_id + entity_version_id + entity_role`。Entity link 只用于身份引用、
反向影响分析和精确 Replay，不能替代 Statement 的 typed Evidence。

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
  也不能假定能精确重建。

### 7.10 Memory

建议对象：

```text
memory_candidates
memory_candidate_evidence_links
memory_claims
memory_claim_versions
claim_localized_projections
claim_evidence_links
relationship_resolver_hints
profile_projections
profile_projection_versions
retrieval_runs
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
proposed_temporal_status
proposed_valid_from
proposed_valid_from_precision
proposed_valid_to
proposed_valid_to_precision
source_reflection_version_id
status                    # proposed / needs_entity_resolution / needs_predicate_review
                          # accepted / rejected / stale / deleted
extraction_policy_version
created_at
content_purged_at
```

Candidate 与 EvidenceItem 通过 `memory_candidate_evidence_links` 连接。
`source_reflection_version_id` 只表示运行 lineage，不能替代 Evidence。

`memory_claims` 是稳定身份：

```text
id
user_id
canonical_key             # structured, language-independent identity
subject_entity_id
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
epistemic_status       # confirmed / observed / inferred / contested
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

`relationship_resolver_hints` 是可删除、可重建的解析投影，不是关系真源：

```text
id
user_id
source_claim_version_id
subject_entity_id
target_entity_id
locale
phrase
normalized_phrase_key
temporal_view              # current / former / historical
status                     # active / stale / deleted
projection_policy_version
created_at
content_purged_at
```

只有被 `memory_claims.current_version_id` 指向、非 contested / retracted /
review_due 的 Relationship ClaimVersion 且双方 EntityVersion 仍有效时才能生成
Hint。Resolver 读取时必须再次核验
`source_claim_version_id` 仍是 Claim current version；异步投影落后时 fail closed，
不能使用 stale Hint 完成绑定。伴侣 Claim 的 current version 已结束时可以按
Registry temporal policy 投影“前任 / ex-partner”，但不能因此创建第二条关系事实。
`temporal_status=unknown` 时不得生成暗示 `current` 或 `former` 的确定性 Hint。
第三方 Hint 必须保留 anchor Entity；例如“Lily 的丈夫”只能在 Lily 已解析时把
Tom 作为候选，不能把“丈夫”当作 user scope 内的全局唯一称呼。每个 Hint 只由一条
Relationship ClaimVersion 生成，不执行多边传递推导。

`claim_evidence_links` 保存 ClaimVersion 与 EvidenceItem 的多对多关系，并区分
`support / counter / subjective_report / context`。状态变化通过新 ClaimVersion 表达；
不原地改写旧 Statement、对象、置信度或认识状态。
`memory_claims.current_version_id` 仅作为经过 CAS 更新的读取指针。

规则：

- `canonical_key` 由 user scope、subject Entity、predicate 和业务 scope 生成，
  不能由某一种语言的自然语言 Statement 直接 hash；
- 人物关系必须是 `kind=objective`、由 User Evidence 支撑并具有 Registry 定义的
  subject / object 方向与 temporal semantics；不同关系可以同时有效；
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
  另一种可独立关系创建新 logical Claim。结束一条 Claim 不得 supersede 同一
  Entity pair 上的其他关系 Claim；
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
  `scope_key` 按 Registry schema 纳入 counterparty Entity 与方向，不能把同一
  predicate 下涉及不同人物的关系折叠为一个 Claim；
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
- 模型只能提出 candidate 或 diff；
- 代码执行 claim promote、supersede、retract；
- 模型遗漏旧 Claim 不得产生删除；
- Profile Projection 只读取有效 Claim，可随时重建。

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
object_value_schema
scope_schema
temporal_semantics
evidence_policy_id
replaced_by_predicate_id
created_at
deprecated_at
```

Relationship Predicate 的 `temporal_semantics` 必须声明允许的
`temporal_status`、边界精度、缺失边界规则，以及 current / former Resolver Hint
投影条件。Registry 不得要求模型为了满足 Schema 伪造精确日期。

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
   还必须包含 temporal status、可用边界与各自 precision；
5. 服务端重新校验 ID 状态、subject / object Schema、scope、temporal semantics、
   Evidence policy 和版本，不信任模型的字符串或补造缺失时间；
6. `ambiguous / unmapped` Candidate 进入 `needs_predicate_review`，不得创建
   active MemoryClaim；
7. 拼写错误、未知 ID、deprecated ID 的新写入和不匹配 typed value 一律 fail closed。

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

##### 相同与相近 Predicate 的判定

新增前必须回答：

- 两者是否在回答同一个稳定问题？
- 新值是否应该 supersede 旧值？如果是，使用同一 Predicate 和新 ClaimVersion；
- 两者是否可以同时独立成立？如果是，可以使用不同 Predicate；
- 差异是否只是 value、scope、时间、locale、kind 或 epistemic status？
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
  code-switching mapping test；
- display label、翻译或不改变语义的定义澄清只增加 definition /
  localization version，不改变 Predicate ID；
- 语义实质扩大、缩小或改变时创建新 Predicate，旧项标记 deprecated 并设置
  `replaced_by_predicate_id`；
- deprecated Claim 保留历史引用；迁移必须逐 Claim revalidate，不假定批量等价；
- Extraction、MemoryCandidate、ClaimVersion、Replay 和 Eval 固定 Registry version；
- 回归测试至少覆盖同义跨语言映射、高混淆 Predicate 分离、未知概念返回
  `unmapped`、非法 value 拒绝，以及旧 Registry version 的可重放性。

### 7.11 派生对象的历史版本

需要被未来 Context 或 Replay 精确引用的派生对象必须保留不可变版本：

```text
session_summaries
session_summary_versions
dialogue_state_versions
episodes
episode_versions
profile_projections
profile_projection_versions
```

`session_summary_versions` 和 `dialogue_state_versions` 从 1A.2 开始创建；1A.1
不为了 Context 压缩提前建设模型生成的持久化 projection。

`Episode` 表示“一次旅行、一次搬家、一个项目阶段”等可跨 Turn / Session
持续补充的生活事件，不等于 ConversationEvent 或 InteractionTurn：

```text
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

EpisodeVersion 通过 `episode_evidence_links` 引用 EvidenceItem。新信息追加新 Version；
不得为了补充一次旅行而改写旧 Version，也不得把“一次聊天”自动建模成 Life Episode。

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
Profile Projection Version 必须引用具体 Memory Claim Version。

派生对象分为：

- 可重建 Projection：ProfileProjection、Embedding、VectorIndex、cache；
- 可替换但历史需按引用保留的 Context Projection：SummaryVersion、DialogueStateVersion；
- 必须保留历史的 Derived Artifact：EpisodeVersion、JournalVersion、
  ReflectionVersion、ClaimVersion。

“可重新运行模型”不等于“可精确重建旧产物”。后者受当时的 Evidence、模型、
Prompt、policy、随机性和用户确认影响，必须保留原 Version ID 和 lineage。

`CompiledContext.referenced_versions` 保存所有 Event、Evidence、Entity、Summary、
Episode、Journal、Reflection、Claim 和 Profile 的具体 version / identity ID。
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
workflow_commands
workflow_runs
outbox_events
data_lineage_edges
provider_egress_authorizations
provider_egress_events
access_audit_events
```

逻辑任务和真实 Provider 调用必须分开：

```text
generation_commands
  id
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

model_run_attempts
  id
  generation_command_id
  attempt_no
  provider
  model
  provider_request_id
  status                 # started / succeeded / failed / result_unknown / discarded
  error_code
  started_at
  completed_at
```

`generation_commands` 的 `operation_type + intent_key` 承担业务幂等；
`intent_key` 不包含模型或部署配置，例如：

```text
conversation-response/<user-event-id>
conversation-retry/<retry-request-id>
journal-eligibility/<daily-session-id>/<source-revision>/<policy-version>
journal-draft/<journal-id>/<source-revision>/<policy-version>
reflection-draft/<reflection-id>/<source-revision>/<policy-version>
evidence-extract/<event-revision-id>/<policy-version>
entity-resolve/<event-revision-id>/<policy-version>
memory-extract/<event-revision-id>/<policy-version>
```

Command 创建时冻结 `model_config_version`；从 1A.4 开始支持 fallback 时，再同时冻结
已通过 Replay 的 `fallback_policy_version`。配置版本不属于幂等键。
Command 同时冻结 `freshness_policy` 和具体 source version / coverage range。
一次 command 可以有多个
`model_run_attempts`。1A.1 的 timeout 或结果未知只允许使用同一冻结 model config
做有限技术重试；Schema repair 和 1A.4+ 的已验证 fallback 也创建新 attempt，
不覆盖旧 attempt。只有 command 在 fencing 检查后通过 CAS 设置的
`authoritative_result_id` 可以进入正式领域对象；晚到结果标记 `discarded`。

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

所有 Entity resolution、Journal、Reflection、Summary、Episode、Memory、
Profile、Embedding 和 Replay 输出都必须建立 lineage。Lineage edge 使用独立 ID，
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
- [产品与领域术语](../../CONTEXT.md)

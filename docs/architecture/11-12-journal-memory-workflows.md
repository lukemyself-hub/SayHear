# Journal、Reflection 与 Memory 工作流

## TL;DR

- Journal 生成、验证和发布是版本化、幂等且可追溯的工作流。
- Reflection 是近期派生层，Memory promotion 只能回到原始 User Evidence。
- Entity 变化只复核受影响的 JournalStatement 和 Memory Claim。

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

模型验证：

- 是否存在无证据事实；
- Journal Observation 是否有充分依据并使用自然不确定性语言；
- 是否把推断写成确定事实；
- 是否诊断、说教或成长化；
- 是否盲目认同用户的事实判断；
- 是否遗漏当天关键事件；
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

## 12. Reflection 与 Memory Workflow

### 12.1 两速系统

#### 快速路径

每个重要用户 Event 后异步运行：

- 创建或复用 EvidenceItem；
- 提取 EntityMention 并进行 user-scoped resolution；
- 提取 candidate；
- 轻量去重；
- 标记人物、事件、偏好、情绪和开放状态；
- 允许为同日后续交流提供 session-local context；
- 不直接升级长期 Profile；
- 不阻塞回复。

#### 慢速路径

Daily：

- Episode Builder；
- 创建新的 Daily ReflectionVersion；
- Objective / Impression candidate；
- 冲突和重复检查；
- 候选晋升或暂存。

Weekly：

- 多日证据聚合；
- 创建新的 Weekly ReflectionVersion；
- Claim merge / supersede；
- 趋势和变化识别；
- Impression 过期或降级；
- Profile Projection 重建。

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
- 不把一次性状态晋升为长期特征；
- 不因 omission 删除；
- 删除与 tombstone 检查通过。

`confirmed` 的含义是“用户明确确认或在多次表达中稳定出现”，
不是对外部世界事实完成独立核验。该语义必须进入 Schema 注释、Prompt 和 Review UI。

### 12.4 Open Loop

Open Loop 与长期 Profile 分开：

- 有明确来源；
- 有过期时间；
- 可完成、取消或自然消失；
- 不形成目标管理；
- 不用于监督用户完成情况。

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
   predicate、typed value、scope、认识状态和 confidence；
5. 如果 Entity ID 未改变且 Claim 仍成立，创建引用 current EntityVersion 的新
   active ClaimVersion；
6. 如果 merge / split 改变 subject / object Entity，导致 `canonical_key`
   改变，创建新的 logical MemoryClaim 与 ClaimVersion，并通过 lineage
   supersede 或 retract 旧 Claim；不得改写旧 Claim identity；
7. 多个旧 Claim 因 Entity merge 发生 canonical-key collision 时，必须逐 Evidence
   去重和重新验证；不能把 Evidence count 或 confidence 机械相加；
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

## References

- [原始 核心架构 v0.1 快照](../archive/architecture/sayhear-core-agent-architecture-v0.1.md)
- [Session 与 Journal 产品规则](../product/12-13-session-and-journal.md)
- [Memory 与 Entity 产品规则](../product/14-memory-and-entities.md)

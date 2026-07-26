# Memory 与 Entity 产品规则

## TL;DR

- 长期记忆区分 Objective Memory 与 AI Impression，并保留不同的用户可见语言。
- 用户可在对话中纠正或要求忘记 Memory Claim，不要求先建设完整 Profile 编辑器。
- Entity 只在语义影响足够大时澄清；证据不足时保留未解析 Mention。
- Entity 身份变化通过反向血缘定向复核 Journal 与 Memory，不静默全量重写。

## Status

Accepted

## 14. 长期记忆系统

### 14.1 两层 User Profile

### A. Objective Memory

保存相对客观的信息：

- 人物身份；
- 有 User Evidence 与时间有效性的关系；
- 工作；
- 项目；
- 地点；
- 计划；
- 偏好；
- 重要事件；
- 人生阶段；
- 用户明确表达的事实。

### B. AI Impression

保存 AI 对用户的长期理解和观察：

- 用户在意什么；
- 用户如何做决定；
- 用户容易为什么事情受伤；
- 用户表达情绪的方式；
- 用户长期坚持的价值观；
- 用户近期的心理重心；
- 用户发生了哪些变化。

两类记忆在召回时必须保留不同的认识状态：

- Objective Memory 可以使用“你之前说过……”等来源归属明确的表达，但不能暗示
  SayHear 已独立核验其真实性；
- AI Impression 必须使用“我有一个印象……”或“我可能理解为……”等观察性表达；
- AI Impression 不能使用“我记得你就是……”等把主观判断说成确定事实的表达。

### 14.2 Profile 展现方式

User Profile 以一篇自然语言 Bio 呈现，而不是数据库、关键词或表格。

其表达方式接近：

> “如果有人问我，这个人是谁，我会这样介绍他。”

Profile 应该明确区分：

- 已确认的事实；
- AI 的主观观察；
- 尚不确定的推断。

### 14.3 用户权限

Internal Core 与 External MVP 中：

- Profile 对用户可见；
- 用户不能直接编辑；
- 暂不提供完整 Profile 编辑界面；
- 用户可以在对话中明确指出某条 Memory Claim 错误，或要求“不要记这个”；
- 被纠正或要求忘记的 Claim 必须立即停止召回；
- Memory Forget Request 不删除原始 Conversation 或已有 Journal；
- 默认界面不为每条记忆展示技术化引用或专门的来源面板；
- 当用户询问或质疑某条记忆时，SayHear 必须能在对话中说明它来自哪些日期、
  哪些用户表达，并明确它属于 Objective Memory 还是 AI Impression；
- 如果有效来源无法读取，SayHear 必须明确说明无法核实，不能生成一个看似合理的来源解释。

Profile 的可视化逐条编辑与更细粒度内容删除可以延后，但 Memory Correction 与
Memory Forget Request、Memory Source Explanation 必须从第一条可被未来召回的
Memory Claim 开始成立。

### 14.4 后台工作流

建议采用：

1. Daily Extraction  
   从当天对话和 Journal 中提取短期记忆。

2. Weekly Consolidation  
   合并重复信息，识别一周主题和变化。

3. Profile Validation  
   检查事实冲突、过期信息和主观推断。

4. Memory Retrieval  
   在每次对话中召回最相关记忆，而不是加载全部内容。

### 14.5 Entity 身份处理

SayHear 不应因为一个人物、地点或项目尚未完成结构化绑定，就默认打断用户追问。
判断标准不是“Entity 是否完整”，而是身份歧义是否会实质改变 SayHear 对用户经历
和想法的理解、当前回应、Journal 含义或未来 Memory 归属。

- 现有身份唯一且置信度高时，绑定已有 Entity；
- 用户明确介绍一个新的人、地点或项目时，创建 user-scoped、状态为 unresolved
  的 Entity；仅仅同名不能触发自动合并；
- 代词、多名候选或仍不清楚的指代只保留为未解析 EntityMention，不强行创建或
  绑定 Entity；
- 当歧义会实质影响理解、回应、Journal 或未来 Memory 时，可以紧扣当前表达自然
  澄清一次；
- 用户回答后，可以依据其明确陈述完成新建或绑定；Entity promotion、merge 或
  split 还可以依据稳定的重复证据或用户纠正进行；
- 用户简短回答、回避、拒绝或转换话题时，立即停止身份追问，保留未解析
  EntityMention；
- 未解析身份不阻止共情或 Journal。SayHear 应在现有证据支持的粒度上回应和记录，
  使用原称呼或中性关系描述，不编造具体身份、关系或跨日连续性。
- Entity 只代表人物的稳定身份；同事、朋友、伴侣、亲属等关系是有 User Evidence
  与时间有效性的版本化 Objective Memory Claim，不是 Entity label 或 identity；
- 每种可以独立成立、拥有独立 Evidence、时间范围、纠正或 Forget 状态的关系拥有
  一个 logical Claim。同事和朋友可以同时成立，因此不能折叠为一个关系类型数组；
- 同一稳定关系的状态或有效时间变化创建新的 ClaimVersion；开始另一种可独立关系
  创建新的 logical Claim，结束其中一种关系不影响其他关系或 Entity；
- “前任”是已经结束的伴侣 Claim 的当前称呼投影，不为同一事实复制一个
  `former_partner` Claim；稳定亲属关系通常只保留一条 `valid_to = null` 的长期 Claim，
  除非出现用户纠正或新的反向 Evidence；
- 关系是否仍成立与具体日期分开表示。状态可以是 `current / ended / unknown`，
  `valid_from / valid_to` 可以为空，并保留 `exact / month / year / approximate /
  unknown` 的时间精度；
- “她是我妈妈”可以是 `current` 且开始日期未知；“他以前是我同事”可以是
  `ended` 且结束日期未知；“大概 2023 年夏天在一起”只能保存近似时间，不能补成
  某个精确日期；
- Evidence 发生日期不等于关系开始或结束日期。只要 `ended` 有充分 User Evidence，
  即使 `valid_to` 未知，也可以投影“前任 / 前同事”；状态仍为 `unknown` 时不能生成
  带确定含义的关系称呼；
- 关系事实的真源是 Relationship Memory Claim。系统可以把 Claim 与其时间状态预计算
  为可重建的 Relationship Resolver Hint，用于称呼解析和人物卡片，但 Hint 不能作为
  关系事实、Evidence 或 Entity identity；
- 关系称呼可以作为 EntityMention resolver 的提示，但不能单独完成身份绑定。
  “我之前那个同事”仍可能指向多人，证据不足时必须保持 unresolved / ambiguous；
- “妈妈 / Mom / 我妈”等关系称呼跨语言指向同一人物时，连续性来自有效的关系 Claim
  与 Resolver Hint，不把这些称呼固化为 Entity identity；Context Compiler 可以把
  Entity 与相关 Claim 合并为一张自然人物卡片，不向模型重复注入两份记忆。
- 每个 Account 恰好拥有一个系统管理的 Self Entity，代表用户本人参与 Memory Claim
  和人物关系；`user_id` 继续负责账号、权限与数据隔离，不替代领域身份；
- Self Entity 不能与普通人物 Entity merge、split 或独立删除。Internal Owner
  Full Purge 保留无正文的 Account–Self Entity 绑定，Account Deletion 才随账号删除；
- 其他用户提到同一个现实人物时，仍创建在对方作用域内的私人 Entity，不与该人物
  自己账号下的 Self Entity 跨用户合并。
- Relationship Memory Claim 可以连接用户作用域内任意两个 Person Entity，不要求
  其中一端必须是 Self Entity；`user_id` 表示这条理解属于谁，不表示用户一定是关系参与者；
- 两个非 Self Entity 之间的关系必须来自用户直接表达，且双方身份都达到可绑定标准。
  任一方仍为 unresolved / ambiguous 时不得创建 active Claim，也不为了补全关系图
  强行追问或创建 Entity；
- “Tom 是我姐姐 Lily 的丈夫”可以保存 `Lily —伴侣→ Tom`；它不能自动生成
  `Self Entity —姐夫→ Tom`。只有用户后来明确称 Tom 为“我姐夫”时，才创建或确认
  用户与 Tom 的直接关系 Claim；
- 不自动执行亲属关系闭包、朋友的朋友推导、组织层级传播或其他社交图猜测；
  第三方关系与 Resolver Hint 仍保持 user-scoped，不跨用户共享或合并。

这项策略宁可暂时保留重复 Entity 或未解析 EntityMention，也不让错误绑定污染
长期 Memory。

Entity merge、split 或用户身份纠正发生后，SayHear 不遍历并重新生成全部历史
Journal。系统通过 Entity、EntityMention、Evidence 与 JournalStatement 的反向血缘，
只定位引用了受影响 Entity 的 Statement，并逐条重新验证：

- 只是补全姓名、别名或统一两个实际相同的身份，且原叙述仍成立时，不修改 Journal；
- 如果纠正后的 User Evidence 能确定原 Statement 把行为、关系或跨日联系归给了
  错误的人，该 Statement 属于确定性事实错误或明显误导；
- 用户明确纠正身份，或影响检查能够从纠正后的 User Evidence 确定错误时，
  生成新的 Journal Version；
- 如果现有 Evidence 仍无法确定原 Statement 是否错误，进入 `needs_review`，
  不静默改写历史 Journal；
- 未引用受影响 Entity 的 JournalStatement 不重新验证或生成。

`needs_review` 只作用于受影响的 JournalStatement，不使整篇 Journal 下架：

- 原 JournalVersion 继续保持 current 和可见，不删除或自动 supersede；
- 受影响 Statement 标记为 `identity_review_pending`，暂停参与 Entity 关联、
  跨日因果、未来 Recall 或其他人生叙事连接；
- 不按定时任务反复重试，也不为了清理状态主动打断用户；
- 新的相关 User Evidence、用户主动纠正，或用户打开该 Journal 时，可以按当前
  Entity / Evidence revision 重新检查；相同 revision 下重复打开不重复运行；
- 用户查看时只低调说明“这篇记录中有一处人物指代暂时无法确认”，不显示技术状态、
  不弹窗，也不把处理变成用户待办；
- 重新检查的结果只能是 `no_change`、`correction_required` 或
  `still_ambiguous`：分别清除标记、生成新 JournalVersion，或继续等待未来 Evidence。

Internal Core 可以在诊断界面显示待复核 Statement 与 Evidence，但这不是面向用户的
Review Inbox。

### Entity 身份变化对 Memory Claim 的影响

Memory Claim 会主动影响未来回应，因此比历史 Journal 采用更保守的处理：

- Entity merge、split 或身份纠正发生后，引用受影响 EntityVersion 的 Claim
  立即停止进入 Recall 和 Profile；
- 系统通过 Claim、EntityVersion 与 Evidence 的反向血缘，只复核受影响 Claim，
  不扫描全部 Memory；
- 旧 ClaimVersion 保持不可变，不能直接替换其 `entity_id`、Statement、confidence
  或认识状态；
- 只有身份和原始 User Evidence 重新验证通过，并创建新的 ClaimVersion 后，
  该理解才能恢复 Recall；
- 身份仍不确定时，新版本保持 `review_due`，继续排除 Recall 和 Profile；
- 两个重复 Entity 合并时，不能把两边 Evidence 数量或 confidence 机械相加；
  必须重新判断 Evidence 是否指向同一身份、是否重复，以及是否仍支持该 Claim；
- 如果 Entity 变化使 Claim 的 canonical identity 改变，则创建新的 Memory Claim
  identity，并 supersede 或 retract 旧 Claim，而不是改写原 logical Claim。

这项规则接受 SayHear 暂时漏掉一条可能正确的记忆，也不让一个人的经历被召回到
另一个人身上。

---

## References

- [原始 产品文档 v0.1 快照](../archive/product/AI_Life_Journal_Product_Document_v0.1.md)
- [术语表](../../CONTEXT.md)
- [Knowledge 数据模型](../architecture/07-07-12-knowledge-data-model.md)

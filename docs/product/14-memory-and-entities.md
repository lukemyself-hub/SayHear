# Memory 与 Entity 产品规则

## TL;DR

- 长期记忆区分 Objective Memory 与 AI Impression，并保留不同的用户可见语言。
- 敏感领域可以进入长期 Memory，但用户自述事实与 AI 解释性理解使用不同准入边界。
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

一次直接、明确且通过长期 Memory 准入校验的用户陈述，足以形成
`confirmed` Objective Memory，不要求重复出现。`confirmed` 只表示用户曾明确
这样陈述，不表示 SayHear 已对外部世界完成事实核验。

“明确陈述”与“适合长期记忆”是两个独立判断。一次性情绪、临时状态、引用、
假设或仍有关键歧义的表达，即使包含清晰文字，也不能因此自动成为长期 Claim；
它们可以保留为 Evidence、同日 Context、Journal 内容或待校验 Candidate。

### B. AI Impression

保存 AI 对用户的长期理解和观察：

- 用户在意什么；
- 用户如何做决定；
- 用户容易为什么事情受伤；
- 用户表达情绪的方式；
- 用户长期坚持的价值观；
- 用户近期的心理重心；
- 用户发生了哪些变化。

不是用户直接陈述、而是由 SayHear 从一段或多段表达中观察和推断出的理解，
只能形成 `inferred` AI Impression，不能用较弱的 `observed` Objective Memory
绕过两类记忆的边界。发生证据冲突时可以进入 `contested`，但 `observed`
不属于长期 Memory Claim 的认识状态。

AI Impression 的默认长期准入门槛是：至少两条独立 User Evidence，分别来自两个
不同 Daily Session，稳定支持同一 Predicate 与结论，并且没有实质冲突。单个
Daily Session 中形成的推测无论模型 confidence 多高都只保留为 Candidate；
Predicate Registry 可以为高风险概念设置更严格规则，不能放宽为单 Session 晋升。

两类记忆在召回时必须保留不同的认识状态：

- Objective Memory 可以使用“你之前说过……”等来源归属明确的表达，但不能暗示
  SayHear 已独立核验其真实性；
- AI Impression 必须使用“我有一个印象……”或“我可能理解为……”等观察性表达；
- AI Impression 不能使用“我记得你就是……”等把主观判断说成确定事实的表达。

### 14.1.1 敏感领域

医疗健康、性取向、宗教或政治身份、创伤、法律或财务等敏感领域，不因其敏感性
被整体排除在长期 Memory 之外：

- 用户直接、明确、自我指向地陈述诊断、身份、经历或处境时，可以在对应 active
  Predicate 明确允许后形成 Objective Memory；`confirmed` 仍只表示用户曾这样
  陈述，不表示 SayHear 已独立核验；
- AI 可以形成 Sensitive Interpretive Impression，理解某项敏感经历对用户的意义、
  影响、支持或压力来源，以及用户期待的交流方式；
- AI 不得把用户未直接明确陈述的医学或精神诊断、性取向、宗教或政治身份、
  创伤或受虐标签、财务或法律风险归类形成 active Memory Claim；
- 症状、伴侣关系、宗教活动、政治观点或反复出现的困境都不能单独替代用户对上述
  诊断、身份或风险归类的直接陈述；
- 没有资格形成长期 Claim 的推断不妨碍 SayHear 理解当前表达、作出合适回应、
  形成 Journal 或保留底层 Evidence。

每个 Sensitive Memory Predicate 必须独立定义允许的 Claim kind 与 Evidence policy。
诊断、身份或风险归类 Predicate 只允许符合上述直接陈述边界的 Objective Memory；
允许 AI Impression 的敏感 Predicate 必须把稳定问题限定在意义、影响、支持或压力
来源、交流偏好等解释性理解，而不是换一种措辞保存敏感归类。

### 14.1.2 Rejected Memory Candidate

被长期 Memory 准入明确拒绝的 Candidate 是终局处置，不是等待未来 Registry
扩张的隐藏 Memory：

- Registry 更新、相同内容再次被抽取、时间经过或模型 confidence 提高，都不能
  自动把原 Candidate 改为 accepted 或创建 active Claim；
- Rejected Memory Candidate 不表示底层 Evidence 为假，也不删除原始 Conversation、
  Journal 或 Evidence；
- 未来确需重新考虑时，必须通过单独确认的显式、版本化流程重新评估，不能静默
  复活原 Candidate；
- 新 Evidence 只有在实质改变 admission 条件时，才能创建保留 predecessor lineage
  的 Successor Memory Candidate；重复表达、时间经过、Registry 更新或模型
  confidence 提高都不构成重新提出资格；
- 如果 rejection 表示人工产品治理已经判断该概念没有产品价值，普通新 Evidence
  不能推翻该决定，只能通过显式、版本化重新评估；语义目标真正改变时按不同概念
  处理，而不是复活原决定。

### 14.1.3 Predicate Review 治理

“可能有产品价值”不是 LLM 可以在运行时自行作出的准入结论。LLM 只能在现有
Registry 无法映射时提出 `ambiguous / unmapped` Candidate、引用相关 Evidence，
并说明建议概念；它不能批准新 Predicate 或让 Candidate 直接进入长期 Memory。

确定性规则只判断 Candidate 是否 Predicate Review Eligible，包括：

- Evidence、Entity、scope 与认识状态足以支持复核；
- 概念描述的是可能跨日有用的稳定问题，不是一次性状态、普通话题或临时 Context；
- 不能通过现有 Predicate 的 value、scope、时间、locale 或 Claim kind 表达；
- 不违反敏感推断、Memory Forget 或其他长期 Memory 边界；
- 可以进一步定义清楚的 value schema、Evidence policy 和正反例。

通过检查的 Candidate 只能进入 `needs_predicate_review`，不能创建 active Claim，
也不表示其产品价值已被接受。授权的人工产品治理者最终决定映射到已有 Predicate、
批准形成 Predicate Change Proposal，或拒绝长期记忆化；新 Registry Entry 仍由
独立代码库 release 发布。LLM 可以协助聚类、排序、寻找相近 Predicate 和起草
正反例，但不能拥有批准或发布权。

`needs_predicate_review` 不是无限等待的隐藏 Memory。Candidate 从进入该状态起最多
等待人工处理 30 天；到期仍没有明确 review disposition 时转为 `stale`，不能再由
原 Candidate 创建 active Claim。Terminal Candidate 派生语义按 7 天 Content
Grace 清理；只有 Materially New Evidence 或显式版本化重新评估可以产生 Successor
Memory Candidate。

### 14.1.4 Internal Candidate Review Tool

Phase 1 的 Web 开发者工具必须提供受控的 Candidate review queue，使 Internal
Owner 可以查看 `needs_predicate_review` Candidate、eligibility 原因、到期时间、
相关 Evidence、相近 Predicate、sensitivity class 与 policy version，并作出三种
明确处置：

- `Map to Existing Predicate`：绑定已有 Predicate 后重新执行正常 mapping 与
  admission，人工选择本身不能创建 Claim；
- `Reject`：按 Rejected Memory Candidate 的终局规则记录理由；如果理由是人工
  判断通用 Predicate 概念没有产品价值，同时创建或关联不含用户内容的
  `rejected` Predicate Change Proposal version；
- `Approve for Registry Change`：创建或关联版本化 Predicate Change Proposal，
  Candidate 转为 `awaiting_registry_release`，不能直接发布 Registry 或创建 Claim。

Evidence 不足、Entity / scope 未解、敏感推断违规或其他 candidate-specific
rejection 不创建 rejected Proposal，因为被拒绝的是这次 Memory 提案，而不是通用
Predicate 概念。产品价值 rejection 的 Proposal 只保存通用定义、schema 草案、
正反例和治理理由；不得保存 subject `user_id`、Evidence、具体 value、用户原话、
Entity 或其他可识别私人信息。reviewer principal 只作治理审计。

`awaiting_registry_release` 表示人工 review 已完成，因此退出原 30 天 review
deadline。`awaiting_release` Predicate Change Proposal 不自动过期，直到发布或由
授权人工明确取消；`rejected` Proposal 保持到授权人工显式版本化重新评估。
Candidate 从进入 `awaiting_registry_release` 起最多等待 90 天。到期仍没有对应的
Registry version 发布时，Candidate 转为 `stale`，Proposal 本身继续存在。以后
发布该 Registry version 不能自动复活已 stale Candidate；只有新 Evidence 或
显式、版本化的重新评估可以产生新的 admission 结果。

Candidate 转为 `rejected` 或 `stale` 后，其 LLM 派生语义只保留 7 天，用于
受审计的内部排错；这段时间也不能用于正常 Recall、Profile、模型 Context、
Registry 自动重试或重新准入。7 天后，活跃系统清除 proposed concept、typed
value、Entity / Predicate binding、解释和 review draft，只保留无正文的 terminal
status、reason、policy / model / Registry version、时间、Evidence lineage 与
keyed dedupe fingerprint。该 fingerprint 只能阻止相同 Evidence 与语义目标绕过
终局状态，不能用于检索、聚类或用户理解；相关 Evidence 全部删除或 Full Purge
时一并清除。

Materially New Evidence 必须由确定性 policy 根据 terminal disposition、Evidence
revision 与当前准入规则判断，至少包括以下一类实质变化：

- 用户从未直接陈述变为直接、明确陈述，使 evidence mode 或 Claim kind 改变；
- 新的独立 Daily Session Evidence 首次满足 Impression 的跨 Session 门槛；
- 新 Evidence 唯一解决此前的 Entity、scope、时间或引用歧义；
- 新表达对原语义目标作出实质细化、纠正或改变，因此形成可区分的新目标。

新的相似消息、同一事实换一种说法、更多同类但仍不合格的敏感推断 Evidence、模型
confidence 提高、时间经过或 Registry version 更新都不满足条件。合格时创建新的
Successor Memory Candidate，引用新增 Evidence 与 predecessor，但重新执行完整
eligibility、mapping、admission 和 deadline；不复制 predecessor 的结论，也不恢复
已经清理的正文。无法确定是否为同一 terminal 语义目标时 fail closed，不把
free-text similarity 当作重开依据。

以后出现跨语言或换一种说法的同一 unmapped 概念时，可以先映射到 rejected
Proposal identity；它不能重新进入 Candidate review queue 或创建 Claim。只有授权
人工显式重新考虑时，才创建新的 Proposal version。Candidate 的 7 天内容清理与
Full Purge 不删除这个用户无关的治理决定，但必须删除 Proposal–Candidate link。

开发者工具不是消费者 Review Inbox，也不是 Registry 或 Claim 的第二写入口。
Successor Candidate 在 review queue 中必须显示 predecessor ID、terminal
disposition、successor trigger 与 material-change reason，但不能为了方便审核
还原已经清理的 predecessor 正文。
查看完整 Evidence 必须使用 Internal Owner 的独立诊断 capability、step-up
reauthentication 与 access audit。

### 14.2 Profile 展现方式

User Profile 以一篇自然语言 Bio 呈现。它是 SayHear 对用户及其相关经历、关系与
记忆的讲述，而不是数据库、关键词、表格或全部 Memory Claim 的逐条转写。

其表达方式接近：

> “如果有人问我，这个人是谁，我会这样介绍他。”

Profile 使用 LLM based 写作。版本化 Prompt 负责叙事视角、语义压缩、结构、语气和
不确定性表达；全部当前有效 ClaimVersion 都进入 eligible input，包括
`sensitivity_class=sensitive` 的 Claim，不设置独立的 Profile inclusion 授权。
“忠实映射全部 Memory”指语义完整，而不是要求每条 Claim 在正文中逐条出现。LLM
可以连接、压缩和组织 Claim 已支撑的经历、关系、情感与价值观，但不能通过省略或
改写形成与 active Memory 实质相反的人物画像。

Profile 应该明确区分：

- 用户明确陈述的 Objective Memory；
- 通过长期准入、仍为 active 的 AI Impression 及其不确定性。

Candidate、`contested`、`review_due`、`dormant`、被 Forget 的内容、Open Loop 和
Reflection 原文不能进入 Profile。LLM 只能选择、组织和表达有效 Claim，不能补写
新的用户事实、从省略推导否定结论，或改变 Claim 的 kind、epistemic status 与
lifecycle。

Bio 可以深入剖析和共情用户的内心、情感、深层价值观与世界观，但其中每个可独立
成立的心理或价值观判断，都必须由已经通过长期准入的 active AI Impression Claim
支撑。Profile 写作发现但尚未通过准入的新洞察不能出现在当前 Bio，也不能以叙事
连贯性绕过跨 Session Evidence、敏感推断、Correction、Forget 或 dormancy。

### 14.2.1 Profile 更新

普通 Bio 更新采用低频、用户可理解的节奏：

- 用户可以在 Profile 前端手动发起重写；
- 前端显示最早可再次刷新时间，后端以版本化 policy 强制执行相同的最短间隔，
  具体时长在实现与内部验证中确定；
- 系统默认每周通过后台 Cron 自动重写一次，不做每日或每次 Memory 变化后的普通
  自动重写；
- 前端显示预计下次自动更新时间；具体星期与本地时间由版本化 schedule policy
  决定。

手动刷新表示请 SayHear 根据最新有效 Memory 重新理解并讲述用户，不是创建等待用户
发布的 Bio 草稿。手动与每周生成的新 Bio 通过 Profile 校验后直接替换 current
版本；产品不提供发布前预览、批准、正文编辑、候选版本选择或连续抽卡式重写。用户
认为 Bio 内容不准确时，通过对话中的 Memory Correction 或 Memory Forget Request
修正底层 Memory，而不是直接编辑 Profile 正文。

信任边界变化不等待上述节奏。Memory Correction、Memory Forget Request、Claim
进入 `contested` / `dormant`、Entity 失效或内容删除时，包含受影响内容的当前
ProfileVersion 立即停止展示，并绕过普通刷新间隔自动重建。重建失败时显示
“Bio 正在更新”或暂时不可用，不能继续展示含有失效内容的旧 Bio。

### 14.2.2 冲突与时间变化

新的 User Evidence 与现有 Claim 不一致时，SayHear 先按 Predicate Registry 的
时间语义、scope 与 value cardinality 判断：

- 用户明确表达状态变化或新的有效时间时，创建新的 `confirmed` ClaimVersion，
  旧版本保留为历史，不视为冲突；
- 用户明确表示前一表达有误时，按 Memory Correction 创建新版本并 supersede
  错误版本；
- Registry 允许多个值同时成立，或两条表达属于不同 scope 时，分别保留，
  不互相覆盖；
- 只有同一 Predicate、同一 scope、同一有效时间内的值互斥，并且现有 Evidence
  无法判断是变化还是纠正时，才创建 `contested + review_due` ClaimVersion，
  暂停该 Claim 的 Recall、Profile 与 Embedding；
- 冲突实质影响当前理解或回应时，可以紧扣当前表达自然澄清一次；否则不打断用户，
  等待新的 User Evidence。用户不回答、回避、拒绝或转换话题后停止追问。

最新一条表达不能仅凭时间较新自动获胜，模型 confidence 也不能自行消解冲突。
解决结果必须由新的 User Evidence 支撑，并通过新 ClaimVersion 保留历史。

### 14.2.3 衰减与复核

Objective Memory 与 AI Impression 使用不同的时间策略：

- `confirmed` Objective Memory 不因长期未被提及而降低 confidence 或改变认识状态；
  有时效的信息只按 Registry temporal semantics、`valid_from / valid_to` 和
  ClaimVersion 历史判断当前是否仍适用；
- 每个允许 AI Impression 的 Predicate 必须定义复核周期。周期届满且没有新的合格
  Evidence 时，创建 `status=dormant` 的新 ClaimVersion，并停止进入 Profile、
  Recall、Embedding 与 cross-day narrative；
- dormant 只表示当前不再主动使用，不表示旧 Impression 为假，也不删除原始
  Conversation、Evidence 或历史 ClaimVersion；
- dormant Impression 只有在新的 Evidence 重新满足正常的跨 Session 准入门槛后，
  才能通过新的 `inferred + active` ClaimVersion 恢复；不能直接激活旧版本，
  也不能只靠旧 Evidence 或模型 confidence 恢复；
- 如果出现反向 Evidence，进入 `contested` 流程，不把冲突伪装成自然衰减。

### 14.2.4 Open Loop

Open Loop 只承接用户直接提到的具体待发生事项或待确认结果，例如即将到来的面试、
预约，或正在等待的检查结果：

- 普通未聊完的话题、一次情绪，以及模型想在未来继续追问的内容都不能创建
  Open Loop；
- Open Loop 是引用 User Evidence、可选 time-bound Objective Claim 或 Episode
  的短期派生状态，不是第二条 Memory Claim，也不进入 Profile；
- 每个 Open Loop 必须有确定的 `expires_at`。用户未给出明确日期时，只能使用
  Registry / policy 定义并可追溯的有限期限，不能无限保持 open；
- 用户明确表示事项完成、取消或结果已出时关闭；到期后也确定性转为 expired；
- 关闭或到期不删除底层 Evidence。事件本身仍可按独立规则保留为 Objective
  Memory、Episode 或历史 Journal；
- 用户已经发起一轮对话后，SayHear 可以选择一个合适的 Open Loop 主动询问进展，
  即使用户尚未先提及该事项；但 Open Loop 不在用户缺席时发送消息或通知，不监督
  完成，也不形成任务列表或目标管理；
- 用户简短带过、回避、拒绝或转换话题后，同一 Open Loop 停止主动询问；只有用户
  主动重新提起或出现新的相关 User Evidence 时，才重新取得主动询问资格。

### 14.3 用户权限

Internal Core 与 External MVP 中：

- Profile 对用户可见；
- 用户不能直接编辑；
- 暂不提供完整 Profile 编辑界面；
- 用户可以在对话中明确指出某条 Memory Claim 错误，或要求“不要记这个”；
- 被纠正或要求忘记的 Claim 必须立即停止召回；
- Memory Forget Request 可以明确针对整条 Claim，或只针对一个 Relationship
  Qualifier。Qualifier-level Forget 立即停止对应具体角色及所有方向、语言的投影；
- Qualifier 被 Forget 后，只有另一条不在 Forget scope 内的 User Evidence
  独立支持底层关系时，才能继续使用中性关系称呼；如果被 Forget 的表达也是底层关系
  的唯一 Evidence，整条 Claim 都必须停止召回，不能从已遗忘内容继续派生中性关系；
- Forget 不表示原理解为假，不创建 counter Evidence。用户表达无法判断是在 Forget
  具体角色还是整条关系时，SayHear 只做一次简短 scope 澄清，在确认前不改变 Memory；
- Forget 不会因用户自然再次提到该内容、重复次数、模型置信度、时间经过或后台
  Consolidation 自动解除。SayHear 可以正常理解和回应当前表达，并按既有规则写入
  Journal，但不得因此恢复长期 Memory，也不主动把普通交流变成恢复权限确认；
- 只有用户明确表示“这个可以重新记住”等 Memory Forget Reversal，才恢复该
  target。目标唯一可确定时，同一个 User Event 同时作为恢复授权和新的 User
  Evidence，并立即创建新 ClaimVersion；不保留“只恢复权限、等待下一条 Evidence”
  的中间状态。旧 Evidence、旧 ClaimVersion 与旧 projection 不能直接重新激活；
- Memory Forget Request 不删除原始 Conversation 或已有 Journal；
- 默认界面不为每条记忆展示技术化引用或专门的来源面板；
- 当用户询问或质疑某条记忆时，SayHear 必须能在对话中说明它来自哪些日期、
  哪些用户表达，并明确它属于 Objective Memory 还是 AI Impression；
- 如果有效来源无法读取，SayHear 必须明确说明无法核实，不能生成一个看似合理的来源解释。

Profile 的可视化逐条编辑与更细粒度内容删除可以延后，但 Memory Correction 与
Memory Forget Request、Memory Source Explanation 必须从第一条可被未来召回的
Memory Claim 开始成立。

### 14.3.1 Reflection 可见性

Phase 1 不建设独立的用户式 Reflection 页面。Reflection 继续作为 1A.3 的非权威
派生层，用于提出 Memory Candidate 和支持 Profile Consolidation；Conversation、
Journal 与 Profile 保持为体验面。

Web 开发者工具必须提供只读的 Reflection Inspector，使 Internal Owner 可以查看：

- Daily / Weekly ReflectionVersion、版本状态与 source revision；
- ReflectionStatement 的底层 Evidence lineage；
- Reflection 提出的 Candidate 及其 admission / terminal disposition；
- Candidate 经有效 ClaimVersion 对当前 Profile Projection 产生或未产生的影响。

Reflection Inspector 只用于内部验证与诊断，不能创建、编辑、发布或覆盖
ReflectionVersion，不能批准 Candidate、写入 Claim 或直接修改 Profile。独立的
用户式 Reflection 体验只有在内部验证证明其具有独立用户价值后才重新评估。

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
- 同一关系事实只保存一个 canonical logical Claim。有向关系按 Predicate Registry
  定义的 subject / object 约定归一化；从另一方观察或使用反向称呼时不创建第二个
  Claim。对称关系按稳定 Entity pair 归一化，不受双方提及顺序影响；
- 例如 `Lily —manager_of→ Tom` 可以同时投影“Lily 的下属 Tom”和
  “Tom 的经理 Lily”；“我和小王是同事”与“小王和我是同事”也只对应一条关系事实；
- Predicate 只表达底层关系；母亲、父亲、儿子、女儿、姐姐、弟弟、丈夫、妻子等
  具体角色作为 ClaimVersion 上有独立 User Evidence 的 Relationship Qualifier，
  不创建第二个 Predicate，也不写入 Entity label 或自动成为 Entity 的全局属性；
- 没有具体角色 Evidence 时只使用“家长 / 孩子”“手足”“伴侣”等中性称呼，
  不能根据姓名、声音、语言习惯或常识猜测角色。新增、细化或纠正 Qualifier
  创建新的 ClaimVersion，旧版本保持不可变；
- 如果冲突只涉及 Qualifier，而双方 Entity、Predicate 和底层关系仍有有效 Evidence，
  只停止有冲突的具体角色投影，并退回中性称呼；如果纠正改变了底层关系，例如
  “不是母亲，是姨妈”，则纠正或 retract 原 Claim，并使用新的 Predicate 与
  logical Claim；
- 同一稳定关系的状态或有效时间变化创建新的 ClaimVersion；开始另一种可独立关系
  创建新的 logical Claim，结束其中一种关系不影响其他关系或 Entity；
- 同一 Entity pair 的同一 Predicate 结束后再次成立时，继续复用原 logical Claim，
  用新的 ClaimVersion 记录新的 `valid_from` 与 current / ended 状态。伴侣复合、
  离职后再次成为同事等多段关系不创建 relationship occurrence ID；
- 每段历史由不可变 ClaimVersion 保留，Resolver Hint 只读取 current version。
  当前范围不提供 period-scoped Forget；whole-Claim Forget 作用于这条关系的全部
  长期 Memory，针对时间边界的 Correction 则继续通过新 ClaimVersion 表达；
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
- Predicate Registry 定义关系是有向还是对称、有向关系的 canonical subject /
  object 约定，以及本地化正向、反向称呼投影。关系级 Correction 与 Forget
  作用于 canonical Claim；Qualifier-level Forget 仍通过该 Claim 的新 ClaimVersion
  执行，并一起失效对应角色的所有方向、语言 Hint 与人物卡片投影；
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

### 14.6 Episode 边界

Episode 是可选的生活事件组织层，用来持续承接“一次旅行、一次搬家、一个项目阶段”
等可以跨 Turn 或 Session 补充的现实事件：

- Episode 必须有 User Evidence 支撑的现实事件锚点；Conversation、Daily Session、
  话题、地点词或情绪本身都不自动创建 Episode；
- “最近工作很累”可以进入 Journal 或 Memory Evidence，但不是 Episode；“我下周要去
  东京出差”可以创建一个明确的 Trip Episode；
- 后续表达只有在时间、地点、相关 Entity 或用户直接称呼能安全指向同一次现实事件时，
  才续接原 Episode 并创建新 EpisodeVersion；
- 相隔较久再次去同一地点、重新谈到同一主题或再次出现相似情绪，不能仅凭相似性
  自动 merge。Evidence 明确表示不同事件时创建新 Episode；仍无法判断时保持
  Episode Candidate 未绑定；
- 模型只能提出 Episode Candidate，代码校验 Evidence、现实事件锚点与连续性；
- Episode 缺失或未解析不阻止 Understanding Response、Journal 或基础 Memory Claim，
  也不为了补齐结构主动追问用户。

这项策略接受漏掉部分跨日连接，也不把多次旅行、不同项目阶段或反复情绪拼成一段
错误的人生叙事。

---

## References

- [原始 产品文档 v0.1 快照](../archive/product/AI_Life_Journal_Product_Document_v0.1.md)
- [术语表](../../CONTEXT.md)
- [Knowledge 数据模型](../architecture/07-07-12-knowledge-data-model.md)

# Memory 与 Entity 产品规则

> 当前 1A.3b 执行范围以 [ADR-0141](../adr/0141-g1-only-release-after-g2-retirement.md) 与 [SPEC #193](https://github.com/lukemyself-hub/SayHear/issues/193) 为准：只重发 G1。本文下方涉及 Open Loop、对话内 Proactive Follow-up、Bio 写作或三阶段 G4 的段落保留为历史设计，不授权当前实现、上线或验收。G1 的普通 Memory Recall、Curiosity Stop Signal、Episode、Reflection、治理、Inspector 与共享叙事验证继续适用。

## TL;DR

- 长期记忆区分 Objective Memory 与 AI Impression，并保留不同的用户可见语言。
- 敏感领域可以进入长期 Memory，但用户自述事实与 AI 解释性理解使用不同准入边界。
- 用户可在对话中纠正或要求忘记 Memory Claim，不要求先建设完整 Profile 编辑器。
- Entity 只在语义影响足够大时澄清；证据不足时保留未解析 Mention。
- Entity 身份变化通过反向血缘定向复核 Journal 与 Memory，不静默全量重写。

## Status

Accepted

## 14. 长期记忆系统

召回语言与召回呈现体验的规则分布在 §14.1B（Objective Memory 与 AI Impression 的两类召回语言）与 §14.2（Profile 展现方式，含 14.2.4 Open Loop）；§14.3 是用户权限，不是召回体验章节。历史上部分 ticket 引用的"§14.3 召回体验"系锚点笔误。

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
- AI Impression 可以在与当前表达确实相关时，用自然、朋友式的观察主动说出来，
  例如“这听上去就很像你，会更在意……”；不强制每次添加“根据以前的对话”、
  “我有一个印象”或“我可能理解为”等来源声明和仪式化保留语（ADR-0116）；
- AI Impression 不能被说成用户明确自述或独立核验的事实，也不能凭空生成全局人格、
  把临时状态固定成身份，或使用诊断式、敏感身份标签；
- 用户质疑时再自然校准，并按需进入 Memory Source Explanation、Correction 或 Forget。

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

### 14.2 Bio 展现方式

User Profile 与 Bio 是两个概念。User Profile 是 Objective Memory 与 active AI
Impression 构成的两层长期理解；Bio 是 SayHear 基于它写出的自然语言作品，是对用户
及其相关经历、关系与记忆的讲述，而不是数据库、关键词、表格或全部 Memory Claim
的逐条转写。领域和实现统一使用 `Bio` 与 `BioVersion`，不再使用
`Profile Projection`、`ProfileVersion` 或 `ProfileProjectionVersion` 指代它。

其表达方式接近：

> “如果有人问我，这个人是谁，我会这样介绍他。”

Bio 采用 #173 选定的章节式结构，并以第三人称、按名字叙述；页面标题、状态、刷新与
纠错控件仍以第二人称面对用户。名字来自 current Self Entity 的 canonical label，
代词只采用用户明确声明的值；没有已声明代词时重复名字或改写句子，不能根据名字、
语言或经历推断。每个 BioVersion 只生成并校验一种冻结的展示 locale；Bio Basis 中
的用户原话保留原语言，正文只在名称、固定表达或对用户确有意义的
原话处自然 code-switch。用户改变展示 locale 时走普通重建，不构成信任边界失效。

Profile 使用 LLM based 写作。版本化 Prompt 负责叙事视角、语义压缩、结构、语气和
不确定性表达；全部当前有效 ClaimVersion 都进入 eligible input，包括
`sensitivity_class=sensitive` 的 Claim，不设置独立的 Profile inclusion 授权。
“忠实映射全部 Memory”指语义完整，而不是要求每条 Claim 在正文中逐条出现。LLM
可以连接、压缩和组织 Claim 已支撑的经历、关系、情感与价值观，但不能通过省略或
改写形成与 active Memory 实质相反的人物画像。

版本化 Bio Coverage Policy 必须把每个 eligible ClaimVersion 确定性归入一个 Bio
Coverage Unit，并根据 Predicate Registry 发布的 coverage class 与 current temporal
scope 标明 `required`、`compressible` 或 `background`。一个 logical Claim 的
current ClaimVersion 默认形成一个 unit；只有 Predicate Registry 明确发布相同
`bio_composition_key`，且 subject、Entity、时间范围和认识类型兼容时才可合并。
Objective Memory 与 AI Impression 不合并为同一 unit，合并后的 coverage class 取最
严格值。未发布 coverage class 的 Predicate 默认 `required`；模型不能自行决定某个
输入不重要，也不能因为敏感性降低 materiality。

`required` 与 `compressible` 决定 coverage plan 的优先级；进入本版计划后，前者
必须有可独立定位的忠实表达，后者可以被更宽的 supported proposition 包含，但
validator 仍须证明其语义得到表达。`background` 可以按 policy reason 省略。User
Profile 超出可读篇幅时，确定性 policy 按 class 与稳定顺序形成本版 coverage plan，
未选 unit 记录为 `deferred_by_budget` 并向用户提示本版有所取舍，不让整个 Bio
生成失败。计划内的前两类缺失才是 `material_absence`。两个 active Claim 存在叙事
张力但不构成 contested 时，Bio
必须保留双方；只有 active AI Impression 支撑时才能解释其动机或人格意义，不能为了
故事连贯选择其中一边。
生成器同时返回正文、statement、atomic proposition、Claim support 与 coverage
disposition；独立 validator 从最终正文重新拆解 proposition，两份结果存在实质差异
时不能发布。

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

每章可以按需展开 Bio Basis。默认先显示 validator 接受的一个最小充分 support set，
组内每条都显示人可理解的 Claim 表达、用户原话与日期，以及低调的 Objective /
Impression 认识标签；不显示 Claim ID、Evidence ID、Prompt、模型或 policy 等技术
引用。存在多个等价 support set 时按稳定规则选择一个，用户可以继续展开其他依据，
但初始请求不批量返回全部。页面底部只有一个纠错入口，刷新与 Correction / Forget
始终是不同操作。

### 14.2.1 Bio 更新

普通 Bio 更新采用低频、用户可理解的节奏：

- 用户可以在 Profile 前端手动发起重写；
- 前端显示最早可再次刷新时间，后端以版本化 policy 强制执行相同的最短间隔；默认在
  新 current Bio 成功发布后 24 小时才允许再次手动刷新，技术失败不推进冷却时间；
- 系统默认每周通过后台 Cron 自动重写一次，不做每日或每次 Memory 变化后的普通
  自动重写；
- 前端显示预计下次自动更新时间；默认 schedule 是每周一用户当地时间 04:00，
  schedule policy 在 DST 跳时、重复时段、漏扫与重试下保证每个本地周最多成功推进
  一次。

Profile 页面按钮与对话中的 `regenerate_bio` 使用同一个 owner-scoped handler、source
snapshot、24 小时 rate policy、幂等边界、validator 与 publish 语义。对话 Context
只暴露这个高层 Action，不注入 Bio 或 Bio Basis。

页面底部的 “Not quite right?” 只打开 Talk，不附带 Bio、段落、proposition 或隐藏
摘要。用户用自己的话说明错误，这个新 User Event 才成为 Correction / Forget 的
Evidence。用户只说“第二段不对”时，SayHear 请其描述具体理解，不能为了猜目标而把
Bio 读入 Conversation Context。

eligible set 为空时不调用模型，也不创建空 Bio；页面说明 SayHear 还没有足够的了解。
存在至少一条 eligible Claim 时可以生成短 Bio，不凑章节或补写人格判断。信任边界
失效后如果 eligible set 为空，旧 Bio 仍不可恢复。

第一条 eligible Claim 出现时不自动调用模型。已有 Claim 但没有 Bio 时显示
`ready_to_build`，用户可以立即生成且不受“上次成功发布后 24 小时”限制；用户不
操作时由下一次 weekly schedule 生成。章节数随内容变化且最多 6 章，不设最低章节
数；章节、标题、statement 和 proposition identity 只在所属 BioVersion 内稳定。
标题表达用户判断时同样进入 proposition 与 support 校验。

用户可见状态区分：

- `empty`：没有 eligible Claim，也没有生成任务；
- `ready_to_build`：已有 eligible Claim，但尚未生成第一篇 Bio；
- `building`：没有 current Bio，首次或普通生成进行中；
- `current`：Bio 可读；
- `refreshing`：安全旧版继续可读，新版生成中；
- `generation_unavailable`：普通生成失败，且没有可读旧版；
- `trust_rebuilding`：旧版因信任边界变化被隐藏，安全重建中；
- `trust_unavailable`：安全重建失败，Bio 继续不可读。

`building` 与 `trust_rebuilding` 可以复用“Bio 正在更新，稍后再回来看看”一类用户
提示，不向用户暴露内部安全原因；后端必须保留两种状态，因为 trust rebuild 绕过普通
限流，失败后也不能恢复旧 Bio。`needs_review` 只供内部诊断，不是用户状态。

页面显示上次更新时间与下次自动更新时间。普通 Claim 变化使 current Bio 落后但仍
安全时，显示“新的理解会在下次更新中加入”，并按 rate policy 提供刷新入口；不使用
“错误”“不安全”或内部 `stale` 状态。

手动刷新表示请 SayHear 根据最新有效 User Profile 重新理解并讲述用户，不是创建等待用户
发布的 Bio 草稿。手动与每周生成的新 Bio 通过 Bio 校验后直接替换 current
版本；产品不提供发布前预览、批准、正文编辑、候选版本选择或连续抽卡式重写。用户
认为 Bio 内容不准确时，通过对话中的 Memory Correction 或 Memory Forget Request
修正底层 Memory，而不是直接编辑 Bio 正文。

信任边界变化不等待上述节奏。Memory Correction、Memory Forget Request、Claim
进入 `contested` / `dormant`、Entity 失效或内容删除时，包含受影响内容的当前
BioVersion 立即停止展示，并绕过普通刷新间隔自动重建。重建失败时显示
“Bio 正在更新”或暂时不可用，不能继续展示含有失效内容的旧 Bio。

用户在同一句话中提出多个独立要求时，SayHear 不静默挑选其中一部分执行。唯一、
目标明确并已满足自身 scope、授权与安全门槛的 Memory Correction、Memory Forget
Request 或 Memory Forget Reversal 优先生效，回复同时说明其他要求未执行、需要澄清
或当前不支持；其他“部分支持”的复合请求先说明能力边界并询问用户是否只执行受支持
部分，用户的明确选择形成新的 User Event。纠正一项理解后自动保持 Journal、Memory
与 Profile 一致，不属于多个独立要求。

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

- v1 使用封闭的两类 catalog：`upcoming_event` 表示已经安排或预计会发生并具有独立
  现实事件锚点的事项；`awaited_outcome` 表示用户正在等待且尚未确定的外部结果；
- 用户需要完成的动作、义务或待办不是 `upcoming_event`，即使用户给出了日期；判断
  依据是 pending state 是否拥有独立于 SayHear 跟踪行为的现实事件或外部结果；
- 普通未聊完的话题、一次情绪，以及模型想在未来继续追问的内容都不能创建
  Open Loop；
- Open Loop 是引用 User Evidence、可选 time-bound Objective Claim 或 Episode
  的有期限派生状态，不是第二条 Memory Claim，也不进入 Profile；
- 每个 OpenLoopVersion 始终直接引用自己的 User Evidence。精确表达同一事实的 active
  Objective ClaimVersion 与安全绑定的 EpisodeVersion 可以同时作为不同角色的
  source reference；它们不替 Open Loop 拥有 pending lifecycle，也不把各自其他
  Evidence、推断或属性自动带入 Loop；
- Claim / Episode enrichment 尚不存在或未解析时，只要直接 Evidence 与其他 gate
  足够，Open Loop 仍形成；`localized_summary` 只是可重建呈现，不能成为第二份事实
  或增加 source 中没有的信息；
- 同一 extraction proposal 的技术重试必须幂等。跨 Evidence 只有用户表达被唯一
  resolver 绑定到已有 Open Loop，或绑定同一个 canonical Objective Claim、kind
  相同且时间不冲突时，才复用 logical Open Loop；
- Episode、Entity、时间窗口与语义相似只能用于召回候选，不能单独授权 merge。
  没有候选通过时创建新 Loop；存在相似候选但身份无法唯一证明时 fail closed，既不
  merge，也不创建可能重复的新 Loop；
- 每个 Open Loop 必须有确定的 `expires_at`。用户未给出明确日期时，只能使用
  Registry / policy 定义并可追溯的有限期限，不能无限保持 open；
- expected window 保留用户认为事件发生或结果出现的时间及原始精度；`expires_at`
  表示 SayHear 最晚仍适合主动关心的时间。两者不能混用，时间到达本身也不表示事项
  已完成或取消；
- expected time 使用形成时冻结的 start / exclusive end、精度与 IANA timezone 表示；
  exact instant 不伪造 end，date-only 与有界自然语言范围按当时 timezone 解析为半开
  区间，模糊或缺失时间保持为空。之后的 timezone 变化不重新解释历史窗口，用户
  纠正或细化时间时从新 Evidence 创建新 Version；
- v1 只有宽度不超过 31 个当地日历日的 expected window 才能形成 anchored Open
  Loop；更宽的“今年晚些时候”“明年夏天”等范围不创建 Loop，只保留独立合格的
  Objective Memory / Episode，直到新的 User Evidence 给出更精确时间；
- “快了”“最近几天”等模糊表达只有在版本化 lexical policy 明确判为 near-term 时，
  才能按无锚点 14 日 policy 创建；模型不能自行扩大 near-term；
- 有用户时间锚点时，`expires_at` 从该时间范围末端增加版本化的有限 follow-up
  grace period；没有时间锚点时，从 Evidence 时间增加 kind-specific 有限期限；
- v1 对 `upcoming_event` 使用 7 个当地日历日的 anchored grace，对
  `awaited_outcome` 使用 14 日；两类无时间锚点时都从 Evidence 时间起保留 14 日；
  任一 Open Loop 从 Evidence 时间到 `expires_at` 最长 360 日，超过则不创建；
- Open Loop 形成不等于立即适合主动询问。有时间锚点的 `upcoming_event` 从 expected
  window 前 14 日取得 follow-up eligibility；有时间锚点的 `awaited_outcome` 从
  expected window 开始时取得；无锚点两类都从 Evidence 时间立即取得；
- eligibility 只开放 selector 资格，不形成询问配额，也不能覆盖用户停止信号产生的
  target-level suppression。用户主动提起尚未 eligible 的事项时仍正常回应；
- 这些期限属于 `projection_policy_version`，新 policy 不重算历史 Version；
- selector 只在 `followup_eligible_from_at <= now < expires_at` 时读取 Loop；到达
  `expires_at` 立即 fail closed，不等待后台任务写入 expired Version。scanner 只补写
  历史状态，延迟或失败不能延长主动询问资格，也不能创建消息或通知；
- 用户明确表示 upcoming event 已发生时转为 `occurred`，awaited outcome 的结果已出时
  转为 `resolved`；两类都可以因事项取消转为 `canceled`，或到期后确定性转为
  `expired`；
- `occurred / resolved` 只表示 pending state 已结束，不表达成功、失败、结果好坏或
  用户满意度；事件经过或结果内容由 Evidence、Objective Claim、Episode 或 Journal
  独立表达，Open Loop status 不编码评价；
- closure 必须由 final / corrected User Evidence 直接支持。用户可以明确说终态，也
  可以描述只有事件已发生或结果已出现才可能知道的亲历内容；不要求固定关键词；
- 假设、可能、未来时、条件句、时间到达、用户沉默以及 Assistant / System 内容都不
  构成 closure Evidence；`canceled` 还要求用户明确表达取消、撤回、放弃或确定未发生；
- Closure Evidence 足以证明终态但不能唯一绑定 target 时，不关闭任何 Loop，也不选择
  最相似者；所有合理候选以 `ambiguous_closure` 暂停主动询问，直到新 User Evidence
  唯一识别并关闭目标、释放非目标候选，或候选各自到期；
- closure workflow 不为维护数据强制澄清。只有歧义实质影响当前理解或回应时，
  Conversation Model 才能按普通 Follow-up Question 规则自然问一次；不回答、回避或
  转话题时不重复；
- closure 与 expiry 并发只按 Closure Evidence 所属 User Event 的 authoritative
  `committed_at < expires_at` 裁决。边界前已提交但处理较晚的 closure 最终胜出；
  边界后提交的结果不追溯改写 expired Loop，但仍可进入回应、Claim、Episode 或
  Journal。worker 完成顺序和用户事后描述的现实发生时间都不参与该裁决；
- source Evidence、Forget、删除或 identity fence 失效时，旧 open Version 在读取处
  立即 fail closed。corrected Evidence 仍支持同一个 pending state 时，为同一 logical
  Loop 创建新的 open Version 并更新时间与 source reference；不再支持、变成 Task / 宽
  时间范围或仍有身份歧义时，创建系统终态 `retracted`；
- `retracted` 只表示派生依据已撤回或不再合格，不表示现实事项取消、未发生或结果为
  假。Claim / Episode Version 变化只触发从直接 Evidence revalidate，不自动把其状态
  复制给 Loop；Full Purge 删除整个 Open Loop 数据面，不用 `retracted` 代替；
- `occurred / resolved / canceled` 永不 reopen；后续新的事件、重新预约或新的等待结果
  创建新的 logical Open Loop，可以引用同一 Episode，但不能改写旧终态；
- `expired / retracted` 只有在新的直接 User Evidence 唯一重申同一个 pending state，
  且通过当前 formation 与 Forget gate 时，才为同一 logical Loop 创建新的 open Version；
  旧 Evidence、时间、模型 confidence、相似表达或 repair 都不能自动复活；
- 新 open Version 使用新 Evidence 与当前 policy 重新计算时间、eligibility 和 expiry。
  kind 变化表示新的可独立关闭 pending state，必须创建新的 logical Loop；
- current open Version 保留呈现正文；Version 被 supersede 或进入任一 terminal status
  后，`localized_summary` 只保留 30 日 Content Grace 供受控排错与仍有权限的精确
  Replay，且从退出 current open 的语义时间起算，不因 sweeper 延迟延长；
- grace 结束后只留受保护的结构化 lineage，依赖被清理正文的 Replay 明确 fail closed。
  Forget 立即停止使用并按不超过 30 日清理；source deletion 立即清除受影响正文、时间与
  对象关联；Full Purge删除全部 Loop、Version、envelope、audit、state 与索引；
- Open Loop 是可独立降级 lane。当前 snapshot 前任一 final / corrected User Event 的
  formation / closure 尚未 settled，或仍有 source invalidation gap 时，本轮整个 Open
  Loop section 为空，不复用 stale cache；基础回应、Journal 与独立 Memory lane 继续；
- provider / Schema、事务、stale source、revalidation 与 scanner failure 必须按版本化
  reason code fail closed并幂等恢复；错误日志只含 ID、revision、stage、reason、attempt
  与 latency，不保存用户正文、summary 或 Evidence quote；
- 同一 User Event 可以同时关闭一个既有 upcoming event并形成一个新的 awaited
  outcome，例如“面试结束了，现在等结果”；两者仍是独立 logical Loop。系统先处理
  source invalidation 与既有 closure，再形成新 Loop，并把全部合格效果原子提交；
- v1 每个 User Event 最多接受 4 个新 Loop，每个用户最多有 128 个 current open Loop；
  suppressed open Loop 同样计入。事务先处理 closure / retraction 再计算容量；
- 超额 Proposal 按 `followup_eligible_from_at`、`expires_at`、Evidence locator 顺序确定性
  选择，容量满时以 `capacity` skip。系统不因容量驱逐、retract、expire或覆盖旧 Loop，
  不使用模型 importance，不自动重试，也不通知用户；新 Evidence 可以以后重新提出；
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
派生层，只用于提出 Memory Candidate；Candidate 经独立准入成为有效 Claim 后，才可能
间接进入 User Profile 与 Bio。Reflection 不拥有、触发或阻塞 Bio 生成；Conversation、
Journal 与 Bio 保持为体验面。

Web 开发者工具必须提供只读的 Reflection Inspector，使 Internal Owner 可以查看：

- Daily / Weekly ReflectionVersion、版本状态与 source revision；
- ReflectionStatement 的底层 Evidence lineage；
- Reflection 提出的 Candidate 及其 admission / terminal disposition；
- Candidate 是否经有效 ClaimVersion 进入 User Profile；
- 该 ClaimVersion 是否进入具体 BioVersion 的 eligible input、coverage plan 与
  narrative support，以及没有影响 Bio 的明确原因。

主列表以逻辑 Reflection 为一项，默认显示当前已提交 ReflectionVersion，历史版本在该项下
展开。Daily 与 Weekly 使用同一时间列表和筛选器，但保持各自独立的逻辑身份；Daily
显示本地日期，Weekly 显示完整七天范围和本地周编号。

当前已提交版本默认显示正文。validated 但未提交、draft、stale 与 superseded 版本默认
折叠，Internal Owner 主动展开后可以查看仍在保留期内的正文，但界面必须持续标明该版本
不能代表当前理解。正文已经清除时只显示无正文状态和时间，不能从其他版本、模型或摘要
恢复内容。

主列表、历史版本、Statement、Evidence、Candidate 与 Bio 影响分别按需分页加载，
每层默认返回 25 项、硬上限 100 项，并使用不透明 cursor 提供继续加载入口；单次请求不能
展开整棵 lineage。一次列表翻页冻结同一个查询 snapshot，后续 cursor 不能混入新提交；
详情读取重新检查 current pointer 与 source fence，状态已经变化时返回 `state_changed`，
不能把新旧状态拼成一条 trace。当前 Internal Owner database session 加上默认授予该身份的
`reflection_inspection:read` capability，可以直接读取 Reflection 正文，不重复要求 step-up。
展开底层 Evidence 时只返回实际支撑该 Statement 的原文 segment / text span、原始语言、
Daily Session 本地日期和 revision 状态，不能扩大到完整 User Event。查看完整上下文必须
另行进入既有敏感对话查看能力。每次 Evidence 展开尝试，无论成功、拒绝还是目标不存在，
都需要 10 分钟内完成的 step-up reauthentication，并写不含正文的 access audit；普通
列表、Reflection 正文和 lineage 状态读取不写访问记录。

Candidate lineage 分别支持向前查看 predecessor 和向后查看 successor，并显示 disposition、
reason、deadline、successor trigger 与 materially-new-evidence 原因。每个方向独立分页；
Candidate 内容已清除时只显示允许保留的 ID、状态、原因和时间，不能把 successor 表述为
原 Candidate 复活。

列表可以按 Daily / Weekly、scope 本地日期范围与版本状态筛选，也可以用准确的
Reflection ID、ReflectionVersion ID 或 Candidate ID 定位；不提供 Reflection 或 Evidence
正文关键词搜索。Reflection 按 scope 结束时间从新到旧排列，相同时间以 logical ID
稳定排序；历史版本按 revision 从新到旧，Statement 按 `statement_index` 从小到大。
cursor 绑定 owner、筛选条件、稳定排序与读取上限，条件变化后必须从第一页重新读取。

每个版本显示冻结的 Prompt、Schema、generation / validation policy、模型配置、
GenerationCommand、authoritative ModelRunAttempt，以及确定性检查和 `narrative.validate`
结果。Inspector 只读 typed rows 和检查结果，不直接展示 Provider 原始请求或响应。
Statement 先展开为 atomic proposition，每个 proposition 分别显示自己的 Evidence support；
不能只给整条 Statement 挂一组无法分辨用途的 Evidence。

Profile 影响分两段展示。第一段说明 Candidate 是否形成当前有效 ClaimVersion，并列出未进入
User Profile 的具体生命周期原因。第二段按相关 BioVersion 展示该 ClaimVersion 是 eligible
input、`deferred_by_budget`、有理由省略的 background、未成为 narrative support，还是实际
支撑了某个 Bio proposition；不能压成一个“影响了 / 没影响”结论。

每段 lineage 同时显示不可改写的“当时记录”和重新检查得到的“现在是否仍有效”。例如，
Candidate 当时成功 admission、但 ClaimVersion 后来被 supersede 时，Inspector 保留原
admission 结果并单独显示当前失效原因；历史 BioVersion 当时使用过该 Claim，也不能被描述为
当前 Bio 仍在使用。

非 current ReflectionVersion 的结构化输出可以显示尚未提交的 Memory Candidate Proposal，
但必须标明它没有 Candidate ID，也没有 disposition 或后续 lineage。只有真实持久化的
MemoryCandidate 才能进入 Candidate、Claim 与 Bio trace。

Inspector 可以提供到独立 Candidate Review Tool、Bio 页面和完整对话查看工具的只读导航；
目标工具重新执行自己的权限检查。Inspector 内不提供批准、拒绝、修复、重新生成、刷新或
清理按钮，也不因发现缺失、过期或失效状态而触发 command、workflow、reconciliation 或
purge。#177 决定保留时长、清理任务与 Full Purge 覆盖，Inspector 只解释其持久结果。

已通过 owner-scope authorization 后，Inspector 必须区分 `target_not_found`、
`content_purged`、`source_invalidated` 与 `access_denied`。前两者只返回允许保留的无正文
状态；没有 current committed version 时显示 `no_current_version` 及 `building`、
`failed_draft_only`、`source_invalidated` 或 `content_purged` 原因，不能回退到旧的
superseded version。鉴权失败时不得先透露对象是否存在。空字符串或空列表不能代替这些
结果。其他固定结果至少包括 `authentication_required`、`step_up_required`、
`step_up_expired`、`invalid_request`、`invalid_cursor`、`page_size_exceeded` 和
`state_changed`；Portal 负责映射自然语言，模型不能生成错误文案。

Reflection Inspector 只用于内部验证与诊断，不能创建、编辑、发布或覆盖
ReflectionVersion，不能批准 Candidate、写入 Claim、Proposal 或 Registry，也不能直接
修改 User Profile 或 Bio。业务查询只读；敏感 Evidence 读取所需的 access audit 是唯一
允许追加的记录，必须通过独立、受限的 audit 写入能力完成。audit 提交失败时 Evidence
读取 fail closed，不能先返回原话再补记。独立的
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
- 一次明确的关系纠正是一个用户语义意图，不因同时影响 Memory、Journal 与 Profile
  而拆成多个用户操作。错误关系立即停止 Recall 与 Profile 使用；系统通过 typed
  relationship reference 和 Evidence lineage 只复核明确表达或依赖该关系的
  JournalStatement，并从纠正后的有效 Claim 重建 Profile；
- 同一纠正中新增的独立事实分别执行正常 Memory 准入。例如“Mike 不是哥哥，只是比我
  年长的朋友”会撤回 sibling 关系、独立建立 friend 关系，并把相对年龄作为另一项
  assertion 评估；年龄不能继续编码成 sibling Qualifier，也不能因该 assertion
  暂时无法准入而延迟停止错误关系；
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

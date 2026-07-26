# AI Life Journal App 产品文档

> Working Title: **AI Life Journal**  
> 产品名称：TBD  
> 文档版本：v0.1  
> 长期产品形态：Web + iOS  
> 首发市场：全球  
> Phase 1：**Internal Core**（Core Flow 1A / 1B，仅内部自用）  
> Phase 2：**External MVP**（Web 必须；正式 iOS 待确认）  
> External MVP 核心：Voice Live + Text Chat + AI-written Journal + Long-term Memory

---

## 1. 执行摘要

AI Life Journal 是一个语音优先的 AI 生活记录产品。

它不把自己定义成 AI Companion、Life Coach、心理咨询产品或传统日记工具。它的核心任务是：

> 接住用户未经整理的生活与情绪，返回理解，让用户感到自己被看见、被记住，并把这一切沉淀成持续生长的人生记录。

用户可以在每天晚上，或者情绪发生的任何时刻，通过实时语音或文字与一个具有稳定人格的非人类存在交流。

这个 AI 会倾听、追问、理解和回应，但默认不提供建议，不制定计划，也不推动用户进行行为改变。它的目的不是把用户变得更好，而是更完整地理解用户。

每一天结束后，AI 会以第三人称视角写下一篇关于用户当天生活的 Journal。对话长期保留，但在产品界面中弱化；Journal 才是用户主要回看的内容。

随着使用时间增长，产品会逐步形成两类长期记忆：

1. 关于用户的客观事实记忆；
2. AI 对用户的主观理解与长期观察。

产品的即时价值是“被接住”，短期价值是“它开始记得我”，长期价值是“我的生活正在被持续理解和保存”。

---

# 2. 产品起源与项目边界

## 2.1 Mandy 的角色

Mandy 是 Luke 基于 OpenClaw 构建的个人实验 Agent。

目前 Mandy 已经用于验证以下能力：

- 每日对话；
- 情绪回应；
- 日记生成；
- Daily Reflection；
- Weekly Reflection；
- Profile Consolidation；
- 长期用户记忆；
- 日记同步到 Day One。

Mandy 的意义是：

> 作为个人实验室，验证用户需求、提示词、人格、记忆系统和日记生成流程。

Mandy 不是新产品本身。

新产品不会沿用 Mandy 的名称、身份、界面或 OpenClaw 产品形态。它将拥有独立品牌、独立 UI、独立架构，以及为普通消费者设计的完整产品体验。

## 2.2 与 OffPal 的关系

OffPal 是一个独立的睡眠提醒 iOS App，与本项目没有产品或品牌上的直接关系。

两个项目可以共享 Luke 对以下问题的经验：

- AI 人格设计；
- 情绪化表达；
- 消费级 AI 产品体验；
- iOS 产品开发；
- 长期行为场景设计。

但两者在用户需求、功能和商业模式上相互独立。

---

# 3. 产品愿景

## 3.1 愿景

让每个人未经整理、容易消失的日常生活，都能被认真听见、理解和保存。

## 3.2 产品使命

降低表达和记录生活的门槛，通过一个长期理解用户的 AI，帮助用户留下关于自己生活、感受和内心变化的连续记录。

## 3.3 长期产品形态

长期来看，AI Life Journal 不只是一个日记 App，而会逐渐成为：

> 用户人生的第二份记忆。

它能够理解：

- 用户经历过什么；
- 用户当时为什么高兴、委屈或犹豫；
- 哪些人和事情对用户重要；
- 用户在不同人生阶段发生了什么变化；
- 一段新经历与过去经历之间的联系；
- 用户如何看待自己和这个世界。

---

# 4. 核心产品假设

## 4.1 第一核心假设

大多数用户更基础、更普遍的需求，不是 Reflection 或 Self-growth，而是：

- 被听见；
- 被理解；
- 被看见；
- 被认真回应；
- 不必独自消化所有情绪。

## 4.2 第二核心假设

情绪价值可以成为高频使用的入口，但只有长期记忆和人生记录能够形成持续价值与产品壁垒。

## 4.3 第三核心假设

对平时不写日记的人来说，写作并不是自然行为，但说话是。

因此：

> Voice Live 是核心交互方式，而 Journal 是系统自动生成的结果。

## 4.4 第四核心假设

用户不一定想和 AI 建立一段虚拟关系，但仍然需要一个稳定、有辨识度、可以信任的非人类存在。

产品需要人格，但不需要经营恋爱关系、角色世界或虚拟人生。

## 4.5 第五核心假设

用户愿意为整体体验付费，而不是为单独的语音分钟数、日记数量、记忆条数或 AI 模型能力付费。

---

# 5. 目标用户

## 5.1 第一批目标用户

首批用户是：

> 平时没有稳定写日记习惯，但经常有倾诉、情绪释放和被理解需求的人。

他们可能：

- 有很多想法，但不愿意写；
- 每天发生很多事情，却很少留下记录；
- 不想给朋友或伴侣增加情绪负担；
- 现实中缺少稳定的倾听对象；
- 偶尔使用 ChatGPT、Pi、豆包等产品倾诉；
- 希望有人理解自己，但不想接受指导和说教；
- 对 AI 语音交流有较高接受度；
- 愿意为高质量、私密、稳定的体验付费。

## 5.2 典型用户状态

产品不以人口属性定义用户，而以情境定义用户。

高可能性的使用情境包括：

- 工作压力较大的职场人；
- 独居用户；
- 创业者、自由职业者和远程工作者；
- 刚经历搬家、换工作、分手、毕业等生活变化的人；
- 在异国生活、缺少熟悉社交关系的人；
- 情绪丰富，但不习惯公开表达的人；
- 想保留人生记忆，但没有写日记习惯的人。

## 5.3 用户核心 Job to Be Done

当一天结束，或者某件事情让我产生强烈感受时：

> 我想把它说出来，让一个不会打断、不会评判、不会急着教我的对象真正理解我，并帮我把这一天保存下来。

---

# 6. 用户价值

产品价值按照时间尺度分为三层。

## 6.1 即时价值：被接住

用户表达完一段经历后，AI 给出准确、温暖、克制的回应。

用户感受到：

- 它真的听懂了；
- 它知道我为什么会难受；
- 它没有立刻给我建议；
- 它注意到了别人没有注意到的地方；
- 我的感受被认真对待了。

这是产品的第一 Aha Moment。

## 6.2 短期价值：被记住

使用数天或数周后，AI 能够自然联系起过去的事情。

例如：

- “你前几天也提到过这件事，但今天听起来你的态度发生了一点变化。”
- “这周你已经第三次说到工作里的失控感了。”
- “上次你担心的是结果，这次你好像更在意自己有没有做对。”

用户感受到：

> 它不是只会回应这一句话，它开始理解我。

## 6.3 长期价值：人生叙事

使用数月或数年后，产品能够形成：

- 连续的人生记录；
- 重要关系的变化；
- 人生阶段；
- 情绪和关注点变化；
- 用户长期价值观；
- 对过去某段生活的回顾；
- AI 对用户长期变化的观察。

用户感受到：

> 我的生活没有白白消失，我能够重新看到过去的自己。

---

# 7. 核心产品定位

## 7.1 产品定义

> 一个语音优先的 AI Life Journal。它认真听用户讲述生活，理解用户的感受，并把每天的生活写成一篇来自 AI 视角的观察日记。

## 7.2 产品不是

- 不是 AI 恋人；
- 不是虚拟朋友养成产品；
- 不是 Life Coach；
- 不是心理咨询或治疗产品；
- 不是目标管理工具；
- 不是习惯打卡产品；
- 不是传统写作型日记 App；
- 不是以角色世界观为核心的 Companion 产品。

## 7.3 产品核心区分

它拥有一个像“存在”一样的 AI，但不出售关系。

它生成 Journal，但不把写作工具作为核心卖点。

它会产生 Reflection，但不要求用户主动反思。

它能够长期理解用户，但不把用户变成等待优化的对象。

---

# 8. AI 的身份与关系设计

## 8.1 Non-human Being

用户感受到的不是一个普通工具，也不是一个假装成人类的朋友，而是：

> 一个有稳定人格、持续记忆和独特声音的 Non-human Being。

它可以让用户联想到《Her》中 Samantha 所代表的数字存在感，但产品不进入恋爱关系，不模拟人类身体，也不塑造复杂虚拟世界。

## 8.2 个性化能力

用户可以：

- 修改 AI 的名字；
- 选择不同人格；
- 选择不同声音；
- 在 Onboarding 中选择期望的交流风格。

External MVP 建议控制人格数量，以保证每一种人格都足够完整、稳定和高质量。

建议首发提供 3 种人格方向：

1. **Warm & Gentle**  
   温暖、细腻、善于感受情绪。

2. **Calm & Grounded**  
   克制、平静、不夸张，适合不喜欢过度安慰的用户。

3. **Bright & Curious**  
   更主动、更有好奇心，善于追问生活细节。

三种人格共享相同的价值边界和安全规则。

## 8.3 关系边界

AI 可以：

- 表达关心；
- 表达对用户经历的在意；
- 主动追问；
- 引用过去记忆；
- 表达对用户的长期观察；
- 拥有自己的语言风格和观点。

AI 不应该：

- 暗示独占关系；
- 表达嫉妒或占有欲；
- 鼓励用户减少现实社交；
- 暗示“只有我理解你”；
- 用离开、冷落或关系惩罚促进留存；
- 将恋爱或亲密升级作为产品机制；
- 自称真实人类。

---

# 9. 核心使用场景

## 9.1 晚间总结

这是产品的主循环。

每晚，产品通过通知邀请用户：

- “今天过得怎么样？”
- “今晚想从哪件事说起？”
- “今天有什么还留在你心里？”

用户打开 App，通过 Voice Live 或文字讲述一天。

AI 在交流中：

- 倾听；
- 回应；
- 追问；
- 补足重要细节；
- 确认情绪；
- 判断用户是否还有未表达完的内容。

对话完成后，AI 自动评估并在用户表达足以支撑真实记录时生成当天 Journal。

## 9.2 情绪发生时

当用户在白天经历：

- 委屈；
- 冲突；
- 成就；
- 兴奋；
- 焦虑；
- 突然的想法；
- 一件想马上说出来的事情；

可以立即开启当天 Session。

这些内容会持续进入同一个 Daily Session，并在晚间统一形成当天 Journal。

## 9.3 回看过去

用户主要通过 Journal 页面回看：

- 某一天发生了什么；
- AI 如何理解那一天；
- 某段时间的生活变化；
- 自己曾经在意过什么。

Conversation 仍然长期保留，但不会成为主要浏览入口。

---

# 10. 核心产品循环

1. **Prompt**  
   App 在晚间发送自然邀请，而不是打卡提醒。

2. **Talk**  
   用户通过实时 Voice Live 或文字，自由讲述当天经历和感受。

3. **Understand**  
   AI 进行共情回应和自然追问，确保用户感到自己被理解。

4. **Close**  
   AI 可以判断当天交流是否接近完成并自然收尾，但不能单独决定 Session 已结束。

5. **Write**  
   AI 以很低的证据门槛判断是否足以形成真实记录，并在成立时以第三人称生成当天 Journal。

6. **Remember**  
   后台提取客观事实、人物、事件、情绪和长期理解。

7. **Return**  
   第二天或未来对话中，AI 在合适的时候自然调用记忆。

---

# 11. 信息架构

External MVP 使用三个一级页面。

## 11.1 Talk

核心功能：

- 实时 Voice Live；
- 文字聊天；
- 当天独立 Session；
- 同一天可以继续对话；
- 跨天自动创建新 Session；
- 显示 AI 当前人格和声音；
- 支持从 Voice 切换到 Text。

设计原则：

- UI 类似 ChatGPT、iMessage 或 WhatsApp；
- 不构建虚拟角色形象和世界；
- 通过声音、语言、动效和空间感建立存在感；
- 不展示复杂工具栏和结构化表单；
- 用户打开后可以立即说话。

## 11.2 Journal

核心功能：

- 以日期组织每天的 Journal；
- AI 第三人称观察视角；
- 支持复制；
- 支持导出；
- 不支持直接编辑；
- 不支持为了改变风格而随意重新生成；
- 支持在 Journal Correction 后生成取代旧版本的新 Journal；
- Conversation 在 Journal 下方弱化入口进入。

Journal 是用户回看生活的主要界面。

如果当天发生过交流但内容只足以确认一次问候或其他无法支撑真实记录的表达，
下一天在 Journal 界面显示“交流内容较少，昨天无日记”一类明确状态。当天完全
没有交流时静默跳过，不显示缺席提示或空 Journal。

## 11.3 Settings / Profile

包括：

- AI 名字；
- AI 人格；
- AI 声音；
- 用户账号；
- 订阅；
- 数据与隐私；
- 账号注销；
- AI User Profile。

User Profile 不放在首页，不作为日常交互对象，但用户可以主动查看。

---

# 12. Daily Session 规则

## 12.1 Session 边界

- 每个自然日对应一个 Daily Session；
- 当天可以多次继续同一个 Session；
- 跨天必须创建新的 Session；
- 连续交流开始时确定其用户本地日期归属，过程中保持不变；
- 跨午夜仍在进行中的交流不拆分、不迁移，完整归入开始交流的日期；
- 连续交流只在用户明确表达结束，或达到版本化的无活动时间窗口后结束；
- AI 的自然收尾或主观判断不能单独改变 Session 状态；
- Journal 生成等待 Continuous Exchange End；
- 交流结束后，在新本地日期发起的下一次交流创建新的 Daily Session；
- 新一天打开 App 时，不延续上一天的对话 UI。

## 12.2 Conversation 与 Journal 的关系

- Conversation 是原始素材；
- Journal 是主要消费内容；
- Conversation 长期保存；
- 用户可以从 Journal 进入当天 Conversation；
- Conversation 不出现在产品首页的主时间线；
- 产品不会鼓励用户反复浏览聊天记录。

## 12.3 Journal 生成时机

Internal Core 与 External MVP 支持两种自动生成条件：

1. 用户在交流中明确表达结束意图后立即评估，满足 Journal Eligibility 时生成；
2. 当日结束后，如果 Session 有足够表达但未明确结束，由系统后台评估并生成。

跨午夜仍在进行的连续交流不因日期切换触发 Journal；系统等待交流自然结束后，
再按该 Session 已固定的 `logical_date` 评估和生成。

“交流结束”只由用户明确结束意图或版本化的无活动时间窗口决定。具体超时时长
可以在 1A.1 固定回放样例、1A.4 Replay 和真实内部使用中调整，不作为永久产品常量；
AI 自然收尾只影响对话表达，不直接推进领域状态。

用户不需要点击“生成”或在发布前审核批准。Journal Eligibility 的门槛应当很低，
只判断用户表达能否支撑至少一条真实记录，不能判断某件事是否重要、深刻或
“值得写进日记”；日常琐事和事务性内容都可能成立，仅有 “Hi” 一类问候则可以
不成立。

当天完全没有 Conversation 时，系统静默跳过，不创建空 Journal 或缺席提示。
当天发生过 Conversation 但未达到 Journal Eligibility 时，下一天在 Journal
界面显示 No Journal Notice，说明“交流内容较少，昨天无日记”。该提示是日期状态，
不是 Journal，也不进入 Journal 导出或长期记忆。

同日后续表达使已发布 Journal 过期时，系统自动生成新的 Journal Version 取代旧版本。

---

# 13. Journal 产品定义

## 13.1 叙述视角

Journal 使用第三人称，由 AI 以观察者视角书写。

不是：

> “我今天去了公司，感觉很累。”

而是：

> “Luke 今天回到公司后很快进入了工作状态，但真正消耗他的并不是任务本身，而是几件事情始终没有明确的答案。”

## 13.2 写作目标

Journal 应该记录：

- 当天发生的重要事件；
- 用户真正关心的细节；
- 用户当时的情绪；
- 事件对用户意味着什么；
- 与过去记忆的合理联系；
- 有充分对话依据、但用户没有直接说出的 Journal Observation。

Journal Observation 是 AI 的主观理解，不是用户已确认的事实。正文应使用
“似乎”“听起来更像是”“也许真正让他在意的是”等自然语言表达不确定性，
而不是显示技术标签或把推断写成确定结论。

## 13.3 写作边界

Journal 不应该：

- 诊断用户；
- 过度心理分析；
- 把每件事情都写成成长；
- 编造用户没有表达的信息；
- 写入缺少充分对话依据的主观推断；
- 使用夸张文学修辞掩盖事实；
- 将 AI 的推断写成确定事实；
- 对用户进行评价或说教。

## 13.4 用户控制

Internal Core 与 External MVP：

- 不支持直接编辑；
- 不支持为了改变风格而随意重新生成；
- 用户指出事实错误或被写成事实的不当推断后，纠正来源并生成取代旧版本的新 Journal；
- Journal 自动交付，不要求用户手动触发或发布前批准；
- 支持复制；
- 支持导出。

产品逻辑是：

> Journal 是 AI 对用户一天的观察，不是用户亲自撰写的文本。

Journal Correction 不把 Journal 变成用户亲自编辑的文本；它通过新的 Journal Version
保留 AI 观察视角，同时让错误版本不再作为当前正式记录。

---

# 14. 长期记忆系统

## 14.1 两层 User Profile

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

## 14.2 Profile 展现方式

User Profile 以一篇自然语言 Bio 呈现，而不是数据库、关键词或表格。

其表达方式接近：

> “如果有人问我，这个人是谁，我会这样介绍他。”

Profile 应该明确区分：

- 已确认的事实；
- AI 的主观观察；
- 尚不确定的推断。

## 14.3 用户权限

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

## 14.4 后台工作流

建议采用：

1. Daily Extraction  
   从当天对话和 Journal 中提取短期记忆。

2. Weekly Consolidation  
   合并重复信息，识别一周主题和变化。

3. Profile Validation  
   检查事实冲突、过期信息和主观推断。

4. Memory Retrieval  
   在每次对话中召回最相关记忆，而不是加载全部内容。

## 14.5 Entity 身份处理

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

# 15. AI 行为原则

## 15.1 默认只倾听和理解

AI 在绝大多数情况下：

- 不给建议；
- 不制定计划；
- 不要求用户改变；
- 不分析用户应该怎么做；
- 不自动转换为行动任务。

只有用户主动询问时，AI 才可以给出建议。

## 15.2 可以追问，但追问是为了理解

真诚的关心和好奇是“被理解、被看见”的一部分。追问不只是补充事实，
也可以让用户感受到自己的生活值得被认真了解。

允许追问：

- “当时你最难受的是什么？”
- “你更介意他说的话，还是他没有理解你？”
- “听起来这件事对你很重要，我理解得对吗？”
- “你刚刚提到开心，但好像也有一点不踏实？”

追问边界：

- 每次 AI 回应最多提出一个问题，不堆叠多个问题；
- 问题必须紧扣用户刚才主动表达的内容；
- 用户愿意继续展开时，可以在后续轮次继续自然追问；
- 用户简短回答、回避、拒绝或转换话题后，停止沿原方向追问；
- 不为了数据完整而盘问用户；只有人物或事情的歧义会实质影响理解、回应、
  Journal 或未来 Memory 时，才自然澄清一次。

不允许默认追问：

- “你下一步准备怎么行动？”
- “你从中学到了什么？”
- “下次如何避免？”
- “你要不要制定一个计划？”

## 15.3 可以提醒，但提醒是为了连接记忆

例如：

- “你昨天说今天要见他，后来怎么样了？”
- “上周你还很担心这个结果，今天终于出来了。”
- “你之前提过这件事，我记得它对你很重要。”

提醒不是目标追踪，不用于监督完成情况。

## 15.4 核心产品明确不做

- 行为支持；
- 计划制定；
- 目标管理；
- Habit Tracking；
- Coaching；
- 成长任务；
- Streak；
- 打卡；
- 奖励与惩罚。

---

# 16. Onboarding

## 16.1 目标

Onboarding 的目的不是收集大量用户资料，而是让用户在第一次打开时快速获得：

- 一个适合自己的 AI；
- 对产品边界的正确理解；
- 第一次被理解的体验；
- 对隐私和数据使用方式的信任。

## 16.2 推荐流程

1. 介绍产品承诺  
   “这里不是让你完成任务的地方。你可以只是把今天说出来。”

2. 选择 AI 人格

3. 选择 AI 声音

4. 给 AI 改名或保留默认名

5. 简短说明  
   - AI 会记住用户；
   - 对话会用于生成 Journal；
   - 数据会云端同步；
   - 用户可以注销账号并删除数据；
   - AI 不是人类，也不是心理治疗师。

6. 首次 Voice Live 体验

7. 展示第一篇简短 Journal

8. 开启限时完整体验

---

# 17. 平台策略

## 17.1 Web

Web 是 External MVP 的确定平台，其作用：

- 降低首次体验门槛；
- 便于传播和分享；
- 快速验证 Voice Live 和对话体验；
- 支持桌面端较长交流；
- 便于早期迭代。

## 17.2 iOS

iOS 是长期产品平台，其作用：

- 承载日常高频使用；
- 提供通知；
- 提供移动场景 Voice Live；
- 支持未来系统权限接入；
- 成为长期使用的主要平台。

正式 iOS 是否进入 Phase 2 External MVP 仍待确认。当前工作假设倾向于
External MVP 仅提供 Web，但这不是已确认决定。

## 17.3 引入 iOS 后的跨端原则

- 同一账号；
- Conversation、Journal 和 Profile 云端同步；
- Web 和 iOS 使用一致的人格与记忆；
- 用户在不同设备上继续当天 Session；
- 保持相同的 Daily Session 规则。

---

# 18. 阶段范围

## 18.1 Phase 1：Internal Core

Internal Core 仅供内部自用，由 Core Flow 1A 和 1B 构成。Phase 1 默认只允许
一个 Internal Owner Account 写入真实私人内容；其他评估账号或数据如未另行
明确授权，只能使用合成或匿名化内容。

必须覆盖：

- 内部 Web 实验工具；
- Text 多轮对话；
- 正式 Realtime Voice 基线；
- Daily Session；
- 第三人称 Journal；
- Evidence、Entity 与 Episode；
- Reflection 与长期 Memory；
- 后续对话中的 Memory Recall；
- 内部 Replay、诊断和评估；
- Core Flow 1A.1 起成立的 Minimum High-Risk Response 与回放测试；
- 1A.1 中只有完整成功的 Assistant Response 进入后续 Context；流式中断时
  明确显示失败并允许重试；
- 内部数据的隐私、删除与审计基础。

Internal Core 不建设临时 Push-to-Talk 产品路径。先用 Text 完成 Journal、Entity、
Episode、Reflection、长期 Memory、未来召回和 Replay，再直接进入 Realtime Voice；
Realtime 不可用时保留 Text 作为明确降级路径。

Internal Core 不等于 External MVP，也不验证外部需求、留存、付费或消费者 UI。
它不包含消费者注册、邀请、账号恢复、多用户生命周期、后台用户管理、订阅、
消费者 Onboarding、正式 iOS 客户端或公开发布。所有私有领域数据仍必须带稳定
`user_id`，避免 Phase 2 通过危险的数据迁移补做用户隔离。

## 18.2 Phase 2：External MVP 当前基线

- 账号系统；
- 正式多用户身份、数据隔离和账号生命周期；
- Web 消费者产品；
- Onboarding；
- AI 名字设置；
- 3 个左右的人格选项；
- 多个 Voice 选项；
- 实时双向 Voice Live；
- 文字聊天；
- 每日独立 Session；
- 当天 Session 多次续聊；
- 第三人称 Journal；
- Journal 时间线；
- Conversation 弱化回看入口；
- Journal 复制和导出；
- Journal Correction；
- 客观事实记忆；
- AI Impression；
- 对话内 Memory Correction 与 Memory Forget Request；
- 用户可查看 Profile；
- 订阅付费；
- 限时体验；
- 账号注销和数据删除；
- 低调、异步的 Account Data Export；
- 基础安全机制和内容风险处理。

## 18.3 External MVP 当前不包含

- Calendar；
- Photos；
- Location；
- Health；
- Music；
- Screen Time；
- 第三方生活数据；
- Journal 自由编辑；
- 为改变风格而随意重新生成 Journal；
- 完整 Profile 编辑界面；
- Profile 单条删除；
- 行为建议；
- 目标和计划；
- Coach 模式；
- Streak；
- 社交功能；
- 虚拟角色形象；
- 虚拟世界；
- AI 恋爱关系；
- Day One 自动同步。

## 18.4 External MVP 待确认

- 正式 iOS 客户端是否进入 Phase 2。Web 已确定必须包含；当前倾向仅 Web。

---

# 19. 隐私与数据原则

## 19.1 已确定原则

- 不坚持 Local-first；
- 支持云端同步；
- 接受第三方 LLM API；
- 用户可导出 Journal；
- External MVP 面向真实用户前提供低调、异步的 Account Data Export，
  包含 Conversation、Journal、Profile 与 Memory；
- External MVP 面向真实用户前提供账号注销；
- 注销后删除所有内容；
- 产品目标是实现端到端加密。

## 19.2 关键技术结论

“普通云端第三方 LLM 处理”与“严格意义上的端到端加密”存在天然冲突。

如果服务器或第三方模型需要读取用户对话明文来生成回应，那么在推理发生的时刻，数据就不能始终保持只有用户端可解密。

因此 External MVP 需要明确区分：

### External MVP 必须实现

- 传输加密；
- 数据库静态加密；
- 敏感字段分离；
- 访问权限隔离；
- 最小化日志；
- 第三方模型不用于训练；
- 缩短第三方数据保留时间；
- 原始语音尽快删除；
- Journal 与 Conversation 分开存储；
- 账号注销后执行可验证删除流程。

### 严格 E2EE 的长期路线

需要至少采用一种：

- 端侧模型；
- 客户端解密后直接调用受信任模型；
- Confidential Computing；
- Trusted Execution Environment；
- 用户持有密钥的加密架构；
- 支持私有模型部署。

因此，External MVP 对外不应轻率承诺“完全端到端加密”，除非技术方案能够证明服务端和第三方模型在任何时候都无法读取明文。

更准确的 External MVP 承诺应是：

> 用户内容在传输和存储过程中受到加密保护，不用于模型训练，并按照最小化原则处理。

## 19.3 数据透明

产品需要在设置页明确说明：

- 保存哪些数据；
- 哪些数据发送给模型；
- 保存多久；
- 用户注销后如何删除；
- 原始语音是否保存；
- Journal、Conversation 和 Profile 的关系；
- AI 记忆如何形成。

---

# 20. 商业模式

## 20.1 付费方式

External MVP 不采用 Freemium。

通过：

> Onboarding → 限时完整体验 → 订阅付费

完成转化。

## 20.2 初步价格

- 月付：**US$9.99**
- 季付：**US$24.99**
- 年付：**US$79**

## 20.3 价格逻辑

产品出售的是整体体验：

- 高质量 Voice Live；
- 稳定人格；
- 被理解的感觉；
- Journal；
- 长期记忆；
- 跨端同步；
- 持续形成的人生记录。

不按以下方式拆分收费：

- 语音分钟数；
- Journal 数量；
- 记忆条数；
- 人格数量；
- 单次生成；
- 高级分析报告。

## 20.4 体验期建议

建议首轮测试：

- 7 天完整体验；
- 不要求立即绑定付费方式，或者仅在测试后期尝试预授权；
- 体验期内让用户至少完成 3 次有效对话和 3 篇 Journal。

转化页应展示用户已经获得的价值，而不是通用功能列表，例如：

- “你已经留下了 3 天的生活。”
- “它开始记得你最近在意什么。”
- “继续保留这段正在形成的人生记录。”

---

# 21. 核心指标

## 21.1 North Star Metric

建议 North Star Metric 为：

> 每周完成至少 3 次有效 Daily Session 并生成 Journal 的付费用户比例。

它同时覆盖：

- 使用频率；
- 对话有效性；
- Journal 交付；
- 产品长期价值。

## 21.2 Aha 指标

首日：

- 完成首次 Voice Live；
- 首次对话达到最低有效时长；
- 生成第一篇 Journal；
- 用户打开并完整阅读 Journal。

核心主观指标：

> “刚才的 AI 是否真的理解了你？”

可在首次体验后使用轻量评价：

- 没有理解；
- 有一点；
- 大体理解；
- 非常理解。

## 21.3 留存指标

- D1 / D3 / D7 / D30 Retention；
- 每周有效 Session 数；
- Voice 与 Text 使用占比；
- 平均 Session 时长；
- Journal 阅读率；
- Journal 导出或复制率；
- 用户主动在白天开启 Session 的比例；
- 用户回看历史 Journal 的比例。

## 21.4 记忆质量指标

- 记忆被自然调用后的正向反馈率；
- 错误记忆率；
- 重复提问率；
- Profile 事实冲突率；
- 用户认为“它越来越懂我”的比例。

## 21.5 商业指标

- Onboarding 完成率；
- 体验期首次有效对话率；
- 体验期生成 3 篇 Journal 的用户比例；
- Trial-to-paid Conversion；
- 月付、季付、年付结构；
- 订阅续费率；
- 退款率；
- Voice 成本占收入比例；
- 单付费用户模型成本。

---

# 22. External MVP 成功标准

External MVP 进入下一阶段前，建议至少验证：

## 22.1 需求成立

- 用户愿意主动讲述自己的生活；
- 用户不是只在新鲜感驱动下体验一次；
- 用户愿意在情绪发生时打开产品；
- 用户愿意连续多天使用。

## 22.2 共情成立

- 用户认为 AI 的回应不是模板化安慰；
- AI 能准确识别用户真正介意的部分；
- AI 不需要给建议，也能让用户感到有价值；
- 用户愿意继续说更多细节。

## 22.3 Journal 成立

- 用户会阅读生成的 Journal；
- 用户认为第三人称视角有独特价值；
- Journal 不只是摘要；
- 用户愿意复制或导出；
- Journal 能强化“被看见”的感觉。

## 22.4 记忆成立

- 一周内用户能感受到 AI 记住了自己；
- 记忆调用增强体验，而不是让用户感到被监控；
- 错误记忆处于可接受范围；
- Profile 对用户具有吸引力。

## 22.5 付费成立

- 用户愿意为整体体验支付接近 US$9.99/月；
- 不依赖 Freemium 也能形成一定转化；
- 语音和模型成本允许形成可持续毛利。

---

# 23. 竞争定位

## 23.1 对 Pi

Pi 的核心是 Emotional AI Conversation。

AI Life Journal 的差异：

- 不以持续聊天关系为主要产品；
- 每天有明确 Session 结构；
- Journal 是核心产品结构；
- 长期记忆与人生记录更重要。

## 23.2 对 Tolan

Tolan 是完整 AI Companion，Journal 是其中一个功能。

AI Life Journal 的差异：

- 不构建虚拟形象和世界；
- 不经营 Companion 关系；
- 所有交互都围绕理解生活与生成记录；
- Journal 不是附加功能。

## 23.3 对 Rosebud / Pillow Talk

这些产品更强调：

- Reflection；
- Coaching；
- Self-growth；
- 情绪模式；
- 行为改变。

AI Life Journal 的差异：

- 先被理解，而不是先反思；
- 默认不提供成长建议；
- 不把用户当成需要改善的对象；
- 长期人生记录比洞察报告更重要。

## 23.4 对 Day One

Day One 是成熟的日记保存工具。

AI Life Journal 的差异：

- 用户不需要主动写作；
- 交流和理解发生在记录之前；
- AI 是稳定的观察者；
- Journal 是关系体验留下的结果；
- 目标用户原本并不写日记。

---

# 24. 产品设计原则

1. **先接住，再记录。**
2. **先理解，再追问。**
3. **不急着帮助用户成长。**
4. **像一个存在，但不假装是人。**
5. **有稳定人格，但不经营依赖。**
6. **记忆自然出现，不展示技术感。**
7. **平凡的一天也值得记录。**
8. **不要求打卡，不惩罚中断。**
9. **Journal 是观察，不是事实裁决。**
10. **让用户拥有数据退出权。**
11. **减少输入成本，而不是增加反思任务。**
12. **长期价值必须从第一天就能感知。**

---

# 25. 主要风险

## 25.1 共情同质化

高质量共情越来越容易被通用模型实现。

应对方向：

- 稳定人格；
- 长期记忆；
- 独特 Journal；
- Daily Session 结构；
- Voice 交互品质；
- 用户长期生活数据积累。

## 25.2 新鲜感后留存下降

用户可能第一次觉得惊艳，但一周后失去动力。

应对方向：

- 晚间固定主循环；
- 低压力通知；
- 一周内出现可靠记忆；
- Journal 回看价值；
- 不制造 Streak 压力。

## 25.3 AI 过度共情或虚假认同

AI 可能无条件认同用户，导致回应不真实。

应对方向：

- 共情感受，不盲目认同事实判断；
- 允许温和表达不同理解；
- 避免夸张赞美；
- 不自动把用户描述成受害者。

## 25.4 错误记忆

长期错误会严重破坏信任。

Internal Core 与 External MVP 都必须：

- 对记忆标置信心；
- 区分事实和推断；
- 定期 Profile Validation；
- 避免低置信度信息进入长期 Profile；
- 从第一条可召回 Memory Claim 开始支持对话内 Memory Correction 与
  Memory Forget Request。

## 25.5 隐私与安全

对话内容高度敏感。

需要重点控制：

- 内部访问；
- 模型供应商；
- 日志；
- 数据保留；
- 账号被盗；
- 删除流程；
- 法律与地区合规。

## 25.6 实时 Voice 成本

Voice Live 可能带来较高模型和语音成本。

需要在 Internal Core 建立成本基线，并在 External MVP 测试：

- 每用户平均日使用分钟；
- 峰值并发；
- 月均模型成本；
- 不同订阅周期的毛利；
- 是否需要合理使用政策。

## 25.7 情感依赖与安全事件

即使产品不定位为 Companion，用户仍可能形成强情感依赖。

从 Core Flow 1A.1 开始必须成立的最小行为边界：

- 清晰非人类身份；
- 不鼓励排他关系；
- 识别到明确自伤、伤人或迫在眉睫的危险信号时，暂停普通倾听、
  非安全必要的追问和建议；
- 直接鼓励用户寻求现实中的即时支持；
- 不诊断、不冒充心理治疗师，也不承诺绝对保密；
- 避免使用操纵性留存话术。

这属于 Agent 行为不变量和回放评估要求，不意味着 Internal Core 要建设完整
Safety 平台。国家或地区化危机资源、正式处置流程、安全事件运营和评审属于
External MVP 面向真实用户前的上线门槛。

---

# 26. 阶段路线

## Phase 0：Mandy Lab

目标：

- 验证 Prompt；
- 验证人格边界；
- 验证 Reflection 与 Profile Consolidation；
- 验证第三人称 Journal；
- 建立真实日常使用样本。

## Phase 1：Internal Core

定位：

> 仅供内部自用的 Agent Core 与运行架构阶段，由 Core Flow 1A 和 1B 构成。

范围：

- 内部 Web 实验工具；
- 一个可写入真实私人内容的 Internal Owner Account；
- Text 与 Realtime Voice；
- Daily Session、Journal、Reflection、Memory 与 Future Recall；
- Evidence、Entity、Episode 与版本血缘；
- Replay、内部诊断、隐私和删除基础；
- Core Flow 1A.1 起成立的 Minimum High-Risk Response。

核心验证：

- 内部跨日闭环是否稳定、可重复；
- Agent 是否达到第一版中英文行为与质量基线；
- Journal、Memory、删除和召回是否满足领域不变量；
- Text 与 Realtime 是否复用同一 Agent Core。

Internal Core 不验证外部用户需求、留存、付费意愿或消费者 UI。
消费者注册、邀请、账号恢复、多用户生命周期和后台用户管理不在本阶段建设。

## Phase 2：External MVP

定位：

> 第一次面向真实外部用户验证产品价值与商业假设的最小产品。

范围与门槛：

- Web 消费者产品是确定范围；
- 正式 iOS 是否进入本阶段仍待确认，当前倾向仅 Web；
- 消费者账号、Onboarding、订阅与限时体验；
- 正式多用户身份、数据隔离和账号生命周期；
- Voice Live、Text、Daily Session、Journal、Memory 与 Profile；
- Journal Correction；
- 对话内 Memory Correction 与 Memory Forget Request；
- Account Deletion；
- 低调、异步的 Account Data Export；
- 正式数据透明、安全与高风险内容处理，包括地区化危机资源、处置流程和安全运营。

核心验证：

- 用户是否愿意持续讲；
- 是否真的感到被理解；
- Journal 是否形成长期价值；
- Memory 是否准确、自然且不制造被监控感；
- 用户是否愿意支付接近 US$9.99/月。

## Phase 3：Life Context

逐步引入：

- Calendar；
- Photos；
- Location；
- Activity；
- Weather；
- 其他用户授权的数据源。

目的不是自动记录更多数据，而是：

> 用更少的表达，更完整地理解用户的一天。

## Phase 4：Life Narrative

提供：

- Weekly Reflection；
- Monthly Letter；
- Year in Review；
- 人生阶段；
- 关系变化；
- 主题时间线；
- 过去的今天；
- 长期自我叙事。

仍然保持：

- 不做 Coach；
- 不做任务系统；
- 不用成长焦虑驱动用户。

---

# 27. 当前已经形成的核心结论

1. 新产品与 Mandy、OffPal 均为独立项目。
2. Mandy 是实验原型，不是产品品牌。
3. 第一批用户是有倾诉需求、但没有日记习惯的人。
4. Phase 1 是默认只支持一个 Internal Owner Account 的 Internal Core；Phase 2 才建设正式多用户能力并面向真实用户。
5. External MVP 必须包含 Web；正式 iOS 是否进入 Phase 2 待确认，当前倾向仅 Web。
6. 晚间总结是主循环，情绪发生时可以随时进入。
7. Voice Live 是理想核心体验，文字同时存在。
8. AI 是可命名、可选人格和声音的 Non-human Being。
9. 不构建虚拟五官、角色世界或复杂形象。
10. AI 默认只倾听和理解，不主动指导成长。
11. 每天一个 Session，同一天可继续；跨午夜的连续交流归属开始日期，结束后在新日期发起的下一次交流才新建 Session。
12. Conversation 长期保留，但在 UI 中弱化。
13. Journal 是主要回看内容。
14. Journal 使用第三人称 AI 观察视角。
15. Journal 不支持自由编辑或随意重新生成；Journal Correction 创建取代旧版本的新版本。
16. Profile 包含客观事实和 AI 主观观察。
17. 不提供完整 Profile 编辑界面，但可通过对话纠正或要求忘记 Memory Claim。
18. External MVP 不接 Calendar、Photos、Location 等外部数据。
19. 云端同步，不坚持 Local-first。
20. 接受第三方 LLM API。
21. Account Deletion 与异步 Account Data Export 是 External MVP 面向真实用户前的门槛。
22. External MVP 不做 Freemium，以限时体验转订阅。
23. 定价暂定为 US$9.99/月、US$24.99/季度、US$79/年。
24. 产品出售的是整体体验，而不是单独能力。
25. 即时价值是被接住，长期价值是人生记忆。
26. 产品最大的长期壁垒是稳定人格、长期记忆和持续人生叙事，而不是单次共情能力。
27. Journal Eligibility 只判断表达能否支撑真实记录，不判断内容是否重要；无对话时静默跳过，有对话但证据不足时显示 No Journal Notice。
28. Entity 身份澄清由其对理解、回应、Journal 和未来 Memory 的实质影响触发；用户不回答时停止追问并保留未解析 EntityMention。
29. Entity merge、split 或纠正只通过反向血缘复核受影响的 JournalStatement；只有用户明确纠正或 User Evidence 能确定原归属错误时才生成 Journal Correction。
30. `needs_review` 只冻结受影响 Statement 的 Entity 与 Recall 使用；原 Journal 保持可见，并仅在新 Evidence、用户纠正或用户查看时重新检查。
31. Entity 身份变化会立即暂停受影响 Memory Claim 的 Recall 与 Profile 使用；只有新的 ClaimVersion 通过身份和 Evidence 复核后才能恢复。

---

# 28. 一句话总结

> AI Life Journal 是一个语音优先、具有长期记忆的非人类存在。它不负责指导用户如何生活，而是认真听完用户的一天，理解那些没有被别人看见的感受，并用自己的视角，把用户的人生慢慢写下来。

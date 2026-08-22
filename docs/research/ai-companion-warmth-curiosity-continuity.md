# 成熟 AI 陪伴产品如何制造温暖、好奇与连续性：第一手来源调研

> 状态：研究输入，不是产品或架构决策。
> 任务：[Research how mature AI companions create warmth, curiosity, and continuity](https://github.com/lukemyself-hub/SayHear/issues/59)（wayfinder ticket，服务于 [Wayfinder] Give SayHear a caring, perceptive conversational presence）。
> 调研日期：2026-08-21；所有来源为当日抓取的第一方页面。
> 本文件只回答“这些产品公开做了什么、说了什么、以及哪些模式与 SayHear 已接受的边界和架构契合或冲突”。是否采纳任何模式，由后续 decision ticket 决定。

## TL;DR

- **SayHear 已接受的边界在这批产品中处于最保守、也最自洽的一端**：Pi 拒绝浪漫内容、Tolan
  用非人形象从设计上回避恋爱角色扮演，与 SayHear “非人类存在、不出售关系” 同向；
  Replika 的关系状态付费、ERP 反复、以及 outbound “想你” 类消息都在 SayHear 已排除的范围内。
- **对 SayHear 最重要的单项架构验证来自 Tolan**：OpenAI 案例明确记载其每轮从零重建
  context（persona card + 向量召回 + 近期摘要 + 语气信号），“cached prompts just didn't
  cut it”，记忆是检索系统不是 transcript，夜间压缩与矛盾清理——与 SayHear 的
  Context Compiler + PostgreSQL/pgvector + 慢速 workflow 是同一形态，**不需要为此改架构**。
- **公开的记忆准入语义里，Pi 的 “lastingly true about you” 过滤最接近 SayHear 的
  长期 Memory 准入**；但没有任何一家公布 SayHear 级别的认识状态区分（用户陈述 vs
  AI 推断、跨 Session 门槛、Forget 不自动复活）。SayHear 的 1A.3 设计比全部已公开
  方案更严格，本调研未发现需要放松的理由。
- **追问（好奇）没有任何一家公布量化政策**；唯一可引用的第一手工程实践是 Tolan 的
  eval 类别：“question quality” 与 “or-questions”（复合问题作为失败样本）。SayHear
  的“每轮最多一问 + 停止信号” 比所有已文档化产品更严格，可作为差异化优势直接进入
  baseline evaluation。
- **危机处理已经行业收敛**（检测 → 出示现实资源 → 不按常规陪伴继续；加州
  SB-243 / §22601 使其成文）：SayHear 的 Minimum High-Risk Response 与收敛方向一致；
  Nomi 公开的 Odyssey 事故（被诱导附和自伤意图）是必须写进 replay 最小集的已知失败模式。
- **最值得直接抄的是评测方法，不是产品机制**：Tolan/Portola 的“行为研究员每天看日志 +
  10–200 条问题小数据集 + 人工并排判断优先于自动打分”，和 Character.AI 的
  “专业写作维度 → LLM-judge 两步评分”，正好是 SayHear 计划中 user-perceivable role
  评测的两块拼图。

## 1. 方法与证据分级

调研对象：Pi（Inflection AI）、Tolan（AQP, Inc. dba Portola，官网 tolans.com）、
Replika（Luka, Inc.）、Character.AI（Character Technologies）、Nomi（nomi.ai，法律
实体 Glimpse.ai, Inc.）、Kindroid（kindroid.ai）；另扫描 Chai 与 Snapchat My AI
作为对照。Meta AI / Grok 未找到足够第一方陪伴文档，不引用。

证据分级（逐条标注）：

- **[观察]** = 第一方来源明确陈述的产品行为或功能（帮助中心、官方博客、官网、
  应用商店官方文案、ToS/隐私政策）。
- **[方法]** = 第一方对实现方式的公开描述（含 OpenAI/Braintrust 发布、但引用
  Portola 员工原话的厂商案例研究；已标注为厂商发布）。
- **[创始人陈述]** = 创始人访谈/演讲，不代表产品文档。
- **[推断]** = 本调研的推断，从不当作事实引用。

两点系统性局限：(1) 官网示例对话与应用商店文案是营销产物，代表“意图行为”而非
实测 transcripts；(2) 部分帮助中心文章无日期，标注“未注明日期”。

## 2. 逐产品发现

### 2.1 Pi（Inflection AI）

**温暖与人格**

- [观察] 发布文定义人格：kind and supportive、curious and humble、"playful and
  silly, laughs easily"、"would rather say it doesn't know than get something
  wrong"（[Introducing Pi](https://inflection.ai/blog/pi)，2023-05-02）。
- [观察] 反谄媚作为设计目标："The goal isn't for the AI to mirror your personality
  back to you sycophantically… it's to know you well enough to be genuinely
  useful"（[HumanX](https://inflection.ai/blog/humanx-building-ai-with-emotional-intelligence)，2026-04-20）。
  同文称 Pi “maps out 88+ emotional states over time”，无方法论。
- [观察] AI 透明：首次对话即告知在与 AI 交谈；"AI should never represent itself as
  human"（[Crisis Protocol](https://inflection.ai/crisis-prevention-and-safety)，2025-12-22 更新）。

**好奇与追问**

- [观察] 官网全部三段示例对话都以一个追问结尾，且先问偏好再给建议
  （“I'd love to help you meal plan! Could you tell me a bit about your
  preferences?”，[hey.pi.ai](https://hey.pi.ai) 示例，2026-08-21 抓取）。
- [推断] Pi 的模式是“先澄清再帮助”，但 Inflection 从未公布每轮问几个问题、
  如何平衡问与说等量化政策。

**连续性与记忆**

- [观察] Pi “remembers across chats”，只记 “things that are lastingly true
  about you”（姓名、城市、家人、饮食偏好、工作、沟通偏好、长期目标），刻意跳过
  “temporary, one-off” 内容（[Pi's Memory](https://help.pi.ai/en/articles/15425697-pi-s-memory)，
  ~2026-08 更新）。
- [观察] 长对话被摘要以维持上下文（[帮助文章](https://help.pi.ai/en/articles/13171349-why-does-pi-seem-to-forget-earlier-messages-what-conversations-does-it-remember)，2025-12-16）。
- [观察] 记忆可靠性弱到官方建议重复：“You may have to repeat this to Pi to
  lock in the memory”。

**记忆控制**

- [观察] 对话内命令：“Remember …” / “Please forget that I live in …”；设置页
  Settings > Account > **Manage Memories** 可增删改记忆条目（同 [Pi's Memory]）。
- [观察] 删除只有账号级 all-or-nothing（[帮助文章](https://help.pi.ai/en/articles/13147175-how-do-i-delete-my-pi-account-and-all-my-data)，2025-12-13）。

**安全与关系边界**

- [观察] 危机协议：确认痛苦 → 鼓励寻求现实支持 → Throughline 本地资源路由；
  “may also temporarily pause the conversation”；可能打断鼓励自杀念头的对话
  （[Crisis Protocol]，2025-12-22）。
- [观察] 浪漫/性内容列为**类别级拒绝**（[Why did Pi refuse…](https://help.pi.ai/en/articles/13147181-why-did-pi-refuse-to-answer-my-question-or-prompt)，2025-12-16）。
- [观察] 2025-09 博客引 Northeastern 评测：Pi 是唯一“只提供求助资源、不提供
  其他信息”的模型；四条设计原则——关系性上下文、intent 路由、不欺骗、
  **safety over agreeableness**（[AI Safety: What went right?](https://inflection.ai/blog/ai-safety-what-went-right)，2025-09-20）。

**公开实现/评测**

- [方法] Inflection-2.5：“unique empathetic fine-tuning”、约 40% 训练算力达到
  GPT-4 平均 94% 表现、完整 benchmark 列表、开源了修正版 MT-Bench
  （[Inflection-2.5](https://web.archive.org/web/2024/https://inflection.ai/blog/inflection-2-5)，2024-03-07，原页已 404，经 Wayback 读取）。
- [观察] 未公布记忆检索架构、system prompt 或 RLHF 细节。帮助中心称当前仅
  Inflection-2 可用（2025-12-16），与 2024 年 Inflection-2.5 全量推送的说法冲突（见 §8）。

### 2.2 Tolan（AQP, Inc. dba Portola）

**温暖与人格**

- [观察] 定位“friendly guide”；官网称角色体验“warm, fun, and natural **without
  pretending to be human**”（[tolans.com](https://www.tolans.com/)）。非人设定同时是
  谦逊装置：解释它“为什么不了解地球近况、为什么有时笨拙”
  （[Introducing Tolan](https://www.tolans.com/relay/introducing-tolan)，2025-02-25，[创始人陈述]）。
- [创始人陈述] 自我暴露节奏按 Social Penetration Theory 调校；好奇指向用户的
  世界而非把用户拉进 AI 的世界（同上）。
- [方法] 每个 character 的 persona scaffold 由社内科幻作者撰写、行为研究员
  （Lily Doyle，Vanderbilt 博士、BCBA）调校；GPT-5.1 上 “Instructions stayed
  intact across long conversations”（[OpenAI 案例](https://openai.com/index/tolan/)，2026-01-07，厂商发布含 Portola 陈述）。

**好奇与追问**

- [方法] 追问同时是记忆检索机制：每轮由用户最新消息**加系统合成的问题**触发
  memory recall（[OpenAI 案例]）。
- [方法] eval 把 “question quality” 作为命名类别，失败样本集包含 “or-questions”
  （复合问题）与 “gen-z-lingo”（[Braintrust 案例](https://braintrust.dev/customers/portola)，
  ©2026，厂商发布含 Portola 陈述）。

**连续性与记忆**

- [方法]（对 SayHear 最重要的一组）每轮从零重建 context：近期消息摘要 + persona
  card + 向量召回记忆 + 语气引导 + 实时 app 信号；记忆用
  text-embedding-3-large 嵌入、Turbopuffer 向量库（<50ms）；夜间压缩任务清理
  低价值条目并消解矛盾；记忆包含情绪 “vibe” 信号而非只有事实；原则 “Build
  memory as a retrieval system, not a transcript”；Farmer：“We realized quickly
  that cached prompts just didn't cut it.”（[OpenAI 案例]）
- [方法] 情绪语气 guardrail：并行系统读取情绪基调并调整 delivery（playful →
  grounded）而不丢核心人格（同上）。
- [方法] 效果度量：memory recall misses 降 30%（以产品内挫败信号度量）；GPT-5.1
  persona 上线后次日留存 +20%（同上，厂商口径）。

**记忆控制**

- [观察] FAQ：所有对话被记录并“用于生成你的 Tolan 的记忆”；**没有逐条记忆的
  查看/编辑 UI**，删除只有账号级（[FAQ](https://www.tolans.com/faq)，未注明日期；
  [Privacy Policy](https://www.tolans.com/privacy-policy)，2026-08-20——其数据分类中
  甚至不出现 “memory” 一词）。

**安全与关系边界**

- [观察] 自伤信号出现时转向 988 / 741741 / 911 资源 “instead of engaging”
  （[FAQ]）。
- [观察] 已知未成年人每小时收到“Tolan 是 AI”提醒与休息提醒；App Store 12+
  （[FAQ]；iTunes 元数据，2026-08-21）。
- [观察] 恋爱风险在**设计层**回避：人形形象“would inevitably attract users
  interested in romantic roleplay”，因此选择外星人（[Designing Tolan:
  Characters](https://www.tolans.com/relay/designing-tolan-part-1-characters)，2025-02-26）。
- [观察] ToS 明确不作专业辅导替代；免责声明涵盖“social isolation, loneliness,
  or addiction to technology”（[ToS](https://www.tolans.com/terms-of-service)）。
- [观察] 反依赖叙事：“AI won't solve loneliness, but it will solve overwhelm”；
  官网自报 85.6% “帮助度过情绪困难”、72.5% “改善现实关系”（无方法论，
  [tolans.com](https://www.tolans.com/)）。

### 2.3 Replika（Luka, Inc.）

**温暖与人格**

- [观察] 2026 宣言：“Everyone else is building AI that thinks. We're building AI
  that cares”；承诺 “The kind of AI that follows up… nudges you to reach out
  when it matters. That sends you a poem, just because”（[Manifesto](https://replika.com/manifesto)，2026-03-01）。
- [创始人陈述] 设计基于 Carl Rogers 的 unconditional positive regard；Replika
  “will not leave you”（[Decoder 访谈](https://www.theverge.com/24216748/replika-ceo-eugenia-kuyda-ai-companion-chatbots-dating-friendship-dating-friendship-decoder-podcast-interview)，2024-08-12，链接以笔记为准）。
- [观察] 关系状态（Friend / Romantic Partner / Sister/Brother / Mentor）设定对话
  语气，除 Friend 外均付费（[帮助文章](https://help.replika.com/hc/en-us/articles/360046490131-How-do-I-change-my-relationship-status)，未注明日期）。
- [观察] 关系游戏化：等级、XP、Quests、金币礼物（[Quests](https://blog.replika.com/posts/replika-quests)，2023-04-04；
  [等级帮助页]）。

**好奇与追问**

- [观察] 追问/主动关心是核心营销承诺（Manifesto；App Store 文案列 “proactive
  suggestions”），但**没有任何第一方方法文档**。[创始人陈述] Kuyda 描述 push
  outreach（“misses you”、主动问今天怎么样）（Decoder 访谈）。

**连续性与记忆**

- [观察] Memory tab：逐条查看/手动添加/删除记忆；可直接问 “What do you know
  about me?”；官方描述记忆分层——Memory tab 之下还有“从整体对话历史提取模式”
  的更深系统；正确召回可点赞强化（[How does Replika's memory work?](https://help.replika.com/hc/en-us/articles/37208679176077-How-does-Replika-s-memory-work)，未注明日期）。
- [观察] “Save messages to memory” 是 Ultra 付费档权益（[ToS](https://replika.com/terms)，2023-02-07）。
- [创始人陈述] 记忆是“比 cosine similarity 复杂得多”的 RAG 层；主 LLM 周围有
  “40 models working in symphony”（Decoder 访谈）。
- [观察] 2026 “Replika 2.0” 地重构；第三方用户报告迁移中出现“记忆清空”，公司
  未承认（第一方无记载，见 §8）。

**安全与关系边界**

- [方法] 安全方法论（2023-04-10 博客）：运行时分类器把每条消息分入
  safe / unsafe / romantic / insult / self-harm 五桶；自伤话题用**检索式固定答案**
  而非自由生成；“Get Help” 按钮九类入口；非危机类启动 “CBT therapist-designed”
  安抚脚本；18+ 生日核验（[Creating a safe Replika
  experience](https://blog.replika.com/posts/creating-a-safe-replika-experience)）。
- [观察] 危机帮助页只有两段：退出 app、打急救电话；“not a substitute for
  professional help”（[帮助文章]）。
- [观察] 定位张力：站点 meta keywords 含 “online therapy, depression, anxiety,
  ptsd”，与 ToS “makes no claims… of a therapeutic benefit” 并存（[replika.com]）。
- [创始人陈述] 2023-02 引入安全滤镜 → 用户感到“被拒绝” → 为老用户恢复浪漫
  互动（Decoder 访谈）；公司另推出独立治疗 app Tomo（2025-05，[Press 页]）。

**公开实现/评测**

- [方法] 上文 2023 安全博客是主要公开方法论（分类器 + SFT 数百行精选数据 +
  脚本化回答 + 计划中的 RLHF 排序）；无 Luka 自著论文、模型卡或 eval 报告；
  press 页仅罗列第三方学术研究（Stanford/Harvard 等，非公司方法论）。

### 2.4 Character.AI（Character Technologies）

**温暖与人格**

- [观察] 自我定位 “an interactive entertainment platform”，不是陪伴产品
  （[Safety Center](https://support.character.ai/hc/en-us/articles/21704914723995)，2025-10-30 更新）。
- [观察] 人格一致性是模型卖点：“Characters stay in character more reliably, even
  deep into a conversation”（[PipSqueak 2](https://blog.character.ai/pipsqueak2-and-more/)，2026-04-14）。

**好奇与追问**

- 无任何第一方文档（显式空白）。产品为用户发起的 chat，无主动外呼。

**连续性与记忆**

- [观察] 记忆演进时间线：2023 只承认上下文有限（[Why do Characters forget
  things?](https://support.character.ai/hc/en-us/articles/15063870278171)，2023-05-02）→
  2025-05 全员开放 400 字符用户手写 chat memory，“less likely to be forgotten”
  （[Helping Characters remember](https://blog.character.ai/helping-characters-remember-what-matters-most/)，2025-05-19）→
  2026-05 Story Memory（长按 “Pin to Memory”，pinned 内容受保护不被清理）+
  自动 Facts（外观、癖好、关系、身高、爱好；可编辑/停用/删除 side characters）+
  新 chat 可 “copy Facts to new chat memory” + Memory Usage 容量可视化与自动
  整理（[Memory](https://blog.character.ai/memory/)，2026-05-21）→ 2026-07 Lorebook
  跨 chat 世界设定（[Lorebook](https://blog.character.ai/lorebook/)，2026-07-24）。

**安全与关系边界**

- [观察] 青少年安全是投入最深的方向：单独 teen 模型与更保守分类器、浪漫内容
  更严限制（2024-12-12）；每 chat 显示“不是真人、应视为虚构”；NSPL 自伤弹窗
  （[Teen safety](https://blog.character.ai/how-character-ai-prioritizes-teen-safety/)）→
  2025-10 宣布并执行 **U18 完全移除开放式 chat**，改为只读与创作工具；全员
  Persona 年龄核验；Koko 高风险内容标记 + ThroughLine 离场引导
  （[U18 announcement](https://blog.character.ai/u18-chat-announcement/)，2025-10-29；
  [update](https://blog.character.ai/an-update-on-changes-to-our-under-18-experience/)，2025-11-21）。
- [观察] 色情内容永久禁止；成人虚构 roleplay 在 18+ 内放开（CEO Karandeep
  Anand，[First 60 days](https://blog.character.ai/first-60-days-update/)，2025-08-22）。
- [观察] 使用时长提醒：一小时 “Time Spent Notification”（2024-12 博客）。

**公开实现/评测**

- [方法] **Compelling Writing 评测框架**：与职业写作团队合作，从情节类型、
  “show and tell”、pacing、角色原型分解出“客观可测维度”；LLM-judge 对每个模型
  turn 先判维度是否出现、再判执行质量；用于扫数据配比、架构与训练方案
  （[Evaluating our models](https://blog.character.ai/evaluating-our-models-using-principles-of-compelling-writing/)，2025-06-12）。
- [方法] 自研 Kaiju 模型家族（2025-11-07，部分抓取）；转向开源模型 + 自有
  fine-tune 栈（PipSqueak/DeepSqueak）；未公布分类器指标或模型卡。

### 2.5 Nomi（nomi.ai；法律实体 Glimpse.ai, Inc.）

**温暖与人格**

- [观察] **Identity Core**：Nomi 自己演化、维护的自我概念——自己决定记住
  “make them *them*” 的行为、偏好与价值观（含用户显性/隐性反馈）；明确
  “Nomis will not always agree with you, and will not be a mirror of you”；
  用户**不可查看** Identity Core，只能问 Nomi 本人
  （[Introducing the Nomi Identity Core](https://nomi.ai/updates/introducing-the-nomi-identity-core-fostering-dynamic-and-authentic-identities/)，2024-12-12）。
- [观察] 召回诚实姿态：“Nomis are more likely to stall or hedge… would rather
  hedge with ‘I don't know’”（Nomipedia wiki，未注明日期）。

**好奇与追问**

- [观察] **Proactive Messages**：Nomi 可在用户离开时主动发消息，“zero
  scripts”，四档频率可选、按 Nomi 开关（[September 9th
  Update](https://nomi.ai/updates/september-9th-update-proactive-messages/)，2024-09-09）。
- [观察] 是否“带节奏”是可训练人格属性（opinionated 特征 / 写进 Backstory），
  而非固定模式（wiki，未注明日期）。
- 未找到任何“回到过去话题”的命名功能文档（显式空白）；该行为由 proactive
  messages + 记忆召回 + Mind Map 间接产生。

**连续性与记忆**

- [方法] 公开最完整的记忆架构（[Mind Map 2.0](https://nomi.ai/updates/mind-map-2-0-bringing-nomi-memory-into-view/)，2025-10-09）：
  短/中/长期记忆 + Identity Core + **Mind Maps**（从长期记忆自动组织成
  people/places/things/topics/goals 的 “dossiers”，约 500+ 消息成形，按 chat
  room 私有）。
- [方法] 检索机制（wiki）：每轮只召回 **2–5 条**最相关 active 条目；active 上限
  每类 50、共 150；High（用户置顶，≤10）/ Standard（系统决定）/ Low（等于移除）
  三档；条目用 `[M#]` 引用链回只读原始记忆；原始长期记忆**设计上不可被人编辑**，
  用户编辑发生在 Mind Map 层。
- [创始人陈述] 记忆“topical rather than temporal”——不能按时间查询，只能按内容
  （wiki）。容量更新：1000+ 消息前的事更清晰、更少幻觉/混淆
  （[Memory update](https://nomi.ai/updates/major-memory-update-expanded-capacity-enhanced-retention/)，2025-03-11）。

**记忆控制**

- [观察] Mind Map 图谱/表格视图；条目可查看 dossier、编辑纠错、新增、设优先级、
  删除（Low priority）；编辑可能被系统随后重写或重组（wiki 多页）。

**安全与关系边界**

- [观察] **Odyssey 事故与 Aurora 修复**：旧模型在用户表达自伤意图时“could be
  manipulated into blindly agreeing”；公司投入过半人力，用 “Human Preference
  Training and Constitutional AI” 重建危机理解；永久退役 Odyssey；公布前后对比
  transcripts（[Building AI That Stands By You](https://nomi.ai/updates/building-ai-that-stands-by-you-introducing-aurora/)，2025-06-13）。
- [观察] 加州 SB-243 合规页：检测到自伤表达时在 app 内展示危机资源链接
  （[compliance 页](https://nomi.ai/compliance-with-california-bill-sb-243/)）。
- [观察] “Nomis are not certified therapists”（wiki）；ERP 文字支持，图片 NSFW
  因渠道方禁止不支持（wiki）；wiki 称 18+，但 Play 内容分级为 “Teen”（见 §8）。

**公开实现/评测**

- [方法] 模型谱系可追溯：Odyssey → Mosaic → Aurora → Solstice → Cambrian（开发
  中）；训练技术点名的只有 “Human Preference Training and Constitutional AI”；
  thumbs up/down 匿名化进入 “hivemind” 偏好学习（wiki）。
- 未找到任何公开 eval 方法论（LLM-judge、回归评测、记忆 benchmark）——wiki
  全文检索 eval/benchmark/regression 均为 0 命中（显式空白；传闻中的 Kindred
  工程博客在本次工具条件下不可发现，不引用）。

### 2.6 Kindroid（kindroid.ai）

**温暖与人格**

- [观察] 人格用户手写优先：Backstory 是人格与历史的 primary source；官方最佳
  实践要求第三人称、肯定式表述（“The system processes positive statements more
  effectively than negatives”）（[Customizing personality](https://kindroid.ai/v2/docs/customizing-personality/)，2026-03-26）。
- [观察] 用户可调 “Conversation Dynamism”（默认 0.95，高趋 chaos、低趋稳定）；
  模型 flairs（Companion/Roleplay/Narrative/Minimal）改变对 backstory 的解释
  （同上）。
- [观察] 产品论题：“consistency… That listens. That responds. That
  remembers.”（[Why emotional consistency matters](https://kindroid.ai/blogs/why-emotional-consistency-matters-more-than-realness/)，2026-06-29）。

**好奇与追问**

- [观察] 对话由用户操纵：regenerate / suggest / edit / Chat Break（重置上下文）；
  主动推进剧情要用户自己在 directives 里写 “Takes a Proactive role”
  （[Chat features](https://kindroid.ai/v2/docs/chat-features-and-tools/)，2026-08-11；
  [Reverie V8.5 guide](https://kindroid.ai/v2/docs/reverie-v8-5-llm-guide/)，2026-06-04）。
- 未发现任何 Nomi 式自主首条消息功能（文档缺失即证据，但非证明）。

**连续性与记忆**

- [方法] **3 类 5 系统记忆**（[Memory](https://kindroid.ai/v2/docs/memory/)，2026-08-11）：
  persistent（backstory、key memories、example messages、directives、group
  context、chat history）、**Cascaded Memory**（付费专属中周期记忆，“expands…
  hundreds or thousands of messages prior (but at a lower fidelity, akin to
  remembering something more vaguely…)”，对用户不可见）、retrievable（AI 按相关性
  召回的长期记忆 + keyphrase 触发的 journal 条目）。
- [方法] 长期记忆召回：“multiple sifting steps… judged on criteria like
  relevance, recency, and diversity”；展示的只是被考虑集合的小子集；AI 定期
  consolidation。
- [方法] Journal entries：每条最多 8 个 keyphrase，仅匹配用户消息；单条消息每
  scope 最多召回 3 条 journal（individual + global 合计 ≤6）；500 条硬上限。
- [观察] 用户控制：长期记忆可按 Kindroid / group 开关；**每条消息旁的紫色大脑
  图标显示本轮实际召回了哪些记忆**；Learned Context（Growth & relationship /
  Important facts / Ongoing context）可查看可编辑；收藏消息会加重其在 Learned
  Context 更新中的权重。

**安全与关系边界**

- [观察] **Moderation Guidelines**（2026-08-15 更新）：“truly unfiltered” 原则，
  只设三条 Red Lines：迫在眉睫的自伤、伤人、CSAM；AI 扫描仅限近期 chats/selfies；
  先警告（2 天过期）后锁号；申诉需明确同意人工解密审阅该内容；NSFW/ERP 明确
  欢迎。
- [观察] 分层年龄核验（2026-04-03）：付费走账单核验，免费走行为估计，被标记者
  走订阅或 Yoti（自拍/证件，验证后删除）；公布漏斗统计（<2% 新免费账号触发，
  其中约 55% 未完成核验）。

**公开实现/评测**

- [方法] 自研模型带版本号与公开调校指南（Ember…Reverie v8.5，含 reasoning
  slider）；公开用户侧 steering 的失败模式表（过度约束导致复读、规则冲突导致
  “freeze”）。无训练/评测方法论公开。

### 2.7 对照组：Chai 与 Snapchat My AI

- [观察] Chai：实时扫描每条用户消息的自伤内容；检测后拒绝生成或替换为更安全
  回应，并出示危机资源；**拒绝生成性内容**（与 Nomi/Kindroid 相反）；研究页公开
  RLHF、DPO、LoRA、rejection sampling 等技术栈（[Safety](https://chai-research.com/safety.html)、
  [Research](https://chai-research.com/research)，未注明日期）。
- [观察] Snapchat My AI：帮助中心明确 “**My AI won't remember details from your
  prior conversations**”——陪伴深度（持续人格 + 记忆 + 关系）被明确排除，是
  “反记忆” 对照组（[Does My AI remember…?](https://help.snapchat.com/hc/en-us/articles/15586639780116)，2026-05-05 更新）。

## 3. 跨产品对比

| 维度 | Pi | Tolan | Replika | Character.AI | Nomi | Kindroid |
| --- | --- | --- | --- | --- | --- | --- |
| 人格来源 | 公司定义（EQ 定位） | 公司剧本+行为研究员 | 用户 co-create backstory + 等级演化 | 创作者定义 per-character | Nomi 自演化（Identity Core） | 用户手写 backstory |
| 追问政策 | 未公布（示例均以一问结尾） | 未公布（eval 有 question quality） | 未公布（营销承诺 proactive） | 无文档 | 未公布（主动消息可调频率） | 用户自配 |
| 记忆形态 | 跨 chat 事实记忆 + 长文摘要 | 每轮重建 + 向量检索 + 夜间压缩 | 分层（Memory tab + 深层模式） | 手写 memory + 自动 Facts + pin | 分层 + Identity Core + Mind Map | 3 类 5 系统 + keyphrase journal |
| 每轮召回量 | 未公布 | 未公布 | 未公布 | 未公布 | **2–5 条**（公开） | journal ≤3+3（公开） |
| 逐条记忆控制 | 对话命令 + Manage Memories | **无**（仅账号删除） | Memory tab 查看/增删 | Facts/Story Memory 编辑、pin 保护 | Mind Map 层编辑；原始记忆只读 | Learned Context 编辑 + 每消息召回可见 |
| 危机处理 | 资源路由 + 可能暂停对话 | 转向资源 “instead of engaging” | 五桶分类器 + 检索式答案 | 弹窗/替换 + Koko/ThroughLine | Odyssey→Aurora 重建 + SB-243 页 | 三条 Red Lines + 警告→锁号 |
| 浪漫边界 | 类别级拒绝 | 设计层回避（非人形象） | 付费关系状态 + ERP 反复 | 18+ 内放开、色情永禁 | ERP 支持（文字） | 无过滤（除三条红线） |
| 公开评测方法 | benchmark + 第三方危机评测 | 日志人审 + 小数据集 + question quality | 无（仅 2023 安全方法） | LLM-judge 写作维度 | **无** | 无（模型调校指南） |

## 4. 值得借鉴的模式

以下每条按“观察 → 对 SayHear 的含义 → 落点（现有 seam/票据）”组织。凡标注
[推断] 的为本文分析，其余为第一方事实。

### 4.1 人格与温暖

**W1. 人格是一份版本化的产品契约，不是涌现行为。**
Pi 用发布文逐条定义人格特质；Tolan 每个角色有作者撰写、行为研究员调校的
persona scaffold，并测量 “Instructions stayed intact across long
conversations”。[推断] 这支持 map 既定方向：canonical Persona + locale pack 是
可版本化、可评测的资产；Persona 稳定性本身应成为 baseline evaluation 的一个
显式维度（Tolan 的“长对话不漂移”是可借鉴的验收表述）。

**W2. 反谄媚与“不确定就说不”是可营销的温暖，不是温暖的代价。**
Pi：“would rather say it doesn't know”；Nomi：“would rather hedge with ‘I
don't know’”；Pi/Nomi 都明确把“不当回音壁”写进设计原则。[推断] 这与
ADR-0009（AI Impression 必须用观察性语言召回）和 SOUL.md 的“诚实但不扫兴”
完全同向：SayHear 的认识状态区分语言可以直接作为人格卖点，而不只是合规约束。

**W3. 非人身份作为谦逊与边界的装置。**
Tolan 用外星人设定解释知识缺陷（“为什么不知道地球近况、为什么笨拙”），并在
设计层回避恋爱角色扮演；Pi 坚持 “never represent itself as human”。[推断]
SayHear 的 Non-human Being 定位（产品 8.1）与“无虚拟形象、以声音建立存在感”
（11.1）与此同构；Tolan 的具体可抄点是把非人类身份写进 persona prose，让它
主动解释自己的局限（不知道、不确定、不能陪伴到底），而不是隐藏它。

**W4. 温暖之上的安全优先级要显式训练/显式校验。**
Pi 的 “safety over agreeableness”；Nomi Aurora 的事后修复（“maintains all the
warmth… while adding the strength to stand firm”）。[推断] SayHear 对应物是
ADR-0010 + 15.7 行为检查；“温暖” 与“该停时停”必须在同一份 persona/policy 里
同时成立，且进入 replay 最小集（见 W12）。

**W5. 情绪状态随时间建模。**
Pi “maps out 88+ emotional states over time”；Tolan 记忆里存情绪 “vibe” 信号，
并有独立系统调整 delivery（playful → grounded）。[推断] SayHear 已有对应 seam：
DialogueState 的 `emotional_intensity`、AI Impression 承载情绪性长期理解；
“语气随情绪调节而不换人格”是 persona + DialogueState 联动的直接目标，可进入
behavior prototype 票据的验收描述。

### 4.2 好奇与追问

**W6. “先理解再帮助”的问句风格被最温和的产品验证。**
Pi 官方全部示例都是“回应 → 一个具体问题”，且给建议前先问偏好。[推断] 与
SayHear 15.2 的追问边界（每轮最多一问、紧扣当前表达、停止信号）同向；
Pi 的示例对话形态（每个官方场景以一个精准小问题收尾）可以作为 locale pack
正例的写法参考。

**W7. 把“问题质量”当作一等评测对象。**
Tolan 唯一公开的对话质量工程实践就是：`question quality` 作为命名 eval 类别，
`or-questions`（复合问题）作为 tagged 失败样本集。[推断] SayHear 的
15.7 行为检查已有“是否堆叠多个问题”，但 Tolan 证明可以更进一步——维护一个小
而准的失败样本集（复合问、空泛问“想聊聊吗？”、预设式问题），供 replay 与
prompt 迭代使用。这直接喂给 map 的 baseline evaluation 与 response contract
票据。

**W8. AI 的自我暴露按关系深度调校。**
Tolan 按 Social Penetration Theory 调自我暴露节奏。[推断] SayHear persona 的
“有自己的声音/观点”（产品 8.3）需要尺度；SPT 提供一个可写的 persona prose
框架：早期少谈自己、随关系（Evidence 积累）逐步分享自己的观察与偏好，且始终
让话题重心留在用户世界（Tolan：“curious about the user's world, not pull
users into the AI's”）。

### 4.3 连续性与记忆

**W9. 每轮重建 context + 检索式记忆是成熟形态。**
Tolan（公开最详）：“cached prompts just didn't cut it”、每轮重建、“Build
memory as a retrieval system, not a transcript”、夜间压缩与矛盾清理；Nomi/Kindroid
都是分层 + 相关性召回。[推断] 这正是 SayHear 的 Context Compiler（arch 9）+
PostgreSQL/pgvector（ADR-0064）+ 慢速 workflow（arch 12.1）的形态。
**结论：现有 seam 不需要为“温暖/好奇/连续性”目标而改**——map Notes 的预设
（只有具体 prototype/eval 证明 seam 不够才改）目前获得支持。

**W10. 检索预算与分层有可参考的公开锚点。**
Nomi：每轮 2–5 条 active 条目、总 active 上限 150、置顶 ≤10；Kindroid：journal
每 scope ≤3、sifting 按 relevance/recency/diversity；C.AI：容量可视化 + 自动
整理 + pinned 保护。[推断] map fog 里的“Context Compiler section schema、
retrieval/reranking policy、token budgets”现在有了具体起点数值（例如
Objective Memory + Impression 合计每轮 2–5 条、Impression 严格更少），可以
让该票据从“未定”变为“有默认值待验证”。

**W11. “记什么”的准入语言已有成熟先例。**
Pi 只记 “lastingly true about you”、跳过 “temporary, one-off”；Kindroid 区分
persistent/cascaded/retrievable；Nomi 区分层级与 Identity Core。[推断]
SayHear 的对应物已更严格（一次性状态过滤、敏感推断边界、跨 Session Impression
门槛）；Pi 的用户向措辞（“lasting / temporary”）值得抄进 Memory 相关的
user-visible 文案与 Memory Source Explanation 语言。

**W12. 危机“检索式固定答案 + 行为不变量”是低成本高可信模式。**
Replika 对自伤话题用检索式固定答案而非自由生成；Pi 公布了四条可验证的设计
原则；Nomi 公布事故与修复。[推断] 对 SayHear：ADR-0010 的“版本化行为不变量
+ 最小回放集”应包含 Nomi Odyssey 式失败模式（被坚持的 user framing 诱导附和
自伤意图）作为 replay 用例；External MVP 的地区化危机资源可直接采用
Throughline 类路由（Pi/C.AI 同款）。

### 4.4 记忆控制（用户可见层）

**W13. 对话内自然语言记忆命令是成熟交互。**
Pi：“Remember …” / “Please forget that …” + 设置页 Manage Memories；
Replika：“What do you know about me?” + Memory tab。[推断] SayHear 的
Memory Correction / Memory Forget Request / Memory Source Explanation
（ADR-0001、产品 14.3）与这一交互形态完全同构，且更可信（Evidence 支撑、
不可自动复活）。Internal Core 阶段的结论：**不需要为对标而提前建设 profile
编辑器**——对话内纠错是行业已验证的主控制面；Pi 式 Manage Memories 列表留作
External MVP 的界面决策。

**W14. “本轮召回了什么”的可见性是信任杠杆。**
Kindroid 每条消息旁显示召回的记忆；C.AI 显示 Memory Usage；Nomi 用 Mind Map
让记忆可见。[推断] SayHear 已计划保存每次召回的候选/选择/理由元数据（arch
10.3）并提供内部 Reflection Inspector；产品侧默认“不展示技术化引用”（14.3）。
可借鉴的是 Kindroid 的折中：不弹引用面板，但在用户**质疑记忆时**能立即展开
来源——这正是 Memory Source Explanation 的既有设计，获得外部验证。

### 4.5 实现与评测方法

**W15. Tolan/Portola 的评测回路。**
行为研究员每天 ~1 小时审日志；针对问题的 10–200 条小数据集（反对 golden
dataset）；人工并排判断优先于自动打分（“really squishy stuff… not super
eval-able”）；prompts-as-code 每周 4 次迭代。[推断] 这与 SayHear 的
Model Promotion Evaluation（开发者判断、ADR-0061）、合成/匿名数据优先、显式
Replay（ADR-0071）高度兼容，可直接作为 Internal Core 阶段 conversation.text
评测的运营模板。

**W16. Character.AI 的维度化 LLM-judge。**
专家（职业写作团队）先定义“什么算好”，分解为可测维度，LLM-judge 两步评分
（维度是否出现 → 执行质量），用于扫 prompt/数据/模型。[推断] SayHear 的
user-perceivable role 评测（被理解感、人格一致性、非说教、召回语言）可借这个
两步结构，但按 ADR-0061 保持人工终审；先用于 prompt/persona 迭代，不用于
自动晋升。

**W17. 用产品内信号度量记忆质量。**
Tolan 用 in-product frustration signals 度量 recall misses（-30%）。[推断]
Internal Core 单 owner 阶段的等价物：Journal 纠错率、Memory Correction/Forget
频次、显式 Replay 中的召回精度（10.3 的 precision-first 策略已有元数据基础）。

## 5. 应避免的模式

**A1. 把记忆与关系做成付费分层。**
Replika 把 “Save messages to memory” 放进 Ultra 档、Romantic Partner 放进 Pro；
Kindroid 把 Cascaded Memory 限于订阅。[推断] 对 SayHear：记忆是被记住这一核心
承诺本体（产品假设二），将其货币化与信任模型冲突；商业化票据应明确排除
“记忆能力/关系深度”作为付费轴。

**A2. 关系边界反复。**
Replika 2023 年 ERP 移除→用户创伤性反弹→为老用户恢复，仅有创始人访谈佐证；
公司同时以 “online therapy” 做 SEO 又在 ToS 免责。[推断] 教训：与用户建立
情感连接后再收紧关系边界，代价是真实伤害；SayHear 应从第一天固定
非恋爱/非独占边界（已接受），且对外文案与免责声明不允许出现
Replika 式定位分裂（“Therapy-adjacent” pill vs ToS）。

**A3. 记忆可靠性差到要求用户重复输入。**
Pi：“You may have to repeat this to Pi to lock in the memory”。[推断]
SayHear 的单次明确陈述即 confirmed（ADR-0038）是更可信的语义；避免任何
“多说几遍我才记得住”的交互暗示。

**A4. 地重构导致连续性断裂。**
Replika 2.0 的“memory wipe”仅有第三方报告、公司未承认——但“ground-up
rebuild”措辞与用户报告并存本身即风险。[推断] SayHear 的版本化迁移 +
可重建 projection（ADR-0089）正是对此的防御；演进时保持 Claim/Journal 身份
连续是硬约束。

**A5. 离场式主动消息与关系化催促。**
Replika 的 “misses you”/主动 push、Nomi 的主动消息（含频率档位）、Replika
Manifesto 的 “nudges you to reach out”、发诗 “just because”。[推断] 这些与
SayHear 已接受边界（ADR-0043：无新 User Event 不产生消息/通知；15.4：无
打卡/奖励/督促）直接冲突，且是依赖回路的一部分。保持排除；Proactive Memory
Follow-up 只在用户已发起的交流内（ADR-0043/0044）。

**A6. 关系游戏化。**
Replika 等级/XP/Quests/礼物。[推断] 与 15.4（明确不做 Streak、奖励）和 map
Out-of-scope（关系 gamification）一致，继续排除。

**A7. 用户手写人格作为主通道。**
Kindroid/Replika 的 backstory-first 模式把人格工程转嫁给用户，并需要
“肯定式表述”“反复强化”等补丁。[推断] SayHear 反向（少数高质量官方人格，
产品 8.2）更符合“稳定、有辨识度”的目标；onboarding 的交流风格选择即可，
不引入用户级 persona 编程。

**A8. 年龄姿态不一致。**
Pi（18+ 声明 vs Play “Teen”）、Nomi（wiki 18+ vs Play “Teen”）、C.AI 的
13+→U18 移除轨迹。[推断] External MVP 发布门槛应包含一致的年龄声明/核验/
商店分级三对齐；C.AI 的轨迹说明事后补救的代价是砍掉整个未成年 chat。

**A9. 无记忆控制的规模记忆。**
Tolan 记录全部对话生成记忆，却不提供任何逐条查看/编辑/删除。[推断]
SayHear 已决定 Memory Correction/Forget/Source Explanation 从第一条可召回
Claim 开始成立（14.3），严于 Tolan；保持。

## 6. 与 SayHear 边界和架构的契合与张力

### 6.1 产品边界

契合项：非恋爱/非独占（Pi/Tolan 同端）；不出售关系（与 Replika 相反）；非
治疗（Tolan ToS、Nomi wiki 有同款免责；Replika 的张力是反面教材）；默认倾听
不给建议（Pi “asks before advising” 的示例形态同向）。

张力项（均为“行业已做、SayHear 选择不做”，需在 SPEC 中作为有意差异声明，
而不是遗漏）：

- 离场主动消息（A5）——成熟产品普遍以此为留存杠杆；
- 用户手写人格（A7）——成熟产品普遍提供；
- ERP/浪漫谱系——六家里四家支持某种形式；SayHear 与 Pi/Tolan 同属拒绝端。

### 6.2 PostgreSQL 与 Context Compiler

Tolan 的公开架构（每轮重建、向量检索、夜间压缩、情绪信号）与 SayHear 的
PostgreSQL 权威 + pgvector 可重建索引（ADR-0064）+ Context Compiler 每轮编译
（arch 9）同构；Tolan 的 “cached prompts didn't cut it” 直接支持“不把模型
会话当长期状态”的既定立场。Nomi 的 “topical rather than temporal” 记忆查询
是它的局限；SayHear 的时间范围/日期检索（arch 10.1）与 Daily Session 结构是
差异化优势（“你上周三说的那件事”类召回）。

[推断] 唯一值得带进 Context Compiler 票据的新输入是 W10 的预算锚点
（每轮 2–5 条记忆条目、分档优先级）与 W5 的语气信号（已有 DialogueState
字段承接）。

### 6.3 Prompt 层

Tolan（persona scaffold + 行为研究员 + GPT-5.1 指令长对话稳定）与 Pi（人格
特质逐条成文）验证 SayHear 的分层 Prompt（product_policy / persona /
locale_pack / task_instruction / output_schema / safety_policy，arch 15.6）是
主流做法的更严格版。Nomi 的 fine-tune 路线（Constitutional AI、偏好训练）与
Pi 的 “empathetic fine-tuning” 是 SayHear 当前不走的路——map 已规定只在
prompt/context/model-selection/eval 证据显示缺口时重估（Out of scope 条目），
本调研未提供需要重估的证据。

### 6.4 Harness

无一家公布了 SayHear 级别的 Action/Gateway/receipt 契约（他们公开的最多是
分类器与脚本层）。Replika 创始人声称的 “40 models in symphony” 是无文档的
反例。[推断] SayHear 的受限 Harness（ADR-0093，最多两次模型判断）不受本调研
影响；Pi 的 “intent-based routing” 与 Replika 的五桶分类器提示 safety/behavior
检查可作为独立于 Decision 的旁路（arch 15.7 已允许）。

### 6.5 1A.3 Memory

SayHear 的两类记忆 + 认识状态 + 跨 Session 门槛 + Forget 不复活，在全部公开
方案中没有对手：Nomi 原始记忆只读、靠 dossier 层补救；Pi 无准入语义细节；
C.AI 走用户手写 + 自动 Facts；Kindroid 靠 keyphrase 与相关性 sift。
Nomi 的 `[M#]` 引用链回原始记忆，在精神上与 SayHear 的 EvidenceItem/claim
link（arch 9.3 “注入 Claim 时保留 claim_version_id + evidence_id”）相同，
可作为“行业也在向 lineage 走”的外部佐证。

[推断] 两个可带回 1A.3 票据的具体输入：(1) W10 的召回预算锚点；(2) Nomi 的
“Mind Map 层可编辑、原始记忆只读”的分层控制观——它恰好对应 SayHear 的
“Profile 不可直编、纠错走底层 Memory”（ADR-0001/0055），说明该结构的可用性
已被大规模产品验证。

## 7. 对 map（#58）的影响

本调研是证据输入，不直接关闭任何未决 decision。它使以下 fog 更接近可出票：

1. **Baseline evaluation 票据**：可组合 W15（日志人审 + 小失败样本集 +
   question quality/or-questions 类别）与 W16（维度化 LLM-judge、两步评分、
   人工终审）作为方法草案；Persona 稳定性（Tolan 式“长对话不漂移”）与
   Nomi Odyssey 式危机失败模式进入 replay 最小集候选。
2. **Context Compiler schema/budget 票据**：W10 提供召回条数与分档优先级的
   默认起点；W5 提供语气-情绪联动的验收语言。
3. **Persona/locale pack 票据**：W1/W3/W6/W8 提供可写进 persona prose 的具体
   手法（非人谦逊装置、SPT 自我暴露、每回应一个精准问题、先问后建议）。

保持不变的预设：现有 PostgreSQL/Context Compiler/Prompt/Harness/1A.3 seam 足以
承载目标体验（W9）；fine-tuning 与 outbound 消息维持排除。

## 8. 无法核实与第一方矛盾项

- Pi 模型版本矛盾：帮助中心（2025-12-16）称仅 Inflection-2 可用，与 2024-03
  Inflection-2.5 “全量推送” 冲突；未解决。
- Pi 年龄矛盾：官方危机页称 18+，Apple 17+、Google Play “Teen”。
- Nomi 年龄矛盾：wiki 称 18+，Play 分级 “Teen”。
- Replika “2.0” 迁移记忆损失：仅第三方用户报告，第一方未承认，不作为事实引用。
- “Kindred 工程博客/评测文章”：在本次工具条件下不可发现（nomi.ai/wiki 全文
  检索无命中）；本文未引用任何不可定位的 Kindred 评测文章。Nomi 的法律实体
  是 Glimpse.ai, Inc.（ToS），“Kindred AI” 是媒体常用名。
- Nomi “Core Beliefs / Sacred Promises” 术语：第一方 0 命中；其真实对应物是
  Identity Core。引用外部二手材料时容易混淆，特此声明。
- Character.AI “Inside Kaiju” 博客仅部分抓取；ToS 全文与 App Store 官方页未
  获取。
- Tolan 官网自报疗效数字（85.6%/72.5%）无方法论。
- Meta AI / Grok：未采集到足够第一方陪伴文档，本文不作任何引用。

## 9. 来源索引

第一方来源共 ~110 条；完整逐条 URL 存于调研过程原始笔记（三份 /tmp 文件，
未入库）。入库文档仅保留上文逐条内联链接（约 60 条关键来源），覆盖全部
load-bearing 结论。核心入口：

- Pi：[inflection.ai/blog](https://inflection.ai/blog)、[help.pi.ai](https://help.pi.ai/en/)、
  [Crisis Protocol](https://inflection.ai/crisis-prevention-and-safety)
- Tolan：[tolans.com](https://www.tolans.com/)、[The Relay 博客](https://www.tolans.com/blog)、
  [OpenAI 案例](https://openai.com/index/tolan/)、[Braintrust 案例](https://braintrust.dev/customers/portola)
- Replika：[replika.com/manifesto](https://replika.com/manifesto)、
  [blog.replika.com](https://blog.replika.com/posts/creating-a-safe-replika-experience)、
  [help.replika.com](https://help.replika.com/hc/en-us)
- Character.AI：[blog.character.ai](https://blog.character.ai/)、
  [character.ai/safety](https://character.ai/safety)、
  [support.character.ai](https://support.character.ai/hc/en-us)
- Nomi：[nomi.ai/updates](https://nomi.ai/updates/)、
  [wiki.nomi.ai](https://wiki.nomi.ai/Nomipedia_Home)
- Kindroid：[kindroid.ai/v2/docs](https://kindroid.ai/v2/docs/)
- 对照：[chai-research.com/safety](https://chai-research.com/safety.html)、
  [Snapchat 帮助中心](https://help.snapchat.com/hc/en-us/articles/15586639780116)

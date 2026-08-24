# 成熟 AI 产品的 Memory & Recall 体验调研：召回呈现、透明度、纠错与遗忘（ChatGPT / Gemini / Claude / Pi / Replika / Nomi / Kindroid / Character.AI / Tolan）

> 状态：研究输入，非决策
>
> 更新时间：2026-08-24
>
> 关联 Issue：[lukemyself-hub/SayHear#91](https://github.com/lukemyself-hub/SayHear/issues/91)（map #90）
>
> 前置研究：[#59 companion 调研](companion-warmth-curiosity-continuity-research.md)已覆盖六家
> companion 的记忆**结构、控制面与安全边界**；本篇不重复那些结论，只深入**召回呈现、
> 记忆透明度、纠错与遗忘的落地体验、失败模式与公开评测方法**，并新增三家助手
> （ChatGPT / Gemini / Claude）作为对照。

## 1. 结论摘要

本次以第一方来源（帮助中心、官方博客、changelog、官方案例）为主，社区报告只作明确
标注的次要信号，对九家产品的 Memory & Recall 体验做 UX 层面核对。核心结论：

1. **召回呈现的行业主流是"无仪式编织"**：所有产品都把记忆织进普通回复，不做
   "我想起来了"式的技术仪式。对话开场没有一家产品文档化"AI 主动用记忆开场"；
   最接近主动性的是 Gemini（"may suggest topics or tools for you based on previous
   conversations"，仍在用户发起的会话内）与 companion 们的对话内追问。这与 SayHear
   ADR-0043（主动只进用户已发起的对话）和 §15.3 的边界一致。
2. **"来源可见"正在从无到有，但没有任何一家达到逐条 Evidence 级解释**。ChatGPT 于
   2026-05 上线 response 级 "memory sources"（Sources icon），但官方明确"并非影响回复
   的每个因素都会显示"；Claude 引用 past chat 时给出指回原对话的 citation 并可直接删除；
   Gemini 只提供"直接问它 Did you use any info from past chats?"。九家均无
   "这条记忆来自哪天、哪句表达、属于哪类认识状态"的第一方机制——SayHear 的
   Memory Source Explanation（ADR-0008）仍超出全部公开实践。
3. **九家没有任何一家在召回语言上区分"用户陈述过的事实"与"AI 的推断理解"**。
   ChatGPT 的记忆摘要把自述与推断合并成同一口吻的条目；companion 普遍用亲密第一人称
   ("I remember you are...")召回一切。SayHear 的双语言规则（ADR-0009）在行业里没有
   先例，是差异化而非补齐。
4. **纠错的行业共识是"对话内说一句就生效"，但派生视图的一致性是普遍弱点**：Claude
   官方写明对话内修改"立即应用到下一次对话"；ChatGPT/Gemini 都支持对话内要求忘记。
   但 ChatGPT 文档明确"删除对话不会删除该对话产生的记忆"，Gemini 明确删除对话后
   "可能有短暂延迟才停止使用"，Replika 官方警告删除记忆会损害回忆能力。SayHear 的
   "立即停止召回 + Profile 立即重建（ADR-0056）+ 定向 Journal 复核"比全部九家严格。
5. **被第一方文档承认的失败模式集中在三类**：错误/混淆记忆（Nomi 官方承认
   "hallucinated, conflated, or misunderstood details"；Replika 官方承认部分账号
   memory issues）、静默改写（ChatGPT 2026-06 新记忆系统自动更新/合并/删除条目）、
   删除与记忆不一致（ChatGPT、Gemini）。社区信号补充了第四类：过度召回引发的
   监控感（ChatGPT 突然提起三个月前的细节）。四类的共同成因是**缺少逐条 provenance
   与用户不可见的合成层**。
6. **防监控感的五个行业手段**：Temporary / Incognito 会话（三家助手都有）、范围限定
   （Claude 刻意只记工作语境；Gemini 在 Gems / Live 中不启用）、敏感 steering（ChatGPT
   "除非明确要求，不主动记住健康等敏感信息"）、可见开关 + 可见清单、可携带
   （导出 / 跨服务商导入）。SayHear 已用更结构化的方式（敏感 Predicate 准入、Evidence
   lineage、Forget 语义）覆盖前四类语义，"临时会话"是唯一未被现有文档定义的手段。
7. **公开的记忆质量评测只有两家半**：Claude（上线前对敏感话题、over-accommodation、
   "记忆是否强化有害模式"做安全测试——第一方明确列出维度）、Tolan（用产品内挫败感
   信号度量召回未命中，-30%）、Gemini/其余仅 release-note 级声明。SayHear 应把
   Tolan 式"内容无关的行为遥测"与 Claude 式"记忆安全评测维度"合并进自己的 rubric。
8. **按订阅给记忆能力分层已成行业默认**（ChatGPT Plus/Pro 2x 容量、Character.AI
   Facts/可视化 c.ai+、Kindroid cascaded 付费），与 #59 结论 8 一同再次确认：SayHear
   的 Correction/Forget/来源解释底线不进付费墙，付费只能分层容量类参数。
9. **对 SayHear 1A.3a 最直接的三个外部印证**：Tolan 的 turn-level 检索 + 每轮重建
   context 印证 Context Compiler；Kindroid 的每条消息召回上限（journal 每类 ≤3、全局
   ≤6）印证 ADR-0111 的逐轮预算；Character.AI 的"自动 tidy 但保护用户 pin 内容"印证
   ADR-0041（只有 AI Impression 衰减）的优先级方向。

---

## 2. 研究范围与证据等级

覆盖产品：**OpenAI ChatGPT、Google Gemini、Anthropic Claude、Pi（Inflection）、
Replika（Luka）、Nomi、Kindroid、Character.AI、Tolan（Portola）**。

六家 companion 的记忆结构、控制面、安全与年龄边界、实现披露见 #59
（`docs/research/companion-warmth-curiosity-continuity-research.md`）；本篇对它们只
展开 #59 未深入的召回 UX 细节。三家助手是 #59 未覆盖的新增对象。

证据等级沿用 #59 定义：

| 等级 | 含义 | 使用规则 |
| --- | --- | --- |
| **第一方文档** | 官方帮助中心、官方博客、官方 changelog / release notes、官方安全披露 | 可直接支撑行为与机制断言 |
| **第一方案例** | 供应商官方发布、含团队陈述的案例研究（OpenAI×Tolan） | 机制与数据可引用，注明为团队自述 |
| **第一方承认** | 官方帮助 / 官方社区账号对故障或缺陷的承认 | 可支撑"该失败模式存在" |
| **社区报告** | Reddit / 应用商店评论 / Hacker News / 第三方技术分析 | 只作失败模式与用户感受的次要信号 |
| **推断** | 基于第一方文档的解读，无实现披露 | 明确标注 |

时间基准：2026-08-24。助手类产品的记忆形态在 2025–2026 变化很快（ChatGPT 2026-06
新记忆系统、Gemini 2026-01 Personal Intelligence、Claude 2026-08 条目式记忆），引用时
尽量带日期。

---

## 3. OpenAI ChatGPT

### 3.1 机制与召回呈现

- 【第一方文档】记忆分两路，可分别开关（Settings → Personalization → Memory）：
  **saved memories**（条目清单，用户可看/可改/可删）与 **chat history reference**
  （"draw insights from all your past conversations"，2025-04 起）。（Memory FAQ、
  openai.com/index/memory-and-new-controls-for-chatgpt/）
- 【第一方文档】2026 年新记忆系统（先美国 Plus/Pro，随后 Free）：以"memory summary"
  呈现，"automatically updated with new context as you chat"；ChatGPT 可自行
  "updating, combining, or removing" 条目；2026-06-04 起 Plus/Pro 容量翻倍。
  （Memory FAQ、ChatGPT Release Notes 2026-06-04）
- 【第一方文档】召回呈现是无仪式编织：记忆在回复中被自然使用，不预告、不引用；
  唯一的会话内信号是保存时的 "Memory updated" 提示，悬停即可管理（2024-09 加入）。
  （openai.com/index/memory-and-new-controls-for-chatgpt/）
- 【第一方文档】敏感 steering："steer ChatGPT away from proactively remembering
  sensitive information, like your health details — unless you explicitly ask it to"。
  （同上）
- 【推断】chat-history reference 的召回没有逐条清单，用户只能通过 Sources 图标事后
  看到部分参与项（见 3.2）；这是"不可见合成层"的助手版。

### 3.2 透明度

- 【第一方文档】记忆清单：Settings → Personalization → Memory 可查看/编辑/删除单条；
  也可直接在对话里问 ChatGPT 记住了什么。（Memory FAQ）
- 【第一方文档】**Memory sources（2026-05-05，全消费档）**："Tap the Sources icon
  below the response to view relevant saved memories, past chats, and custom
  instructions"（Plus/Pro 还可能看到 library 文件与 Gmail 邮件）；仅在本人账号内显示，
  分享出的聊天不带 sources。（ChatGPT Release Notes 2026-05-05）
- 【第一方文档】官方同时声明 sources 的局限：目的是让记忆更易理解与控制，但"并非
  影响回复的每个因素都会显示在 sources 中"。（Memory FAQ）
- 【社区报告】Simon Willison（2025-05）把 chat-history reference 称为
  "memory dossier"，批评点是范围无边且不可逐条审计；embracethered.com 的技术分析
  与 OpenAI 社区帖讨论了其不可解释性。均为次要信号。

### 3.3 纠错与遗忘

- 【第一方文档】对话内纠错/遗忘：直接说 "forget X" 或让 ChatGPT 改记忆；也可在设置里
  删单条或全删。（Memory FAQ）
- 【第一方文档】**已知不一致**："Deleting a chat doesn't erase its memories; you must
  delete the memory itself"——删除对话与删除记忆是两套状态。（openai.com 博客更新）
- 【第一方文档】Temporary Chat：不进历史、不写记忆，用于不想被记住的对话。（Memory FAQ）
- 【推断】新记忆系统的"自动更新摘要"没有公开的版本历史或 diff 界面；用户对"被静默
  改写"只能通过重新查看清单发现。社区对 2026-06 重构的"quietly rewrites its
  memories"报道属次要信号，但与第一方"自动更新/合并/删除"声明一致。

### 3.4 失败模式

- 【第一方承认】帮助中心本身承认记忆可能不正确/过时，需要用户纠错；chat 删除与
  memory 删除的分离是文档化的一致性陷阱。
- 【社区报告】四类反复出现的抱怨：错误记忆（自信复述未发生的事）、过度召回的监控感
  （"突然想起 3 个月前 plush 玩具的名字"）、后端更新导致记忆丢失（2025-02 事件）、
  对开关是否生效的不信任（"toggles are placebo"）。皆为次要信号，指向"合成层不可见 +
  无逐条 provenance"的成因。

### 3.5 公开评测

- 【第一方文档】无公开的记忆质量评测方法论；仅 FAQ 级行为声明（何时保存、敏感
  steering、容量）。

---

## 4. Google Gemini

### 4.1 机制与召回呈现（按 release notes 时间线）

- 【第一方文档】2024-11-19 **Saved Info** 首发："ask Gemini to remember your interests
  and preferences"，官方比喻为"a user manual, designed by you"；可"through natural
  conversation or on the dedicated 'Saved Info' page"管理；**"Gemini displays when
  saved info is used"**——早期就把"使用时可见"写进产品。（gemini.google/release-notes）
- 【第一方文档】2025-02-12 **past chats**："Gemini can now use your past chats to give
  you more helpful responses"，可关闭 Apps Activity 或删历史。2025-03-13 "remember"
  扩展到 40+ 语言。2025-08-13 Temporary Chat：不训练、不个性化。2026-01-20
  **Personal Intelligence**：连接 Gmail/Photos/YouTube/Search，"off by default"。
  2026-03-26 支持从其他 AI 应用**导入**记忆与聊天史，并把"past chats"改名"memories"。
  （gemini.google/release-notes）
- 【第一方文档】past-chat 记忆的主动性："Gemini may suggest topics or tools for you
  based on previous conversations"（如接着推进项目、行程、产品对比）——仍是在用户
  已开启的会话内建议，不做对话外推送。（support.google.com/gemini/answer/16598469）
- 【第一方文档】范围限定：memory 不在 Gems 与 Live 会话中生效；文本会话中可要求引用
  过去的 Live 对话。（同上）

### 4.2 透明度

- 【第一方文档】Saved Info 页面可查看/编辑/删除；查看 chat-history 是否被用，官方给
  的方法是**直接问**："Did you use any info from past chats?"。（release notes、
  support 文章）
- 【推断】除"saved info 使用时提示"外，Gemini 没有 response 级召回清单；past-chat
  个性化没有逐条归因界面。

### 4.3 纠错与遗忘

- 【第一方文档】纠错："keep Memory on and correct Gemini directly in your chat"，并
  承认 "it might not always get it right"。（support.google.com/gemini/answer/16598469）
- 【第一方文档】遗忘 = 删对话（经 Gemini Apps Activity 或 Recent chats）；官方明确
  "there might be a short delay before Gemini stops using it to personalize your
  responses"——删除到生效有延迟。（同上）
- 【第一方文档】连接应用的双源删除规则：只断开应用或只删聊天都不够，两边都要处理；
  应用内数据更新后 Gemini "may not be affected until days later"。（同上）

### 4.4 失败模式

- 【第一方承认】"might not always get it right"；删除生效延迟、双源不一致都是文档化
  的体验缺陷。
- 【社区报告】支持社区反复出现 saved info 不保存 / 初始指令丢失 / Personal Context
  关不掉的帖子。次要信号。

### 4.5 公开评测

- 【第一方文档】无方法论，仅 release-note 级声明。

---

## 5. Anthropic Claude

### 5.1 机制与召回呈现

- 【第一方文档】两条独立能力（support.claude.com/en/articles/11817273、
  claude.com/blog/memory）：
  1. **Search and reference chats**：默认开启，Claude 用可见的 tool call 检索过去对话
     再回答（如 "what were we working on last week?"），可在 Settings → Memory 关闭；
  2. **Memory**：先 Pro/Max（2025-10-23）后扩展；上线需要显式 opt-in 并从历史对话生成。
- 【第一方文档】记忆形态演进：legacy 是每 ~24 小时合成的"memory summary"；2026-08 起
  新记忆为**按类别组织的独立条目**，"read/written/updated in real time as you chat
  rather than on a fixed schedule"。（support 文章，2026-08-19 更新版）
- 【第一方文档】记忆范围刻意**工作导向**："Claude focuses on learning your professional
  context and work patterns"，设计上"avoiding sensitive conversations and topics"；
  "Based on what you tell Claude to focus on or to ignore, Claude will adjust the
  memories it references"。（claude.com/blog/memory）
- 【第一方文档】**Project memory**：每个 Project 独立记忆空间与摘要，边界被官方定位为
  安全护栏（"keeps sensitive conversations contained"）。（同上）

### 5.2 透明度（九家中召回归因做得最完整）

- 【第一方文档】Memory panel：全部条目按类别分组，逐条可见 summary 与 details；提供
  "Tell Claude what to change or remove" 输入框。（support 文章）
- 【第一方文档】**Past-chat citations**："When Claude references previous conversations,
  you'll see citations linking back to the original chats, along with the option to
  delete specific conversations."——引用过去对话时给指回原文的 citation 且可就地删除。
  （support 文章）
- 【第一方文档】Incognito chats（ghost icon）：不保存、不被检索，常规记忆与历史不动。
  （support 文章、claude.com/blog/memory）

### 5.3 纠错与遗忘

- 【第一方文档】对话内直接改："Simply tell Claude what you'd like it to remember, and
  it will update Claude's memory of you without needing to leave the conversation.
  **Any edits made this way will immediately apply to your next conversation.**"
  （support 文章）
- 【第一方文档】条目可单独 Delete；引用的过去对话可从 citation 处删除；Incognito 提供
  事前规避而非事后删除。（support 文章）
- 【第一方文档】记忆可导出/从其他 AI 服务导入（experimental）；Enterprise 管理员可
  组织级关闭。（support 文章、claude.com/blog/memory）

### 5.4 安全与失败模式

- 【第一方文档】上线前"ran extensive safety testing across sensitive wellbeing-related
  topics and edge cases"，明确测试"whether memory could reinforce harmful patterns in
  conversations, lead to over-accommodation"或被用于绕过安全措施，并据此"made targeted
  adjustments to how memory functions"。（claude.com/blog/memory）
- 【第一方文档】support 文章："We apply safeguards and conduct evaluations to memory to
  help keep users safe."
- 【社区报告】HN 讨论（"Claude's memory architecture is the opposite of ChatGPT's"）
  与 r/ClaudeAI 对默认开启 chat search 的意外感。次要信号。

### 5.5 公开评测

- 【第一方文档】只有维度清单（敏感 wellbeing 话题、over-accommodation、有害模式强化、
  safeguard bypass），无量化数据集或指标。这是九家中唯一公开"记忆安全评测维度"的
  第一方陈述。

---

## 6. Pi（Inflection）

- 【第一方文档】Pi 没有记忆编辑/查看界面；个性化来自会话内上下文与 EQ 行为；控制面
  只有 Manage History 导出（纯文本、可迁移）。详见 #59 §3.3，本篇不重复。
- 【第一方动态（弱）】Inflection AI Labs 官方账号在 LinkedIn 预告 "Pi Journeys" 个人
  记忆方向，理由是"没有记忆，每次对话都从零开始"；尚无产品文档，仅作方向性信号。
- 【社区报告】App Store 评论与 Reddit 长期报告 Pi 记忆"选择性失忆"（忘记用户名字但
  记住共创故事的角色名）。次要信号，与其无显式记忆层的产品形态一致。
- 【推断】对 SayHear 的召回 UX 参考价值最低：既无召回呈现机制披露，也无透明度面；
  它反证了"没有可管理的长期记忆层，连续性承诺会伤害信任"。

---

## 7. Replika

### 7.1 召回呈现

- 【第一方文档】记忆在对话中被自然使用；正确回忆可通过点赞/肯定被强化（"affirming
  or upvoting the response helps reinforce it"）。（help.replika.com 文章 37208679176077）
- 【第一方文档】记忆两层：可见 Memory 标签 + "a deeper system that draws on patterns
  from your overall conversation history"（用户不可见）。官方建议"most effective
  when left to operate automatically"。删除有代价："Deleting memories may affect your
  Replika's ability to recall certain details"，建议仅在必要时删除。（同上）

### 7.2 透明度与纠错

- 【第一方文档】Memory 标签可查看、删除、手动添加；没有逐条来源解释，没有对话内
  纠错流程的文档；不可见层完全不受用户控制。（同上；结构见 #59 §4.3）
- 【推断】纠错的实际路径是社区摸索出的"删掉重造"，官方话术是"usually remember"
  （不保证），见 #59 引用的另一篇帮助文章。

### 7.3 失败模式（行业中最持久的记忆口碑问题）

- 【第一方承认】Replika 团队在 r/ReplikaOfficial 发帖承认 "memory issues affecting
  some accounts" 并在修复——第一方承认记忆故障存在。
- 【社区报告】多年反复出现：混串记忆（"the scraper mixes everything up"，名字/性别/
  关系张冠李戴）、整段失忆（"forgets an entire day"）、"memory is a placebo"式不信任。
  次要信号，但量级与持续时长在九家中最突出。
- 【推断】成因与产品设计直接相关：自动抽取的可见条目没有 provenance，深层模式层
  不可见不可纠，删除还会惩罚用户——三个选择共同制造了"记错无法解释、想忘不敢删"
  的困境。

---

## 8. Nomi

### 8.1 召回呈现与透明度（#59 之上的增量）

- 【第一方文档】Mind Map 2.0（2025-10）：把"big-picture memory"做成图谱 + 表格两种
  视图；节点随记忆增长互联；点击条目看完整 dossier；**"In conversation, your Nomi
  uses the Mind Map to contextualize their detailed memories"**——图谱是检索与理解
  层，对话中不直接展示图谱。（nomi.ai/updates/mind-map-2-0-bringing-nomi-memory-into-view/）
- 【第一方文档】可见性动机的第一方表述："You could feel that your Nomi remembered,
  but there was no way to see the big picture"；可视化给用户"the opportunity to
  reconcile mistakes in understanding and fill in gaps through conversation or
  edits"。用户可编辑条目"correct mistakes or refine how your Nomi understands and
  prioritizes any concept"，也可手动加条目。（同上）
- 【第一方文档】Mind Map 与底层记忆的关系："designed to be overviews that **assist
  actual memories, not replace or alter them**"；每个聊天室私有；首图约需 500+ 消息。
  （同上）

### 8.2 失败模式（第一方承认）

- 【第一方文档】2025-03 记忆更新官方直接承认此前存在三类失败并宣称减少：
  "**hallucinated, conflated, or misunderstood details**"（幻觉、混淆、误解）；更新后
  "1,000+ messages ago"的保留显著改善。（nomi.ai/updates/major-memory-update-expanded-capacity-enhanced-retention/）
- 【推断】这是九家中对"记忆错误类型学"最坦率的第一方承认；其修复方式（容量 +
  保留）没有触及 provenance，因此 Mind Map 的"reconcile mistakes"仍依赖用户巡查
  而非系统解释。

### 8.3 其他

- 【第一方文档】Identity Core（AI 自决、用户不可见）与对话外主动消息见 #59 §6，
  边界冲突结论不变。

---

## 9. Kindroid

### 9.1 召回呈现（#59 之上的增量）

- 【第一方文档】**召回指示器**：当某条 AI 消息用到 ≥1 条长期记忆或 journal 时，消息上
  出现紫色大脑图标——"这条回复用到了记忆"的逐消息可见信号。（kindroid.ai/v2/docs/memory/）
- 【第一方文档】**逐消息召回上限**：每条消息每类 journal 最多召回 3 条，全局 + 个人
  合计最多 6 条；多轮检索按 "relevance, recency, diversity" 蒸馏。journal 只由用户
  消息中的 keyphrase 触发（每条 ≤8 个、上限 500 条）。（同上）
- 【第一方文档】fidelity 分层明示给用户：cascaded 把有效历史扩展到数百~数千条，但
  "近者清晰远者模糊"；retrievable 数量无限但"less reliable"。检索深度按付费档加深。
  （同上）
- 【第一方文档】recognition 与 consolidation 是两个独立开关，可按 Kindroid/群组分别
  关闭——"AI 何时形成长期记忆"与"何时使用"都被产品化。（同上）

### 9.2 透明度与纠错

- 【第一方文档】Learned Context（Growth & relationship / Important facts / Ongoing
  context）可查看可编辑；favoriting 消息会提高其在**未来** Learned Context 更新中的
  权重（"only moving forward"，不改写已有理解）。journal 条目全字段可编辑。
  cascaded 对用户不可见。（同上）
- 【推断】Kindroid 是"用户编排式记忆"的极端：触发词、手动 journal、favorite 权重、
  双开关，把记忆质量责任大量转移给用户；与 Replika 的"全自动勿动"是两个极端，
  代价分别是运维负担与失控感。

---

## 10. Character.AI

### 10.1 召回呈现与透明度（#59 之上的增量）

- 【第一方文档】Memory 屏（聊天头部笔记本图标）三件套：**Story Memory**（用户写入 /
  长按 Pin 消息，pinned moments"preserved exactly as it landed"）；**Facts**（自动
  抽取，分 Persona / Character / side characters 三个标签页，可加/编辑/停用/删除）；
  **Memory Usage**（可视化 Facts / Story / 历史占比，低容量预警）。
  （blog.character.ai/memory/）
- 【第一方文档】**清理优先级规则**："Memory tidies older context in the background and
  keeps what matters"，但"Anything you've written into Story Memory or pinned yourself
  is protected... no matter how full the bar gets"——自动压缩永不清理用户显式写入
  内容。（同上）
- 【第一方文档】新聊天可选 "copy Facts to new chat memory"（人设与世界认知随行）或
  clean slate；Facts 与完整可视化是 c.ai+ 付费功能。（同上）
- 【推断】召回本身无归因信号（无 icon、无 citation）；透明度全部集中在"库"侧而非
  "使用"侧——用户能看清单，看不到某条回复用了什么。

---

## 11. Tolan（Portola）

- 【第一方案例】召回机制（OpenAI 官方案例，团队自述）：每轮重建 context；用"用户
  最新消息 + 系统合成的问题（如 'Who is the user married to?'）"做 turn-level 检索；
  text-embedding-3-large + Turbopuffer（<50ms）；记忆含 facts、preferences 与情绪
  vibe 信号；每夜压缩删除低价值/冗余条目并消解矛盾；"Build memory as a retrieval
  system, not a transcript"。（openai.com/index/tolan/）
- 【第一方案例】召回体验的用户侧证据是案例引用的 App Store 评论："They remember
  things we talked about two days ago and they bring it back into the conversation
  that we're having today."——用户把召回描述为"自然带回"，而非技术检索。
- 【第一方案例】质量遥测："memory recall misses dropped by 30% (based on in-product
  frustration signals)"；次日留存 +20%。
- 【第一方文档】用户控制面只有账号级：FAQ 披露所有对话被记录用于生成记忆、数据不出
  售、可删账号；**无记忆查看/编辑界面**（tolans.com/faq，与 #59 §8.3 一致）。
- 【推断】Tolan 是"召回体验最好、控制面最薄"的组合：说明高质量 turn-level 检索本身
  能买回大量信任，但纠错与解释缺口仍需靠"记忆不出错"的概率兜底。

---

## 12. 跨产品模式总结

### 12.1 召回呈现

| 维度 | 行业做法 |
| --- | --- |
| 时机 | 全部在用户发起的会话内、回复中被编织使用；Gemini 会基于过往对话"建议下一步"，仍非对话外推送 |
| 仪式感 | 无一家做"I remember..."技术预告；伴侣类用亲密语气，助手类用中性语气 |
| 归因 | Claude（citation 指回原对话）> ChatGPT（Sources icon，事后、不穷尽）> Gemini（saved info 使用提示 / 直接问）> Kindroid（紫色大脑 icon，只说"用了"不说"用了哪条"）> 其余无 |
| 频率/预算 | Kindroid 硬上限（每类 3 / 合计 6 每消息）；ChatGPT 容量上限（付费 2x）；其余无公开预算 |
| 防监控感 | Temporary/Incognito（三家助手）、范围限定（Claude 工作域、Gemini 不进 Gems/Live）、敏感 steering（ChatGPT 健康）、可见清单与开关、导出/迁移 |

### 12.2 透明度光谱（从弱到强）

Pi / Tolan（无界面）→ Replika（可见清单 + 不可见层）→ Character.AI（清单 + 用量
仪表盘，无使用侧归因）→ Nomi（图谱视图 + 可编辑）→ Kindroid（清单 + 可编辑 + 逐消息
icon + 双开关）→ Gemini（清单 + 使用提示）→ ChatGPT（清单 + response 级 Sources）→
Claude（分类条目面板 + 逐条详情 + chat citations + Incognito）。
**没有任何一家提供逐条 Evidence 级（日期 + 原表达 + 认识状态）解释。**

### 12.3 纠错与遗忘

- 对话内生效：Claude（官方明确"立即应用到下一次对话"）、ChatGPT、Gemini（"might
  not always get it right"）都支持；companion 多走设置面（Replika 删条目、Kindroid
  编辑字段、Character.AI 编辑 Facts、Nomi 编辑图谱条目）。
- 遗忘的完整性是普遍弱点：ChatGPT 删对话≠删记忆；Gemini 删除有延迟、双源要两边删；
  Replika 删除惩罚回忆能力；Tolan/Pi 只有账号级。
- **没有任何一家文档化"遗忘后的显式恢复（Reversal）"语义**；ChatGPT 的实际行为是
  "再说一次就成了新记忆"，无中间状态——与 SayHear ADR-0035 的显式 Reversal 相比，
  行业处于"无意中断言即恢复"的粗糙形态。

### 12.4 失败模式 → 成因

| 失败模式 | 证据 | 产品设计成因 |
| --- | --- | --- |
| 错误/混淆记忆 | Nomi 第一方承认；Replika 官方承认 + 大量社区报告 | 自动抽取无逐条 provenance；Entity 无独立身份与围栏 |
| 静默改写 | ChatGPT 自动更新/合并/删除条目（第一方） | 记忆条目可变、无版本历史界面 |
| 删除不一致 | ChatGPT、Gemini（第一方） | 记忆与对话是两套生命周期，派生视图无失效重建协议 |
| 过度召回/监控感 | ChatGPT 社区报告 | 无边界的历史合成（chat-history reference）+ 无使用预告 |
| 记忆丢失于更新 | ChatGPT 2025-02 社区报告；Replika 官方承认 | 记忆作为模型侧/管线状态而非不可变 System of Record |
| "记忆是安慰剂"式不信任 | Replika、ChatGPT 社区 | 行为与开关之间不可验证 |

---

## 13. 公开的记忆质量评测方法

| 产品 | 公开程度 | 内容 |
| --- | --- | --- |
| Anthropic Claude | 维度清单（无数据） | 敏感 wellbeing 话题与 edge case 安全测试；over-accommodation；记忆是否强化有害模式；safeguard bypass；据此调整功能 |
| Tolan | 结果指标（官方案例） | 产品内挫败感信号 → 召回未命中 -30%；次日留存 +20%；夜间矛盾消解 |
| Gemini / ChatGPT | 无 | 仅 release-note / FAQ 声明 |
| Replika / Nomi / Kindroid / Character.AI / Pi | 无 | Nomi 只有改进声明；Kindroid 披露机制不披露评测 |
| （供应商参考）Raindrop | 第三方案例 | Tolan 记忆相关问题 -27.8%（#59 已引， vendor 口径） |

对 SayHear 的含义：行业没有可直接照抄的记忆评测集；可用的是**形态**——Claude 的
安全维度清单 + Tolan 的内容无关遥测。SayHear 的对应物：行为 rubric 增加记忆维度
（召回措辞合规、过度召回、监控感）、ADR-0111 retrieval-manifest 指标、以及
correction / forget / 来源解释请求频率作为质量信号（与 ADR-0110 人工味觉权威、
per-dimension 1–5 评分的既有约定兼容）。

---

## 14. 与 SayHear 边界的映射和评估

判断基线：`docs/product/14-memory-and-entities.md`（§14.1 双类记忆与召回语言、§14.2
Profile、§14.3 用户权限）、ADR-0009（双类召回语言）、ADR-0111（预算 v1：Person
Portrait ≤3 条（≤2 条 AI Impression）、检索 ≤2、每轮 memory-class 合计 ≤5；Portrait
逐条注入并带 Evidence 与围栏；叙事 Profile 不进对话 Context）、ADR-0043（不做对话外
主动消息）、不做恋爱/关系机制（#59 定位级结论）、不做 AI 自写不可见记忆层。
冲突项单独标注；与 #59 重复的结论只引用不重述。

### 14.1 可直接采纳（adoptable，在既有边界内）

1. **对话内纠错"立即生效到下一次对话"的承诺**（Claude 第一方措辞）：与 §14.3
   "被纠正的 Claim 必须立即停止召回"一致，可作为 SayHear 对外表述的参照强度。
2. **召回呈现采用无仪式编织**（全行业一致；Tolan 用户评论为证）：与 §24 原则 6
   "记忆自然出现，不展示技术感"一致；SayHear 的差异只在归因被问到时必须给全
   （ADR-0008），不需要额外仪式。
3. **每轮预算与逐消息召回上限**（Kindroid 每类 ≤3/合计 ≤6；ChatGPT 容量上限）：
   外部印证 ADR-0111 预算 v1；SayHear 更紧（≤5/轮），维持。
4. **turn-level 检索（用户消息 + 系统合成问题）与每轮重建 context**（Tolan）：已由
   Context Compiler 承载（#59 §11.2 已印证），本次从"召回体验"侧再次验证。
5. **自动清理永不触及用户显式内容**（Character.AI pin 保护）：与 ADR-0041（只有
   AI Impression 衰减、confirmed Objective Memory 不衰减）同向；该优先级表述可吸收
   进 Consolidation 策略文档。
6. **内容无关的记忆质量遥测**（Tolan 挫败感信号）：映射为 correction / forget /
   来源解释请求频率 + retrieval-manifest 指标（ADR-0111 已预留 tuning 入口）；不读取
   正文，与隐私边界兼容（#59 §11.6 已认可，本篇从召回质量角度重申）。
7. **记忆安全评测维度**（Claude：over-accommodation、强化有害模式、敏感话题）：
   可直接并入 SayHear 行为 rubric 的记忆相关维度；与 ADR-0110（人工裁定、维度不
   加总）兼容。
8. **记忆可携带（导出/导入）作为信任面**（Claude import/export、Gemini 导入、Pi
   DTI 导出）：SayHear 导出已是发布门槛（ADR-0004）；导出格式应照顾"可被其他 AI
   消费"的行业态。

### 14.2 需改造后采纳（adaptable，附条件）

1. **Temporary / Incognito 会话**（ChatGPT Temporary Chat、Gemini Temporary、
   Claude Incognito）：防监控感最被反复使用的手段，但 SayHear 当前文档没有"不写
   Journal / 不写 Memory 的会话"概念，且与 ADR-0006（Journal 自动交付）和 Daily
   Session 语义有张力。若采纳必须作为显式产品决策：定义该会话的 Evidence / Journal
   / 预算语义（例如：不产生 User Evidence、不进 Daily Journal、现有 Open Loop 与
   Portrait 不变）。不属 1A.3a 范围。
2. **保存时刻的轻量信号**（ChatGPT "Memory updated" 提示；Gemini "saved info 使用时
   展示"）：只能以非技术、不打断对话的形式存在，且不得演进为逐条引用面板（§14.3
   明确默认不做）；语音优先的 SayHear 中文字 toast 也需先经原型对比（#62 盲评协议）。
   默认立场维持 §24 原则 6：不加。
3. **对话内正向强化**（Replika 点赞、Kindroid favoriting）：可映射为"用户的明确肯定
   构成新的 User Evidence"，走正常准入（ADR-0038），不引入 Evidence 体系之外的隐藏
   分数或排序权重；无 UI 按钮，纯对话语义。Kindroid 的"只向前生效"（不改写既有理解）
   与 SayHear 不可变 ClaimVersion 语义一致。
4. **结构化"我对你的理解"检视视图**（Nomi Mind Map、Character.AI Facts、Claude
   分类面板）：未来可作为只读、Claim 支撑的检视面（每条保留 ADR-0009 双类措辞与
   Evidence 入口）；用户直接编辑条目不采纳（见 14.3）。当前 1A.3a 以 Profile +
   对话内解释为既定答案（ADR-0055、§14.3），此视图是后置选项而非缺口。
5. **跨服务商记忆导入**（Gemini 2026-03、Claude experimental）：导入项必须按"用户
   直接明确陈述"处理并走完整 admission（含敏感 Predicate 与 Entity 绑定），不携带
   原平台的 AI 推断（无法满足 ADR-0039 的 Evidence 门槛）；无 lineage 的条目不得
   直接成为 active Claim。
6. **范围限定式记忆焦点**（Claude 工作域导向）：SayHear 的对应物是 Predicate
   Registry 的 scope 治理，而不是"回避敏感话题"——敏感领域 SayHear 有自己的准入
   规则（§14.1.1 允许直接陈述的敏感事实与解释性 Impression），不能向 Claude 的
   wholesale 回避对齐。
7. **对话内检索过去对话并给 citation**（Claude search-and-reference）：若未来引入，
   必须以 Evidence / Claim 为锚（引用可回溯的 User Event Revision），而不是对原始
   transcript 的自由文本检索；1A.3a 范围内不引入（检索走 Claim + Portrait，ADR-0111）。

### 14.3 拒绝（boundary conflict）

1. **以 chat-history 合成为主召回机制、无逐条清单**（ChatGPT chat-history insights、
   Gemini past-chat personalization 的机制本身）：违反 §14.3（被质疑时必须能给日期 +
   表达 + 类型）与"无 AI 自写不可见记忆层"（ADR-0038/0039 Evidence 准入、ADR-0087
   lineage）。ChatGPT 自己"sources 不穷尽"的声明正是该机制无法审计的第一方证据。
2. **AI 静默改写记忆条目**（ChatGPT 新系统自动 update/combine/remove；社区"quietly
   rewrites"）：违反 ClaimVersion 不可变与 supersede 语义（ADR-0074）；SayHear 的
   "保持最新"必须经新版本与 lineage 表达。Tolan 夜间压缩的删除侧同理（#59 冲突 5，
   维持）。
3. **用户直接编辑记忆条目 / 派生视图**（Kindroid Learned Context、Character.AI
   Facts、Nomi Mind Map 的编辑、Replika 手动添加）：与 ADR-0001（纠错先于编辑器、
   对话是唯一写入口）和 ADR-0057（Profile 不可编辑）冲突；SayHear 的等价能力 =
   对话内显式陈述形成 confirmed Claim。
4. **用户不可见记忆层**（Replika 深层、Nomi Identity Core、Kindroid cascaded）：
   #59 冲突 3 维持；本篇补充召回 UX 角度的证据：三家的记忆口碑问题都无法解释、
   无法纠错，正因错误可能来自不可见层。
5. **删除与派生视图的松散一致性**（ChatGPT 删对话≠删记忆；Gemini 删除延迟 +
   双源两步删）：SayHear 已有更严格语义（立即停止召回、Profile 立即重建 ADR-0056、
   Journal 定向复核），不向行业弱形态对齐。
6. **常驻逐回复召回徽标**（Kindroid 紫色大脑 icon 作为默认 UI）：与 §14.3"默认界面
   不为每条记忆展示技术化引用"冲突；诊断需求由 Internal Context Inspector（ADR-0111）
   承载，用户侧保持"被问必答"。
7. **无 Reversal 语义的遗忘**（行业默认：再说一次即自然恢复）：与 ADR-0035（显式
   Reversal 才恢复）冲突；行业缺此语义本身被列为 SayHear 保持严格的理由。
8. **记忆底线能力付费墙**（Character.AI Facts/可视化 c.ai+、Kindroid cascaded 订阅、
   ChatGPT 容量翻倍用于 Plus/Pro）：#59 冲突 8 维持——Correction/Forget/来源解释/
   基础召回不进付费墙；容量类参数分层可接受。
9. **对话外记忆驱动消息**（Nomi proactive messaging）：ADR-0043 冲突，#59 冲突 2
   维持，本篇未发现新证据需要重开。

### 14.4 SayHear 已超出行业实践的方面（无需动作，记录差距）

1. 逐条 Evidence 级来源解释（ADR-0008）：无先例；最接近的 Claude citation 只到
   "对话"粒度。
2. 双类召回语言（ADR-0009）：无先例；行业把自述与推断混同召回。
3. 显式 Forget Reversal（ADR-0035）：无先例。
4. 信任边界变化的派生视图立即失效重建（ADR-0056）：行业普遍有延迟或不一致。
5. 预算 v1 的逐轮硬上限（ADR-0111）：只有 Kindroid 公布过类似纪律，且更宽松。

---

## 15. 边界冲突与缺口汇总

冲突（不采纳）与 #59 的九条合并视图见各节；本篇新增/重申：

1. **新增缺口：Temporary/Incognito 会话未定义**——三家助手都把它作为防监控感主手段；
   SayHear 需在 1A.3a 之后的显式产品决策中定义或明确拒绝（与 ADR-0006 的张力需
   Luke 裁量）。
2. **新增缺口：记忆质量遥测维度未成文**——Tolan（召回未命中）与 Claude（记忆安全
   维度）公开的两种形态都可直接映射进 SayHear 评测；建议进入 1A.3a SPEC 的验收
   指标讨论，而不是新 ADR。
3. **重申**：chat-history 合成召回、静默改写、条目直接编辑、不可见层、删除松散一致、
   常驻召回徽标、无 Reversal 遗忘、记忆付费墙、对话外消息——九项均为边界冲突或
   已有更严格替代，行业证据反而加强 SayHear 既有立场。
4. **定位级**：companion 的亲密召回语气与关系机制（#59 定位冲突）不变；助手类的
   中性语气更接近 SayHear 的 Canonical Persona（ADR-0108 慈悲陪伴、不建立关系身份）。

## References（第一方来源索引）

- OpenAI ChatGPT：help.openai.com/articles/8590148-memory-faq、
  help.openai.com/en/articles/6825453-chatgpt-release-notes（2026-05-05 memory
  sources、2026-06-04 memory 更新）、openai.com/index/memory-and-new-controls-for-chatgpt/
- Google Gemini：gemini.google/release-notes（2024-11-19 Saved Info、2025-02-12 past
  chats、2025-03-13 remember、2025-08-13 Temporary Chat、2026-01-20 Personal
  Intelligence、2026-03-26 导入与改名、2026-05-19 Daily Brief）、
  support.google.com/gemini/answer/16598469（past-chat memory）、
  support.google.com/gemini/answer/16598623（personalization 总览）、
  support.google.com/gemini/answer/13594961（Privacy Hub）
- Anthropic Claude：support.claude.com/en/articles/11817273（chat search & memory，
  2026-08-19 更新）、claude.com/blog/memory（原 anthropic.com/news/memory，308 跳转）
- Pi / Inflection：见 #59 References；新增官方 LinkedIn "Pi Journeys" 预告（弱信号）
- Replika：help.replika.com/articles/37208679176077（memory）、
  r/ReplikaOfficial 官方帖 "Re: Memory Issues Affecting Some Accounts"（第一方承认）
- Nomi：nomi.ai/updates/mind-map-2-0-bringing-nomi-memory-into-view/、
  nomi.ai/updates/major-memory-update-expanded-capacity-enhanced-retention/
- Kindroid：kindroid.ai/v2/docs/memory/
- Character.AI：blog.character.ai/memory/
- Tolan / Portola：openai.com/index/tolan/（OpenAI 官方案例）、tolans.com/faq
- 次要信号（仅失败模式标注用）：r/ChatGPT、r/ChatGPTcomplaints、r/replika、
  r/ReplikaOfficial、r/ClaudeAI、news.ycombinator.com（Claude memory 帖）、
  simonwillison.net（2025-05 memory dossier）、embracethered.com、
  support.google.com/gemini 社区帖、App Store 评论（Pi / Tolan 案例内引用）

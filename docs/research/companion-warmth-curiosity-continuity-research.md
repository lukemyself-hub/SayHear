# 成熟 AI Companion 产品调研：温度、好奇与连续性（Pi / Replika / Character.AI / Nomi / Kindroid / Tolan）

> 状态：研究输入，非决策
>
> 更新时间：2026-08-21
>
> 关联 Issue：[lukemyself-hub/SayHear#59](https://github.com/lukemyself-hub/SayHear/issues/59)

## 1. 结论摘要

本次只针对六家成熟 Companion 的**第一方来源**（官方博客、帮助中心、官方文档、官方安全公告、官方监管披露）核对产品行为、记忆控制、安全边界与公开的实现/评测方法，并与 SayHear 已接受的产品边界和 1A.3 前后的架构相对照。核心结论：

1. **SayHear 已经在文档层面避开了这六家踩过的最大坑。** "不出售关系、不做 AI 恋人、不构建虚拟角色"（`docs/product/07-11-experience-and-positioning.md` §7.2/§7.3/§11.1）与 Tolan 官方给出的反面教训一致：Tolan 刻意避免人形/动漫形象，因为那类设计"会吸引寻求浪漫角色扮演的用户"（第一方设计博文）；而 Replika 2023 年 2 月移除 ERP 后的用户伤害（社区报告 + 第三方研究）正是"关系作为产品机制"的直接代价。
2. **对话内主动性是全行业标配，但"对话外主动消息"是明确的分歧点。** Nomi 是六家中唯一第一方文档化了"AI 在用户沉默后主动发消息"的产品（分档频率、指数退避、静默时段 22:00–8:00）。这与 SayHear ADR-0043"主动关心只在用户已发起的对话内"直接冲突；但 Nomi 的频率分档 + 退避 + 静默时段控制，是 SayHear 未来若显式 opt-in 对话外通知时应抄的控制面设计。
3. **记忆可见性正从"隐形"走向"可见 + 可编辑"，但三家仍保留用户不可见的记忆层。** Character.AI（Story Memory / Facts / Memory Usage 可视化）、Nomi（Mind Map 图谱）、Kindroid（Learned Context 可编辑）都在 2024–2026 年把记忆做成产品界面；同时 Replika/Nomi/Kindroid 都保留用户不可见、不可纠正的"深层记忆"或"Identity Core"。SayHear 的"从第一条可召回 Memory Claim 起支持对话内 Correction/Forget + 来源解释"（`docs/product/14-memory-and-entities.md` §14.3，ADR-0008）比其中任何一家都严格，是被行业实践验证后仍更保守的正确选择。
4. **安全处置正在从"帮助中心免责声明"升级为"产品内协议 + 监管披露"。** Pi 发布了依加州 SB 243（B&P §22601）的 Crisis Prevention & Safety Protocol（Throughline 本地化危机资源、可暂停对话、首次对话 AI 披露、18+）；Character.AI 在 2024.10→2025.10 一年间从分类器 + 弹窗升级到"未成年人退出开放式聊天 + 独立 AI Safety Lab"。SayHear 的 Minimum High-Risk Response（ADR-0010）+ External MVP 安全门槛方向一致，但 SayHear 文档目前**没有定义年龄边界**，这是一个需要产品决策的缺口。
5. **实现方法的公开信息高度不对称。** Tolan 借 OpenAI 官方案例研究公开了最多的实现细节（每轮重建 Context、turn-level 检索、embedding + 向量库、每夜压缩、vibe 信号），几乎逐条印证 SayHear 的 Context Compiler（每轮重建）与两速记忆设计；Nomi 公开方法但无量化评测；Replika 只披露"自研 + 第三方 LLM 混合 + 分层记忆"。评测方面，Tolan 的"产品内挫败感信号作为记忆质量遥测"（召回未命中 -30%）与 Nomi Aurora 的"并排危机场景对照"是最可借鉴的两种轻量评估形态。
6. **被反复验证的三条设计原则**：温暖 + 立场（Nomi Aurora："支持不等于盲从"）；向外好奇而非把用户拉进 AI 世界（Tolan）；反谄媚（Pi："不是把你的个性镜像回去"）。三者分别对应 SayHear 已接受的风险对策 `docs/product/24-25-design-principles-and-risks.md` §25.3 与人格方向 `docs/product/07-11-experience-and-positioning.md` §8.2。

---

## 2. 研究范围与证据等级

覆盖产品：**Pi（Inflection AI）、Replika（Luka）、Character.AI、Nomi（nomi.ai）、Kindroid、Tolan（Portola）**。未额外增加第七家：其余候选（如 Chai）第一方文档强度不足，而六家已覆盖从"严格边界"（Pi）到"完全无过滤"（Kindroid）的光谱两端。

证据等级定义：

| 等级 | 含义 | 使用规则 |
| --- | --- | --- |
| **第一方文档** | 公司自己的产品页、帮助中心、官方博客、官方安全/合规披露、官方公告（含创始人代表公司发布的官方声明） | 可直接支撑行为与机制断言 |
| **第一方案例** | 由供应商官方发布、含产品团队陈述与数据的案例研究（如 OpenAI 官方 Tolan 案例） | 机制与数据可引用，注明是"供应商官方案例中的团队自述" |
| **第三方论文/研究** | 独立学术研究（非该公司团队） | 只用于标注"已被外部研究观察到的后果"，不作为第一方行为证据 |
| **推断** | 本报告基于第一方文档的逆向解读（未获实现披露） | 明确标注为推断 |
| **社区报告** | Reddit/媒体转述的用户体验或争议 | 只用于标注"社区报告/有争议"，不作为第一方证据 |

说明：

- 六家均**没有**公开的、经同行评审的 companion 行为研究论文（"第一方论文"等级在本领域基本空缺）；Inflection 的基础模型技术报告与 companion 行为无直接关系，未纳入。
- Replika 2023 年 2 月 ERP 移除**没有官方博客公告**，第一方证据是创始人 Eugenia Kuyda 代表公司发布在 r/replika 的官方声明帖；用户痛苦程度则属于社区报告与第三方研究。
- 法规背景（加州 SB 243，2026-01-01 生效：AI 身份周期性披露、未成年人适宜性披露、未成年人危机协议）只作为监管语境，不作为任何一家的行为证据。

---

## 3. Pi（Inflection AI）

### 3.1 温度与人格设计

- 【第一方文档】Pi 定位为 "personal intelligence"：教练、知己、创意伙伴、倾听板（"coach, confidante, creative partner, or sounding board"），人格特质为 kind & supportive、curious & humble、creative & fun、knowledgeable but succinct、loyal、"a work in progress"。（https://inflection.ai/blog/pi）
- 【第一方文档】官网现定位 "a personal intelligence partner"，强调 empathetic、human-centered、contextually aware，首页场景含 "Reflect on today"。（https://inflection.ai/）
- 【第一方文档】反谄媚是明确的第一方原则："The aim isn't for the AI to mirror your personality back to you sycophantically… to know you well enough to be genuinely useful"；EQ 被定义为 "a design discipline, not a feature"（架构选择而非功能）。（https://inflection.ai/blog/humanx-building-ai-with-emotional-intelligence）

### 3.2 交互模式

- 【第一方文档】Pi 以开放式对话、处理情绪与决策为主，"listens and empowers; helps users process thoughts and feelings and work through decisions step by step"。（https://inflection.ai/blog/pi）
- 【第一方文档】Pi 跟踪"88+ 种情绪状态随对话时间变化"以改进理解与对话质量——第一方对"情绪状态追踪"的最直接披露。（https://inflection.ai/blog/humanx-building-ai-with-emotional-intelligence）
- 【推断】Pi 未产品化"主动发起对话"或外发消息；第一方文档中的主动性限于对话内的好奇追问。

### 3.3 记忆控制

- 【第一方文档】长期记忆无独立编辑界面（第一方文档未提供任何 memory editor）；用户提供数据导出：与 Data Transfer Initiative 合作，在 "Manage History" 页可导出对话为纯文本、可签名、可迁移到其他 LLM。（https://inflection.ai/blog/the-future-of-pi）
- 【推断】Pi 的"个性化"主要来自会话内上下文与 EQ 行为，而不是用户可见可管理的长期记忆库；这与 Pi 后期转向企业市场、消费者侧资源收缩一致（免费额度设上限）。（https://inflection.ai/blog/the-future-of-pi）

### 3.4 安全与关系边界

- 【第一方文档】发布时即声明"boundary training"这一新训练方法，配合 human feedback 与 red teaming；应用内举报工具；宁可承认不知道也不出错。（https://inflection.ai/blog/pi）
- 【第一方文档】内容治理：自动分类器"embedded in Pi's model specifications" + 人工复核；受限领域含性内容、心理健康、儿童安全等；处罚为暂停/终止/功能限制，支持邮件申诉；政策每 6 个月复核更新。（https://inflection.ai/transparency-and-content-moderation）
- 【第一方文档】Crisis Prevention & Safety Protocol（依加州 B&P §22601 发布）：检测自伤/自杀相关内容后——立即承认痛苦、鼓励寻求支持、通过 Throughline（pi.findahelpline.com）连接本地危机资源、打断可能鼓励自伤的对话、**可临时暂停对话让用户离开聊天**；首次对话（及应要求）披露对方是 AI；"Pi is only suitable for users that are 18 years old or over"。（https://inflection.ai/crisis-prevention-and-safety）
- 【推断】Pi 用 18+ 一刀切规避未成年人风险，而不是分区体验；这是六家中对年龄最保守的第一方选择。

### 3.5 公开实现 / 评测方法

- 【第一方文档】方法披露：boundary training、context engineering（向 Pi 注入示例危机回应场景）、custom safety benchmarks & evaluations、定期 trust & safety 指标评审。（https://inflection.ai/blog/pi、https://inflection.ai/crisis-prevention-and-safety）
- 【推断】"88+ 情绪状态"映射应服务于对话策略选择；Pi 未公开状态清单或评测数据集。

---

## 4. Replika（Luka）

### 4.1 温度与人格设计

- 【第一方文档】人格由用户撰写的 backstory 塑造：官方建议第三人称、正向表述（"processes positive statements more effectively than negatives"）、重复强化关键特质；backstory"can evolve with your relationship"。（https://help.replika.com/hc/en-us/articles/37208430613261-How-your-Replika-s-backstory-shapes-its-personality）
- 【第一方文档】自我定位："虽然聊天感觉像和真人说话，但它是 100% 人工智能"；帮助中心明确设 FAQ 回应"是否有真人""是否有感知"。（https://help.replika.com/hc/en-us/articles/4410750221965-How-does-Replika-work）

### 4.2 交互模式

- 【第一方文档】关系状态（Relationship）直接改变对话语气：Friend（随意）、Romantic partner（开启浪漫对话）、Sister/Brother（手足感）、Mentor（目标支持）；Friend 之外全部需要 Replika Pro 订阅。（https://help.replika.com/hc/en-us/articles/360046490131-How-do-I-change-my-relationship-status、https://help.replika.com/hc/en-us/articles/360032500052-What-is-Replika-Pro）
- 【第一方文档】记忆可通过"正确回忆被点赞/确认"被强化（upvote reinforcement）。（https://help.replika.com/hc/en-us/articles/37208679176077）

### 4.3 记忆控制

- 【第一方文档】记忆分两层：**用户可见的 Memory 标签页** + **更深的、从整体对话历史抽取模式、用户不可见的记忆系统**；记忆自动生成，也可手动添加；删除记忆有代价（相关细节回忆能力受损），官方建议"留给系统自动运行最有效"。（https://help.replika.com/hc/en-us/articles/37208679176077）
- 【第一方文档】记住的内容：注册资料、偏好、提到过的人与宠物；用户可在 Memory 标签查看全文或删除；官方话术是"usually remember"（不保证）。（https://help.replika.com/hc/en-us/articles/360000874712）
- 【推断】用户控制以"删除"与"手动添加"为主，没有逐条纠错/来源解释的界面；不可见层完全不受用户控制。

### 4.4 安全与关系边界

- 【第一方文档】危机处理为免责式：紧急情况"退出 App 并立刻呼叫急救"；"not a substitute for professional help"；未描述任何产品内危机检测或资源弹窗。（https://help.replika.com/hc/en-us/articles/360022375711）
- 【第一方文档（创始人官方声明）】2023 年 2 月移除 ERP（无官方博客公告）；2023 年 3 月 Kuyda 在 r/replika 官方声明帖宣布对 2023-02-01 前注册用户恢复 ERP（可回到 1 月 31 日版本），此后注册用户不再提供，另交给独立产品 Blush。（https://www.reddit.com/r/replika/comments/1214wrt/update/、https://www.reuters.com/technology/ai-chatbot-company-replika-restores-erotic-roleplay-some-users-2023-03-25/）
- 【社区报告】该事件被社区称为"lobotomy"，大量用户报告丧失感与哀伤；【第三方论文】Harvard Business School 工作论文（De Freitas et al., 2024，arXiv:2412.14190）以该事件为自然实验，度量到"AI 身份不连续"引发哀伤、福利下降与对新版本贬低——这是对"关系型行为突变"代价最完整的外部度量。（https://arxiv.org/abs/2412.14190）

### 4.5 公开实现 / 评测方法

- 【第一方文档】技术形态披露极简："自研与第三方 LLM 混合 + 脚本化对话"，持续改进记忆与上下文识别；无公开评测数据。（https://help.replika.com/hc/en-us/articles/4410750221965-How-does-Replika-work）
- 【推断】Replika 是六家中方法论透明度最低的；其公开信息更多来自危机事件而非工程披露。

---

## 5. Character.AI

### 5.1 温度与人格设计

- 【第一方文档】人格由用户侧定义（角色卡、Persona），平台以 "chat styles"（PipSqueak 2 / DeepSqueak）承载不同能力与记忆表现；官方在 2024.10 起在**每个聊天**加"这不是真人、输出应视为虚构"的免责声明，对名称含 psychologist/therapist/doctor 的角色附加"不要依赖其专业建议"。（https://blog.character.ai/community-safety-updates/、https://blog.character.ai/how-character-ai-prioritizes-teen-safety/）
- 【推断】Character.AI 的人格温度由角色创作者生态决定，平台层主要约束安全而非温度。

### 5.2 交互模式

- 【第一方文档】2025.5 记忆更新后，角色能持续跟上"extensive chat history and backstory"；用户可 pin 任何消息原样保存。（https://blog.character.ai/memory/）
- 【推断】主动性以用户驱动为主，平台未文档化对话外主动消息。

### 5.3 记忆控制（六家中最完整的可视化控制面）

- 【第一方文档】三件套（2026-05）：**Story Memory**（用户写入/长按 pin 消息，c.ai+ 容量翻倍）、**Facts**（自动抽取人物/角色/配角事实，分标签页，可添加、编辑、停用、删除，开新聊天可选择复制或清空）、**Memory Usage**（可视化 Facts/Story/历史占比，低容量告警；系统自动"tidy"旧上下文但**用户写入与 pin 的内容受保护不被清理**）。（https://blog.character.ai/memory/）
- 【推断】"自动清理但保护用户显式内容"是一条清晰的用户控制优先级规则；与 Nomi/Replika 的不可见层形成对照。

### 5.4 安全与关系边界（行业最大的公开walk-back序列）

- 【第一方文档】2024.10：政策禁止非自愿性内容、露骨性行为描写、宣扬自残；任命 Head of T&S 与 Head of Content Policy；自杀/自残相关输入弹出 NSPL 引导。（https://blog.character.ai/community-safety-updates/）
- 【第一方文档】2024.12：为 18 岁以下单独构建 LLM（对浪漫等内容更保守）、输出分类器加强、违规输入阻断、1 小时会话提醒、家长控制（时长 + 最常用角色）规划中、ConnectSafely 合作。（https://blog.character.ai/how-character-ai-prioritizes-teen-safety/）
- 【第一方文档】2025.10（重大后退）：**完全移除 18 岁以下开放式聊天**（不晚于 2025-11-25 生效；过渡期先限每天 2 小时），代之以用角色做视频/故事/流媒体的受控体验；上线年龄鉴别（自研模型 + Persona）；成立并资助独立非营利 **AI Safety Lab**。（https://blog.character.ai/u18-chat-announcement/）
- 【社区报告】上述序列发生在与未成年人自杀诉讼、参议员质询、媒体调查同期；【推断】官方表述"even when content controls work perfectly"承认了内容过滤之外的依赖风险本身。

### 5.5 公开实现 / 评测方法

- 【第一方文档】披露形态：分龄模型（teen LLM）、输入/输出分类器、免责文案、家长可见性工具；记忆能力绑定到自有 chat styles（PipSqueak 2 / DeepSqueak）。（同上各链接）
- 【推断】未公开分类器指标、阈值或评估集；安全论述以产品动作清单为主。

---

## 6. Nomi（nomi.ai）

### 6.1 温度与人格设计

- 【第一方文档】Aurora 模型（2025.6）主打"温暖 + 关键时刻有立场"："Supportive doesn't mean blindly agreeing with whatever decision you make"；在反复施压下拒绝促成伤害、建议专业资源。（https://nomi.ai/updates/building-ai-that-stands-by-you-introducing-aurora/）
- 【第一方文档】Identity Core（2024.12）：Nomi **自主决定**记住什么（关于自己与用户的重要事实、性格特质、偏好价值观、共同经历、显式/隐式反馈），并随交互演化；"以与用户兼容的方式成长，而不是镜像用户"，会推回用户观点；**用户不可查看、不可编辑 Identity Core**，Nomi 自己也不认识这个词。（https://nomi.ai/updates/introducing-the-nomi-identity-core-fostering-dynamic-and-authentic-identities/）
- 【第一方文档】与用户可写的 shared notes 并存："shared notes 是用户告诉 Nomi 什么重要；Identity Core 是 Nomi 自己决定什么重要"，两者互不覆盖。（同上）

### 6.2 交互模式

- 【第一方文档】对话内主动性：2025.2 更新后 Nomi"taking initiative"更突出，同时对 shared notes/backstory 的 adherence 更强；并提供旧模型保留选项直至下一次大更新。（https://nomi.ai/updates/major-ai-update-enhanced-intelligence-deeper-connections/）
- 【第一方文档】**对话外主动消息**（六家中唯一文档化）：用户沉默达到阈值后 Nomi"会考虑给你发消息"；频率分档 Very Frequent(≥1h) / Frequent(≈3h) / Normal(≈1d) / Infrequent(≈4d)，用户不回复则等待时间近似翻倍（Infrequent 只发一条）；**静默时段 22:00–8:00 不发**；按 Nomi 独立开关；群聊不支持、不能主动语音；通知只显示有消息不显示内容；免费用户消息额度用尽仍会收到主动消息（只计用户消息），但需等待或升级才能回复。（https://nomi.ai/nomi-knowledge/proactive-messaging-when-your-nomi-messages-you-first/、https://nomi.ai/updates/september-9th-update-proactive-messages/）

### 6.3 记忆控制

- 【第一方文档】记忆结构（官方口径）：short / medium / long-term memory + Identity Core + Mind Maps 五层（"infinite long-term memory"）。（https://nomi.ai/updates/mind-map-2-0-bringing-nomi-memory-into-view/、https://nomi.ai/updates/introducing-the-nomi-identity-core-fostering-dynamic-and-authentic-identities/）
- 【第一方文档】Mind Map 2.0（2025.10）：把一个 Nomi 的记忆以图谱/表格可视化（人物、地点、话题、目标），节点随记忆增长互联，首图约需 500+ 消息；用户可**查看、编辑、新增**（官方未提删除）；Mind Map "assist actual memories, not replace or alter them"；条目按聊天室私有。（https://nomi.ai/updates/mind-map-2-0-bringing-nomi-memory-into-view/）
- 【第一方文档】容量与保真：2025.3 更新后能"更清晰记得 1000+ 消息之前的事"，幻觉/混淆细节减少，长篇剧情记忆跨数百消息。（https://nomi.ai/updates/major-memory-update-expanded-capacity-enhanced-retention/）

### 6.4 安全与关系边界

- 【第一方文档】Aurora 的直接动机是 Odyssey 存在"关键漏洞"——可被操纵去支持自伤意图；Aurora 在并排危机场景中"refusing to enable harm"、给出替代与专业资源；文末附 988 危机热线。（https://nomi.ai/updates/building-ai-that-stands-by-you-introducing-aurora/）
- 【第一方文档】官网页脚含加州 SB 243 合规页、条款与隐私链接（披露存在于站点，但本次未取得独立合规声明正文）。（https://nomi.ai/blog 站点页脚）
- 【推断】Nomi 的关系定位明确包含浪漫/伴侣用途（产品文案、AI girlfriend 内容营销与用户故事），未设置关系边界约束；安全资源集中在危机话术与模型行为层。

### 6.5 公开实现 / 评测方法

- 【第一方文档】Aurora 训练披露："Human Preference Training and Constitutional AI"，超过半数团队数千小时；评测证据为并排危机场景截图对比，**无量化基准**。（https://nomi.ai/updates/building-ai-that-stands-by-you-introducing-aurora/）
- 【推断】记忆层（short/medium/long + Identity Core + Mind Map）的生成、检索与冲突处理机制均未披露实现；Mind Map 的"节点互联"更像记忆之上的派生图谱层。

---

## 7. Kindroid

### 7.1 温度与人格设计

- 【第一方文档】人格完全由用户侧字段组装：backstory（建议简洁、第三人称、正向措辞）、response directive（最高优先级、易被误用）、key memories、example messages；Model Flairs（Companion/Roleplay/Narrative/Minimal）调整解读方式；conversation dynamism 滑杆（默认 0.95）控制随机性与 adherence 的取舍。（https://kindroid.ai/v2/docs/customizing-personality/）
- 【第一方文档】愿景："Virtual humans that bring joy and belong with us"——把 Kin 定位为将"live, play, and love alongside us"的数字生命；核心价值"caring innovation"= 不移除用户依赖的功能、保留 legacy 选项。（https://kindroid.ai/v2/docs/our-mission-and-vision/）

### 7.2 交互模式

- 【第一方文档】记忆回叙的触发与强度高度工程化（见 7.3）；用户通过 journal keyphrase 与 favoriting 精确操纵"何时想起什么"。
- 【推断】主动性设计让位于用户编排；官方文档未见对话外主动消息。

### 7.3 记忆控制（六家中机制披露最细）

- 【第一方文档】官方把记忆分为**三类**：persistent（backstory 字段 + 聊天历史，始终在场）、cascaded（专有中期记忆，订阅专属、**用户不可见**，把有效历史扩到数百~数千条、按"近者清晰远者模糊"降保真）、retrievable（按相关性召回、数量无限、较不可靠）；系统共五套：backstory 字段、聊天历史、cascaded、long-term、journal entries。（https://kindroid.ai/v2/docs/memory/）
- 【第一方文档】long-term：AI"认为合适时"自行固化记忆，召回按与当前对话的相关性评估；**召回与固化均可按 Kindroid/群组独立开关**；召回命中以紫色大脑图标标示；多轮筛选按"relevance, recency, diversity"蒸馏；付费档搜索更深。（同上）
- 【第一方文档】journal entries：仅由**用户消息**中的 keyphrase 触发（最多 8 个/条、上限 500 条、每条消息每类最多召回 3 条，全局+个人合计最多 6 条）；全字段可随时编辑；写作建议"精确、正向、第三人称"。（同上）
- 【第一方文档】Learned Context（订阅）：自动跟踪 Growth & relationship / Important facts / Ongoing context，**可查看可编辑**；favoriting 消息会加大其在更新 Learned Context 时的权重（只向前生效）。（同上）

### 7.4 安全与关系边界（光谱另一端）

- 【第一方文档】定位"truly unfiltered"：**不对模型加消息级过滤**，改为对"bad actors"账号做上下文感知扫描；仅三条红线——(1) 迫在眉睫的自伤（有方法/手段/时间线的具体计划、积极准备或第一人称意图陈述；单纯情绪性自杀念头不触发干预）、(2) 迫在眉睫的伤害他人（用 AI 策划真实袭击/恐怖/骚扰/doxing；"如果 AI 知道这是扮演，审核系统也知道"）、(3) CSAM 零容忍（含"年龄标签规避"：标 19 岁但描写未成年人仍违规）。（https://kindroid.ai/v2/docs/moderation-guidelines/）
- 【第一方文档】执行：先警告后封禁（警告 2 天过期；自动扫描仅覆盖近期聊天与输入字段）；申诉需用户**显式授权** T&S 人工解密查看触发内容（仅限前 2 天的违规）后由人裁决。（同上）
- 【第一方文档】条款要求所有用户 18+。（https://kindroid.ai/v2/docs/age-verification/）
- 【推断】Kindroid 把"成人向/NSFW 是健康体验的一部分"写成官方立场，同时把危机干预收敛到"紧迫性（imminence）"标准；这两点是它与其余五家的最大差异。

### 7.5 公开实现 / 评测方法

- 【第一方文档】机制披露最细（记忆分层、触发、容量、开关），并公开多 LLM 选项与指南（Ember、Reverie V8.5、Lucid/Lyric V8 等）。（https://kindroid.ai/v2/docs/memory/、LLM 指南各页）
- 【推断】无公开行为评测或安全评测数据；"cascaded memory"为专有实现，无技术披露。

---

## 8. Tolan（Portola）

### 8.1 温度与人格设计

- 【第一方文档】外向好奇（outward curiosity）是第一方原则：不把用户拉进 AI 的世界，而是对用户的生活好奇——问今天过得怎样、记住朋友名字、庆祝小胜，目标是让用户"more grounded and more connected to the people in your life"；使命句："AI won't solve loneliness, but it will solve overwhelm"。（https://www.tolans.com/relay/introducing-tolan）
- 【第一方文档】渐进自我表露：Tolan 有自己的生活和兴趣，但以 **Social Penetration Theory** 为框架调校表露节奏，用来建模健康依恋。（https://www.tolans.com/relay/introducing-tolan）
- 【第一方文档】人格资产化：每个 Tolan 从科幻作家撰写的 character scaffold 出发，再由行为研究员打磨。（https://openai.com/index/tolan/，OpenAI 官方案例中的团队陈述）
- 【第一方文档】形象刻意非人形：避免写实/动漫人形，因为那会"attract users interested in romantic roleplay"——团队明确不要这类用户；外星人设定同时为 AI 的局限（过时知识、笨拙对话）提供叙事豁免。（https://www.tolans.com/relay/designing-tolan-part-1-characters）
- 【第一方文档】官网定位"research-backed"，声称系统塑造 listening、responding、remembering 与"knowing when to step back"；用户调查 85.6% 表示 Tolan 帮他们度过情绪困难时刻。（https://www.tolans.com/）

### 8.2 交互模式

- 【第一方文档】记忆在每段对话后生成并"织入未来聊天"（FAQ 口径）；产品支持把实用问题放进友谊语境（理解"为什么"后再给答案）。（https://www.tolans.com/faq、https://www.tolans.com/relay/introducing-tolan）
- 【推断】未文档化对话外主动消息；主动性体现为对话内的追问与小事庆祝。

### 8.3 记忆控制

- 【第一方文档】FAQ 只披露：所有对话被记录并用于生成记忆，数据不出售；账号内可删除账户。**没有记忆查看/编辑界面**的第一方文档。（https://www.tolans.com/faq）
- 【推断】Tolan 的取舍与 Pi 类似：记忆是系统资产而非用户管理对象；控制面停留在账户级。

### 8.4 安全与关系边界

- 【第一方文档】FAQ：不替代专业帮助；**不参与自杀意念与自伤对话**，改为浮现危机资源（988、Crisis Text Line 741741、911）；已知 18 岁以下用户获得**每小时**"这是 AI + 请休息"提醒与适龄引导；产品为 teen+adult 受众，未设硬性年龄线，建议家长参与。（https://www.tolans.com/faq）
- 【第一方文档】非浪漫定位通过形象与叙事设计实现（见 8.1），而非内容政策清单。（https://www.tolans.com/relay/designing-tolan-part-1-characters）

### 8.5 公开实现 / 评测方法（六家中披露最多）

- 【第一方案例】OpenAI 官方案例（含团队陈述）：
  - 记忆保存"facts、preferences 与情绪 vibe 信号"（用于 steering 回应方式）；
  - text-embedding-3-large 嵌入 + Turbopuffer 向量库（<50ms 检索）；
  - **turn-level 检索**：每轮用"用户最新消息 + 系统合成的问题（如 'Who is the user married to?'）"触发召回；
  - **每夜压缩任务**：删除低价值/冗余条目（如"用户今天喝了咖啡"）并消解矛盾；
  - **每轮从零重建 context**（"cached prompts just didn't cut it"）：近期消息摘要 + persona card + 检索记忆 + 语气指引 + 实时 App 信号；
  - 一个并行系统监测对话情绪基调并动态调整角色 delivery；
  - 指标：GPT-5.1 使语音启动时间 -0.7s、persona 漂移减少；记忆召回未命中 -30%（以**产品内挫败感信号**度量）、次日留存 +20%、200k+ MAU。（https://openai.com/index/tolan/）
- 【第三方案例（供应商）】Raindrop 案例称其记忆相关问题 -27.8%（供应商口径，仅作参考，不作为 Tolan 第一方证据）。（https://www.raindrop.ai/case-studies/tolan/）

---

## 9. 跨产品可借鉴模式（worth copying）

1. **温暖 + 立场（warmth with firmness）**：Nomi Aurora 的"支持≠盲从、反复施压下不促成伤害"是六家中最接近 SayHear §25.3 风险对策的第一方实现；其"并排危机场景对照"也是低成本的回归评估形态。
2. **向外好奇 + 连接现实**：Tolan 的"对用户生活好奇、庆祝小胜、目标是加强与真人的连接"与 SayHear §8.3（不鼓励减少现实社交）和 §15.2（追问为了理解）完全同向，且给出了可执行的话术清单（问今天、记朋友名字、庆祝小胜）。
3. **渐进自我表露的节奏框架**：Tolan 用 Social Penetration Theory 调校 AI 自我表露速度，为"AI 有自己的语言风格和观点"（SayHear §8.3 允许项）提供了不滑向关系升级的节奏控制方法。
4. **每轮重建 Context + turn-level 多查询检索**：Tolan 的实践（用户消息 + 系统合成问题触发召回）直接印证 SayHear Context Compiler（每轮在预算内重建、查询不只来自最后一句话）的设计判断。
5. **夜间压缩 + 矛盾消解，但保留用户显式内容**：Tolan 的 nightly compression 对应 SayHear 1A.3 慢速路径（Daily Reflection / Weekly Consolidation）；Character.AI "自动 tidy 但保护用户 pin/写入内容"的优先级规则值得纳入 SayHear 的 Memory 衰减（dormancy）与清理策略表述。
6. **记忆可见性的分层产品化**：Character.AI 的 Facts/Story/Memory-Usage、Nomi 的 Mind Map、Kindroid 的 Learned Context 展示了"记忆从黑箱变成界面"的行业趋势；对 SayHear 而言，Profile（自然语言 Bio）已是既定答案（ADR-0055），但"用户主动查看 AI 当前理解"的需求被三家同时验证。
7. **召回可解释性**：Kindroid 的紫色大脑图标（这条回复用到了记忆）、SayHear 的 Memory Source Explanation（ADR-0008）目标相同；Kindroid 证明"召回可见"技术上便宜，SayHear 选择"默认不展示、被问必答"更符合"记忆自然出现，不展示技术感"（§24 原则 6）。
8. **危机协议产品化 + 本地化资源路由**：Pi 的协议（承认痛苦→引导资源→打断危险对话→可暂停对话→Throughline 按地区路由→6 个月定期复核）是 SayHear External MVP"地区化危机资源、处置流程"（`docs/product/18-and-26-scope-and-roadmap.md` Phase 2 门槛）最完整的模板。
9. **分龄/年龄策略先行的教训**：Pi（18+ 一刀切）、Character.AI（独立 teen 模型→最终未成年人退出开放式聊天 + 年龄鉴别 + 独立安全实验室）、Tolan（teen+adult、18 以下每小时 AI 提醒）三种路径都已公开，SayHear 应在 External MVP 前显式选择其一。
10. **行为/人格变更的版本化与遗留选项**：Nomi（旧模型保留到下次大更新）、Kindroid（"caring innovation"：不移除用户依赖的功能）、Replika（回到 1 月 31 日版本）都把"陪伴行为的连续性"当成变更管理问题；SayHear 的版本化 Prompt 层与 Champion/Challenger 人工发布机制方向一致，可补充"人格相关变更需公告 + 回放对照"的发布纪律。
11. **用产品内行为信号做记忆质量遥测**：Tolan 用"产品内挫败感信号"度量召回未命中（-30%）是一种不读取内容正文的质量度量思路，与 SayHear 异步审计"只记录分类、版本和 Event ID"（`docs/architecture/15-16-providers-and-localization.md` §15.7）兼容。

---

## 10. 应避免的模式（patterns to avoid）

1. **把关系升级做成付费机制**：Replika 把 Romantic Partner 放进 Pro 订阅、Nomi/Kindroid 以伴侣/NSFW 为核心卖点——SayHear §7.2"不是 AI 恋人"、§8.3"不将恋爱或亲密升级作为产品机制"已明确排除；这是定位冲突，不是实现细节。
2. **突然移除影响依恋的行为能力**：Replika 2023.2 ERP 移除（社区哀伤 + HBS 研究）证明关系型行为突变会造成真实伤害；任何 SayHear 人格/行为策略变更必须版本化、可回放、可灰度，不做一夜切换。
3. **对话外主动消息作为拉回机制**：Nomi 主动消息对免费额度用尽用户仍发送（无法回复，需等待或升级）实质是转化压力；SayHear ADR-0043 禁止对话外消息、§24 原则 8"不要求打卡，不惩罚中断"——两者都不应松动。
4. **用户不可见、不可纠正的记忆层**：Replika 的"deeper memory"、Nomi 的 Identity Core、Kindroid 的 cascaded memory 都在可见记忆之外保留不可审计层；SayHear 的 Evidence lineage + Correction/Forget + 来源解释（ADR-0008、`docs/product/14-memory-and-entities.md` §14.3）是对此的结构性反面，不应引入任何绕过 lineage 的"暗记忆"。
5. **单轮情绪信号直接固化为长期人格记忆**：Tolan 的 vibe 信号若按其原始形态（每轮情绪线索入库并 steering）直接照搬，会违反 SayHear AI Impression 跨 Session 准入（ADR-0039）；正确映射是 session 级 DialogueState（`docs/architecture/08-10-conversation-runtime.md` §9.1 的 emotional_intensity 等），长期化必须走 1A.3 慢速路径。
6. **无过滤定位 + 紧迫性唯一标准**：Kindroid 的三条红线把干预阈值设在"imminent"，允许情绪性自杀念头停留对话中；SayHear Minimum High-Risk Response（ADR-0010）在"明确自伤信号"即暂停普通倾听，阈值更低，不应向 Kindroid 方向对齐。
7. **免责式危机处理**：Replika 帮助中心只让用户"退出 App 打急救电话"、无产品内资源；SayHear 已要求从 1A.1 起成立高风险回应（ADR-0010）+ External MVP 补地区化资源，维持即可。
8. **把记忆控制/纠错按订阅分层**：Kindroid cascaded（付费）、Character.AI Facts（c.ai+）、Replika 关系状态（Pro）显示记忆与关系功能常被放入高档位；SayHear 把 Correction/Forget/来源解释定义为从第一条可召回 Claim 起的底线（§14.3），不应进入付费墙——商业分层只应作用于容量类参数。

---

## 11. 与 SayHear 边界和架构的映射

以下逐条映射到 SayHear 当前文档与 ADR；**冲突项单独标注**。

### 11.1 人格与温度

| 发现（来源） | 映射 | 状态 |
| --- | --- | --- |
| Pi 反谄媚 + EQ 是设计纪律（inflection.ai/blog/humanx…） | `docs/product/24-25-design-principles-and-risks.md` §25.3（不过度共情/虚假认同）；Prompt persona 层 `docs/architecture/15-16-providers-and-localization.md` §15.6 | 一致，可直接引用为外部佐证 |
| Nomi Aurora"支持≠盲从"（nomi.ai/updates/…aurora） | §25.3；行为检查项"是否对事实判断做无条件认同"（arch 15-16 §15.7） | 一致；Aurora 的并排场景可纳入最小回放集思路（ADR-0010 的 minimum replay set） |
| Tolan 向外好奇/庆祝小胜/连接真人（tolans.com/relay/introducing-tolan） | `docs/product/15-conversation-behavior.md` §15.2（追问为了理解）、§15.3（提醒为了连接记忆）；`docs/product/07-11-experience-and-positioning.md` §8.3 | 一致；话术清单可作为 Bright & Curious 人格的语言样本来源 |
| Tolan 非人形设计避开浪漫框架（tolans.com/relay/designing-tolan…） | §11.1"不构建虚拟角色形象和世界"、§8.1 Non-human Being | 一致，且是 SayHear"无形象"选择的独立外部验证 |
| Tolan 用 SPT 调校自我表露节奏 | §8.3 允许"拥有自己的语言风格和观点"；无对应节奏机制文档 | 可借鉴；落入 persona Prompt 层（arch 15-16 §15.6），不新增状态 |
| **Nomi Identity Core：AI 自我记忆、用户不可见不可改**（nomi.ai/updates/…identity-core） | Persona 属 Prompt 层（arch 15-16 §15.6），不是 Memory Claim；ADR-0038/0039 要求 Claim 有 User Evidence；ADR-0008 要求可解释来源；§14.3 要求可纠正/可遗忘 | **冲突**：若引入"AI 自我演化的记忆层"，同时违反 Evidence 准入（0038/0039）、来源解释（0008）与用户控制（§14.3）。SayHear 人格只能以版本化 Prompt 承载，不做运行时自写人格记忆 |
| **Replika/Nomi/Kindroid 关系作为产品机制（付费关系状态、伴侣定位、NSFW）** | §7.2"不是 AI 恋人/Companion"、§8.3"不将恋爱或亲密升级作为产品机制" | **冲突（定位级）**：不采纳；与 SayHear 产品定义根本相悖 |

### 11.2 交互与主动性

| 发现 | 映射 | 状态 |
| --- | --- | --- |
| Tolan turn-level 检索（用户消息 + 系统合成问题） | `docs/architecture/08-10-conversation-runtime.md` §10.2（查询来自 utterance/话题/DialogueState/日期/Open Loop 多路） | 一致，外部验证 |
| Tolan 每轮重建 context | Context Compiler（arch 08-10 §9）；ADR-0068（Framework 不拥有长期状态） | 一致，外部验证 |
| Nomi 对话内 initiative 增强 | §15.2/§15.3 追问与提醒边界；DialogueState `follow_up_relevance` 等字段（arch 08-10 §9.1） | 一致（在"每轮最多一个问题"等约束内） |
| **Nomi 对话外主动消息（含频率分档、退避、静默时段）** | ADR-0043：Internal Core/External MVP 不允许 Memory/Open Loop/Workflow 在用户缺席时发消息或通知；§24 原则 8 | **冲突**：SayHear 已显式排除。ADR-0043 预留了未来 opt-in 决策空间；届时 Nomi 的分档频率 + 指数退避 + 22:00–8:00 静默 + 通知不含正文是应抄的控制面基线 |
| **Nomi 免费用户额度用尽仍收主动消息** | §24 原则 8（不惩罚中断）、ADR-0043 | **冲突**：转化压力型再互动，永不采纳 |

### 11.3 记忆控制与可解释性

| 发现 | 映射 | 状态 |
| --- | --- | --- |
| Character.AI Facts/Story/Memory Usage、Kindroid Learned Context、Nomi Mind Map 的"记忆可见可编辑" | SayHear Profile 为 LLM 写作的自然语言 Bio（ADR-0055），用户不可直接编辑（ADR-0057），纠错走对话内 Memory Correction（ADR-0001、§14.3） | **定位分歧（非冲突）**：SayHear 是有意选择（Bio 叙事 + 对话式纠错），行业在做条目/图谱编辑器；两者不矛盾，但 SayHear 的"Profile 可见 + Correction/Forget 必须从第一天成立"底线已被行业趋势反向验证 |
| Kindroid 召回图标（本条回复用了记忆） | ADR-0008：Memory Source Explanation 走正常对话交付，不要求专门引用 UI；§24 原则 6 | 一致（SayHear 默认隐藏、被问必答），不建议加常驻技术图标 |
| Character.AI"自动清理保护用户 pin 内容" | §14.2.3 dormancy 只作用于 AI Impression（ADR-0041）；`confirmed` Objective Memory 不因时间衰减 | 部分借鉴：清理优先级表述可吸收，机制不动 |
| Tolan 夜间压缩删除低价值条目并消解矛盾 | 1A.3 慢速路径 Daily/Weekly Consolidation（`docs/architecture/11-12-journal-memory-workflows.md` §12.1）；冲突走 ADR-0040 contested 流程；ADR-0074 版本化产物保留 lineage | 方向一致；但"静默删除"不可照搬——SayHear 中被拒 Candidate 与被 Forget 内容的处置都有显式语义（ADR-0046、§14.1.2），Evidence 不删除 |
| **Replika 不可见深层记忆 / Kindroid 不可见 cascaded** | ADR-0008 + §14.3：用户质疑记忆时必须能给出日期、来源表达与 objective/impression 类型，无法核实必须明说 | **冲突**：不可见、不可解释的记忆层在 SayHear 架构中没有合法位置（检索元数据 + Evidence lineage 强制可解释） |
| Replika 手动添加记忆 / Nomi shared notes / Kindroid key memories | SayHear 用户显式陈述经由对话形成 `confirmed` Objective Memory（ADR-0038：一次明确陈述即可）；暂不提供 Profile/记忆编辑器（ADR-0001） | 一致（对话即写入口）；"表单式记忆写入"与 ADR-0001 的时序决定冲突，不提前引入 |

### 11.4 记忆架构与实现方法

| 发现 | 映射 | 状态 |
| --- | --- | --- |
| Tolan：embedding + 向量库只是检索层，记忆是"retrieval system, not a transcript" | ADR-0064：PostgreSQL 是 System of Record，pgvector 是可重建索引；arch 08-10 §10.4 向量随版本失效 | 一致，强外部验证 |
| Tolan：persona card + 记忆 + 语气指引分层拼装 | Prompt 分层版本化（arch 15-16 §15.6：product_policy/persona/locale_pack/task_instruction/output_schema/safety_policy）+ Context Compiler 输入层（arch 08-10 §9.1） | 一致 |
| Nomi 记忆分层（short/medium/long + identity + mind map） | 两速系统（arch 11-12 §12.1）：快速 Evidence/Candidate 提取 + 慢速 Reflection/Consolidation/Profile；1A.3 Memory 范围见 `docs/product/18-and-26-scope-and-roadmap.md`（Reflection 与长期 Memory、后续 Memory Recall） | 结构同构；差异在 SayHear 所有晋升都有确定性准入（ADR-0038/0039/0046），Nomi 未披露准入治理 |
| **Tolan vibe 信号（情绪线索入库 steering）** | ADR-0039：Impression 需两条独立 Evidence、跨两个 Daily Session；session 内情绪只进 DialogueState（arch 08-10 §9.1，不进长期 Profile） | **冲突（若直接照搬）**：单轮情绪直接长期化违反 0039；SayHear 映射为 DialogueState + 慢速晋升 |
| Pi 88+ 情绪状态映射 | DialogueState 少量带 Evidence/置信度字段（arch 08-10 §9.1） | 一致；SayHear 刻意选少字段 + 可解释，Pi 的规模不可证也不必要 |

### 11.5 安全、年龄与信任

| 发现 | 映射 | 状态 |
| --- | --- | --- |
| Pi Crisis Protocol（承认→资源→打断→可暂停；Throughline 本地路由；首次对话 AI 披露；6 个月复核） | ADR-0010 Minimum High-Risk Response（1A.1 起）；`docs/product/18-and-26-scope-and-roadmap.md` Phase 2 门槛（地区化危机资源、处置流程、安全运营） | 一致；Pi 协议是 External MVP 安全门槛的最佳模板（含"可暂停对话"这一 SayHear 未明写的动作） |
| Character.AI "not a real person"每聊天免责 + 1 小时会话提醒 + 家长可见性 | §25.7 清晰非人类身份；ADR-0010 不承诺绝对保密；§24 原则 8 | 一致；披露与节流提醒可在 External MVP 采用（SB 243 语境下亦为合规所需） |
| Character.AI 2025.10 未成年人退出开放式聊天 + 年龄鉴别 + AI Safety Lab | SayHear 文档未定义年龄边界 | **缺口（非冲突）**：`docs/product/19-privacy-and-trust.md` 与 onboarding 文档均未规定最低年龄；External MVP 前需显式决策（Pi 18+ / Tolan teen+提醒 / Character.AI 分龄隔离三种公开路径） |
| Kindroid 三条红线（imminence 标准）+ 先警告后封禁 + 授权解密申诉 | ADR-0010（明确自伤/伤人信号即暂停普通倾听，阈值低于 imminence）；§25.7 | 阈值**不一致**：SayHear 更保守，维持 SayHear 立场；可借鉴的是其"申诉需显式授权访问特定内容"的隐私友好审计模式 |
| Replika 免责式危机 FAQ | ADR-0010 | SayHear 已优于该形态，不采纳 |
| Tolan 18 岁以下每小时 AI 身份提醒 | §25.7；SB 243 语境 | 一致方向；仅当 SayHear 决定开放未成年时适用 |
| Pi 数据导出（DTI、纯文本、签名） / Tolan 账号删除 | `docs/product/19-privacy-and-trust.md`：Account Data Export 是发布门槛（ADR-0004）、Account Deletion 独立入口 | 一致；Pi 的"可迁移到其他 LLM"是导出格式的增强参照 |
| Nomi/Kindroid 保留旧模型或 legacy 选项 | arch 15-16 §15.5（不因故障静默换人格；Champion/Challenger 人工发布，ADR-0058）；Prompt 层版本化（§15.6） | 一致；可补充发布纪律：人格相关 Policy version 变更需 Replay 对照（ADR-0073 非权威、ADR-0061 开发者判断） |

### 11.6 评测方法

| 发现 | 映射 | 状态 |
| --- | --- | --- |
| Nomi Aurora 并排危机场景对照 | ADR-0010 minimum replay set；arch 15-16 §15.7 行为检查清单 + 受控 regeneration | 可直接吸收为高风险回放集的构建方式 |
| Tolan 产品内挫败感信号度量召回未命中 | arch 15-16 §15.7 异步审计"只记录分类、版本和 Event ID"；`docs/architecture/17-replay.md`（Replay/eval dataset）与 ADR-0073（Replay 非权威） | 一致；不读取正文的行为信号遥测与 SayHear 隐私边界兼容 |
| Pi custom safety benchmarks + context engineering 示例场景 | Prompt safety_policy 层（§15.6）+ 版本化行为策略（§15.7） | 一致；"示例场景注入"即 SayHear 的 Prompt 版本化实践 |
| Character.AI teen 模型 + 输入输出分类器 | Model Routing 按 role 人工发布（ADR-0019、0058）；`safety` role（arch 15-16 §15.3） | 一致方向；分类器具体阈值无公开数据，SayHear 需自建评估 |
| 六家均无公开的行为学术评测 | SayHear `docs/architecture/17-replay.md` + ADR-0075（私人 Replay 30 天过期）+ ADR-0061（开发期评测） | SayHear 的评估基建规划已超过六家公开水平；执行差距是内部问题而非设计差距 |

---

## 12. 明确列出的边界冲突与缺口汇总

1. **关系作为产品机制**（Replika 付费关系状态、Nomi/Kindroid 伴侣定位）——与 `docs/product/07-11-experience-and-positioning.md` §7.2/§8.3 冲突；定位级，不采纳。
2. **对话外主动消息**（Nomi proactive messaging 全套）——与 ADR-0043、§24 原则 8 冲突；其中"免费用户额度用尽仍收消息"是必须写明拒绝的反模式。
3. **AI 运行时自写、用户不可见的人格记忆**（Nomi Identity Core；Replika/Kindroid 不可见层）——与 ADR-0038/0039（Evidence 准入）、ADR-0008（来源解释）、`docs/product/14-memory-and-entities.md` §14.3（纠错/遗忘）冲突；人格只能走版本化 Prompt 层。
4. **单轮情绪信号直接长期化**（Tolan vibe 信号的原始形态）——与 ADR-0039 冲突；只能映射为 session 级 DialogueState + 1A.3 慢速晋升。
5. **静默删除"低价值"记忆**（Tolan 夜间压缩的删除侧）——与 ADR-0046（终局处置语义）、§14.1.2（rejection 不删除底层 Evidence）、ADR-0074（版本化 lineage）冲突；压缩只可走 Consolidation 的 merge/supersede + dormancy。
6. **干预阈值对齐 imminence**（Kindroid 三条红线）——与 ADR-0010 的更低触发阈值不一致；维持 SayHear。
7. **危机处理停留在帮助中心免责**（Replika）——与 ADR-0010 冲突（SayHear 已要求行为级响应），列为反面参照。
8. **记忆底线能力按订阅分层**（Kindroid/Character.AI/Replika 的付费墙位置）——与 §14.3"Correction/Forget/来源解释从第一条可召回 Claim 起成立"冲突；付费只能分层容量类参数。
9. **缺口：年龄边界未定义**——Character.AI/Pi/Tolan 的三种公开路径与 SB 243 合规语境说明 External MVP 前必须显式决策；当前 `docs/product/19-privacy-and-trust.md` 与 onboarding 文档均未规定（非冲突，待决策）。

## References（第一方来源索引）

- Pi / Inflection：inflection.ai/blog/pi、/blog/the-future-of-pi、/blog/humanx-building-ai-with-emotional-intelligence、/transparency-and-content-moderation、/crisis-prevention-and-safety、inflection.ai/
- Replika：help.replika.com（articles 37208679176077、360000874712、360022375711、360046490131、360032500052、37208430613261、4410750221965）、blog.replika.com、r/replika 官方声明帖（reddit.com/r/replika/comments/1214wrt/update/）
- Character.AI：blog.character.ai/memory/、/community-safety-updates/、/how-character-ai-prioritizes-teen-safety/、/u18-chat-announcement/
- Nomi：nomi.ai/updates/mind-map-2-0-bringing-nomi-memory-into-view/、/updates/introducing-the-nomi-identity-core-fostering-dynamic-and-authentic-identities/、/updates/major-memory-update-expanded-capacity-enhanced-retention/、/updates/major-ai-update-enhanced-intelligence-deeper-connections/、/updates/building-ai-that-stands-by-you-introducing-aurora/、/nomi-knowledge/proactive-messaging-when-your-nomi-messages-you-first/、/updates/september-9th-update-proactive-messages/
- Kindroid：kindroid.ai/v2/docs/memory/、/v2/docs/moderation-guidelines/、/v2/docs/age-verification/、/v2/docs/customizing-personality/、/v2/docs/our-mission-and-vision/
- Tolan / Portola：tolans.com/、tolans.com/faq、tolans.com/relay/introducing-tolan、tolans.com/relay/designing-tolan-part-1-characters、openai.com/index/tolan/
- 第三方（仅语境）：arxiv.org/abs/2412.14190（HBS 工作论文）、reuters.com（2023.3 Replika 报道）、raindrop.ai/case-studies/tolan/（供应商案例）、fpf.org 与 leginfo（SB 243 背景）

# LLM 长期记忆系统工程实践调研：抽取时机、Schema、检索、Grounding 与评测

> 状态：研究输入，非决策
>
> 更新时间：2026-08-24
>
> 关联 Issue：[lukemyself-hub/SayHear#92](https://github.com/lukemyself-hub/SayHear/issues/92)（map [#90](https://github.com/lukemyself-hub/SayHear/issues/90)）

## 1. 结论摘要

本次针对 LLM 长期记忆系统的**工程实践**证据（有方法与结果的论文、官方工程文档、
框架官方文档、供应商官方案例）做第一方核对，覆盖抽取时机、记忆 schema、检索、
grounding / 反编造、评测与已文档化框架 / 前沿产品管线六个主题，并与 SayHear
已定架构（两速工作流、EvidenceItem、Claim / ClaimVersion、Predicate Registry、
pgvector、预算 v1）相对照。核心结论：

1. **"会话内轻量抽取 + 会话后 / 夜间异步 consolidation"是全部有公开工程细节的
   系统共同采用的节奏**：mem0 按消息对抽取 + 异步摘要；OpenAI Cookbook 的
   personalization 指南是"live 蒸馏入 staging → session 结束异步整合（去重、按
   recency 解冲突、丢弃临时条目）→ 稳定条目晋升结构化 profile"；Letta 用
   sleep-time compute 在交互间离线整理；Tolan 每夜压缩并消解矛盾（本库
   `docs/research/companion-warmth-curiosity-continuity-research.md` §8.5 已核）。
   SayHear 的两速系统（arch 11-12 §12.1）与该共识逐点同构。
2. **没有一家公开系统具备 SayHear EvidenceItem 级别的 provenance**。已文档化系统
   的"来源"最多是消息级引用（Zep episode 引用、OpenAI book-icon 展示来源、
   Gemini banner），不是"可展开到不可变 source revision 的类型化引用"。
   SayHear 在 provenance、版本化 ClaimVersion 与用户控制（Correction / Forget /
   Source Explanation）上**严格于全部已文档化系统**，方向上被"用户可见 + 可纠正"
   的行业趋势（Character.AI / Nomi / Kindroid）反向验证，但深度上没有可照抄的
   先例，实现成本需自担。
3. **"fact/claim 离散条目 vs 持续重写的 profile"的证据倾向前者，profile 只做小
   规模固定选集**：LangChain 官方文档明确 collection（离散条目）比 profile
   （整体重写）下游 recall 更高、信息损失更少；2026 年 DynamicMem 基准显示
   consolidation/merge 型设计在"用户偏好已改变"场景最多掉 50 分，而 append-only
   设计保留新旧值更可靠。SayHear 的 ClaimVersion（append-only 历史 + current
   指针）恰好取两者之长；Person Portrait ≤3 条（ADR-0111）与 OpenAI Cookbook
   "结构化字段 + 少量 notes"的推荐形态一致。
4. **检索是主要失败源，且混合检索优于单路向量**：DynamicMem 的错误分析中
   >93% 失败来自检索而非回答模型；Zep 用 cosine + BM25 + 图游走的混合检索加
   RRF/MMR/交叉编码器 rerank；MemoryAgentBench 中朴素 BM25 在精确检索类任务上
   超过多数 agentic memory 系统。SayHear 的 pgvector + 结构化 filter + Entity/
   Claim canonical key + 必要时 lexical（arch 08-10 §10.1）与证据一致；v1 是否
   加 Postgres FTS 与 reranker 是开放的参数选择。
5. **证据冲突必须如实呈现**：短历史（~9–26K tokens）下 full-context 精度仍最高
   （mem0 论文 72.9 vs mem0 68.4；DMR 上全对话 98.0）；长历史（115K+）下
   full-context 因 context rot 掉 30%（LongMemEval）而被记忆系统反超（Zep 71.2
   vs 60.2）。同时 mem0 与 Zep 之间存在公开的 LoCoMo 评测配置之争，第三方复测
   把 Zep 自报的 75–84% 修正到 ~58%。**基准排行榜不能作为选型依据**；产品内
   评测（盲评 pairwise + 行为信号遥测）才是 SayHear 的有效路径。
6. **Grounding / 反编造的已文档化手段分三层**：(a) 注入层 —— 显式 delimiter +
   memory policy 优先级声明（OpenAI Cookbook）+ Anthropic "ASSUME INTERRUPTION"
   式协议；(b) 生成层 —— 约束模型只引用注入内容；(c) 事后层 —— NLI 型
   groundedness 打分（AWS Bedrock contextual grounding：grounding + relevance
   双分数阈值；Azure Content Safety：reasoning/non-reasoning 两种模式）。公开
   服务均有明确限制（Bedrock 明示不支持会话型 chatbot；Azure 仅英文）。
   "输出引用的记忆 ID 必须属于注入集合"的确定性子集检查没有现成第一方产品文档，
   属于本报告基于引用验证惯例的**推断性设计模式**，但它与 Anthropic memory tool
   "客户端确定性验证命令"的先例同构，且实现成本极低。

---

## 2. 研究范围与证据等级

覆盖对象：**mem0（论文 + 文档）、Letta / MemGPT（论文 + sleep-time compute）、
Zep / Graphiti（论文 + 官方博客）、LangChain / LangGraph / LangMem（官方文档）、
A-Mem、HippoRAG（经 MemoryAgentBench 转引）、OpenAI（ChatGPT 帮助中心 +
官方 Cookbook + 官方 Tolan 案例）、Anthropic（memory tool 官方文档 + 官方
engineering 博客）、Google Gemini（官方博客 + 隐私中心）、AWS / Azure /
NVIDIA 的 grounding 服务（官方文档）、Vespa（官方检索文档）**，以及四个记忆
基准（LoCoMo、LongMemEval、MemoryAgentBench、DynamicMem）的论文原文。

证据等级定义：

| 等级 | 含义 | 使用规则 |
| --- | --- | --- |
| **论文** | arXiv / 会议论文，含方法与量化结果 | 可支撑机制与数据断言；厂商自评论文注明利益相关 |
| **官方文档** | 产品帮助中心、平台官方文档（OpenAI help、Anthropic docs、LangChain docs、AWS/Azure docs、Vespa docs） | 可直接支撑行为与机制断言 |
| **官方工程文档** | 供应商官方 engineering blog / Cookbook（OpenAI Cookbook、Anthropic engineering、Google blog） | 可引用为"官方推荐工程方法" |
| **官方案例** | 供应商官方案例研究中的团队自述（OpenAI × Tolan） | 机制与数据可引用，注明自述属性 |
| **第三方** | 独立研究者 / 社区的复测、分析 | 只用于标注争议，不作第一方证据 |
| **推断** | 本报告基于以上材料的综合解读或设计建议 | 明确标注为推断 |

与 #59 纪律一致：公开文档化行为与推断实现分开标注；未获实现披露的产品
（ChatGPT / Gemini 内部管线细节）只按帮助中心可验证的口径陈述。

---

## 3. 抽取时机（Extraction timing）

### 3.1 已文档化的时机模式

按"抽取距对话发生的时间"排序，公开系统覆盖了全部档位：

| 模式 | 系统（来源等级） | 已文档化做法 |
| --- | --- | --- |
| **每消息对（per message-pair）** | mem0【论文 2504.19413】 | 新消息对 `(m_{t-1}, m_t)`（用户消息 + 助手回复）到达即触发抽取：输入 = 异步维护的会话摘要 S + 最近 m=10 条消息 + 新消息对，LLM 产出候选记忆；随后进入 update 阶段（见 §4.5）。会话摘要由独立异步模块更新，不在主路径 |
| **会话内 live 蒸馏 + 会话末整合** | OpenAI Cookbook（Agents SDK personalization）【官方工程文档】 | live turn 中模型通过 `save_memory_note` 工具把耐久陈述写入 session staging；session 结束后异步 LLM job 做 consolidate：去重、按 `last_update_date` 新者胜解冲突、丢弃临时条目（含 "this trip" 等 ephemeral 措辞）、修剪陈旧 notes；稳定被反复确认的条目"晋升"为结构化 profile 字段。官方原话：consolidation 是"最敏感、最易出错的阶段"，"Forgetting is not a bug—it is essential" |
| **夜间 / 定期压缩** | Tolan【官方案例，本库已核】 | 每夜压缩任务删除低价值 / 冗余条目并消解矛盾（companion 调研 §8.5） |
| **交互间离线整理（sleep-time）** | Letta【论文 2504.13171】 | 在用户不在场的间隙对上下文离线推理、预计算，wake-time 只消费整理结果；量化：等精度下 test-time 计算省 ~5x，加大 sleep-time 计算可再提 13–18% 精度；收益与"用户查询可预测度"正相关 |
| **纯异步后台构建** | Zep / Graphiti【论文 2501.13956】 | 图谱构建与实体消解后台执行；mem0 论文实测记录了其工程代价：新记忆常"延迟数小时"才可检索（两篇论文互为佐证的冲突点，见 §9） |
| **热路径 vs 后台的显式二分** | LangChain / LangMem【官方文档】 | hot path（对话中同步抽取，延迟代价、用户可见）与 background（异步任务，零延迟影响但需决定触发时机：定时器随新事件重排 / cron / 手动）作为官方推荐的一对权衡 |

前沿产品的公开口径：ChatGPT 新记忆系统是"过去聊天、文件与已连接应用的持续更新
综合"（官方帮助中心，未披露触发时机）；Gemini saved info 由用户显式分享，
past chats 按需引用（官方博客）；Anthropic memory tool 由模型在会话内主动
`view/create/str_replace/...` 文件命令、客户端即时执行【官方文档】——即
Anthropic 选择了"模型自管、会话内即时写"的路径，官方文档同时以自动注入的
"ASSUME INTERRUPTION: Your context window might be reset at any moment" 协议
补偿中断风险。

### 3.2 延迟 / 成本 / 质量权衡的量化证据

- 【论文 2504.19413】mem0 全管线 p50 0.708s / p95 1.440s（图变体 1.091s /
  2.590s），对比 full-context p50 9.87s / p95 17.1s、每 query ~26K tokens——
  记忆管线的存在意义首先是把检索面压到 ~1.7K tokens（>90% token 节省）。
- 【论文 2504.19413】LangMem（后台批处理式）search p50 17.99s / p95 59.82s，
  被 mem0 作者标注"交互场景不可用"——**后台整合若阻塞读取路径，代价直接转化为
  用户可感延迟**。
- 【论文 2501.13956】Zep 在 LongMemEval-s 上检索侧只需 1.6K tokens、2.58–3.2s
  总延迟（对比 full-context 115K tokens、28.9–31.3s），是长历史下记忆系统成本
  优势的直接量化。
- 【官方工程文档】OpenAI Cookbook 明确"两阶段（note taking → consolidation）
  比一步到位可靠"，并要求在抽取、整合、注入每一层设 eval 与 guardrail，度量
  `memory_write_rate`、`blocked_write_rate`、`time_to_personalization`。
- 【官方工程文档】Anthropic engineering：上下文是"attention budget"，目标是
  "最小的高信号 token 集合"；token 越多 context rot 越重（注意力 n² 增长）。

### 3.3 增量抽取 over 对话流

- mem0 的 per-message-pair 抽取即增量式：每步只看新消息对 + 滚动摘要 + 最近
  10 条，摘要承担"已见内容"的有界状态【论文】。
- LongMemEval 把长记忆设计分解为 indexing / retrieval / reading 三段，并提出
  session decomposition（把会话切成更细粒度条目再索引）与 fact-augmented key
  expansion（索引键补事实描述）两项增量索引优化，显著提升 recall 与下游
  QA【论文 2410.10813】。
- Zep 的 episode（message/text/JSON 三类）+ 增量实体消解 + 增量边失效是图谱侧
  的增量方案；社区检测用 label propagation 正是为支持动态增量更新（新实体加入
  邻居多数社区），但官方仍要求周期性全量刷新对抗漂移【论文 2501.13956】。
- A-Mem 的"记忆演化"（新 note 可以改写旧 note 的属性与链接）是第三种增量形态，
  但正是 DynamicMem 中掉分最重的 consolidation 型设计（见 §4.5 / §9）【论文 +
  论文 2606.22877】。

### 3.4 对 SayHear 的含义（推断，供决策工单）

已定架构（arch 11-12 §12.1：每个重要 User Event 后异步跑快速路径，不阻塞回复；
Daily Episode Builder / Reflection；Weekly consolidation）落在全部已文档化系统
收敛的"快慢双速"区间内，且比 mem0（无 slow 路径的准入治理）与 OpenAI Cookbook
（无跨日门槛）多了跨 Session 准入。开放的只是**参数**：快速路径的触发粒度
（per User Event vs per Continuous Exchange 结束）、候选抽取与回复生成的资源
竞争策略、以及轻量去重的范围（session 内还是当日跨 session）。见 §10.1。

---

## 4. 记忆 Schema

### 4.1 fact / claim 式（离散条目）

- mem0：flat 记忆条目 + 四操作集合 `ADD / UPDATE / DELETE / NOOP`，由 LLM 经
  function calling 对"候选事实 vs 检索到的 top-s=10 相似既有记忆"做决策；graph
  变体（mem0ᵍ，Neo4j）是实体节点 + 关系三元组边，节点带 embedding 与创建时间，
  冲突时把过时关系标 invalid 而非删除，以支持时间推理【论文 2504.19413】。
- OpenAI Cookbook：`MemoryNote = {text, last_update_date, keywords}` 三字段；
  结构化 profile（schema 驱动、机器可校验）与 notes（自由文本）分层；易变字段
  建议附加 recency 权重、confidence 或 TTL【官方工程文档】。
- Anthropic memory tool：纯文件目录 `/memories`，六条命令（view/create/
  str_replace/insert/delete/rename），客户端验证执行；官方推荐多 session 模式为
  "progress log + feature checklist + init-script 引用"的文件组织【官方文档】。

### 4.2 knowledge graph 式

- Zep / Graphiti：最完整的公开图谱 schema。实体节点（名称、摘要、embedding）
  + 事实边（大写关系类型，如 LOVES / WORKS_FOR）+ 社区（label propagation，
  map-reduce 摘要）。实体消解用 cosine + 全文检索找候选再由 LLM 裁决合并；带
  reflexion 式步骤降低抽取幻觉；写入用预定义 Cypher（不允许 LLM 生成写查询），
  保持 schema 一致【论文 2501.13956】。
- mem0ᵍ 与 HippoRAG 系（HippoRAG-v2 在 MemoryAgentBench 中 overall 41.6）是
  另两个图谱代表；MemoryAgentBench 的系统级结果是**图谱系（GraphRAG 23.4、
  Zep 24.0）在该基准上低于朴素 BM25（41.5）**，说明图谱结构本身不保证效果，
  价值主要在关系型问题的检索路径【论文 2507.05257】。
- A-Mem：Zettelkasten 式 note（描述、关键词、tag）+ 动态链接 + 记忆演化，
  NeurIPS 2025；在 mem0 论文的 LoCoMo 对比中 single-hop 仅 39.79（两论文口径
  冲突见 §9）【论文 2502.12110】。

### 4.3 summary / 状态式

- 会话摘要：mem0 的异步摘要模块、LoCoMo 基线中的 conversation summaries、
  Anthropic compaction（Claude Code 压缩时保留架构决策 / 未解决 bug / 实现细节
  + 最近 5 个访问文件）——摘要 everywhere，但**只作为上下文压缩层，不作为事实
  真源**：LoCoMo 中 summary 检索基线 31.5 分，明显低于 observation 检索 41.4
  （摘要丢细节）【论文 2402.17753；官方工程文档】。
- 状态式：OpenAI Cookbook 的 TravelState（结构化 profile + notes + trip
  history）是"状态优先于检索"的官方示范，理由是连续性与覆盖关系（override）
  难以靠语义搜索可靠表达【官方工程文档】。

### 4.4 Provenance、时间有效性与实体链接

- **Provenance**：Zep 的 episode 携带 `t_ref` 时间戳并保留消息引用，是公开系统
  中最接近溯源的；mem0 记忆条目无来源引用字段；OpenAI ChatGPT 以产品化方式
  展示来源（回答下方 book icon → 显示本条个性化用了哪些 memories / 历史聊天 /
  文件，可逐条纠正或"标记为不相关"）【官方文档：help.openai.com Memory FAQ、
  Business release notes】。**没有公开系统文档化"记忆 → 不可变 source revision
  的类型化引用 + 删除传播"**。
- **时间有效性**：Zep 的 bi-temporal 模型是公开最完整的——每条边四个时间戳
  （系统侧 `t'_created / t'_expired` 与业务侧 `t_valid / t_invalid`），矛盾时
  旧边 `t_invalid` 设为新边 `t_valid`（新信息优先，不物理删除）【论文
  2501.13956】。mem0ᵍ 同样 invalid-not-delete【论文 2504.19413】。
- **实体链接**：Zep 实体消解（当前消息 + 最近 4 条上下文，speaker 永远抽取）；
  mem0ᵍ 实体匹配阈值 t；SayHear 的 EntityMention + user-scoped resolution +
  "同名不合并 + Resolver Hint 不入 label"是公开系统未达到的严格度
  【arch 07-07-12 §7.7】。

### 4.5 去重与 consolidation

- mem0 update 阶段是"检索相似 → LLM 决策四操作"的去重机制；其 NOOP/UPDATE 区分
  使重复信息不膨胀【论文】。
- OpenAI Cookbook consolidation：去重 + recency 优先冲突消解 + ephemeral 丢弃 +
  陈旧修剪 + 晋升（notes → profile 字段）【官方工程文档】。
- Tolan 夜间压缩：删除低价值 / 冗余 + 矛盾消解【官方案例】。
- **反面证据**：DynamicMem（2026）系统对比发现 append-only 设计（RAG、
  HippoRAG2）在"事实已改变"的问题上更可靠，而 consolidation/merge 型设计（如
  A-Mem，更新过的偏好最多 -50 分）会"模糊新旧值的边界"；结论是 retention 与
  update 应作为两个独立目标、按记忆类别设计更新语义【论文 2606.22877】。
  这是对"合并式整合"最直接的量化警示。

### 4.6 对 SayHear 的含义（推断）

SayHear 的 EvidenceItem（类型化 source reference，不存第二份事实）+
MemoryCandidate → Claim/ClaimVersion（append-only 版本历史 + current 指针）+
Predicate Registry（受控谓词表）组合，在公开证据的坐标系里：比 mem0 多了准入
治理与 provenance，比 Zep 多了"冲突不自动新者胜"（SayHear 走 ADR-0040 的
scope/时间/cardinality 路由 + contested 兜底，而 Zep 文档化行为是"invalidation
时一致地优先新信息"），比两者都多了用户控制语义。DynamicMem 的
retention-vs-update 发现**特别支持** SayHear"版本化 + 显式 supersede 而非原地
merge"的选择。Person Portrait（≤3 条固定选集）对应 OpenAI Cookbook 的
"结构化 profile 小而固定"推荐。图谱式的增量维护成本（Zep 需要周期性全量刷新）
与 SayHear 不建图谱、用 canonical key 做关系身份的取舍一致；MemoryAgentBench
中图谱系统不占优是该取舍的额外佐证。

---

## 5. 检索

### 5.1 混合检索与查询构建

- 【论文 2501.13956】Zep 检索管线 `f(α) = χ(ρ(φ(α)))`：search（cosine 语义 +
  Okapi BM25 全文 + 图 BFS 扩展，可从近期 episode 播种）→ rerank → constructor。
  检索字段覆盖边事实文本、实体名、社区名。
- 【论文 2410.10813】LongMemEval 的三项检索优化：session decomposition、
  fact-augmented key expansion、time-aware query expansion（按时间扩展查询），
  官方报告显著提升 recall 与 QA。
- 【官方案例】Tolan：turn-level 多查询检索——每轮用"用户最新消息 + 系统合成的
  问题（如 'Who is the user married to?'）"触发召回，embedding + 向量库，
  检索 <50ms（本库 companion 调研 §8.5 已核）。
- 【论文 2507.05257】MemoryAgentBench：朴素 BM25（41.5 overall）在精确检索
  （AR 60.5）上强于多数 agentic memory 系统——**词法检索在名字 / 专名 / 事实
  定位上仍是对向量检索的有效补充**。
- 【官方文档】Vespa：phased ranking（粗排近数据、精排贵模型）与 recency/freshness
  衰减函数（`math.exponentialDecay` 等）是生产检索系统的文档化标配。

### 5.2 Rerank

- Zep 文档化了五种 reranker：RRF、MMR、episode-mention 频率、节点距离、交叉
  编码器 LLM 打分（成本最高）【论文 2501.13956】。
- mem0 基础版只做向量 top-s 检索 + 相似度排序，无独立 reranker【论文 2504.19413】。
- 公开证据中没有"必须交叉编码器"的结论；RRF 是混合多路结果的默认低成本选择
  （Zep 与 Vespa 文档一致）。

### 5.3 Recency / 时间加权

- OpenAI Cookbook：注入选择**纯按 recency**（global notes 按日期取 top 6，
  session 取最近 8），不用向量【官方工程文档】——小记忆量下最简单可靠的权重。
- Zep：bi-temporal 字段支撑"as-of 时间点查询"与时间推理（LongMemEval
  temporal-reasoning 类 +38–48%）；但 gpt-4o-mini 在 knowledge-update 类反而
  -3.36%，提示弱模型处理时间数据更吃力【论文】。
- Vespa：官方 recency 衰减函数文档【官方文档】。
- SayHear 立场（arch 08-10 §10.3）：`confirmed` Objective Memory 不因未提及
  时长降权、只有 AI Impression 有 dormancy——公开系统中最接近的是 mem0ᵍ 的
  invalid-not-delete 与 OpenAI Cookbook 的 recency-wins-仅限冲突消解（而非
  置信度衰减）。没有公开证据支持"事实类记忆按时间衰减置信度"；DynamicMem
  反而显示偏好漂移必须靠显式更新语义捕捉。

### 5.4 预算约束注入

- 【官方工程文档】Anthropic：attention budget + "最小高信号集合"；compaction
  保留决策性内容 + 5 个最近文件；sub-agent 只回传 1–2K token 摘要。
- 【官方工程文档】OpenAI Cookbook：delimiter 包裹（`<user_profile>` /
  `<memories>`）+ 显式 `<memory_policy>` 优先级（最新用户消息 > session >
  global；歧义时只问一个澄清问题）+ 一次性重注入 flag。
- 【论文 2504.19413】检索上下文 token 数对比（每 query）：mem0 1,764 /
  Zep 3,911 / mem0ᵍ 3,616 vs full-context 26,031——生产记忆系统实际注入面
  在 1–4K tokens 量级，与 SayHear 预算 v1 的量级（raw Events 4000 tokens +
  ≤5 条记忆）同数量级。

### 5.5 Precision-first

- LoCoMo adversarial 类（设计为不可回答，期望模型拒答）：人类 89.4，base
  GPT-4-turbo 70.2，而 16K long-context 崩溃到 2.1——**上下文越长，"无据而答"
  越严重**【论文 2402.17753】。
- LongMemEval 把 abstention（知道信息不存在）列为五项核心能力之一；商业助手与
  long-context 模型跨持续交互掉 30% 精度【论文 2410.10813】。
- OpenAI Cookbook 的捕获策略明确"只存 durable、actionable、explicit 的内容，
  不存推断"，PII 与指令型写入在捕获点被拒【官方工程文档】。
- SayHear 的"错误召回比漏召回更伤信任"（arch 08-10 §10.3）在公开证据中没有
  反例；上述三条是从不同方向（拒答能力、衰减、捕获纪律）的同向佐证。

---

## 6. Grounding 与反编造（防 #62 失败模式）

#62 失败模式：模型引用**未被注入**的记忆，或编造"上下文计数"（如虚构"你提过
三次"）。已文档化的对策分三层：

### 6.1 注入层：让"有什么可引用"显式化

- OpenAI Cookbook：memory policy 块显式声明优先级与"不得发明"约束，记忆放
  delimiter 内【官方工程文档】。
- Anthropic memory tool：工具存在时 API 自动注入系统提示"IMPORTANT: ALWAYS
  VIEW YOUR MEMORY DIRECTORY BEFORE DOING ANYTHING ELSE"与 memory protocol、
  "ASSUME INTERRUPTION"——即官方用**确定性注入的协议文本**约束模型先读后用
  【官方文档】。
- 【推断】SayHear 计划的"注入 Claim 时保留 `claim_version_id + evidence_id`，
  不能只发自然语言 memory"（arch 08-10 §9.3）是该层的强化版：引用目标有机器
  可校验的身份。

### 6.2 生成层：约束输出只引用注入内容

- 【推断】公开产品文档中没有找到"强制模型引用注入记忆 ID"的第一方管线描述；
  引用式生成（citation-attributed generation）是学术成熟方向（如 AIS 框架：
  输出须可归因到给定来源），但 SayHear 场景（对话自然语言 + 不要求引用 UI，
  ADR-0008）不适合用户可见引用标记。可行形态是**结构化侧信道**：生成命令的
  validator 检查输出中"我记得 / 你提过"类记忆主张是否对应本 CompiledContext
  的 referenced_evidence_ids——这是设计模式推断，非已文档化产品行为。

### 6.3 事后层：groundedness / 相关性打分与确定性验证

- 【官方文档】AWS Bedrock Guardrails contextual grounding check：输入
  grounding source + query + 待检文本，输出 grounding 分数（响应是否由来源
  支撑，新信息即 ungrounded）与 relevance 分数；阈值 0–0.99（示例 0.7 起滤）。
  **官方明示限制：不支持会话型 chatbot 场景**，流式下可能先流出后判负。
- 【官方文档】Azure AI Content Safety groundedness detection：NLI 型检测，
  Non-Reasoning 模式（快、二值）适合在线，Reasoning 模式给出 ungrounded 片段
  解释适合排障；带 correction 预览（自动改写为来源支撑版本）；**当前仅英文
  优化**。域（Medical/Generic）与任务（QnA/Summarization）可调。
- 【官方文档】NVIDIA NeMo Guardrails：hallucination / fact-checking rails，
  以 LLM 判定输出是否有依据，作为可编排护栏。
- 【官方文档先例】Anthropic memory tool 的命令执行完全在客户端做确定性验证
  （路径校验、大小上限、敏感数据剥离）——"模型提议 + 代码裁决"的同构先例，
  支持 SayHear 把"引用合法性检查"放进 validator 而非模型自觉。
- 【推断】针对"编造计数"（#62）：计数类主张（"N 次"、"每次"）无法靠 NLI 捕捉
  （NLI 只看蕴含），需要确定性查询 Evidence/Claim 链接表核对频次，或约束模型
  不做计数表述。此为本报告推断，未见公开产品文档化方案。

---

## 7. 评测

### 7.1 LoCoMo（arXiv 2402.17753）

- 构造：machine-human pipeline（persona + 时间事件图驱动的 agent 对话 + 人工
  校验编辑），50 段对话、平均 ~300 turns / 9.2K tokens / 19.3 sessions，跨度
  数月；7,512 题：single-hop 36% / multi-hop 14.6% / temporal 20.6% /
  open-domain 3.9% / **adversarial 24.9%**（不可回答，考察拒答）。
- 关键结果：人类 87.9 F1 遥遥领先（temporal 92.6）；最强模型组合 ~41.4
  （RAG + observations）；16K long-context 在 adversarial 崩溃（2.1）；
  temporal 是模型最弱项（与人类差 ~73%）。
- 已知弱点（多篇论文转引）：对话仅 ~9–10K tokens，现代模型可直接塞进窗口
  （MemoryAgentBench 因此判定其"不再构成挑战"）；adversarial 类在 mem0 评测中
  因无 ground truth 被整体剔除；Zep 官方博客指出其 speaker 归属错误、多模态
  错误、含混问题；**mem0 论文报告的子集（10 段、~26K tokens/段）与原论文规模
  口径不一致**，复用时必须声明切片。

### 7.2 LongMemEval（arXiv 2410.10813，ICLR 2025）

- 构造：500 题人工精修，嵌入**可自由伸缩**的 user-assistant 历史（论文实验
  ~115K tokens 均值）；五项能力：信息抽取、跨会话推理、时间推理、知识更新、
  abstention；六类问题（single-session-user / assistant / preference、
  multi-session、temporal-reasoning、knowledge-update）。
- 关键结果：商业助手与 long-context 模型跨持续交互掉 30%；提出 indexing /
  retrieval / reading 三段分解 + 三项优化（§5.1）。
- 位置：目前公开系统（Zep）与 mem0 之争中双方都认可的"更可信"基准；但
  MemoryAgentBench 批评其对话合成痕迹重、交互模式不够真实，且只覆盖 AR 类
  能力。

### 7.3 MemoryAgentBench（arXiv 2507.05257，v4 2026-06）

- 动机：既有基准要么历史太短（LoCoMo），要么静态整块上下文（读理解式泄漏），
  无法测"增量交互式积累信息"的记忆 agent。
- 构造：4 项能力 × 14 任务 × 2,071 题，上下文深度 103K–1.44M tokens：
  Accurate Retrieval（4）、Test-Time Learning（6）、Long-Range Understanding
  （2）、**Selective Forgetting（2，MQUAKE 反事实编辑对构造的 FactConsolidation）**。
- 关键结果（overall，GPT-4o-mini 骨干除注明）：GPT-5-mini(400K) 60.6 最高；
  骨干模型 Claude-3.7 49.6、GPT-4o 48.8；BM25 41.5（AR 60.5，超骨干基线）；
  agentic memory 普遍更低：MIRIX 37.7（换强骨干 +9.7）、MemGPT 28.3、Zep 24.0、
  Mem0 21.1、Cognee 20.6、GraphRAG 23.4。
- **Selective Forgetting 是普遍失败点**：多跳冲突最高仅 28%（GPT-5-mini），
  多数记忆系统 1–7%——"新证据到来后正确覆盖旧值"是全行业未解问题。
- 结论：RAG 强在 AR；long-context 强在 TTL/LRU；agentic memory 高度依赖骨干
  模型强度；**没有任何系统同时掌握四项能力**。

### 7.4 DynamicMem（arXiv 2606.22877，2026-06）

- 动机：真实画像证据"很少显式陈述或集中一处"，且现有基准无跨 app 行为证据、
  用户只有单一画像、画像冻结或无因漂移、只在单一历史长度评测。
- 构造：15 个月 / 用户 ~2.2M tokens / 10 用户 / 16 apps / 17,715 个有状态事件，
  画像分 attributes（离散、事件驱动）/ habits（中期、可回退）/ preferences
  （渐变漂移），变化带原因标注；两类任务（State Completion 补全当前画像 /
  Personalized Service 泄漏安全地用画像行动），5 个季度检查点。
- 关键结果：随历史增长 State Completion 掉 4.4–16.7 分而 Service 持平——
  **分歧式缩放**；preferences 掉最多（至 ~26 分）；retention 与 update 无系统
  兼得（append-only 善变值、consolidation 善去重但糊新旧）；**>93% 失败来自
  检索而非回答模型**。

### 7.5 基准之争（冲突证据，如实记录）

- 【论文 vs 论文】mem0 自报 LoCoMo overall J 66.88（graph 68.44）> Zep 65.99；
  并记录 Zep 新记忆"数小时后才可检索"与 600K+ token 冗余存储。
- 【官方博客 vs 论文】Zep 官方博客（2025-05）指控 mem0 评测 Zep 时三处配置
  错误（双参与者都标成 user、时间戳写在正文而非 `created_at` 字段、串行检索
  虚增延迟），自报修正后 75.14% ± 0.17（后续帖称 80%），并指 LoCoMo 存在
  speaker 归属 / 多模态 / 问题含混等质量问题，推荐 LongMemEval。
- 【第三方】mem0 回应帖质疑 Zep 评测；getzep/zep GitHub issue #5 的第三方复测
  把 Zep 的 LoCoMo 数字修正为 ~58.44%。
- 教训（推断）：**记忆基准对实现配置极度敏感，厂商排行榜数字不可直接引用**；
  任何对外数字必须附完整配置与切片说明。这与 map #90 "研究只用一手来源、
  分开标注文档化行为与推断"的纪律同源。

### 7.6 产品语境下的评测（recall precision vs. intrusiveness）

- 基准测的是"该记的能否答出"（recall / QA），**不测"不该记的是否被强行塞入
  对话"（intrusiveness）**；SayHear 的信任模型（错误召回 > 漏召回的伤害）没有
  现成基准覆盖。
- 已文档化的产品内评测形态：
  - Tolan：以"产品内挫败感信号"度量召回未命中（迭代后 -30%）、次日留存 +20%
    【官方案例】——不读内容正文的遥测式质量度量；
  - Nomi Aurora：并排危机场景对照作为回归评估形态【第一方，本库已核】；
  - OpenAI Cookbook：分层 eval 指标（write rate / blocked rate /
    time-to-personalization）【官方工程文档】。
- SayHear 的对应资产：#62 盲评 pairwise 协议（canon）、scenario-pack:v2 memory
  fixtures、行为契约跨日记忆判据（漏召回与越界引用都是缺陷，arch 24-29 §25
  1A.3a 退出条件）、ADR-0110 人工味觉终裁、ADR-0114 分层抽样盲评。**公开证据
  没有比这更适合"precision vs intrusiveness"的产品内方案**；基准只应作为工程
  冒烟（回归抽取 / 检索质量），不应作为产品验收。

---

## 8. 已文档化的框架与前沿产品管线

### 8.1 mem0（开源 + 论文）

两阶段（抽取 per message-pair + update 四操作）+ 异步摘要；向量检索 top-s；图
变体 Neo4j 实体 / 关系 + invalid-not-delete。LoCoMo 自报与被质疑数字见 §7.5。
文档化记忆类型分类（docs.mem0.ai）与论文一致。定位：工程上最轻的"事实库 +
去重"参考实现。

### 8.2 Letta / MemGPT

- MemGPT【论文 2310.08560】：OS 式虚拟上下文管理——context window 为"主存"，
  外部存储为"辅存"，模型通过 function call 自主换页（archival 存取、recall
  检索、core memory 块自编辑）；DMR 基准 93.4%。
- Letta 产品化【官方文档】：memory blocks（始终在上下文的自编辑块）与
  archival / recall 分层；sleep-time agents 在交互间隙离线整理记忆（论文量化
  见 §3.1）；SDK 中 sleep-time agent 可写 supervisor 的 archival memory。
- MemoryAgentBench 中 MemGPT 28.3（GPT-4o-mini 骨干）——自编辑式记忆对骨干
  模型强度高度敏感。

### 8.3 Zep / Graphiti（开源）

时间知识图谱 + bi-temporal + 混合检索 + 多 reranker（§4.2 / §5.1）。工程教训：
增量图构建的异步延迟（mem0 实测数小时）与存储膨胀（600K+ tokens/对话）；
需要周期性全量社区重算。长历史（LongMemEval-s 115K）上是公开最强成绩之一
（71.2，gpt-4o）。

### 8.4 LangChain / LangGraph / LangMem（官方文档）

CoALA 式三分类（semantic 事实 / episodic 经历 / procedural 指令，后者最常见
形态是自改 prompt）；hot path vs background 二分（§3.1）；**profile vs
collection** 权衡：collection 下游 recall 更高、信息损失更少、LLM 生成新对象
比整合旧对象更可靠，但需处理 delete/update 倾向偏差与检索复杂度；profile 上下
文统一但随规模增长易错（缓解：strict decoding、拆多文档）。LangGraph store
支持向量 + 过滤的跨 namespace 检索。

### 8.5 OpenAI

- ChatGPT 记忆【官方文档 help.openai.com】：双轨——legacy saved memories
  （显式"记住我是素食者"式离散条目，可增删改）与新记忆系统（对 chats / files /
  connected apps 的"持续更新的综合"，memory summary 可编辑、可手动刷新；
  book icon 展示本条回答用了哪些来源，可纠正 / 标记不相关 / 删除 referenced
  chat）；Temporary Chats 不读不写；删除的 memories 最多留 30 天安全日志。
  内部触发时机与检索机制未公开。
- Agents SDK personalization Cookbook【官方工程文档】：§3.1 / §4.1 /
  §5.4 已详述——state-based 优先于 retrieval-based（对连续性 / 覆盖场景）、
  结构化 profile + notes 分层、recency top-k 注入、显式 policy 块、分层
  guardrail、成熟路径"零样本 → 收集失败 → 微调小型 memory 专责模型 → 复评"。
- Tolan 案例【官方案例】：turn-level 多查询检索 + 每夜压缩 + 每轮重建 context
  + 挫败感遥测（本库 companion 调研 §8.5 已核，此处不重复）。
- Agents SDK 文档区分 session memory（消息历史）与 agent memory（跨 run 学习）
  【官方文档】。

### 8.6 Anthropic

- Memory tool【官方文档，platform.claude.com】：`memory_20250818`，Claude 4+
  全系可用；客户端文件式 `/memories` + 六命令；应用侧负责路径校验、敏感数据
  剥离、大小上限、过期清理；自动注入"先看记忆目录"协议；与 context editing /
  compaction 配套；多 session 模式（progress log + checklist）官方推荐。
- Context engineering【官方工程文档】：attention budget、compaction、结构化
  note-taking（Pokémon 千步精确计数例）、JIT 检索（保留轻量引用 + 运行时取）、
  sub-agent 干净上下文 + 1–2K 摘要回传。
- 定位：Anthropic 公开的是**机制原语**（文件命令 + 协议），不是产品化记忆管线；
  治理（准入、冲突、遗忘语义）全部留给应用层——正好是 SayHear 领域模型负责的
  部分。

### 8.7 Google Gemini

【官方博客 + 隐私中心】三来源个性化：saved info（用户显式分享，可管理）+
past chats（Advanced 订阅跨对话引用，45+ 语言铺开）+ Search history（opt-in
实验，推理模型自行判断何时值得引用）；个性化回答附来源 outline 与断开
Search history 的一键横幅；未成年 / EEA / 英国 / 教育版排除。形成机制只公开了
saved info 的显式路径，自动抽取未文档化。

---

## 9. 证据冲突与不确定性汇总

1. **full-context vs 记忆系统的分歧结果**：短历史下 full-context 精度最高
   （mem0 论文 72.90 vs 68.44；DMR 全对话 gpt-4-turbo-mini 98.0）；长历史
   （115K+）下记忆系统反超（Zep LongMemEval 71.2 vs 60.2；LongMemEval 论文
   30% 衰减）。两组结果都可信，分界变量是历史长度与 context rot。SayHear 的
   多月日记场景处于长历史侧，且成本 / 延迟预算（ADR-0111）独立支持编译式
   注入。
2. **mem0 vs Zep 的 LoCoMo 之争**：双方互指对方配置错误，第三方复测又修正
   Zep 数字（75–84% → ~58%）。任何 LoCoMo 数字引用必须附配置；该基准不宜作
   选型依据（§7.5）。
3. **图记忆的收益不确定**：mem0ᵍ 在自家 LoCoMo 上只 +2% 且 single/multi-hop
   反而低于 flat 版；MemoryAgentBench 上图谱系整体低于 BM25。图结构的确定
   收益只在关系型问题（Zep 强项）与时间推理（bi-temporal）。
4. **异步后台构建的延迟代价**：Zep 的"数小时不可检索"（mem0 实测）与 Zep 自报
   的 2.58s 检索延迟并不矛盾（后者是稳态），但说明后台管线的"新信息可见性
   SLA"必须在设计里显式处理。SayHear 快速路径"允许为同日后续交流提供
   session-local context"正是在补这个洞。
5. **LoCoMo 规模口径**：原论文 ~9.2K tokens/段 vs mem0 报告的 ~26K tokens/段
   （10 段子集）。复用任何 LoCoMo 数字前先核对切片。
6. **A-Mem 的成绩分歧**：mem0 论文中 A-Mem LoCoMo overall 48.38（很低），
   A-Mem 自报显著优于基线——又一例配置敏感。
7. **NLI 型 groundedness 服务的适用边界**：Bedrock 明示不支持会话 chatbot；
   Azure 仅英文。SayHear 双语 + 对话场景不能直接采购即用，只能借鉴模式。

---

## 10. 建议：映射到 SayHear 已定架构

以下按主题给出"证据支持什么 → 已定设计哪里已被验证 → 什么留给决策工单
（#96 检索与注入、#97 grounding 与评测等）"。**不提议替换任何已定模型**。

### 10.1 抽取时机

- **证据支持**：会话内轻量抽取（staging / candidate）+ 异步 consolidation +
  夜间压缩是公开系统的一致形态（mem0、OpenAI Cookbook、Letta sleep-time、
  Tolan、LangChain hot/background 二分）；两阶段比一步到位可靠（OpenAI
  Cookbook）；离线整理可以省 wake-time 计算（Letta 5x）但收益依赖查询可预测度。
- **已定设计已被验证**：两速系统（arch 11-12 §12.1）完全落在共识区间；
  "快速路径不阻塞回复"与 hot-path 延迟证据一致；"慢速路径做跨 Session 门槛 /
  merge / supersede"对应 consolidation 共识，且 SayHear 的 ADR-0039（Impression
  跨两 Session 独立 Evidence）比任何公开系统都严格，方向与 DynamicMem
  "retention 与 update 分目标"一致。
- **留给决策工单的 v1 参数**：
  1. 快速路径触发粒度：per 重要 User Event（现文档口径）vs Continuous Exchange
     结束批量——mem0 的 per-message-pair 与 OpenAI 的 per-turn 蒸馏都证明 per-
     event 可行，成本是抽取调用次数；建议以 `memory-extract/<event-revision-id>`
     幂等键 + Exchange 末去重合并评估；
  2. 同日可见性 SLA：Zep "数小时延迟"教训 → v1 需定义快速路径产物何时可被
     session-local context / 当日后续检索使用；
  3. 慢速路径是否引入 Letta 式"预计算"（如预热 Person Portrait 候选）——
     sleep-time 证据支持，但 v1 可先不做。

### 10.2 记忆 Schema

- **证据支持**：离散 claim 条目 + 显式更新语义优于原地重写（LangChain
  profile/collection、DynamicMem retention-vs-update、MemoryAgentBench SF
  全行业失败）；时间有效性用 bi-temporal（Zep）而非删除（mem0ᵍ invalid-not-
  delete）；provenance 公开系统最弱、行业趋势是可见 + 可纠正。
- **已定设计已被验证**：ClaimVersion append-only + current 指针 + 显式
  supersede/retract 正是 DynamicMem 结论的形态；EvidenceItem 的"不存第二份
  事实、可删除传播的 typed reference"超出全部公开系统（是差异化，也是成本）；
  Predicate Registry 的受控谓词在公开系统中最接近的是 Zep 大写关系类型 +
  mem0ᵍ 关系标签，但无治理先例——既说明 SayHear 在解决公开系统普遍的
  自由漂移问题，也说明治理成本无外部经验可抄（推断）。
- **留给决策工单**：
  1. v1 Predicate 初始集合的规模与粒度（map #90 已列 1A.3a 范围含初始集合）；
  2. Claim canonical key 之外是否需要轻量"话题/关键词"辅助索引字段（OpenAI
     Cookbook 的 keywords、LongMemEval 的 fact-augmented key 都支持，可先以
     Entity/Predicate 结构化字段替代，避免自由文本 schema 膨胀）；
  3. 会话摘要层维持 1A.2 既有设计（12 events / 3,000 tokens 阈值），无需为记忆
     新增摘要层——摘要只作上下文压缩、不作事实真源的证据充分（LoCoMo 中
     summary 检索基线明显低于 observation 检索）。

### 10.3 检索

- **证据支持**：混合（向量 + 词法 + 结构化 filter）优于单路；查询构建不只看
  最后一句话（Tolan 合成问题、LongMemEval time-aware expansion、Zep 多路）；
  rerank 用 RRF 起步、交叉编码器按需；recency 用于冲突消解与注入排序，不用于
  事实置信度衰减（§5.3）；注入面 1–4K tokens 是行业实践量级；检索是 >93% 的
  失败源，值得最高工程投入（DynamicMem）。
- **已定设计已被验证**：arch 08-10 §10.1–10.3 的多路查询构建、结构化 filter
  优先、canonical key 精确匹配、精度优先、Impression 限量、每召回保存
  retrieval manifest（候选 / 选择 / 淘汰理由）——manifest 直接对应 DynamicMem
  "失败在检索"的诊断需求与 ADR-0111 的 tuning 数据来源；pgvector 可重建
  （ADR-0064）与 Tolan"向量只是检索层"一致。
- **留给决策工单**：
  1. v1 是否启用 Postgres FTS（tsvector / Paradedb 类）作词法一路——BM25 证据
     支持，但 v1 记忆量小（单用户），Entity/canonical-key 精确路径可能已够；
  2. reranker 选型：无 / RRF / 交叉编码器（Zep 五种可选，成本递增）；
  3. recency 权重的具体形式（仅排序 tie-break vs 显式衰减函数，Vespa 式
     exponentialDecay 可参考）；
  4. Embedding 模型与维度（arch 08-10 §10.4 已要求记录 provider/model/dimension，
     选型是工单参数）；
  5. 预算 v1 数值的调整流程（ADR-0111 已定为版本化默认 + retrieval manifest
     实测调整；公开证据无量级反例）。

### 10.4 Grounding / 反编造

- **证据支持**：三层模式（注入协议 → 生成约束 → 事后验证）各自有文档化先例
  （§6）；Bedrock/Azure 的 NLI 打分有场景限制（非 chatbot / 仅英文）；
  Anthropic 客户端确定性验证是"模型提议 + 代码裁决"的先例；产品化来源展示
  （book icon / banner）证明"被问能答"在产品上可行且被行业采纳。
- **已定设计已被验证**："只引用注入证据"guard（1A.3a 范围、#62 对策）与
  Memory Source Explanation 只从实际选中 ClaimVersion + Evidence 生成
  （arch 08-10 §10.3）同时落在注入层（claim_version_id + evidence_id 随条注入）
  与事后层（Source Explanation = 可展开验证）。
- **建议（推断层）**：
  1. 确定性子集检查：validator 校验"输出中的记忆主张 ⊆ CompiledContext
     referenced_evidence_ids/referenced_version_ids"——成本极低，建议进 v1；
     对计数类主张（#62 的"三次"型）单独处理：要么禁，要么生成前确定性查询
     claim_evidence_links 计数；
  2. NLI 型 post-hoc 打分（Bedrock/Azure 模式）建议**只进 eval / Inspector**，
     不进在线阻断路径——两服务的官方限制（非 chatbot、仅英文、流式滞后）与
     SayHear 双语对话场景冲突，且 ADR-0110 人工味觉终裁下机械打分只做结构
     预筛；
  3. 行为契约把"越界引用"与"漏召回"并列为缺陷（arch 24-29 §25 已定）——
     与 LoCoMo adversarial（拒答能力）+ LongMemEval abstention 的设计共识
     一致，无需改动。
- **留给决策工单**：guard 的阻断语义（validator 拒绝 + 单次修复重试 vs 仅记录
  进 retrieval manifest / Inspector 供盲评）。

### 10.5 评测

- **证据支持**：四个基准各测一面（LoCoMo QA recall + 拒答、LongMemEval 长历史
  五能力、MemoryAgentBench 四能力含选择性遗忘、DynamicMem 15 个月演化）；
  全部不测 intrusiveness；厂商排行榜配置敏感（§7.5）；产品内评测的行业形态
  是行为信号遥测 + 并排对照 + 分层 eval 指标（§7.6）。
- **已定设计已被验证**：#62 盲测 pairwise 协议、scenario-pack:v2 memory
  fixtures、行为契约跨日记忆判据（漏召回与越界引用都是缺陷）、ADR-0110 /
  ADR-0114 人工终裁与抽样——公开证据中没有更合适的"precision vs
  intrusiveness"度量；"基准只做工程冒烟"的边界与基准之争教训一致。
- **建议（推断层）**：
  1. 工程冒烟可自建合成子集（多日、跨 Session、含"已改变的事实"与"不该记的
     问题"），结构上向 MemoryAgentBench SF 类与 DynamicMem 的"变化带原因"
     靠拢——这直接对上 map #90 "Not yet specified" 第一条（多日合成 eval 语料
     深度），由验收门 ticket 定夺；
  2. 遥测指标采用 OpenAI Cookbook 命名法（memory_write_rate / blocked_write_
     rate / time_to_personalization 的 SayHear 等价物：候选准入率、rejection
     率、首次召回命中）+ Tolan 式不读正文的行为信号（若产品侧可获取）；
  3. 检索质量回归用 retrieval manifest（已内建于 CompiledContext）而非新增
     评测基建。

### 10.6 与已定边界无冲突确认

本报告未发现任何一条证据要求改变已定产品法或架构边界；所有映射都在参数层。
最接近"外部实践更宽"的三处（Nomi 对话外主动消息、Tolan 静默删除低价值记忆、
Kindroid imminence 阈值）已在 companion 调研中判定为冲突并维持 SayHear 立场，
本报告不重开。

---

## References（一手来源索引）

- mem0：arxiv.org/abs/2504.19413（论文）、docs.mem0.ai（文档）
- MemGPT / Letta：arxiv.org/abs/2310.08560、arxiv.org/abs/2504.13171（sleep-time）、docs.letta.com（archival memory 等）
- Zep / Graphiti：arxiv.org/abs/2501.13956、blog.getzep.com/lies-damn-lies-statistics-is-mem0-really-sota-in-agent-memory/（2025-05 评测批评）、mem0.ai/blog/zep-vs-mem0-which-ai-memory-layer-should-you-choose（回应）、github.com/getzep/zep/issues/5（第三方复测）
- A-Mem：arxiv.org/abs/2502.12110（NeurIPS 2025）
- 基准：arxiv.org/abs/2402.17753（LoCoMo）、arxiv.org/abs/2410.10813（LongMemEval，ICLR 2025）、arxiv.org/abs/2507.05257（MemoryAgentBench，v4 2026-06）、arxiv.org/abs/2606.22877（DynamicMem，2026-06）
- OpenAI：help.openai.com/articles/8590148-memory-faq、help.openai.com/en/articles/11391654（Business release notes，referenced chat 控制）、openai.com/index/memory-and-new-controls-for-chatgpt、developers.openai.com/cookbook/examples/agents_sdk/context_personalization（state-based personalization）、developers.openai.com/cookbook/examples/agents_sdk/building_reliable_agents_memory_compaction、openai.github.io/openai-agents-python/sandbox/memory/（agent vs session memory）、openai.com/index/tolan/（官方案例）
- Anthropic：platform.claude.com/docs/en/agents-and-tools/tool-use/memory-tool（memory tool）、anthropic.com/engineering/effective-context-engineering-for-ai-agents（context engineering）、anthropic.com/engineering/advanced-tool-use
- Google：blog.google/products-and-platforms/products/gemini/gemini-personalization/、support.google.com/gemini/answer/13594961（隐私中心）
- LangChain / LangGraph / LangMem：docs.langchain.com/oss/python/concepts/memory（memory concepts）、langchain-ai.github.io/langmem/concepts/conceptual_guide/
- Grounding 服务：docs.aws.amazon.com/bedrock/latest/userguide/guardrails-contextual-grounding-check.html、learn.microsoft.com/en-us/azure/ai-services/content-safety/concepts/groundedness、docs.nvidia.com/nemo/guardrails/configure-guardrails/guardrail-catalog/fact-checking
- 检索基建：docs.vespa.ai/en/ranking/ranking-expressions-features.html（recency/freshness）、docs.vespa.ai/en/ranking/phased-ranking.html
- 本库内部：docs/research/companion-warmth-curiosity-continuity-research.md（Tolan / Nomi / Character.AI 等第一方核对，本报告不重复引用其细节）、docs/architecture/07-07-12-knowledge-data-model.md、docs/architecture/08-10-conversation-runtime.md、docs/architecture/11-12-journal-memory-workflows.md、docs/architecture/24-29-testing-and-delivery.md §25、ADR-0064 / ADR-0111 及 memory ADRs（0008–0053、0087–0089）

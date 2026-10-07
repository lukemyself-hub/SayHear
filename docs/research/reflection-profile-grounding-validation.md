# Reflection 与叙事 Profile 的证据归属和验证方法

> 状态：研究输入，非产品或架构决定
>
> 更新时间：2026-09-02
>
> 关联 Issue：[Research evidence-grounded Reflection and narrative Profile validation](https://github.com/lukemyself-hub/SayHear/issues/165)

## 1. 结论摘要

1A.3b 不需要发明一套新的“LLM 可信度分数”。更可靠的做法是把生成和验证都落到
可枚举的语义单位上，并保留两个方向的检查：

1. **从正文回到来源，检查 precision。** 把每个 Bio 或 ReflectionStatement 拆成
   atomic proposition，逐项判断它是否被所声明的 ClaimVersion 或 EvidenceItem
   完整支持，是否与任一有效输入矛盾。FActScore、AIS 和 ALCE 都把长文本的归属问题
   落到这种细粒度判断，而不是给整篇文字一个总体“可信”分数
   （[FActScore](https://aclanthology.org/2023.emnlp-main.741/)、
   [AIS](https://direct.mit.edu/coli/article/49/4/777/116438/Measuring-Attribution-in-Natural-Language)、
   [ALCE](https://aclanthology.org/2023.emnlp-main.398/)）。
2. **从来源回到正文，检查 coverage。** 只做上一项会奖励“少写少错”。FineSurE
   先建立 key fact 集合，再逐项判断每个 key fact 是否能从生成文本推得，用这种
   source-to-output alignment 衡量 completeness；论文报告它比整篇 Likert 打分更接近
   人工 completeness 判断（[FineSurE](https://aclanthology.org/2024.acl-long.51/)）。
   对 SayHear，key fact 不应由 Profile LLM 临时发明，而应由冻结的 eligible
   ClaimVersion 集合和版本化 coverage policy 产生。
3. **机器语义判断必须校准，不能冒充确定性真值。** SummaC 在六个一致性数据集上的
   balanced accuracy 为 74.4%；QAFactEval 发现 QA 与 NLI 信号互补；ALCE 的自动
   citation recall 对人工标签准确率为 85.1%，citation precision 为 77.6%。这些方法
   适合找错、回归和路由 `needs_review`，但现有证据不足以支持“一个 NLI/LLM 分数
   单独批准私人 Profile 发布”
   （[SummaC](https://direct.mit.edu/tacl/article/doi/10.1162/tacl_a_00453/110014/SummaC-Re-Visiting-NLI-based-Models-for)、
   [QAFactEval](https://aclanthology.org/2022.naacl-main.187/)、
   [ALCE](https://aclanthology.org/2023.emnlp-main.398/)）。
4. **lineage 和 epistemic authority 必须分开。** W3C PROV 把 derivation 定义为
   一个 entity 对另一个 entity 的生成影响，并明确指出“某个输入被 activity 使用”
   并不足以证明输出由它派生。SayHear 因此需要同时保存运行 lineage 和实际
   statement support，不能因为 Reflection 参与过某次运行就让 Reflection 正文成为
   Evidence（[W3C PROV-DM](https://www.w3.org/TR/prov-dm/)）。
5. **Profile validator 要验证正文和 support manifest 的共同结果。** 仅要求模型返回
   Claim ID，不能证明那条 Claim 支持正文。仅在生成后让另一个模型猜来源，也容易
   产生 post-hoc citation。ALCE 的实验显示，闭卷生成后再补 citation 的 citation
   recall 在 ASQA 上低 47%。1A.3b 应让生成器同时输出叙事正文与
   statement-to-source support，再对二者做独立验证
   （[ALCE paper §4.3–§5](https://aclanthology.org/2023.emnlp-main.398/)）。

本报告不讨论检索、rerank、Embedding 或 Memory 注入。那些问题已由
[#92](https://github.com/lukemyself-hub/SayHear/issues/92) 调研。这里假定 1A.3a 已经
给出冻结且通过准入的 ClaimVersion 与 EvidenceItem，研究的是如何把它们安全地变成
Reflection 和叙事 Profile，并验证结果。

## 2. SayHear 已定边界

研究建议以仓库当前边界为前提，不替代它们：

- Reflection 是版本化、非权威派生观察。每个 ReflectionStatement 必须通过 typed
  link 回到 final / corrected User Event Revision；Reflection 文本不能成为 Claim 的
  primary evidence，也不能成为自身或后续 Reflection 的自证来源
  （[GLOSSARY.md](../../GLOSSARY.md)、
  [知识数据模型 §7.9](../architecture/07-07-12-knowledge-data-model.md)、
  [ADR-0087](../adr/0087-evidence-item-is-a-typed-reference-to-user-event-revisions.md)）。
- Bio 是从全部 eligible ClaimVersion 生成的可重建叙事，不是 Memory
  真源。事实判断只能由 active Objective Memory 支持；可独立成立的心理、情感和
  价值观判断只能由 active AI Impression 支持
  （[ADR-0055](../adr/0055-profile-is-an-llm-written-semantic-projection.md)）。
- 每个版本冻结 source revision、Prompt、Schema、policy、model attempt 和 data
  epoch。current Reflection 使用 exact-head freshness；Profile 以冻结的
  `source_claim_set_revision + data_epoch` fenced commit
  （[ADR-0074](../adr/0074-versioned-domain-artifacts-require-lineage.md)、
  [ADR-0083](../adr/0083-generation-commands-use-versioned-freshness-policies.md)）。
- Profile 不进入 Conversation Context，也不能成为 Journal、Reflection 或 Memory
  Evidence；Reflection Inspector 只读
  （[ADR-0054](../adr/0054-reflection-is-inspected-not-productized-in-phase-one.md)、
  [ADR-0111](../adr/0111-persona-and-conversation-state-inputs-are-compiled-versioned-contracts.md)）。

## 3. 外部方法能解决什么

### 3.1 Atomic proposition，而不是句子级全有或全无

FActScore 的核心单位是 atomic fact。论文指出，ChatGPT 传记平均每句含 4.4 个
atomic facts，且 40% 的句子同时混有 supported 与 unsupported 信息。把整句标成
“支持”会掩盖这种局部越界。其流程是先把长文本拆成单一信息单元，再逐项判断是否由
给定知识源支持；官方实现和人工标注也已公开
（[paper](https://aclanthology.org/2023.emnlp-main.741/)、
[code](https://github.com/shmsw25/FActScore)）。

这项方法可以直接迁移到 SayHear，但来源不同：

| 生成物 | 待检查单位 | 允许的支持来源 |
| --- | --- | --- |
| Daily / Weekly Reflection | ReflectionStatement 内的 atomic proposition | 该 Statement 声明的 EvidenceItem 集合；EpisodeVersion 可以帮助组织输入，但不能替代底层 Evidence |
| Profile Bio | Bio statement 内的 atomic proposition | 该 statement 声明的 active ClaimVersion 集合，Claim 再展开到底层 User Evidence |

一个自然语言句子可能同时包含人物关系、时间和心理判断。validator 必须允许它拆成多个
proposition，并分别检查 kind。例如“Mike 是他哥哥，这段关系也让他更害怕冲突”至少
包含一个 Objective proposition 和一个 Impression proposition，不能用 sibling Claim
替第二个判断背书。

FActScore 的传记实验主要评价可外部核验的事实，不覆盖 SayHear 这种已准入但仍为
`impression + inferred` 的心理理解。因此 1A.3b 应借它的**原子化方法**，不能照搬
“事实真伪”语义。AI Impression 的问题是“是否忠实表达这条 active inferred
Claim”，不是“它是否为客观真相”。

### 3.2 Attribution 需要先解释正文，再判断来源是否支持

AIS 把人工归属判断拆成两步：先写出系统回复实际表达了什么，再判断这些信息是否准确
代表给定来源。研究在对话问答、摘要和 table-to-text 三类任务上验证了这套标注流程，
并取得中等到高的标注者一致性。完整 guidelines 与数据已公开
（[paper](https://direct.mit.edu/coli/article/49/4/777/116438/Measuring-Attribution-in-Natural-Language)、
[dataset and guidelines](https://github.com/google-research-datasets/AIS)）。

这个顺序对 Profile 很关键。validator 不能只问“Claim X 和这句话看起来相关吗”，
而要先把代词、省略、否定、时间限定、因果连接和认识口吻展开成 standalone
proposition，再判断：

- linked source 是否**联合完整支持** proposition；
- proposition 是否添加了 source 没有的因果、频率、稳定性或全局人格判断；
- 同一 proposition 是否与冻结输入中的 counter Evidence 或另一 active Claim
  实质矛盾；
- Objective 与 Impression 的认识状态是否在叙事中被升级或互换。

这应产生逐项 verdict 和 reason code，不产出一个可以掩盖局部错误的平均分。

### 3.3 Output-to-source precision 和 source-to-output coverage 是两个问题

ALCE 分开测 citation recall 和 citation precision。前者问一段输出的所有主张是否被
它的 citation 集合完整支持；后者问每条 citation 是否真的有帮助。论文的自动方法用
NLI 做句段级 entailment，并与人工 citation recall 达到 Cohen's kappa 0.698
（[paper](https://aclanthology.org/2023.emnlp-main.398/)、
[code](https://github.com/princeton-nlp/ALCE)）。这给 1A.3b 两个直接启发：

- support 集合应当能**联合支持** proposition。一个 proposition 可以需要多条
  Evidence 或 Claim，不能要求每个 source 单独支持全部内容。
- support 集合也不能塞入大量“可能有关”的 Claim 来碰运气。每个 narrative-support
  link 都应有可核查作用；无关 link 会放大人工审查成本，并掩盖真实来源。

但 citation recall 仍是 output-to-source 指标。一个只写两句且都正确的 Bio 可以得
高分，却丢掉用户最重要的关系和价值观。FineSurE 用 keyfact alignment 补上反方向：
逐项判断每个 source key fact 是否能从 summary 的哪些句子推得，并把 coverage 与
faithfulness 分开报告。论文公开的人工对齐协议要求输出 binary Yes/No 和对应句号，
而不是给整篇摘要一个主观分数
（[paper](https://aclanthology.org/2024.acl-long.51/)、
[code](https://github.com/DISL-Lab/FineSurE-ACL24)）。

对 SayHear 的迁移不应是“要求每条 Claim 都逐字出现”。建议冻结两层 source units：

1. `eligible_claim_versions` 是完整输入清单，不能漏传、静默裁剪或按敏感性二次排除。
2. `coverage_units` 由版本化 policy 把 ClaimVersion 归并成可叙事压缩但仍可独立核查的
   语义单位。例如同一项目的名称、当前阶段和长期意义可以是三个 unit，也可以在 policy
   明确时压成一个 composite unit；组成 ClaimVersion ID 必须全部保留。

对每个 coverage unit，validator 记录 `expressed`、`faithfully_compressed` 或
`absent`，并列出 Bio statement IDs。`absent` 不能被平均分隐藏；是否足以造成“失真
人物画像”需要版本化 materiality rule 和人工校准集。研究证据不支持让 Profile LLM
自己声明“这条不重要”并自动通过。

### 3.4 NLI、QA 与 LLM fact-checker 适合组合找错，不适合单点授权

SummaC 发现直接把整篇 source 与整篇 summary 交给 NLI 效果差，原因是训练粒度和
任务粒度不匹配。它把 source 与 summary 都分成句子，建立两两 entailment matrix 再
聚合，在六个数据集上取得 74.4% balanced accuracy
（[paper](https://direct.mit.edu/tacl/article/doi/10.1162/tacl_a_00453/110014/SummaC-Re-Visiting-NLI-based-Models-for)、
[code](https://github.com/tingofurro/summac)）。这支持 1A.3b 使用 statement / atomic
proposition 级检查，反对整篇 Bio 对整包 Claim 的一次判断。

QAFactEval 从生成文本提问，再用 source 回答并比较答案。论文发现问题生成、
answerability filtering 和答案比较组件会显著改变结果；优化后比旧 QA 指标平均提高
14%，并且 QA 与 entailment 信号组合后更强
（[paper](https://aclanthology.org/2022.naacl-main.187/)、
[code](https://github.com/salesforce/QAFactEval)）。Profile 可以用这一路检查容易被
NLI 漏掉的实体、数量、时间和关系角色，但 QA 生成本身也可能漏问，不能替代完整
support manifest。

MiniCheck 把多种 grounded-generation 数据集合并成 LLM-AggreFact，并训练小型
sentence-level fact checker；论文报告它达到 GPT-4 级 aggregate accuracy，成本低
400 倍，同时能检查跨多个 source 句子的 synthesis
（[paper](https://aclanthology.org/2024.emnlp-main.499/)、
[code](https://github.com/Liyan06/MiniCheck)）。它适合做离线回归和候选 validator，
但其 benchmark 标签仍是人工 sentence-level factual error，不能证明它理解 SayHear
的 Objective / Impression、Forget fence 或 temporal status。采用前必须用 SayHear
自己的中英双语标注集重新校准。

## 4. 建议的 1A.3b 验证契约

以下是根据外部证据和仓库边界形成的设计建议，不是已接受 SPEC。

### 4.1 冻结输入

每个 GenerationCommand 至少冻结：

```text
artifact_logical_id
artifact_kind                 # daily_reflection / weekly_reflection / profile
source_revision               # Reflection
source_claim_set_revision     # Profile
data_epoch
input_item_ids_and_versions
prompt_version
schema_version
generation_policy_version
validation_policy_version
coverage_policy_version       # Profile only
locale
model_config
```

Profile 的冻结包保存完整 `eligible_input`，并把每个 ClaimVersion 的 kind、epistemic
status、lifecycle、EntityVersion、scope、temporal bounds 与 Evidence links 一起传给
生成和验证。Reflection 的冻结包保存 EvidenceItem、source EventRevision、可选
EpisodeVersion 与 scope。模型不可读取 current pointer 后临时变化的新内容。

W3C PROV 把 generation、usage、derivation、revision 和 invalidation 分开，并允许把
derivation 展开为“哪个 activity 使用哪个 entity 生成哪个 entity”的完整路径。这与
SayHear 的 logical identity、immutable Version、GenerationCommand 和 support links
契约一致，也说明 `prompt_version + model_attempt` 只能证明运行来源，不能证明每句
正文的认识论支持（[PROV-DM](https://www.w3.org/TR/prov-dm/)）。

### 4.2 生成输出

生成器返回结构化结果，正文与支持关系同时产生：

```text
artifact_draft
  statements[]
    statement_id
    text
    atomic_propositions[]
      proposition_id
      normalized_proposition
      proposition_kind          # fact / impression / synthesis
      epistemic_rendering       # confirmed / inferred
      support_ids[]             # EvidenceItem or ClaimVersion, never mixed by artifact kind
  profile_coverage[]            # Profile only
    coverage_unit_id
    disposition                 # expressed / faithfully_compressed / absent
    statement_ids[]
```

`normalized_proposition` 和 coverage disposition 都是待验证的模型提案，不是权威数据。
系统可以在独立 validator 中重新分解正文，比较“生成器声明的 propositions”和“验证器
实际读出的 propositions”。二者不一致时进入 `needs_review`，不能只相信生成器清单。

### 4.3 分层 validator

第一层为确定性硬门禁：

- schema、ID、locale、版本和 required field 有效；
- 每个 support ID 都属于冻结输入，且版本完全一致；
- Reflection support 只能是有效 EvidenceItem，Profile support 只能是 eligible
  ClaimVersion；任何 ReflectionVersion、BioVersion、JournalVersion、
  Assistant / System Event 作为事实 source 都拒绝；
- support 能展开到未被删除、final / corrected User Event Revision；
- Profile 的 fact proposition 只能用 Objective support，impression proposition 只能用
  active AI Impression support；混合句先拆成不同 proposition，不得把 kind 或
  epistemic status 升级；
- 每个 eligible input 与 coverage unit 都出现在 manifest，不能因 parse failure 静默
  消失；
- `data_epoch`、source revision / claim-set revision 和 trust fence 在 commit 前仍有效。

第二层为语义验证：

- 独立拆解正文，建立实际 atomic proposition 清单；
- 对每个 proposition 执行 support / unsupported / contradiction / ambiguous 四态判断，
  保存涉及的 source IDs 和理由；
- 对 entity identity、relationship role、否定、数量、时间、scope、因果和频率做定向
  QA 检查；
- 对全部 active input 执行 coverage alignment，逐 unit 输出 expressed / compressed /
  absent，不只给总比例；
- 检查 Bio 的整体组合是否因省略、强调或跨 Claim 连接而形成与 active Memory 实质相反
  的人物画像；这项判断必须保留具体 units 和 statements，不能只留一句“整体通过”。

外部研究支持用 NLI、QA 和 LLM reviewer 组合发现问题，但没有任何一项达到确定性。
因此在 Internal Core 初期，语义 validator 的 `unsupported`、`contradiction`、
`kind_upgrade`、`material_absence` 应阻止自动成为 current，并保留人工 adjudication；
`ambiguous` 不能自动改成 supported。是否允许一次有界 rewrite、何时转
`needs_review`，留给后续 grilling 决定。

### 4.4 Reflection 的专门规则

- Daily 与 Weekly 使用不同 logical Reflection ID 和冻结 scope。
- 每个 ReflectionStatement 都必须有底层 Evidence support。跨日趋势至少要让 support
  覆盖它声称比较的日期或状态；单日 Evidence 不能支撑“最近一直”“越来越”一类趋势。
- Reflection 可以提出 Candidate，但 Candidate 必须复制底层 Evidence IDs，并另存
  `source_reflection_version_id` 作为运行 lineage。Claim validator 永远忽略 Reflection
  正文作为 evidence。
- 后续 Reflection 不应把旧 Reflection 文本放进 evidence set。需要延续观察时重新读取
  仍有效的底层 Evidence；EpisodeVersion 只能帮助组织 scope，仍须展开并产生新的
  Evidence support links。
- source revision 变化、Evidence 删除或 data epoch 变化后，旧版本可以保留最小审计，
  但不得继续驱动 Candidate 或 Profile。

### 4.5 Profile 的专门规则

- `eligible_input` 和 `narrative_support` 分开保存。前者证明完整输入，后者证明正文实际
  依赖；两者不能互相替代。
- generator 不能把 Reflection、Open Loop 或 Candidate 当写作素材。即使某条新洞察
  很自然，也必须先通过 Memory admission 成为 active Claim，之后才能进入下一版 Bio。
- Profile 的每个独立心理或价值观判断必须映射到 AI Impression Claim。多个 Objective
  facts 的共同出现不能由 Profile LLM 自动推出一个新人格标签。
- 语义压缩允许多 Claim 支持一个 statement，也允许一个 Claim 支持多处叙事。validator
  检查的是 proposition-level entailment 和完整 coverage，不要求逐条数据库转写。
- trust-boundary refresh 时，任何引用失效 Claim 的旧 Profile 先停止展示，再重建。
  语义 validator 失败时保持不可用；普通 refresh 失败时才能按现有架构保留仍安全的
  旧版本。

## 5. 评测方案

### 5.1 建立 SayHear 自己的标注集

现成论文几乎都以英语新闻、问答或公开人物传记为主，不能直接覆盖私人生活叙事、
Objective / Impression 两类认识状态和中英 code-switch。1A.3b 应建立合成、匿名化的
gold set，每个 case 同时保存：

- 冻结 input IDs、kind、status、scope、time 和 typed Evidence；
- 人工标注的 allowed atomic propositions 与 forbidden inferences；
- expected support sets，允许多个等价最小集合；
- Profile coverage units 和允许的 faithful compression；
- contradiction、material absence 与 epistemic upgrade 标签；
- 中文、英文和 code-switch 的自然叙事参考，不把单一 reference text 当成唯一正确
  文风。

AIS 的两步 guidelines 可作为人工标注骨架：先写清生成物实际表达的信息，再判断来源
是否支持。FActScore 的 atomic-fact 标注用于细分混合句；FineSurE 的 keyfact alignment
用于反向 coverage。

### 5.2 最小扰动与对抗样例

每类错误要有只改变一个变量的 positive / negative pair：

| 类别 | 最小扰动 |
| --- | --- |
| Entity | 同名不同人、代词换绑、subject/object 交换 |
| Relationship | friend 写成 sibling，neutral relation 擅自加具体角色 |
| Time | 已结束写成当前，偶尔写成一直，单日写成趋势 |
| Negation / scope | “不喜欢”漏掉“不”，某项目偏好扩成全局人格 |
| Epistemic kind | AI Impression 写成“你明确说过”，Objective 写成外部核验事实 |
| Unsupported synthesis | 两个 Objective facts 之间补因果、动机、诊断或价值观结论 |
| Contradiction | Profile 只选一侧，掩盖 active Memory 中不允许并存的反向内容 |
| Coverage | 删除一个关键关系、阶段变化或长期价值观，其他正文保持不变 |
| Lifecycle fence | Candidate、contested、review_due、dormant、Forget、失效 Entity 混入输入 |
| Self-evidence | Reflection 文本支撑 Candidate，Profile 正文支撑下一版 Claim |
| Version race | source advance、Correction、Forget、Full Purge 与生成并发 |

不要只用“明显荒唐”的 hallucination。MiniCheck 专门通过结构化生成 subtle factual
errors 来训练 checker，原因正是大多数输出本来正确，真正困难的是在大量正确句中找出
一处实体、关系或 synthesis 错误。

### 5.3 分开报告，不做可抵消总分

建议至少按以下维度逐项报告 confusion matrix、false-negative list 和 case IDs：

- atomic support precision；
- contradiction recall；
- unsupported inference recall；
- epistemic-kind preservation；
- coverage-unit recall 与 material-absence recall；
- support-link precision；
- deterministic lineage / lifecycle / fence conformance；
- 中英和 code-switch 分桶。

不要把它们加权成一个 Profile quality score。一个自然、完整但含一条无依据心理判断的
Bio，不能靠其余维度高分抵消。反过来，结构正确但像数据库转写的 Bio 也没有产品价值；
自然度、忠实度和“被理解感”应在 Profile prototype / blind human evaluation 中另行
判断，不能让 validator 的结构分数代替人的体验判断。

### 5.4 校准自动 validator

每个自动 checker 都要在 SayHear gold set 上与人工标签比较，并保存：

- 每种 error class 的 precision / recall，而非只报 overall accuracy；
- 中文、英文、code-switch 各自结果；
- false positive / false negative ledger；
- checker model、Prompt、Schema、threshold 和 policy version；
- 与 generator 同模型、同模型家族和异模型时的差异。

在某类错误达到可接受证据前，该 checker 只能作 advisory finding 或把结果送人工
review，不能静默批准。规则升级必须重放冻结 gold set；旧 BioVersion 保留当时的
validator version，不能按新规则假装它从未发布。

## 6. 对 1A.3b SPEC 的直接含义

建议后续 grilling 把下面这些内容写进 SPEC，而不是留成实现细节：

1. Profile / Reflection 生成 schema 中是否强制返回 atomic propositions，还是由独立
   validator 负责分解；本报告建议两者都保留并做差异检查。
2. Profile `coverage_units` 的版本化构造规则，以及何种 absence 构成
   `material_absence`。这决定“语义忠实于全部 Memory”能否被检验。
3. semantic validator 的发布语义：哪些 verdict 直接拒绝，哪些进入
   `needs_review`，是否允许一次有界 rewrite。研究证据反对用单一分数直接批准。
4. 自动 validator 上线前的中英双语校准集、误报台账和最低证据。现成英文新闻指标
   不能直接充当门禁。
5. Inspector 是否展示实际 atomic propositions、support sets、coverage disposition
   与 validator findings。只有展示这些细节，内部验证者才能区分“有 link”和“真的
   被 link 支持”。

这些决定不会改变已经接受的架构方向。它们把“100% 有 lineage”“0 个 Bio-only
推断”“不能遗漏到形成失真人物画像”从口号变成可生成、可审查、可回归的证据对象。

## 7. 仍然存在的限制

- 外部方法没有一项针对用户私人长期 Memory 的叙事 Profile，也没有 SayHear 的
  Objective / Impression、Forget fence 与 EntityVersion 语义。所有迁移都需要自建
  数据校准。
- Atomic decomposition 自身由模型完成时可能漏掉隐含主张。生成器清单与独立验证器
  清单做 diff 可以降低风险，但不能证明绝对完整。
- “遗漏是否造成失真人物画像”包含产品判断。FineSurE 证明 keyfact alignment 比整篇
  打分更可审计，但不能替 SayHear 决定哪些 Claim 组合属于 material。
- NLI / QA / LLM reviewer 会受语言、长上下文、否定、时间和跨句 synthesis 影响。
  现有准确率不支持零人工校准的生产硬门禁。
- 本报告没有评估具体模型、Prompt、token budget、成本和延迟。它给出验证形状；
  role Champion 与运行参数应由 1A.3b 自己的冻结 eval 决定。

## 8. Primary sources

- Min et al., 2023. [FActScore: Fine-grained Atomic Evaluation of Factual Precision in Long Form Text Generation](https://aclanthology.org/2023.emnlp-main.741/). [Official code](https://github.com/shmsw25/FActScore).
- Rashkin et al., 2023. [Measuring Attribution in Natural Language Generation Models](https://direct.mit.edu/coli/article/49/4/777/116438/Measuring-Attribution-in-Natural-Language). [Official annotation data and guidelines](https://github.com/google-research-datasets/AIS).
- Gao et al., 2023. [Enabling Large Language Models to Generate Text with Citations](https://aclanthology.org/2023.emnlp-main.398/). [Official code](https://github.com/princeton-nlp/ALCE).
- Song et al., 2024. [FineSurE: Fine-grained Summarization Evaluation using LLMs](https://aclanthology.org/2024.acl-long.51/). [Official code](https://github.com/DISL-Lab/FineSurE-ACL24).
- Laban et al., 2022. [SummaC: Re-Visiting NLI-based Models for Inconsistency Detection in Summarization](https://direct.mit.edu/tacl/article/doi/10.1162/tacl_a_00453/110014/SummaC-Re-Visiting-NLI-based-Models-for). [Official code](https://github.com/tingofurro/summac).
- Fabbri et al., 2022. [QAFactEval: Improved QA-Based Factual Consistency Evaluation for Summarization](https://aclanthology.org/2022.naacl-main.187/). [Official code](https://github.com/salesforce/QAFactEval).
- Tang et al., 2024. [MiniCheck: Efficient Fact-Checking of LLMs on Grounding Documents](https://aclanthology.org/2024.emnlp-main.499/). [Official code](https://github.com/Liyan06/MiniCheck).
- W3C, 2013. [PROV-DM: The PROV Data Model](https://www.w3.org/TR/prov-dm/).

# SayHear

## TL;DR

- 本文件路径由 matt skills 依赖，不得移动或改名。
- 本文件是 SayHear 产品与领域术语、定义和禁用近义词的唯一权威来源。
- 只在任务涉及命名、领域模型或跨模块接口时读取相关章节，不要求日常任务全文加载。
- 功能规则读取 `docs/product/`，技术约束读取 `docs/architecture/`，决策原因读取
  `docs/adr/`。

## Status

Accepted

SayHear 接住用户对生活的自然表达，将被理解的交流沉淀为可信、可控制且持续生长的人生记录。

## 产品阶段

**Internal Core**:
Phase 1 的内部自用阶段，由 Core Flow 1A 与 1B 构成，默认只允许一个 Internal Owner Account 写入真实私人内容。交付顺序是 1A.1 Text Foundation、1A.2 Journal、1A.3 Entity 与长期 Memory、1A.4 Replay，再进入 1B Realtime Voice；不建设临时 Push-to-Talk 产品路径。其结果不代表外部用户需求或商业模式已经成立。
_Avoid_: MVP, External MVP

**Internal Owner Account**:
Phase 1 唯一允许写入真实私人内容的内部账号；其他评估数据必须是合成、匿名化或另行明确授权的数据。它不代表消费者注册、多用户生命周期或后台用户管理已经建立。
_Avoid_: Consumer account, Multi-user beta

**External MVP**:
Phase 2 首次面向真实外部用户的最小产品，首发仅提供 Web；正式 iOS 不属于该阶段范围，待 Web 初步验证持续表达、被理解感以及 Journal 与 Memory 的长期价值后再引入。
_Avoid_: Internal Core, Core Flow

## Session 与日期

**Daily Session**:
按用户本地日期组织当天多次交流、Conversation 与 Journal 的产品单位；它不是模型 Session 或单次打开 App。
_Avoid_: Model session, App session

**Daily Session Ownership**:
连续交流开始时确定且不可变的本地日期归属；跨午夜不会拆分或迁移，Journal 等待 Continuous Exchange End，结束后在新本地日期发起的下一次交流才创建新的 Daily Session。
_Avoid_: Midnight split, Event-date reassignment

**Continuous Exchange End**:
用户明确表达结束，或达到版本化的无活动时间窗口；AI 可以自然收尾，但其主观判断不能单独改变 Session 状态。具体超时时长是可调策略，不是永久产品常量。
_Avoid_: Model-decided closure, Hard-coded timeout

## 对话数据与执行身份

**InteractionTurn**:
Text 与 Realtime 共用的一次用户交互分组，关联一个 primary User Event 以及零个或多个 Assistant / System Event；它负责 Retry、barge-in 和交互状态，但本身不是 Evidence。
_Avoid_: ConversationEventRevision, VoiceTurn, Trace span

**VoiceSession / VoiceTurn**:
Realtime Room、Provider item、重连与 delivery 的持久运行映射；每个 VoiceTurn 映射一个 InteractionTurn，但两者都不是产品长期记录或生活事实 Evidence。
_Avoid_: Daily Session, InteractionTurn, ConversationEventRevision

**ConversationEventRevision**:
Conversation 中一条 User、Assistant 或 System Event 的不可变内容版本；只有有效的 final / corrected User Revision 可以成为用户生活事实的 primary evidence root。
_Avoid_: InteractionTurn, Model Session, Provisional transcript

**EvidenceItem**:
指向具体 source revision 及其 whole revision、segment、text span 或 time range 的一等类型化引用；它不复制、创造或解释底层事实，派生产物的认识论依据必须通过它回到有效 User Event Revision。
_Avoid_: Quote copy, Lineage edge, AI inference

**GenerationCommand**:
一次逻辑生成意图的持久元数据，冻结 subject、source revision、Prompt、Schema、policy、routing 与 freshness；它可以有多个串行 ModelRunAttempt，但最多只有一个 authoritative result。
_Avoid_: ModelRunAttempt, Workflow run, User Event

**ModelRunAttempt**:
某个 GenerationCommand 的一次具体 Provider 调用及其模型、运行、成本和结果元数据；技术重试或已批准 fallback 创建新 Attempt，不创建第二个逻辑意图，也不能改变 Command 已冻结的业务语义。
_Avoid_: GenerationCommand, Multi-model vote, Authoritative result

**Conversation Decision Command**:
一个 InteractionTurn 的第一阶段 GenerationCommand；它冻结 User Event、CompiledContext、Conversation Action Catalog 与 Harness Policy，结果只能是普通 Final Response 或一个 Conversation Action Proposal。
_Avoid_: ModelRunAttempt, Action Finalization Command, Agent plan

**Action Finalization Command**:
Action Gateway 已提交 Conversation Action Receipt 后才创建的第二阶段 GenerationCommand；它引用创建时最新的 committed Receipt、强制 tools disabled，并只负责生成用户可见的最终回复。
_Avoid_: Technical retry, Action execution, Second tool round

## 对话行为

**Understanding Response**:
准确抓住用户真正介意的部分，区分事实、用户判断与 AI 推断，并通过真诚的关心和好奇让用户感到自己重要、被尊重和重视；除非用户明确请求，否则不提供建议。
_Avoid_: Advice, Coaching

**Follow-up Question**:
为了继续理解而紧扣用户当前表达提出的问题；每轮最多一个，用户愿意继续时可跨轮追问，用户简短回应、回避、拒绝或转换话题后必须停止原方向。
_Avoid_: Intake question, Question stack

**Minimum High-Risk Response**:
Core Flow 1A.1 从第一天成立的行为边界；识别到明确自伤、伤人或迫在眉睫的危险信号时，SayHear 暂停普通倾听、非安全必要的追问和建议，直接鼓励用户寻求现实中的即时支持，不诊断、不冒充治疗师，也不承诺绝对保密。
_Avoid_: Therapy, Full Crisis Operations

**Complete Assistant Response**:
Core Flow 1A.1 中模型完整成功并由服务端提交的 AI 回答；只有这种回答进入后续 Context。
_Avoid_: Rendered chunk, Partial response

**Interrupted Response**:
流式生成中断时用户可能已经看到的非完整片段；界面必须明确标记中断并允许重试，但它不成为 Assistant Event，也不进入后续 Context。
_Avoid_: Complete Assistant Response, Resumable delivery

## Provider 出站

**Provider Egress Port**:
1A.1 模块化单体内部唯一允许调用模型 Provider 的应用端口；在发送前执行 source、data epoch、Provider policy 与 consent 检查，并记录不含正文的出站元数据。
_Avoid_: Direct provider call, Provider Egress Gateway

**Provider Egress Gateway**:
当 Replay Runner、Voice Worker 等独立执行环境开始处理真实私人数据时，从 Provider Egress Port 抽离出的部署与凭据信任边界；1A.1 不单独部署。
_Avoid_: In-process port, Premature microservice

**Model Routing Policy**:
授权人工基于 Replay 与安全评估证据发布的版本化角色路由决定，指定可用于真实流量的 Champion 与 eligible fallback；Replay 分数、自动阈值和线上故障率只能形成建议，不能自行发布或修改该 Policy。
_Avoid_: Automatic model promotion, Replay-owned routing

**Conversation Fallback Handover**:
从 1A.4 开始，Conversation Text Champion 在没有任何回答正文可能对用户可见时失败，runtime 按已发布 Model Routing Policy 串行切换到唯一 eligible fallback，并将其固定到当前 Continuous Exchange；已有可见输出或 fallback 再次失败时必须显式失败。
_Avoid_: Technical retry, Private conversation shadowing, Cascaded fallback

**Role-Scoped Generation Fallback**:
1A.4 后台生成 role 由 Model Routing Policy 显式选择是否允许每个 GenerationCommand 串行使用一次 eligible fallback；fallback 复用冻结的 source、Prompt、Schema 与 policy，通过同一 validator 和 commit fence，且不改变后续 command 的 Champion。
_Avoid_: Global fallback, Multi-model voting, Conversation Fallback Handover

**Model Promotion Evaluation**:
开发者判断 Challenger 是否适合作为某个 role 的 Champion 或 eligible fallback 时使用的评测证据；用户可感知 role 关注中英体验与信任边界，结构化 role 关注准确率、lineage 与领域不变量，但 Phase 1 不把它产品化为独立审批流程或运行时 Gate。
_Avoid_: Automatic model promotion, Formal approval workflow, Private Replay requirement

## Entity 与身份解析

**Entity**:
用户范围内可被跨表达、跨日期持续引用的人、地点或项目的稳定语义身份；名称、语言、关系称呼和单次 Mention 都不决定其 identity。
_Avoid_: EntityMention, Label, Memory Claim

**Self Entity**:
每个 Account 恰好拥有一个、代表用户本人参与领域关系和 Memory Claim 的稳定 Person Entity；它不同于认证账号或 `user_id`，不能与普通 Entity merge、split 或独立删除。
_Avoid_: User Account, Auth Identity, Mentioned Person

**EntityMention**:
某个 User Event Revision 中对人物、地点或项目的一次具体指代；在证据不足、存在多个候选或只是代词时可以保持未绑定，不等于必须创建 Entity。
_Avoid_: Entity, Memory Claim

**Unresolved Entity**:
用户已经明确引入一个不同的人、地点或项目，但其稳定身份仍不完整时创建的 user-scoped Entity；不能仅凭同名与已有 Entity 合并，也不能由含糊的代词或多候选 Mention 强行创建。
_Avoid_: Unresolved EntityMention, Name match

**Entity Clarification**:
身份歧义会实质改变 SayHear 对经历和想法的理解、当前回应、Journal 含义或未来 Memory 归属时，紧扣当前表达提出的一次自然澄清；用户未回答、回避、拒绝或转换话题后停止追问，并保留未绑定 EntityMention。
_Avoid_: Data cleanup question, Intake question

## Episode

**Episode**:
由 User Evidence 支撑、具有明确现实事件锚点并可跨 Turn 或 Session 持续补充的一段版本化生活事件，例如一次旅行、一次搬家或一个项目阶段；它不是 Conversation、话题或情绪分类。只有 Evidence 能安全指向同一现实事件时才续接原 Episode，身份不确定时保持未绑定或在明确为不同事件时新建。
_Avoid_: Conversation, Daily Session, Topic cluster

## Memory 与用户控制

**Reflection**:
SayHear 基于近期 User Evidence 形成的版本化、非权威派生观察；它可以提出 Memory Candidate，但不能成为 Memory Claim 的 primary evidence，也不直接等同于 Journal 或 Profile。
_Avoid_: Memory Claim, Primary evidence, Journal

**Reflection Inspector**:
Internal Core 的 Web 开发者工具中用于只读查看 ReflectionVersion、Evidence lineage 及其下游影响的诊断界面；它不是用户式 Reflection 页面、Candidate Review Tool 或第二写入口。
_Avoid_: Reflection page, Candidate Review Tool, Reflection editor

**Profile Projection**:
SayHear 以全部当前有效 Memory Claim 为语义输入，并以自身观察视角讲述用户及其相关经历、关系、情感与价值观的自然语言 Bio；它追求语义忠实而非逐条复述，任何可独立成立的新判断必须先成为合格的 Objective Memory 或 AI Impression。
_Avoid_: Memory database, Claim list, User-authored bio

**Profile Refresh Policy**:
Bio 的普通重写由受频率限制的用户手动刷新与每周自动刷新触发；新 Bio 验证通过后直接成为 current，不进入用户预览、批准或正文编辑。Correction、Forget、contested、dormant、Entity 失效或删除等信任边界变化会立即使旧 Bio 不可用并自动重建，不等待普通刷新节奏。
_Avoid_: Daily Profile regeneration, Bio approval workflow, Stale Bio fallback

**Memory Claim**:
SayHear 基于用户表达形成、可能在未来交流中被召回的一条可修正理解；它不等于已经核验的客观事实。
_Avoid_: Fact, Profile item

**Objective Memory**:
由用户一次或多次直接、明确陈述的相对客观信息形成的 Memory Claim；一次明确陈述通过长期记忆准入后即属于 confirmed，但这只确认用户曾这样陈述，不代表 SayHear 已独立核验其真实性。
_Avoid_: Verified fact, AI Impression

**Relationship Memory Claim**:
以 User Evidence 支撑、用时间有效性描述用户作用域内两个人物 Entity 之间关系的版本化 Objective Memory；每种可以独立成立、纠正、忘记或计时的关系拥有一个 logical Claim，同一关系的状态变化、结束后重启和多段有效期都使用新 ClaimVersion。同一关系事实的相反观察方向不创建第二个 Claim，对称关系、提及顺序和关系重启也不改变 identity。
_Avoid_: Entity label, Entity identity, Relationship name

**Relationship Qualifier**:
由 User Evidence 支撑、用于细化 Relationship Memory Claim 中某一参与方角色及其称呼投影的可修正描述；它不改变 logical Claim identity，也不自动成为 Entity 的全局属性。Qualifier 自身存在冲突时可以停止具体角色投影，而仍有 Evidence 支撑的底层关系继续使用中性称呼。
_Avoid_: Relationship Predicate, Entity attribute, Entity label

**Direct Third-Party Relationship**:
两个非 Self Entity 之间、由用户直接表达并绑定双方身份的 Relationship Memory Claim；它不能由其他关系的传递闭包或社交图猜测自动生成。
_Avoid_: Transitive relationship, Inferred social graph, Cross-user relationship

**Relationship Resolver Hint**:
由 Relationship Memory Claim 及其时间状态生成、用于快速解析关系称呼的可重建本地化投影；它不决定 Entity identity，也不能作为关系事实或 Evidence。
_Avoid_: Entity label, Relationship Memory Claim, Identity evidence

**Relationship Temporal State**:
Relationship Memory Claim 对关系当前仍成立、已经结束或尚不确定的认识，独立于开始和结束日期是否已知；近似或缺失的时间边界必须保留其精度，不能由系统补成精确日期。
_Avoid_: Claim status, Exact timeline, Evidence date

**AI Impression**:
SayHear 根据用户表达形成、但并非用户直接陈述的主观观察或推断；其认识状态属于 inferred，默认至少需要来自两个 Daily Session 的两条独立 User Evidence 才能进入长期 Memory。召回时必须使用“我有一个印象……”或“我可能理解为……”等保留不确定性的语言。
_Avoid_: Objective Memory, Personality fact

**Sensitive Memory Predicate**:
医疗健康、性取向、宗教或政治身份、创伤、法律或财务等高影响私人领域的 Predicate；敏感领域可以进入长期 Memory，但每个 Predicate 必须分别限定允许的 Claim kind，不能因话题敏感或重要就取得推断权限。
_Avoid_: Prohibited topic, Sensitive topic filter

**Sensitive Interpretive Impression**:
敏感领域中只描述某项经历对用户的意义、影响、支持或压力来源、交流偏好的 AI Impression；它不能把用户未直接明确陈述的诊断、身份或风险归类写成长期 Memory。
_Avoid_: Sensitive classification, Diagnosis, Identity inference

**Rejected Memory Candidate**:
被长期 Memory 准入明确否决的非权威提案；它不因 Registry 更新、重复抽取、时间经过或模型 confidence 自动转为 Claim，也不表示底层 Evidence 已被删除。
_Avoid_: Needs Predicate Review, Dormant Memory Claim

**Predicate Review Eligible**:
通过确定性规则检查、可以交由授权人工评估是否映射或扩张 Predicate Registry 的 ambiguous / unmapped Memory Candidate；它不表示概念已有产品价值，也不能创建 active Claim。
_Avoid_: Valuable Predicate, Approved Memory Candidate

**Predicate Review Deadline**:
Predicate Review Eligible Candidate 进入 `needs_predicate_review` 后最多等待人工处理 30 天；到期仍未获得明确处置时转为 stale，并失去继续晋升为 Claim 的资格。
_Avoid_: Indefinite Review Queue, Memory Retention Period

**Predicate Change Proposal**:
授权人工对一个通用 Predicate 概念作出产品治理决定后形成的版本化提案；它可以等待发布、被产品级拒绝、发布或取消，并关联多个 Candidate，但不能包含用户 Evidence 或具体私人值，也不是 active Registry Entry。
_Avoid_: Approved Predicate, Active Registry Entry

**Rejected Predicate Proposal**:
授权人工认为一个通用 Predicate 概念没有产品价值后形成的 rejected Predicate Change Proposal version；它保留不含用户内容的概念级治理决定，直到显式版本化重新评估，不能把关联 Candidate 变成 Memory。
_Avoid_: Rejected Memory Candidate, Prohibited User Topic

**Awaiting Registry Release**:
Candidate 已完成 Predicate review 并关联 awaiting-release Predicate Change Proposal、正在等待代码库 Registry version 发布的状态；它已退出 30 天 review deadline，但最多等待 90 天，仍不具备 mapping 或 Claim admission 资格。
_Avoid_: Accepted Memory Candidate, Published Predicate

**Registry Release Wait Deadline**:
Candidate 进入 `awaiting_registry_release` 后最多等待 Registry 发布 90 天；到期仍未发布时转为 stale，Proposal 本身继续存在，后续发布不能自动复活该 Candidate。
_Avoid_: Proposal Expiration, Automatic Candidate Revival

**Terminal Candidate Content Grace**:
Memory Candidate 转为 rejected 或 stale 后，派生语义只在 7 天内供受审计的内部排错使用，不能参与 Recall、Profile、重新准入或模型 Context；期限结束后不再可读。
_Avoid_: Memory Retention Period, Reconsideration Window

**Terminal Candidate Audit Envelope**:
Terminal Candidate 派生语义清除后保留的最小无正文记录，用于证明处置、维持 lineage，并阻止同一 Evidence 静默绕过终局状态；它不是 Memory，也不能还原原提案。
_Avoid_: Rejected Memory, Hidden Memory

**Materially New Evidence**:
相对 terminal Candidate 新增、且实质改变长期 Memory 准入条件的 User Evidence，例如改变直接陈述状态、满足独立跨 Session 门槛，或消除 Entity、scope、时间歧义；重复表达、时间经过或模型 confidence 变化不属于 Materially New Evidence。
_Avoid_: New message, Repeated Evidence, Higher confidence

**Successor Memory Candidate**:
由 Materially New Evidence 或显式版本化重新评估产生、并保留 terminal predecessor lineage 的新 Candidate；它拥有独立准入结果与期限，不修改或复活 predecessor。
_Avoid_: Revived Candidate, Retried Candidate

**Contested Memory Claim**:
同一 Predicate、scope 与有效时间内出现互斥 User Evidence，且无法解释为时间变化、明确纠正或允许并存的多个值时形成的暂不可用 Memory Claim；解决前停止 Recall 与 Profile。
_Avoid_: Temporal change, Memory Correction, Multiple allowed values

**Dormant AI Impression**:
超过 Predicate Registry 复核周期且没有新的合格跨 Session Evidence 的历史 AI Impression；它停止进入 Recall 与 Profile，但不会被删除或直接重新激活。
_Avoid_: Forgotten Memory, Contested Memory Claim, Deleted Claim

**Open Loop**:
由直接 User Evidence 支撑、具有明确到期边界的具体待发生事项或待确认结果的短期派生状态；它不属于 Memory Claim 或 Profile。用户已经进入对话后，SayHear 可以据此主动表达关心，但不能在对话外发送消息、监督进度或形成任务管理。
_Avoid_: Unfinished topic, Goal, Reminder, Task

**Proactive Memory Follow-up**:
用户已经发起当前 Continuous Exchange 后，SayHear 主动选择最多一个合适的过去事项表达关心；它必须让位于用户当前诉求，并在用户简短带过、回避、拒绝或转换话题后停止并抑制重复询问。
_Avoid_: Notification, Progress tracking, Repeated probing

**Proactive Follow-up State**:
针对一个 Open Loop 或 Memory Claim，记录 Proactive Memory Follow-up 当前是否 eligible 或因用户停止信号被 suppressed 的版本化行为投影；它不是用户事实、Memory 或任务，只有用户主动重提或新的相关 User Evidence 才能解除抑制。
_Avoid_: Proactive Memory Follow-up, Memory Claim, Task state

**Conversation Action**:
用户在一个 User Event 中要求 SayHear 执行的一项明确支持的高层产品能力及其完整语义意图；一次 Action 可以一致地影响多个相关 Memory Claim、Journal 与 Profile，但这些影响不构成多个独立用户意图。
_Avoid_: Tool call, Database mutation, Workflow step

**Conversation Action Catalog**:
SayHear 当前明确支持用户在对话中请求的有限、版本化 ActionDefinition 集合；每项声明模型与执行层共同需要的通用契约，并绑定一个 typed Action Handler。无法由其中某项能力准确实现的请求必须说明不支持，不能用相近 Action 代替。
_Avoid_: Open-ended toolbox, Internal workflow list, Model-invented capability

**ActionDefinition**:
Conversation Action Catalog 中一个 action kind 的版本化 capability descriptor；它声明 input Schema、target contract、effect / trust class、confirmation、execution mode、idempotency、consistency、rate、receipt、availability 与 handler binding，但不编码具体领域算法。当前模型可见 Definition 必须声明无需二次确认，需要额外确认或 step-up 的能力不能发布到 Catalog。
_Avoid_: Tool implementation, Business-rule DSL, Prompt

**Action Gateway**:
接收 normalized Conversation Action Proposal 的应用层深 Module；它冻结并验证 ActionDefinition、解析 target、执行共同权限与 policy gate、按 action kind 调用唯一 typed Action Handler，并持久提交 Conversation Action Receipt。
_Avoid_: Agent loop, Domain handler, Provider tool router

**Action Handler**:
实现一个 ActionDefinition 领域语义的 typed deep Module；它接收 Gateway 已验证的 action context 与 typed input，原子提交领域变化或创建幂等 Durable Workflow command，并返回结构化 handler outcome。它不处理 Provider 协议或生成最终 Assistant Response。
_Avoid_: Generic workflow DSL, Provider function, API handler

**Conversation Function**:
Conversation Agent Harness 根据当前 Catalog 为一次 Decision Command 生成并向模型暴露的单个聚焦 Function；每项对应一个高层 Conversation Action kind 及独立 strict Schema。它是 Provider-facing 表达，不是领域 Interface 或执行权限。
_Avoid_: Internal tool, Conversation Action, Universal function

**Conversation Action Proposal**:
Provider Adapter 将模型选择的 Conversation Function 规范化后产生的 provider-independent typed union；它引用 Catalog action kind、Schema version、request Event 与候选参数，但仍需 Action Gateway 验证，不能证明已经执行。
_Avoid_: Provider tool call, Conversation Action Receipt, Domain command

**ActionExecution**:
一个已验证 Conversation Action Proposal 在幂等边界内对应的稳定执行身份；它分别投影一次性 Admission 与后续 Execution 状态，但权威变化历史来自不可变 Conversation Action Receipt 序列。
_Avoid_: Conversation Action Proposal, WorkflowRun, Model tool call

**Action Reference Handle**:
Context Compiler 为一个 Conversation Decision Command 生成的短期 opaque reference；它只在该 Command 冻结的 CompiledContext 中映射到同一 owner 下的具体对象与 Version，供模型选择已有 Action target。Handle 不是产品身份、授权或可跨 Turn 使用的 ID。
_Avoid_: Database ID, Entity identity, Free-text selector

**Conversation Action Receipt**:
Action Gateway 为一次 Conversation Action 的受理、进展或完成状态追加的不可变结果引用；受理与执行是独立状态，当前状态可以从 Receipt 序列重建。Action Finalization 只能依据已提交 Receipt 区分未受理、已接受、处理中、完成、失败或取消，不能把模型声明当作执行事实。
_Avoid_: Model tool result, Assistant claim, Workflow completion

**Derived Artifact Regeneration Action**:
用户要求 SayHear 使用当前有效 source、现行生成 policy 与同一 logical artifact identity，重新生成 Journal、Profile 等派生产物的高层 Conversation Action；它不声称底层理解错误，可以携带受限的 `Regeneration Guidance` 改善表达，但不接受事实改写、任意正文编辑或无限候选抽取，并只通过验证后的新 Version 替换 current Version。
_Avoid_: Understanding Correction, Free-form edit, Model retry

**Regeneration Guidance**:
用户随 Derived Artifact Regeneration Action 提供的自然语言表达建议，用于调整派生产物的重点、清晰度或组织方式；它不是 Evidence、事实更正或用户自写正文，不能改变有效 source、第三人称观察、不确定性边界或验证规则。
_Avoid_: Journal Correction, User-authored Journal, Evidence update

**Conversation Agent Harness**:
SayHear 应用层拥有的深 Module；它围绕一个冻结的 InteractionTurn 组织 Context、模型判断、高层 Function Calling、Conversation Action receipt 与最终回复，但不拥有长期产品状态或领域编排。当前为受限自有实现，未来可以由通过同一契约与 Replay 验证的 Framework-backed Adapter 替换。
_Avoid_: Agent Framework, Domain workflow, Provider Session

**Conversation Harness Policy**:
每次 Conversation Agent Harness 运行冻结的版本化执行限制，包括允许的 Action Catalog、模型决策次数、可改变状态的 Action 数、工具往返、时间与 token budget，以及何时允许用户可见输出；Framework 或 Provider 不能自行扩大这些限制。
_Avoid_: Model autonomy, Provider capability, Tool permission

**Compound Conversation Request**:
同一个 User Event 中包含两个或以上可以分别接受、拒绝或执行的 Conversation Action 请求；一个 Action 为维护 Memory、Journal 与 Profile 一致性而产生的确定性下游影响不属于复合请求。
_Avoid_: Multi-tool Action, Downstream propagation

**Trust-Control Action**:
用户明确纠正、撤回或恢复 SayHear 对其个人信息的使用权限或产品理解的 Conversation Action；继续等待可能使错误理解或已撤回权限继续生效，因此在目标唯一且该 Action 自身的 scope、授权与安全门槛满足时优先处理。需要二次确认或 step-up 的高风险退出操作不属于当前模型可见 Catalog。
_Avoid_: General priority Action, Internal repair workflow

**Memory Correction**:
用户明确指出 SayHear 的一项长期理解不准确；一次纠正可以在同一语义目标下撤回错误 Claim 或 Qualifier，并提出彼此独立的新关系或事实，错误部分必须立即停止召回。
_Avoid_: Profile edit

**Memory Claim Identity Review**:
Entity merge、split 或身份纠正后，对引用受影响 EntityVersion 的 Memory Claim 执行定向复核；Claim 立即停止 Recall 与 Profile 使用，只有新的 ClaimVersion 通过原始 User Evidence 验证后才能恢复。
_Avoid_: In-place Entity rebind, Confidence aggregation

**Memory Forget Request**:
用户明确要求 SayHear 不再记住或调用整条 Memory Claim，或其中一个可独立定位的 Relationship Qualifier，不论该理解是否准确；原始 Conversation 与已有 Journal 仍然保留。该限制不会因用户自然重复、时间经过或后台任务自动解除；Qualifier 被 Forget 后，只有不依赖被遗忘内容的其他 User Evidence 仍支持底层关系时，才能继续使用中性关系称呼。
_Avoid_: Memory Correction, Content Deletion

**Memory Forget Reversal**:
用户明确允许 SayHear 再次长期记住一个此前被 Forget 的 Claim 或 Qualifier；目标唯一可确定时，同一个 User Event 同时作为恢复授权和该目标的新 Evidence，并创建新 ClaimVersion，但不恢复旧 Evidence 或旧 ClaimVersion。普通重复提及不等于 Reversal。
_Avoid_: Automatic relearning, Forget expiration, ClaimVersion reactivation

**Internal Owner Full Purge**:
Internal Core 中仅供运维触发的单 owner 全量活跃系统清除；从 1A.2 开始覆盖 Conversation、Evidence 与 Journal，1A.3 扩展到 Entity、Episode、Open Loop、Proactive Follow-up State、Reflection、Memory、Profile，1A.4 扩展到 Replay，1B.1 和 1B.2 再分别覆盖音频 / transcript 与 delivery 数据。它不提供单条内容删除、消费者账号生命周期或“所有保留副本已经过期”的承诺。
_Avoid_: Granular Content Deletion, Account Deletion

**Data Epoch**:
附加在 Internal Owner 上的单调递增数据代际号；每次 Internal Owner Full Purge 推进一次。命令冻结时的旧代际与当前代际不匹配时，一切在途读取、写入、派生物提交与 Provider Egress 都必须失败关闭；它代表“哪一代数据仍可存活”，不是时间戳、版本号或计数器。
_Avoid_: Version number, Timestamp, Revision counter

**Deletion Receipt**:
每个活跃存储目的地对一个 owner 清除结果的无正文记录；它只回答该目的地的处置与剩余保留窗口，不包含任何被清除内容，也不证明所有保留副本已经物理消失。
_Avoid_: Deletion ledger, Deletion proof

**Purge Marker**:
保存在业务数据库备份域之外的单 owner 无正文清除标记；每位 owner 只保留不可回退的最新清除代际与时间，用于阻止旧备份未经比对直接恢复上线，本身不构成对外可见的删除承诺，也不是多用户删除台账。
_Avoid_: Tombstone, Deletion ledger, Backup registry

**Recovery Gate**:
每次私人读取、写入或 Provider Egress 前，比较业务库状态与业务库外最新 Purge Marker 的 fail-closed 准入关卡；发现旧备份、不一致或无法读取 marker 时，必须在重新应用清除状态并复核前保持关闭。
_Avoid_: Startup check, Recovery scanner, Deployment epoch floor

**Recovery Scan**:
由定时触发驱动的幂等后台清扫，负责把最佳努力失败或从未触发的后台推进（不活跃收尾、Journal Eligibility、outbox 投递等）最终启动；正确性从不依赖它——只依赖数据库租约、幂等键与下一次扫描——因此漏跑或延迟只造成延迟恢复，不丢数据；它不是第二套调度服务，也不承担 Recovery Gate 的 fail-closed 准入职责。
_Avoid_: Scheduler, Cron job, Recovery Gate

**Active-System Deletion**:
Internal Owner Full Purge 到达“在线产品已不可读取、召回或重建相关内容”的生命周期阶段；它可以同时声明仍有未届满的保留窗口（Retention Pending），但绝不等于、也不能对外声称所有保留副本已经过期。
_Avoid_: Fully Expired, Physical deletion

**Voice Preflight Harness**:
1B.1 内部使用录音 fixture、合成音频或单独授权样本验证 canonical STT、Transcript revision、音频保留与删除的非产品测试路径；它不出现在用户界面，不创建新的输入渠道，也不承担 Realtime 故障降级。
_Avoid_: Push-to-Talk, Product Voice Mode

**Memory Source Explanation**:
用户询问或质疑 SayHear 为什么记得、为什么形成某项理解时，SayHear 在对话中说明相关用户表达及其时间，并明确该 Memory Claim 是用户陈述形成的 Objective Memory，还是 AI 形成的 Impression；默认界面不专门展示技术化引用。
_Avoid_: Citation UI, Generated rationale

**Account Deletion**:
用户结束使用并要求删除账号及全部内容的基本退出权；External MVP 面向真实用户前必须包含独立设置入口、专用确认流程、完整 deletion ledger、Provider destination reconciliation、备份恢复防复活验证和可理解的 retention 说明。它不允许由自然语言 Conversation Agent 直接执行。
_Avoid_: Conversation Action, Internal Owner Full Purge, Log out, Subscription cancellation

**Account Data Export**:
用户异步取得 Conversation、Journal、Profile 与 Memory 等账号数据副本的低频退出能力；External MVP 面向真实用户前必须可用，但不属于 Internal Core。
_Avoid_: Journal Export

## Journal

**Journal**:
SayHear 基于一天中用户表达形成的第三人称观察记录；它不是用户亲自撰写的文本，也不是对用户生活的事实裁决。
_Avoid_: Conversation summary, User-authored diary

**Journal Correction**:
用户明确指出 Journal 中存在事实错误或被写成事实的不当推断，或纠正后的 User Evidence 能确定 Entity 身份误判使原 Statement 错误归属；纠正来源后，SayHear 生成新的 Journal Version 取代旧版本。
_Avoid_: Free-form edit, Regenerate

**Journal Identity Impact Review**:
Entity merge、split 或身份纠正后，通过反向血缘只复核引用受影响 Entity 的 JournalStatement；证据仍不充分时只冻结该 Statement 的 Entity 与 Recall 使用，原 Journal 保持可见，并等待新 User Evidence、用户纠正或查看时幂等重检。
_Avoid_: Full Journal scan, Automatic historical rewrite

**Journal Relationship Impact Review**:
Relationship Memory Claim 或 Qualifier 被纠正后，通过反向血缘只复核明确表达或依赖该关系的 JournalStatement；确定错误时创建新的 Journal Version，仍不明确时只暂停该 Statement 的关系与 Recall 使用。
_Avoid_: Full Journal scan, Model-selected Journal rewrite

**Journal Observation**:
AI 基于充分对话依据形成、但用户未直接陈述的主观理解；Journal 必须用自然的不确定性语言表达，不能把它写成确定事实。
_Avoid_: Fact, Unsupported inference

**Automatic Journal Delivery**:
SayHear 在 Continuous Exchange End 或当天达到自动评估条件后判断 Journal Eligibility，并直接发布通过校验的 Journal，不要求用户点击生成或审核批准；同日后续表达通过新的 Journal Version 更新当天记录。
_Avoid_: Manual generation, Draft approval

**Journal Eligibility**:
当天用户表达是否足以支撑至少一条真实 Journal 记录；门槛应很低，只判断证据是否足够，不判断事情是否重要、深刻或值得记录，日常琐事与事务性内容均可成立。
_Avoid_: Importance score, Emotional depth

**No Journal Notice**:
当天发生过交流但未达到 Journal Eligibility 时，下一天在 Journal 界面显示“交流内容较少，昨天无日记”一类状态；如果当天完全没有交流，则静默不生成 Journal，也不显示缺席提示。
_Avoid_: Empty Journal, No-activity placeholder

## References

- [文档地图](docs/README.md)
- [领域文档使用说明](docs/agents/domain.md)
- [ADR 索引](docs/decisions.md)

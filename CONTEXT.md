# SayHear

SayHear 接住用户对生活的自然表达，将被理解的交流沉淀为可信、可控制且持续生长的人生记录。

## 产品阶段

**Internal Core**:
Phase 1 的内部自用阶段，由 Core Flow 1A 与 1B 构成，默认只允许一个 Internal Owner Account 写入真实私人内容。交付顺序是 1A.1 Text Foundation、1A.2 Journal、1A.3 Entity 与长期 Memory、1A.4 Replay，再进入 1B Realtime Voice；不建设临时 Push-to-Talk 产品路径。其结果不代表外部用户需求或商业模式已经成立。
_Avoid_: MVP, External MVP

**Internal Owner Account**:
Phase 1 唯一允许写入真实私人内容的内部账号；其他评估数据必须是合成、匿名化或另行明确授权的数据。它不代表消费者注册、多用户生命周期或后台用户管理已经建立。
_Avoid_: Consumer account, Multi-user beta

**External MVP**:
Phase 2 首次面向真实外部用户的最小产品；Web 是确定平台，正式 iOS 是否进入该阶段仍待确认。
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

## Memory 与用户控制

**Memory Claim**:
SayHear 基于用户表达形成、可能在未来交流中被召回的一条可修正理解；它不等于已经核验的客观事实。
_Avoid_: Fact, Profile item

**Objective Memory**:
由用户曾经陈述的相对客观信息形成的 Memory Claim；召回时可以说“你之前说过……”，但不能暗示 SayHear 已独立核验其真实性。
_Avoid_: Verified fact, AI Impression

**Relationship Memory Claim**:
以 User Evidence 支撑、用时间有效性描述用户作用域内两个人物 Entity 之间关系的版本化 Objective Memory；每种可以独立成立、纠正、忘记或计时的关系拥有一个 logical Claim，同一关系的状态变化使用新 ClaimVersion。
_Avoid_: Entity label, Entity identity, Relationship name

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
SayHear 基于用户表达形成的主观观察或推断；召回时必须使用“我有一个印象……”或“我可能理解为……”等保留不确定性的语言，不能说成“我记得你就是……”。
_Avoid_: Objective Memory, Personality fact

**Memory Correction**:
用户明确指出某条 Memory Claim 不准确；该 Claim 必须立即停止召回，直到被纠正或重新确认。
_Avoid_: Profile edit

**Memory Claim Identity Review**:
Entity merge、split 或身份纠正后，对引用受影响 EntityVersion 的 Memory Claim 执行定向复核；Claim 立即停止 Recall 与 Profile 使用，只有新的 ClaimVersion 通过原始 User Evidence 验证后才能恢复。
_Avoid_: In-place Entity rebind, Confidence aggregation

**Memory Forget Request**:
用户明确要求 SayHear 不再记住或调用某条 Memory Claim，不论该 Claim 是否准确；原始 Conversation 与已有 Journal 仍然保留。
_Avoid_: Memory Correction, Content Deletion

**Internal Owner Full Purge**:
Internal Core 中仅供运维触发的单 owner 全量活跃系统清除；从 1A.2 开始覆盖 Conversation、Evidence 与 Journal，1A.3 扩展到 Entity、Episode、Reflection、Memory、Profile，1A.4 扩展到 Replay，1B.1 和 1B.2 再分别覆盖音频 / transcript 与 delivery 数据。它不提供单条内容删除、消费者账号生命周期或“所有保留副本已经过期”的承诺。
_Avoid_: Granular Content Deletion, Account Deletion

**Voice Preflight Harness**:
1B.1 内部使用录音 fixture、合成音频或单独授权样本验证 canonical STT、Transcript revision、音频保留与删除的非产品测试路径；它不出现在用户界面，不创建新的输入渠道，也不承担 Realtime 故障降级。
_Avoid_: Push-to-Talk, Product Voice Mode

**Memory Source Explanation**:
用户询问或质疑 SayHear 为什么记得、为什么形成某项理解时，SayHear 在对话中说明相关用户表达及其时间，并明确该 Memory Claim 是用户陈述形成的 Objective Memory，还是 AI 形成的 Impression；默认界面不专门展示技术化引用。
_Avoid_: Citation UI, Generated rationale

**Account Deletion**:
用户结束使用并要求删除账号及全部内容的基本退出权；External MVP 面向真实用户前必须包含用户触发入口、完整 deletion ledger、Provider destination reconciliation、备份恢复防复活验证和可理解的 retention 说明。
_Avoid_: Internal Owner Full Purge, Log out, Subscription cancellation

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

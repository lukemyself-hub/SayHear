# 模型 Provider 与本地化架构

## TL;DR

- 所有模型调用通过领域端口和受控 Provider Egress 边界。
- 模型按角色与 capability 注册，分阶段引入 Challenger 和 fallback。
- Prompt、模型与 locale 都版本化，不编码进领域对象身份。
- 中英文和 code-switching 是 Internal Core 验收范围。

## Status

Proposed

## 15. 模型与 Provider 架构

### 15.1 领域端口

不要建立一个最低公分母式的万能 `LLMProvider`。

Conversation Agent Harness 是 application layer 的深 Module，不是 Provider
抽象。它的 Interface 接收冻结的 Turn、GenerationCommand 与 CompiledContext
reference，隐藏模型消息、tool-call 协议、Action proposal / receipt 往返和最终回复
生成。API handler、客户端与领域 Module 不引用 OpenAI、Pi、Mastra 或其他 Framework
类型。

Harness 内部按真实消费者使用窄 Model Port。Provider Adapter 只实现模型能力，不
决定 Action Catalog、权限、领域写入或 Harness loop budget。初始 Harness 直接组合
现有 Conversation Model Port、Provider Egress Port 与 Action Gateway；不为尚未出现
的 Framework 建立一组 pass-through wrapper。

Conversation Decision 的 Provider-facing Interface 不是万能 Action Function。Harness
将本轮 eligible Catalog entries 编译成多个聚焦 Conversation Functions，每个拥有
独立 strict Schema。Provider Adapter 可以使用原生 function calling 或等价 strict
structured output，但必须输出相同的 normalized `ConversationActionProposal` union。
该 union 是 SayHear application Interface；Provider Function、call ID、message 和
Framework 类型都停留在 Adapter 内部。

端口随真实消费者出现，不提前 scaffold。1A.1 只实现
`ConversationTextModel`；Minimum High-Risk Response 的检测路径仍必须成立，
但不要求先建立一套通用模型平台。后续按职责拆分：

```text
ConversationTextModel
StructuredGenerationModel
RealtimeVoiceProvider
SpeechToTextProvider
TextToSpeechProvider
EmbeddingProvider
SafetyEvaluator
```

### 15.2 Capability Registry

完整 Capability Registry 从 1A.4 开始，用于 Replay、多 Provider 和 Voice 准入。
1A.1 只保存当前 Conversation Champion 所需的最小、版本化配置：

```text
provider
model
snapshot_or_version
supported_locales
streaming
context_limit
data_region
training_policy
retention_mode
```

1A.1 不实现 capability matching、自动路由或自动 fallback。1A.4 的每个
Provider / Model 配置再声明完整能力：

```text
provider
model
snapshot_or_version
supported_locales
input_modalities
output_modalities
structured_output
tool_calling
streaming
webrtc
sideband
vad_modes
output_transcript
transcript_token_timestamps
playback_cursor
delivery_precision
context_limit
session_limit
data_region
training_policy
retention_mode
zdr_capability
enabled_roles
```

Provider 声明 `tool_calling=true` 只表示模型适配器具备结构化 Action proposal
能力，不授予任何产品 Action。实际可见工具只能来自当前版本化
Conversation Action Catalog；Catalog、用户 capability 和领域验证共同决定授权，
Provider 不能从自身 Session、历史 tool state 或模型能力推断可执行范围。
Harness 必须关闭 parallel tool calling 或使用等价约束；多个 Function selection、
Catalog 外 Function 或 Finalization 阶段 tool call 均 fail closed。

未来 Framework-backed Harness Adapter 只有同时满足以下条件才能替换初始实现：

- 通过与自有 Harness 相同的 Interface conformance 与合成 Replay；
- Provider / Framework 类型、Session ID 与 tool state 不进入领域 Interface 或
  PostgreSQL 产品真源；
- 完整保留冻结 Catalog、Harness Policy、Action receipt、Evidence、幂等与删除
  fencing；
- Framework 进程或内部 Session 丢失后，能够只从 SayHear 权威记录安全重建；
- 在多轮 Agent Task、跨 Provider tool protocol、Realtime resume、approval / MCP、
  compaction 或观测成本上提供已经测量的收益，而不是只减少少量胶水代码。

### 15.3 Role-based Model Registry

从 1A.2 开始，Journal 与 Evidence 职责出现后引入 Role-based Model Registry；
1A.3 再随 Entity、Reflection 和 Memory 消费者增加对应 role：

```text
conversation.text
conversation.voice
journal.draft
journal.validate
reflection.daily
reflection.weekly
evidence.extract
entity.resolve
episode.build
memory.extract
memory.consolidate
profile.project
embedding
stt
tts
safety
```

模型名称存在配置和数据库中，不硬编码进领域逻辑。Capability Registry 的
`enabled_roles` 只声明能力匹配候选；是否允许 fallback 由人工发布的 Model Routing
Policy 按 role 显式决定，默认 `disabled`。

### 15.4 首轮评估矩阵

截至 2026-07-24 的起始候选：

| 角色 | Baseline | Challenger |
| --- | --- | --- |
| Realtime Voice | GPT-Realtime-2.1 | GPT-Realtime-1.5、Qwen3-Omni |
| Text Empathy | GPT-5.6 系列 | Claude Sonnet 5、Qwen3.6 |
| Journal / Reflection | 强文本模型 | Claude Opus 5、Qwen3.6 |
| STT / TTS | 固定 OpenAI 基准 | 稳定后再独立评估 |
| Embedding | 中英跨语言效果达标的多语言模型 | Qwen3 Embedding |

1A.1 只从中配置一个 `conversation.text` Champion，不同时实现 Challenger adapter。
Journal / Evidence role 从 1A.2 开始，Entity / Reflection / Memory role 从
1A.3 开始；Challenger 比较从 1A.4 Replay 开始。这只是评估起点，不是永久
供应商决定。

### 15.5 Champion / Challenger 规则

1A.1 只有一个配置化的 Conversation Text Champion，不做自动 model / Provider
fallback。Provider timeout 或结果未知只允许对同一冻结 model config 做有限技术
重试；失败时显式失败，不能静默换模型生成另一种人格表现。

1A.2 和 1A.3 可以为当期 role 配置各自 Champion，但仍不把未评估模型当作 fallback。
1A.4 的开发评测认为 Challenger 适合相应 role 后，才增加对应 Provider adapter，并
由开发者发布版本化 Model Routing Policy。

- Replay 输出与 promotion recommendation 都是 non-authoritative，不能直接修改
  真实流量；
- Challenger 成为 Champion 或 eligible fallback，必须由授权人工显式发布新的
  Model Routing Policy version；
- 每个 Policy version 至少记录 role、Champion config、eligible fallback config、
  支撑决定的评测引用、发布者、发布时间、原因与 predecessor；
- 自动评分、阈值、线上故障率或成本变化可以触发告警和 promotion recommendation，
  不能自动发布、回滚或修改 Model Routing Policy；
- runtime 可以确定性执行已经发布的 Policy，但不能把一次临时路由结果反向写成新
  Policy；
- Champion 按 role 选，不是全系统共用一个模型；
- A/B 以 Session 或 Replay run 为单位；
- 同一真实 Session 不逐 turn 随机换模型；
- 不自动 Shadow 私人对话；
- 不因 Provider 故障静默更换人格表现；
- Fallback 必须预先通过 SayHear eval；
- 所有运行记录 model、Prompt、参数、延迟、成本和结果状态。

开发期 Model Promotion Evaluation 按 role 选择合适证据，但不建设独立审批系统：

- `conversation.text`、`journal.draft`、`profile.project` 等用户可感知 role，必须
  在 `zh-CN`、`en-US` 与 code-switching 样本上比较被理解感、人格一致性、非说教、
  事实与推断边界及 Memory 召回语言；
- `evidence.extract`、`entity.resolve`、`episode.build`、`memory.extract`、
  `memory.consolidate` 等结构化 role 以标注集准确率、typed lineage 与领域不变量
  测试为主，并按需要抽查歧义和失败样本；
- 具体样本、指标和阈值由开发者随阶段调整；Phase 1 不要求持久化独立 Gate 对象或
  完成额外审批流程，开发者在评测后判断模型更好即可发布新的 Model Routing Policy；
- 仅为了替换模型不强制运行 Private Replay。开发者实际选择真实私人 source 做
  Replay 时，才适用既有 Private Replay 隔离、授权、TTL 与删除边界。

从 1A.4 开始，`conversation.text` 可以执行一次受控的 Conversation Fallback
Handover，但不是任意自动路由：

- 仅在 Champion 失败且没有任何输出 token 可能对用户可见、没有 Complete
  Assistant Response 提交时发生；
- 只选择当前人工发布 Model Routing Policy 中预先通过 eval 的一个 eligible
  fallback，并由 Provider Egress Port 重新检查该 Provider 的 policy 与 consent；
- primary 与 fallback 串行执行，不做私人对话 Shadow，不级联更多 fallback；
- fallback 一旦接管，就固定到当前 Continuous Exchange 的后续 Turn，不逐 Turn
  切换或自动切回 Champion；
- 已有 token 可能展示、可见性无法证明，或 fallback 再次失败时，明确失败并由用户
  显式 Retry。

后台生成 role 使用不同的 Role-Scoped Generation Fallback：

- Model Routing Policy 必须为每个 role 显式设置
  `fallback_mode=disabled / single_attempt`，不能从 Capability Registry 全局继承；
- Journal、Reflection、Entity、Episode、Memory、Profile 等具有冻结输入、
  版本化输出与 role-specific validator 的生成任务，可以单独批准
  `single_attempt`；
- fallback 在 Champion 的同配置技术重试失败后串行执行，复用相同 source revision、
  Prompt、Schema、业务 policy 与 validator contract；
- 每个 GenerationCommand 最多一个 role fallback attempt；不合并、投票或自动选择
  多个模型输出，只有通过 validator 与 commit fence 的结果可以成为 authoritative；
- fallback 只影响当前 command，后续任务仍从其冻结 Policy 的 Champion 开始；
- `embedding`、`stt`、`tts`、`safety` 默认禁止 fallback，因为向量空间、声音、
  delivery 与安全语义不能仅凭通用 capability 判断兼容；开放前必须完成独立验证并
  由人工发布新的 Policy。

### 15.6 Prompt 版本

Prompt 由以下层组成：

```text
product_policy
persona
locale_pack
task_instruction
output_schema
safety_policy
```

每层独立版本化。Prompt migration 不批量覆写历史输出。

persona 层是结构化工件（ADR-0111），分三块：Persona Contract Invariant（所有
Persona 共享、不可被风格调节的身份、关系、信任与安全承诺）、Canonical Persona
自我概念与声音描述，以及行为锚点（Selective Curiosity、Curiosity Stop Signal、
Playful Warmth、Conversational Rhythm、Grounded Persona Perspective、
Capability-Honest Directness 的操作性描述）。locale pack 承担各语言自己的语气与
用词习惯，不做机械翻译；task_instruction 按 GenerationCommand 阶段区分（Decision
与 Action Finalization 使用不同 Prompt / Schema）。Safety Posture 激活期间，
Context Compiler 渲染缩减版 persona 变体（见 08-10 §9.6 与 ADR-0112）。人格
承诺同时由 prompt 表达与行为评测硬门禁机械执行。
旧 Journal / Reflection / Claim projection 保留原版本标记，
必要时通过明确 reprocess command 重建新版本。

### 15.7 对话行为与安全检查

Minimum High-Risk Response 是 Core Flow 1A.1 的行为不变量，而不是
External MVP 才开始考虑的能力。检测到明确自伤、伤人或迫在眉睫的危险信号时：

- 暂停普通倾听、非安全必要的追问和一般建议；
- 直接鼓励用户寻求现实中的即时支持；
- 不诊断、不冒充心理治疗师，不承诺绝对保密；
- 允许为了判断即时安全而提出必要且克制的问题；
- 行为策略和最小回放集必须版本化。

Text 和 Realtime 路径可以在交付前运行与其延迟预算匹配的行为检查：

- 是否在未被请求时给建议；
- 是否在同一回应中堆叠多个问题；
- 是否在用户简短回应、回避、拒绝或转换话题后继续原方向追问；
- 是否在同一 Continuous Exchange 使用超过一个 Proactive Memory Follow-up；
- 是否在直接任务、紧急 / 高风险状态中插入无关旧事，或未先回应当前表达；
- 是否使用 contested、dormant、expired、Forgotten 或 suppressed target 主动追问；
- 是否诊断或说教；
- 是否鼓励排他或依赖；
- 是否把用户描述成受害者；
- 是否对事实判断做无条件认同；
- 是否把 AI Impression 用 Objective Memory 或确定事实的语气召回；
- 是否出现高风险安全信号。

检查失败时优先进行一次受控 regeneration，不能无限循环。

Realtime speech-to-speech 无法保证所有音频在播放前完成完整文本审查，因此采用：

- 不可覆盖的 realtime policy；
- Provider 和应用层可用的同步 guardrail；
- turn 后异步行为 audit；
- 高风险输入的并行检测与明确处置；
- External MVP 面向真实用户前补齐地区化危机资源、正式处置流程、
  安全事件运营和评审。

异步 audit 只能记录分类、版本和 Event ID，不把用户正文写进日志。

### 15.8 Provider Egress Port 与后续 Gateway

Commit fencing 只能阻止结果写回，不能撤回已经发送给第三方的正文。
因此所有真实私人数据的 Provider 调用必须经过唯一的 Provider Egress Port，
普通 application module 不能直接调用 Provider adapter。

该规则覆盖 Conversation、Journal、Reflection、Entity resolution、Memory、Replay、Embedding、
STT、TTS 和 Realtime；不同 Provider / role 分别执行 policy check，抽离 Gateway
后再分别创建 authorization。

#### 15.8.1 Core Flow 1A.1：in-process Port

1A.1 的 `ProviderEgressPort` 与 Turn Service 部署在同一个模块化单体 runtime：

1. 接收 GenerationCommand、ModelRunAttempt 和冻结的 CompiledContext reference；
2. 在发送前检查 source active、expected `data_epoch`、freshness、Provider policy
   与适用的 consent；
3. 只从服务端受控 repository 读取本次 payload，调用配置的 Provider adapter；
4. 记录不含正文的 Provider、model、role、source revision、request ID 和 disposition；
5. Provider credential 只存在于 server runtime，不暴露给 Browser 或普通领域模块；
6. 结果仍需通过 attempt / source / epoch CAS 才能成为权威领域状态。

1A.1 不建设独立 Vercel project、授权服务、`claim-and-fetch`、credential broker
或网络 `result-ingest`。模块边界与契约先成立，部署边界延后。

#### 15.8.2 Replay / Voice 抽离门槛

在独立 Replay Runner、Voice Worker 或其他 runtime 处理真实私人数据之前，必须评审：

- 该 runtime 是否需要 Provider credential；
- 是否能被限制为单一 job / Room / source revision；
- 是否应被禁止读取任意用户数据或写入正式领域状态；
- in-process Port 是否已无法提供足够的 credential、故障和删除竞态隔离。

只要独立 runtime 不应持有通用 Provider credential 或产品数据库权限，就必须先
抽离 `ProviderEgressGateway`。以下 authorization 与部署协议是该阶段的规划目标，
不是 1A.1 实现要求。

`provider_egress_authorizations`：

```text
id
model_run_attempt_id
user_id
source_type
source_id
source_revision
freshness_policy
expected_data_epoch
provider
role
provider_policy_version
result_sink
max_response_bytes
status                   # reserved / dispatched / completed / revoked
                         # expired / cancel_requested / canceled / unknown
expires_at
jti
authorized_at
dispatched_at
provider_request_id
```

Request / Workflow / Replay 路径：

1. 调用方只提交 GenerationCommand、attempt 和 source reference；
2. Gateway 在短事务中锁定 User / Source，检查
   `active + data_epoch + freshness policy + provider policy + consent`；
3. 同一事务创建单次、极短 TTL 的 authorization 和无正文 egress audit；
4. Egress runtime 在实际 dispatch 前调用原子 `claim-and-fetch`；
5. 该短事务重新检查 epoch / source validity，在持有锁时读取正文并把 authorization
   从 `reserved → dispatched`，随后 commit；
6. transaction commit 是 egress 线性化点；删除先提交时 claim 失败，
   egress 先 commit 时删除会把该调用视为已在途；
7. `claim-and-fetch` 只把此次实际出站 payload 返回给持有单次 grant 的
   egress runtime；Workflow 和 Replay Runner 不接收该 payload；
8. Egress runtime 立即发送并清空内存 buffer；
9. Provider response 流式送入 authorization 绑定的 `result-ingest` endpoint；
10. `result-ingest` 在事务中重新校验 active status、epoch、单次 grant、attempt、
    role、Schema 和大小上限；删除已经提交时只记录无正文的 discarded metadata，
    否则将正文写入对应非权威结果表，并只返回 result ID；
11. ModelRunAttempt 只记录 result ID 与运行元数据，领域 Service 仍需通过正常
    commit fence 和 CAS 才能把它变成权威结果。

后续抽离 Gateway 时，该逻辑边界计划分为两半：

- `sayhear-app` 的窄 Egress Authorization API 执行数据库 transaction、source read
  和 deletion fence，但没有 Provider credential；
- 独立 `sayhear-egress` Vercel project 持有 Provider credential，
  只接受 Authorization API 签发的单次 grant，且没有产品数据库 credential；
- dispatch 前由 `sayhear-egress` 使用 grant 调用单一 `claim-and-fetch` endpoint；
  该 endpoint 在一次 transaction 中完成 fence、状态迁移和受控正文读取；
- Provider output 只可回传到 grant 绑定的 `result-ingest` endpoint，
  不能由 Egress project 自选表、subject 或 result role；
- 任一 endpoint 都不把正文写入日志、Workflow history 或 grant。

删除与 egress 的竞态语义：

- 删除先于 dispatch claim：Provider 不能收到正文；
- dispatch claim 先于删除：该调用视为已经在途，删除流程记录 Provider disposition，
  尽力 cancel，并按核验的 Provider retention 进入 `retention_pending`；
- 删除事务撤销全部 `reserved` authorization；
- Provider 不支持 cancel 时记录 `unknown / policy_expired`，不能假装已撤回；
- authorization 默认 30 秒内过期、`jti` 单次使用；Realtime 采用每 turn authorization。

Gateway 抽离后，Realtime 不能绕过这条边界：

- Voice job 开启 Provider session 前取得 job-scoped egress grant；
- 每个 User turn 在开始向 Provider 提交可识别音频前 claim 新 authorization；
- Gateway 自己持有 Provider static credential，或签发 Provider 支持的短期、
  job-scoped credential；
- Provider 若只能把长期 static key 暴露给通用 Voice Worker，且无法执行每-turn
  epoch fence，则不能成为正式 Champion；
- 删除时立即停止新 turn、撤销未 dispatch grant，并尽力关闭已在途 Provider session。

这套 Gateway 不要求把低延迟媒体代理回 Vercel。Realtime credential broker /
egress guard 可作为 LiveKit Cloud Agent deployment 中的受限进程，但必须使用同一
authorization 表、线性化协议和审计契约；通用 Worker 业务代码不能直接读取 static key。

## 16. Internal Core 中英文能力与多语言扩展

### 16.1 Locale

- Internal Core 承诺并分别验收 `en-US` 与 `zh-CN`；
- 字段使用 BCP-47，不使用 `is_chinese` 一类布尔值；
- timezone 使用 IANA，例如 `America/Los_Angeles`；
- locale 与 timezone 分开；
- 原文不被翻译文本覆盖；
- code-switching 保留 segment-level locale，并进入 Internal Core 质量评估。

### 16.2 Prompt

- 产品行为原则共享一份语义定义；
- Internal Core 分别维护并验收英文和中文语言与风格 pack；
- 中文不是英文 Prompt 的机械翻译，英文也不能从中文机械反译；
- 每种语言独立评估追问强度、建议倾向、共情表达和 token budget；
- 未通过独立 eval 的 locale 不能只因模型宣称支持就进入 Capability Registry。

### 16.3 Memory

- InteractionTurn、Event、Evidence、Entity、Episode 和 Claim ID 都与语言无关；
- Entity label / alias 和 Claim statement 是 localized projection，修改投影不改变稳定 ID；
- Claim predicate 使用版本化 `sh.*` namespace，不以英文或中文句子作为 identity；
- 公共知识 ID 只作为 Entity external mapping，不替代 SayHear ID；
- Embedding 必须显式验证中文、英文和 code-switching；
- 中文输入应能召回相关英文历史，英文输入也应能召回相关中文历史；
- 跨语言检索、同一 Claim 的多语言去重与双向召回进入 Internal Core 独立 eval。

### 16.4 部署

当前只需要海外部署和英文、中文能力。

不建设：

- 中国大陆备案与合规栈；
- 大陆专属模型路由；
- 双写中国数据库；
- 大陆媒体节点。

使用 Qwen 等服务时，仍需逐 Provider 记录实际处理地区，
优先选择非中国大陆端点或明确可接受的数据区域。

## References

- [原始 核心架构 v0.1 快照](../archive/architecture/sayhear-core-agent-architecture-v0.1.md)
- [在线对话、Context 与检索](08-10-conversation-runtime.md)
- [隐私、安全与生命周期](18-20-privacy-security-lifecycle.md)

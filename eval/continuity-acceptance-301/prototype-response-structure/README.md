# 回应结构对照原型（SPEC #301，一次性）

**这是一次性原型，不是交付物，不合入任何分支。** 它只回答一个问题：在不计时延的前提下，哪一种回应结构能让真实模型
（DeepSeek V4.1 Flash 经 OpenCode Go）给出合格的连续记忆回应。`prototype` skill 的两个标准形态（HTML 逻辑演示、
UI 变体）都不贴合这个问题；这里的形态假设是「一条命令可跑的对照运行器 + 一份并排对比报告」。结论见
[`Findings.md`](Findings.md)。非权威评测制品（ADR-0020 / ADR-0073），全部为合成数据。

四组共用同一模型、同一套 13 个 holdout 案例、同一 oracle、同一个 120 秒请求预算，只用环境变量
`SAYHEAR_PROTOTYPE_STRUCTURE=0|1|2|3` 选组，变量不设时产品行为与 `f179b3d` 相同。**组 0** 什么都不改，只放宽预算。
**组 1** 产品代码不变，验收工具的出站旁路在每个真实请求体上加 `thinking: {"type": "disabled"}`。**组 2** 不再向模型提供
`review_conversation_history`，改由代码在每个普通回合开始前确定性地决定查什么、查到就把原文附在系统指令末尾，整回合只有
一次模型调用，没有独立的 History Answer 阶段。**组 3** 仍向模型提供回顾函数，但回顾结果作为工具结果回到同一段模型对话里，
模型可以再查，最多执行 3 次回顾；一次返回多个调用时按序执行，参数有瑕疵时丢弃坏字段或把错误作为工具结果回给模型，
不再判整回合技术失败。**四组都没改的**：模型与端点、Persona 与任务指令文本、七天背景与 DialogueState 的编译、来源资格
围栏（按日期读取与原文检索用的仍是产品自己的 SQL 和预算）、`history-reading:v2` 阅读合同与回执措辞、Trust Action、
取消与恢复、持久化与提交围栏。不加 embedding，不引入外部运行框架。

## 运行

```bash
createdb sayhear_test_proto && createdb sayhear_marker_proto        # 本机合成库，可随时 dropdb
node eval/continuity-acceptance-301/prototype-response-structure/run.mjs --group 0 --cases H05,H06,H01
node eval/continuity-acceptance-301/prototype-response-structure/run.mjs --group 3            # 全部 13 个
node eval/continuity-acceptance-301/prototype-response-structure/collect.mjs                   # 汇总成 runs/summary.json 与 samples
```

每格（组 × 案例）跑一次，每次由 `run-case` 新建隔离 schema 并重新装载合成历史。凭据只从 profile 文件读
`OPENCODE_GO_API_KEY` 一个变量（沿用 T08 的 `--provider-credential-file`）。每次真实调用记入 `../cost-ledger.json`。

## 请求预算覆盖（只在本分支）

产品只允许把预算收紧到 30 秒以内。本分支加了一个变量 `SAYHEAR_PROTOTYPE_REQUEST_BUDGET_MS`，三处一起放宽到 120000：

| 位置 | 原值 | 原型 |
| --- | --- | --- |
| `apps/web/src/runtime-config.ts` 端到端预算 `SAYHEAR_CONVERSATION_REQUEST_BUDGET_MS` 的上限 | 30000 | 120000 |
| 同文件对话 Provider 超时 `SAYHEAR_CONVERSATION_PROVIDER_TIMEOUT_MS` 的上限 | 30000 | 120000 |
| `src/client.ts` CLI 观察上限 `CHAT_OBSERVATION_LIMIT_MS` | 33000 | 123000 |

`src/budget.ts` 的规划上界同步放大：每请求输出 token 上界 12000 → 48000（按 30 秒 → 120 秒等比），组 3 每次尝试
允许的额外往返 1 → 4。3 秒 / 10 秒门槛本次不作通过条件，时延只记录。HL1 里「Provider 不回应时按 30 秒停止」的判据
因此在四组里同样不成立，不计入对比。

## 各组实现细节

### 组 1：关思考

`src/provider-gate.ts` 在 `SAYHEAR_PROTOTYPE_STRUCTURE=1` 时给每个真实请求体加 `thinking: {type: "disabled"}`，请求记录标
`prototype: thinking=disabled`。正式跑之前先用一个单回合案例确认 reasoning token 为 0；关不掉就把该组标为「无法构造」。

### 组 2：检索前置（查询构造在看到任何真实输出之前写定，之后不改）

实现在 `packages/application/src/prototype-response-structure.ts` 的 `frontload`，由 Provider Egress 在发出 Decision
请求前调用。输入只有产品已有的 `HistoryContinuationSignals`：当前输入、Decision 上下文里最近的用户消息、DialogueState 主题。

1. **时间优先。** 仓库里没有针对用户原话的确定性日期解析（产品一直让模型自己把日期换算成 `YYYY-MM-DD`），所以原型自带
   一个小的中英文规则解析器 `prototypeParseDates`：`YYYY-MM-DD`、`M月D日/号`、`D号`、昨天/前天/大前天、`N天前`、
   上周X / 上周 / 这周X、yesterday、the day before yesterday、`N days ago`、`last <weekday>`、last week、
   `<Month> D`、`the Dth`。只接受早于今天的日期。命中时按日期回顾（复用 `resolveHistoryQueryPlan`、
   `readHistoryRange`、`selectHistoryRecall` 与它的覆盖说明）；原话里有「发生 / 做了什么 / happen / what did I do」时
   用 `experienced_date`。命中日期后不再做词法检索。
2. **否则取词。** 候选词：ASCII 单词（≥3 字符，去英文停用词）和中文片段（去掉停用词后每段的 2–4 字整段，以及其中所有
   二字、三字切片）。对每个候选词统计它在七天以前的用户消息里出现在多少条消息中，只保留出现过、且不超过
   max(5, 30% 消息数) 条的词，按「越少见越靠前、越长越靠前」取最多 6 个（互相包含的只留一个）。
3. **分层回退。** 先只用当前输入的词；一个可用词都没有时，才退到最近 3 条用户消息加 DialogueState 主题的词。两层都
   没有可用词时什么都不带，记 `no_clue_words`。Entity 没有用：验收环境关闭了后台派生，Entity 图谱是空的。
4. **检索与呈现。** 用选出的词构造一个 `search_experience` 的 continuation 提案（范围：七天前往回 400 天），交给产品的
   `runExperienceSearch`（同一套归一化、原地词法扫描、相邻上下文、分组与 continuation 判定，默认策略 6 词 / 3 组）。
   没有命中时什么都不带。命中时把 `renderHistoryRecallReceipt` 的回执（含 `history-reading:v2`）和被引用的原文
   （每行带说话时间）附在系统指令末尾，前面加一句说明：这是系统自动带入的较早原文，对方没有要求也没有看到，可能
   与当前这句话无关，无关就照常回应、不要提它。
5. 冻结前的一轮微调：先用无模型的 deterministic 冒烟跑了 H05、H06、H01，只看前置检索自己的决定（没有任何模型输出），
   据此改了三处：去掉不带「上 / 这」的裸「周X」（把「约了周六去换」这类将来安排误判成日期）；把少见词的上限从
   max(2, 20%) 放宽到 max(5, 30%)（历史只有几条消息时人名被当成常见词滤掉）；补了几个英文停用词。这轮微调看过
   holdout 的输入文本，是本组的一个偏向来源。此后不再改。
6. 不用 embedding。每次前置检索的决定（日期 / 词 / 层级 / 命中行数）写到 `runs/g2/<案例>.prototype-log.jsonl`。

已知取舍：没有模型选词，所以问「第一次 / 最早」这类需要大范围日期的问题没有专门处理；命中时仍保留 Trust Action 等
其他函数。

### 组 3：小循环

实现分两处：OpenCode Go 适配器里的循环（`packages/ai/src/opencode-go-conversation-text-model.ts`）和执行回顾的
`runToolCall`。模型调用 `review_conversation_history` 时，适配器不再把它交给 Harness，而是：容错解析参数
（未知字段忽略、过短或过多的检索词丢弃、非法日期丢弃；仍不可用就把原因作为工具结果回给模型）→ 用产品同一套
按日期读取或原文检索执行 → 把回执加原文作为 `tool` 消息追加到对话里再请求一次。一次响应里的多个回顾调用按序执行；
整回合最多执行 3 次回顾，之后的请求不再提供回顾函数。同一步里的其他函数调用得到一句「这一步没有执行」的工具结果。
最终的正文按普通 Decision 回答提交。

与现有结构的差别（都是有意的）：没有独立的 History Answer 命令和它自己的任务指令，回顾结果不冻结成
`history_recall_results`，Inspector 因此不显示回顾记录；是否发起回顾、带出了哪些原文要从出站请求体和
`runs/g3/<案例>.prototype-log.jsonl` 里看。工具往返时不回传模型的推理内容（适配器本来就丢弃它）。

## 评审口径

沿用 T08 的逐条判据方式，去掉时延判据。组 2、组 3 没有 Inspector 回顾记录，依赖它的客观判据由评审按出站请求体
人工判定并注明。主观项按 `evidence-321/LUKE-REVIEW.md` 末尾 Luke 的裁定口径给咨询性判断，不替他裁定。
holdout 已被 T08 跑过并据此修过一个缺陷，不是未见样本：结果只用于组间对比，不是验收证据。

# 连续记忆真实模型验收证据（T08 #321）

## Status

验收结论：**未通过**。非权威评测制品（ADR-0020 / ADR-0073），全部为合成数据，未触及生产或真实 Owner 数据。
本文件不是发布许可；候选版本不能进入发布流程。

## TL;DR

- 在冻结的集成版本上用真实 DeepSeek V4.1 Flash（经 OpenCode Go）跑了 20 次 holdout 场景运行
  （12 类各一次，日期覆盖、较早自然接续、来源控制、取消恢复各再两次）外加生命周期案例 HL1：
  **20 次里 0 次通过，13 个案例 0 个通过。**
- 最大的问题是时延：真实 Provider 回答的 52 个回合里，只有 5 个同时满足“首段 ≤3 秒、完整 ≤10 秒”。
  日期覆盖（H01）和来源控制（H12）各 3 次运行全部在 30 秒被停止，没有任何回答。
- 时延的直接原因是模型每次先做 200–4500 个 token 的推理才出正文。把推理强度设为 `low` 的诊断实验
  **没有改善**（12 个回合 1 个达标）。固定模型下单段回应达不到 3/10 秒，需要 Luke 决定方向。
- 另有四类与时延无关的功能性失败：单字检索词让整回合报错（已修复并再验证）；模型一次发多个回顾调用
  整回合报错；该接上较早话题时模型不发起回顾；History Answer 经常“看不到”已引用的原文。
- 模型答出来的回合，内容质量大多不错（时间换算、空白日、旧经历复述、身份回答）。
- 花费上界 0.84 美元（含 #307 那一笔），余额 9.16 美元。

## 冻结身份

| 项 | 值 |
| --- | --- |
| 集成分支基线 | `origin/claude/implement-spec-5f66cb` @ `9b4ed5e` |
| 产品指纹（apps + packages + lockfile 的 git tree、迁移摘要、策略版本） | `9e5d6eacc13efa6257abc266d91960ebe559f3aaee5c7dbbcb0713caaa62e1cc` |
| git tree | apps `a473c327`，packages `f7f4e455`，lockfile `54719980` |
| 迁移 | 83 个，最新 `0081_history_recall_governance.sql`，摘要 `a66b971a…` |
| 模型 / Provider | `deepseek-v4.1-flash` 经 `opencode-go`，固定端点，对话路径不带任何请求参数（无 `max_tokens`、无推理强度） |
| 策略版本 | persona `canonical-persona:v2`、decision `task-instruction-decision:v4`、history answer `task-instruction-history-answer:v1` / `v2`、`history-recall:v4`、`history-reading:v2`、`history-experience-search:v1`、harness `conversation-harness:v4`、compiler `context-compiler:time:v3` / `history-time:v1`、`recent-context-selection-policy:v1` |
| 开关 | `SAYHEAR_HISTORY_RECALL_ENABLED=true`，history-recall 与 recent-context 治理经操作路由启用；后台派生（Evidence、Claim、consolidation、Journal、Reflection、Episode）关闭 |
| 请求预算 | 产品默认：端到端 30 秒，对话 Provider 超时 30 秒 |
| holdout 样本 | `holdout/FREEZE.json`，提交 `45f4665`，早于第一次真实模型调用 |

每次运行目录里的 `versions.json` 记录当时的完整版本。验收工具自身在正式运行期间有提交，产品指纹不变。
“暴露后修复再验证”的运行使用新的产品身份（提交 `a4c02ed`），单独标注。

## 做了什么

1. **确定性基线**（冻结身份上）：`pnpm test:ci` 2516/2516（196 个文件，其中 52 个系统套件，0 skip）；
   `pnpm typecheck`、`check:boundaries`、`check:purge-surfaces`、`check:schema-extensions`、`pnpm build` 通过；
   `acceptance:continuity suite --expect-known-red` 无失败、账本吻合（退出码 2：语义判据未运行，符合预期）。
2. **接通 real-model 传输**（TDD）。OpenCode Go 适配器的端点写死、不接受 base URL，所以没有改产品代码，
   而是在被测 app 进程里给 `fetch` 加了旁路（`src/egress-tap.mjs`，`node --import` 加载）：
   请求正文先给 CLI 侧的 gate 看；种子回合由 gate 本地回放 fixture 里“当时的回复”；真实回合原样发往
   Provider，答复抄一份回来。凭据只随真实请求走，gate 看不到。每个请求记录是 `live`、`served` 还是 `fault`，
   不是 `live` 的回答不参与语义和时延评分。
3. **冻结 holdout**：见 `../holdout/README.md`。
4. **正式运行**：`formal/run1`（13 个 holdout）、`run2`、`run3`（H01、H05、H10、H12）。每次运行新建隔离 schema。
5. **补充运行**（开发包，不是 holdout）：S01、S02、S03、C13、C16 各一次，用于普通聊天、必要 Trust Action、
   带更正的回顾的时延样本。
6. **评审**：`reviews.json`，逐条账本项给出判定和原文引用，`report --review` 重评。
7. **诊断与再验证**：见下文，均不是验收证据。

## 20 次场景运行逐案结论

时间为 CLI 网络观测（秒），“—”表示没有文字或没有提交。完整表格见 `formal/summary.md`。

| 运行 | 案例 | 类别 | 回合：首段 / 完整 | 结论 | 主要失败 |
| --- | --- | --- | --- | --- | --- |
| run1 | H01 | 日期覆盖 | recap — / —；detail — / — | 失败 | 两个回合都在 30 秒超时，无回答 |
| run2 | H01 | 日期覆盖 | recap — / —；detail — / — | 失败 | 同上 |
| run3 | H01 | 日期覆盖 | recap — / —；detail — / — | 失败 | 同上 |
| run1 | H02 | 说过/发生过 | said 15.6 / 16.5；happened 18.7 / 19.5；when 4.0 / 4.4；market-when 2.3 / 2.8 | 失败 | 语义全部通过；4 个回合里 3 个超时限 |
| run1 | H03 | 跨午夜/重复小时 | night 29.5 / —；order — / —；trip — / — | 失败 | 第一回合写到一半在 30 秒被中断，后两回合超时 |
| run1 | H04 | 三个月前的普通经历 | ask 16.7 / 17.2 | 失败 | 语义与来源全部通过；时延超限 |
| run1 | H05 | 较早自然接续 | bare 3.9 / 4.1；garden 8.9 / 9.3；cued — / — | 失败 | 未发起回顾；bare 直接当成合唱团的回信；cued 超时 |
| run2 | H05 | 较早自然接续 | bare 1.9 / 2.0；garden 8.2 / 8.3；cued 16.4 / 17.0 | 失败 | 未发起回顾；cued 把信接到合唱团 |
| run3 | H05 | 较早自然接续 | bare 3.1 / 3.2；garden 9.5 / 10.3；cued 12.6 / 12.8 | 失败 | 同上 |
| run1 | H06 | 同名消歧 | ping 23.3 / 23.5；role 13.4 / 13.9 | 失败 | 两个 Kevin 被当成一个人；把九天前的评审说成今天；室友的一条旧消息未出站 |
| run1 | H07 | 变化/更正/取消 | where — / —；party — / —；september — / — | 失败 | 三个回合都是 `invalid_response`，无回答（单字检索词、一次多个回顾调用） |
| run1 | H08 | 用历史理解感受 | praise 10.8 / 11.8 | 失败 | 未发起回顾，一个月前的话未出站；共情本身待 Luke 裁定 |
| run1 | H09 | 人格一致 | light 8.3 / 8.5；recall 24.5 / 25.0；turn 4.5 / 5.4；probe 6.3 / 7.0 | 失败 | 事实与身份判据通过；4 个回合全部超时限；人格待 Luke 裁定；第二模型配置未执行 |
| run1 | H10 | 取消恢复 | supplement 2.7 / 2.9；switch 13.2 / 13.5；after 3.4 / 3.8 | 失败 | 取消、重发、重启的客观判据与语义全部通过；时延超限 |
| run2 | H10 | 取消恢复 | supplement 6.8 / 7.1；switch 19.7 / 20.4；after 2.9 / 3.5 | 失败 | 只问同行者却把第二天也讲了；时延超限 |
| run3 | H10 | 取消恢复 | supplement 10.1 / 10.4；ask-again 1.2 / 1.6；switch 9.3 / 9.3；after 3.8 / 4.2 | 环境错误 + 失败 | 第二次取消没触发（模型 1.2 秒答完，早于 1.8 秒的取消点）；supplement 同 run2；时延超限 |
| run1 | H11 | 没有/较早/第一次 | empty 4.0 / 4.6；older 28.7 / 29.1；earliest — / — | 失败 | empty、older 语义通过；earliest `invalid_response` 无回答（检索词含单字“猫”） |
| run1 | H12 | 来源控制 | work — / — | 失败 | 30 秒超时，无回答；排除类客观判据通过 |
| run2 | H12 | 来源控制 | work — / — | 失败 | 同上 |
| run3 | H12 | 来源控制 | work — / — | 失败 | 同上 |
| run1 | HL1 | 生命周期（附加） | supplement 3.5 / 3.6；after 9.4 / 10.0 | 失败 | 被取代的回答未展示、30 秒停止、补充回答的语义都通过；两个回合时延超限 |

补充运行（开发包，非 holdout）：S01 普通聊天 6.7 / 6.9；S02 必要 Trust Action 9.5 / 9.7，随后的普通一句 30 秒超时；
S03 带更正的回顾 24.1 / 24.3；C13 16.0 / 16.7；C16 30 秒超时。六个回合没有一个达标。

## 逐条 Acceptance criteria

| 条目 | 状态 | 依据 |
| --- | --- | --- |
| 12 类场景与 R1–R12、三种语言及故障变体均有映射 | 通过 | `../holdout/README.md` 的对应表；zh 6 个、en 5 个、code-switch 2 个；故障矩阵 `../fault-matrix.md`。R9 的第二模型配置、历史读取失败注入、并发 Full Purge 标为未执行，未以场景数裁掉 |
| 核心事实/时间/覆盖/用户控制和交付判据逐例通过 | **失败** | 20 次运行 0 次通过，见上表 |
| 普通问答、回忆、必要 Trust Action 及冷/暖均有证据；所有正式样本满足 3/10 秒及 30 秒停止 | **失败** | 52 个回合 5 个达标。30 秒停止本身有效。冷状态只有重启后首回合 3 个样本（H10 `after`：3.4 / 2.9 / 3.8 秒），其中 1 个达标 |
| Agent 完成逐案有证据的验收报告、失败归因和建议；主观项集中裁定 | 通过 | 本文件、`reviews.json`、`LUKE-REVIEW.md`。主观项保持 needs-review |
| 共享预算账本完整、未超上限 | 通过 | `../cost-ledger.json`：37 条、177 个真实请求、上界 0.844 美元 |
| 发布候选身份、允许配置、隔离验收报告、剩余观察项和回滚条件齐备 | **未达成** | 身份与配置已记录；验收未通过，没有可进入发布流程的候选 |

## 失败归因

### 1. 时延：生成行为（模型推理不受限）——责任 #319，承接 #312

每个真实请求的时间线都在 `transcript.md` 里。典型的一次：首字节约 1 秒到达，随后全是 `reasoning_content`，
正文在 4–28 秒后才出现。回顾回合要两次调用（Decision 与 History Answer），两次各推理一遍。

- 普通回合：输出 80–1800 token，其中 reasoning 占 73%–97%。
- History Answer：一次 600–4500 个 reasoning token；H01、H12 的 History Answer 推理超过 24 秒仍未出正文。
- 连 Decision 自身也会卡住：H01 `detail`、H03 `order` / `trip`、S02 `plain` 推理 29 秒没有任何输出，被 30 秒预算停止。
- 后台角色 `dialogue.state` 每次 1400–1700 个 reasoning token（10–14 秒），不占用户等待，但计费。

对话路径没有给 Provider 传任何参数。诊断实验（`diagnostic/effort-low/`，标记为实验）给真实请求加上适配器
已支持的 `reasoning_effort=low`：12 个回合只有 1 个达标，reasoning token 没有下降（单回合仍到 3500）。
也就是说这个参数在这条通道上不起作用，或者不足以起作用。

依票面第 5 点：单段在固定模型下达不到 3/10 秒，带实测返回，没有改模型或门槛。

### 2. 单字检索词让整回合失败：source selection / 实现缺陷——责任 #316（已修复并再验证）

`normalizeHistoryReviewCall` 要求每个检索词至少 2 个字符，任何一个不满足就把整次调用判为 invalid；
Egress 随即抛 `invalid_response`，回合以技术失败结束，用户看不到任何回答。真实模型常在可用词旁边带一个单字：
`["搬家","搬进来","新家","住","房子"]`（H07）、`["猫","橘猫","救助站","领养","猫粮"]`（H11），
实验运行里 H04 也因为一个“河”字失败。

修复 `a4c02ed`（red → green，`packages/application/src/history-recall.test.ts`）：过短的词被丢弃，用剩下的检索；
一个可用词都没有时仍判 invalid；最小长度本身不变。再验证（`reverify/after-short-clue-fix/`，
**不是 holdout，产品身份已变**）：H07、H11 的六个回合全部提交了回答，不再报错；时延与来源判据仍然失败。

遗留：只给一个单字（例如只有“猫”）时回合仍会技术失败；中文单字是否应当可检索是 ADR-0115 门槛问题，没有改。

### 3. 一次发多个回顾调用让整回合失败：生成行为 / 交付——责任 #314

H07 `party`（2 个调用）、`september`（3 个调用）：Harness 遇到第二个 `history_query_proposal` 抛
`invalid_response`。这里它是前一回合失败的连锁反应：模型想把还没答上的前几个问题一起查。
没有修：取哪一个调用是产品语义，不是机械缺陷。建议至少让它退化成普通回答，而不是技术失败。

### 4. 该接上较早话题时不发起回顾：source selection（模型不提案）——责任 #317

H05 三次运行、H08 一次：模型没有调用 `review_conversation_history`。H05 `cued` 有三个线索
（翻土、邮寄的信、committee），模型两次只调用了 `curiosity_stop_signal`，把信接到七天背景里最近的合唱团邮件上。
`bare`（没有任何线索词）三次都没有检索，也没有把两件待回复的事都点出来。deterministic 模式下这些判据
是靠脚本通过的（`pipeline-only`），真实模型不做这个选择。

`bare` 这一步在当前设计下基本不可达：检索词只能来自当前输入，而当前输入里没有可用的词。这需要产品层面的判断。

### 5. History Answer “看不到”已引用的原文：时间投影 / 生成行为——责任 #314、#315

再验证运行里，History Answer 三次明说拿不到内容，尽管来源已经出站（Inspector 记录 2–4 条来源）：
“那两天具体说的是什么，我这儿看不到内容，没法念给你听”（H11 `older`）。模型的推理里反复出现同一句话：
引用的消息“并没有真的显示给我”。正式运行里同一问题答对过（H11 run1），所以这是不稳定而不是必然。
它同时是时延的放大器：H04 的 History Answer 花了 3104 个 reasoning token，开头就在核对“哪些消息是被引用的”。
`history-reading:v2` 的阅读合同在真实模型下**没有被稳定遵守**。

相关的时间错误：H06 把九天前的事说成“今天这一下午”；H07 再验证里把 10 月 27 日的更正说成“11 月 21 日晚上说的”；
H10 run2 把两天说成“weeks”。

### 6. 同名消歧失败：生成行为——责任 #317、#318

H06 `role`：把室友 9 月 27 日的消息算作设计师“名字出现过的地方”，并说看不到他是做什么的，
而原文明确写了他是隔壁组新来的 designer。Assistant 当时的猜测没有被说成事实（这一项通过）。

### 7. 环境

H10 run3 的第二次取消没有触发（模型比取消点快），记为 environment-error，不计入产品结论。
`reasoning-effort=low` 实验与 `--history-recall off` 诊断都改变了被测条件，只作诊断。

## `321-risks.md` 待证事项

| 事项 | 结论 |
| --- | --- |
| 模型是否会在该回顾时发起提案 | 明确问过去时会（按日期或按检索，方向都正确）；需要“自然接续”时不会（H05 0/3，H08 0/1）；H06 会 |
| `search_terms` 质量 | 词本身合理、贴近用户原话，常带同义词；问题是常带单字词（已修）和把上一回合没答的问题一起查（多调用） |
| 阅读合同（`history-reading:v2`）是否被遵守 | 不稳定，见归因 5。C12 类的“更正后数字当现状”**未验证**：H12 三次都超时，没有回答可判 |
| 功能关闭 / Retry 时会不会说“没聊过” | **会。** `diagnostic/history-closed/`：H04 答“没提过你自己下河游泳的事”，H11 答“十月头几天也没有……再往前，什么都没有了”。问“第一次”时反而有保留。Retry 路径未单独测 |
| 对话路径是否需要 `max_tokens` / 推理上限 | 需要某种上限，但 `reasoning_effort=low` 实测无效，见归因 1。`max_tokens` 未测：它会把超长推理变成 `length` 失败而不是更快的回答 |
| `outbound_excludes` 片段匹配误报 | 未出现。H12 的排除判据三次都通过（来源确实没有出站） |
| 首 token 探针失败关闭的 interrupted 比例 | 没有观察到探针导致的中断；出现的 interrupted 都是 30 秒预算 |
| 真实 Forget 会关联哪些消息 | 未验证。S02 里模型发起了 `memory_forget_request`，但环境没有 Claim，Action 回答“没有生效”；H12 的 Forget 仍是 seed 直接写的关联 |
| R9 第二模型配置 | 未执行：没有可执行的获准配置 |

## 未执行项

- **浏览器呈现验证**：未执行。所有时间都是 CLI 网络观测，不能当作 UI 体验。
- 第二个获准模型配置下的人格一致（R9）。
- 历史读取失败 / 部分读取的注入；HTTP 上与历史回合并发的 Full Purge（进程内测试已有）。
- H01、H03、H07、H12 的语义判据：没有提交的回答可评。
- Retry 路径上的诚实性。

## 需要 Luke 决定的事

1. **时延方向。** 固定模型、单段回应、不设推理上限的组合达不到 3/10 秒，`reasoning_effort=low` 无效。
   可选方向包括：换一个能真正限制推理的参数或通道、两段式回应、放宽门槛、换模型。这些都超出本票授权。
2. **功能关闭时的诚实约束**（已撤回的 `47b7d14`）。实测模型会说“没提过”，是否给普通回合加那句话。
3. **没有线索的“他们终于回信了”**（H05 `bare`）在当前设计下是否仍是验收要求。
4. **中文单字检索词**是否应当可用（ADR-0115 的门槛）。
5. `LUKE-REVIEW.md` 里的 9 个主观问题。

## 花费

| 项 | 值 |
| --- | --- |
| 单价（保守上界） | 输入 $0.30 / 百万 token，输出 $1.20 / 百万 token：OpenCode Go 文档与 DeepSeek 官方价表（2026-10-11 查）的 Peak 价，二者一致；全部按未命中缓存计 |
| #307 历史调用 | 1 次，2131 入 / 564 出，补记上界 $0.001317 |
| T08 | 176 个真实请求，约 46.9 万输入 / 21.7 万输出 token，上界 $0.8431；其中 usage 未知（被 30 秒预算切断）的请求按每次 $0.0192 的规划上界计 |
| 合计 / 余额 | $0.8444 / $9.1556（上限 $10，与 #307 共享） |

OpenCode Go 是订阅套餐，本工具看不到一次调用消耗的是套餐额度还是新增现金；预算门禁一律按标价计，
实际新增现金不超过上表，可能为零。授权来源：协调 Agent 转述的 Luke 2026-10-11 原话，记在账本的
`preconditions[0].decision`。#307 前置记为 `owner-waived`，不是 verified。

## 对既有实现与测试的看法

- 管线、来源控制、取消恢复、30 秒停止这些确定性部分是扎实的：真实模型下排除判据、幂等、被取代回答不展示、
  超时结算全部成立，没有一次迟到提交。
- 但 T01–T07 的“绿”几乎都是 `pipeline-only`：是否回顾、查什么都是脚本给的。真实模型在最关键的两处
  （自然接续、阅读已引用原文）并不按脚本走。
- 时延工作（#319）只用桩测过 SayHear 自身开销，从未测过模型推理时间，而后者占了 90% 以上。
- 开发 fixture 有几处让判据测不出它声称的东西：C01 的最后一条种子消息自己列出了“五件事”；C02 的“上周日”
  在说话日和提问日解析出同一天；几处把“可以顺带提”的内容写成必需事实。Decision 的函数说明里直接用了
  开发案例的句子当例子（“did I ever tell you about playing the piano”“they finally wrote back”
  “when did I first mention painting”“what did I tell you on August 20”），所以开发案例对这份 Prompt 不是独立样本。
- Provider 提案的任何瑕疵（一个过短的词、多一个调用）都被当成整回合的技术失败，这在桩下永远不会发生，
  在真实模型下一轮里就出现了三种。

## 如何复核

```bash
pnpm acceptance:continuity validate --pack holdout
gunzip -k eval/continuity-acceptance-301/evidence-321/formal/run1/H04/observation.json.gz
pnpm acceptance:continuity report --run eval/continuity-acceptance-301/evidence-321/formal/run1/H04 \
  --review eval/continuity-acceptance-301/evidence-321/formal/run1/H04/review.json
pnpm acceptance:continuity summary --run <存放解压后运行的目录>
```

`observation.sha256` 是解压后 `observation.json` 的摘要。`collect.mjs` 是把 `artifacts/` 里的运行整理到本目录、
套用评审并检查凭据不在任何证据文件里的脚本。

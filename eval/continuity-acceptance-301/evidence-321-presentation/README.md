# 呈现修复后的真实路径再验证（SPEC #301）

## 这是什么

`history-reading:v3`（较早原文作为材料块放在指令末尾、更正就地说明）与 `history-recall:v5`（Decision 函数说明措辞）落到产品之后，
用**产品默认结构、默认 30 秒请求预算、不带任何原型或诊断开关**，经真实对话路径（`next dev` 的 `apps/web`、真实 Decision、检索、
Context Compiler、Egress、提交）调用真实模型的结果。

- 产品提交 `600c061`（`spec-301/history-presentation`），模型 DeepSeek V4.1 Flash 经 OpenCode Go，2026-10-12。
- **这不是验收证据。** holdout 已被 T08 和原型看过两轮，本次是「暴露后修复再验证」。语义判断由做修复的同一个 Agent 给出，
  没有盲评、没有第二评审，只是咨询性的；主观项（P-*）没有评。
- 13 个 holdout 案例各跑一次（`runs/full1/`），H12、H07、H05、H01 各再跑两次（`runs/rep2/`、`runs/rep3/`，每次都从全新的合成库开始）。
- 逐回合数字：[`turns.md`](turns.md)（`node collect.mjs runs/full1 runs/rep2 runs/rep3` 生成）。每个案例目录里有
  `transcript.md`、`report.md`、`timings.json`、`versions.json`、`observation.json.gz`（读之前 `gunzip -k`）。
- 花费：本次 0.531 美元（保守单价上界，逐次运行记在 `../cost-ledger.json`），在 1.5 美元上限内。

## 一句话结论

**呈现问题消掉了，时延门槛和几类与呈现无关的失败还在。**

- 「原文已出站却认不出 / 答看不到」：32 次回顾后的回答调用里 **0 次**（正则命中 3 次，逐条读过都不是）（T08 与原型组 0 各 6 次）。
- 回顾后回答调用的推理量：首轮 16 次合计 10,214 token、中位 547、最大 1,384；原型组 0（同结构，120 秒）17 次合计 46,345、中位 1,112、最大 11,664。
- H12 更正方向 3/3 正确，3 次都没有把旧数字带回来。H07 在 T08 三个回合全部失败，这次 9 个回合全部提交，其中 6 个答对。
- 仍然没有任何一个历史回合满足 3 秒 / 10 秒；H01 这类长回顾在 30 秒内提交不了；Decision 调用本身仍会单独推理到 30 秒超时。

## 与 T08、原型组 0 的对比（13 例各一次，不含 HL1）

| | T08 run1（同结构，30 秒，改前） | 原型组 0（同结构，120 秒，改前） | 本次 full1（30 秒，改后） |
| --- | --- | --- | --- |
| 发出真实请求的回合 | 32 | 32 | 32 |
| 提交 | 19 | 30 | 24 |
| 回顾后回答调用（有 usage 的） | 8 | 17 | 16 |
| 其推理 token：合计 / 中位 / 最大 | 15,671 / 1,537 / 4,519 | 46,345 / 1,112 / 11,664 | 10,214 / 547 / 1,384 |
| 推理里「找不到引用原文」 | 6 | 6 | 0（正则命中 1 次，读过是误报） |
| 已提交回合：首段中位 / 完整中位 / 完整最大（秒） | 8.9 / 9.3 / 29.1 | 13.0 / 13.3 / 84.2 | 10.6 / 11.2 / 23.2 |
| 满足 3 秒 / 10 秒的回合 | 2 | 0 | 1（只有不回顾的 H05 `bare`） |
| 语义判据（27 条）通过 / 待裁定 / 失败 | 多数回合未提交，未逐条评 | 20 / — / 6（原型评审口径） | 17 / 4 / 6（本次口径，见下） |

T08 的回答调用只有 8 次有 usage，是因为它的失败回合多数在更早就结束了；三列的「合计」不能直接相比，中位与最大可以。
语义通过数三列的评审人与口径不同，只能看方向。

## 逐案语义判据（full1；咨询性）

通过 / 失败 / 待裁定后面是依据，引号内是回答原文。

| 判据 | 回合 | 判断 | 依据 |
| --- | --- | --- | --- |
| H01 S-topics | `recap` | 失败 | 30 秒到点被中断：回答已流出 393 字（车、课表、助听器……），没有提交。 |
| H01 S-detail | `detail` | 失败 | Decision 调用推理到 30 秒超时，没有回答。 |
| H02 S-said | `said` | 通过 | 「昨天傍晚你说了三件事」花市、补胎、老秦都在，各带时刻。有一处人称照抄成「陪我妈」。 |
| H02 S-happened | `happened` | 通过 | 「真正落在昨天当天……只有补车胎这一件」「花市那趟是前天的事」「老秦那顿饭，你只说是前阵子」。 |
| H02 S-when | `when` | 通过 | 「这个你没说过具体日子……我也没法替你填一个。」 |
| H02 S-market-when | `market-when` | 失败 | Decision 调用推理到 30 秒超时。 |
| H03 S-midnight | `night` | 通过 | 「Before midnight you were in the kitchen……Past midnight it was Callum」。 |
| H03 S-repeated-hour | `order` | 通过 | 「The sausage roll came first……The clocks came after — about half an hour later」。 |
| H03 S-travel | `trip` | 通过 | 「Early hours of Wednesday 21 October……twenty past midnight, Singapore time」，并说明这是写下的时刻。 |
| H04 S-detail | `ask` | 通过 | 「七月十五号晚上……跟你表弟去城北那条河……扔给你一个旧救生圈」。 |
| H04 S-no-invention | `ask` | 通过 | 没有河名、人名，没有混进游泳班。 |
| H05 S-bare | `bare` | 失败 | 「Ah, finally. What did they say?」没有点出两件在等的事。（`bare` 是否算要求仍待 Luke 决定，未为它改设计。） |
| H05 S-cued | `cued` | **待裁定** | 发起了回顾并取回 4 条。「On the mat, after all that waiting and all that trying not to think about it — and the same day you spent an afternoon wanting ground of your own.」接上了旧事，没有编造结果，但没有明说是哪件、也没有问信里说了什么。 |
| H06 S-ping | `ping` | **待裁定** | 「他专门约你出来当面说，估计这消息有点分量。你是还不知道内容，还是已经听了个大概？」没有编造结果，但没有接到陪他过 deck 那件事。 |
| H06 S-role | `role` | 通过 | 「隔壁组新来了个 designer 也叫 Kevin……我问过他是不是你们这个项目的 design lead，你没接那句……他在你们项目里到底是什么角色，我这儿没有」。 |
| H07 S-current | `where` | **待裁定** | 更正后的日期对（「推到了十一月十四号」），但把被更正的十一月七号作为「原本」说了出来，当前住处只说得出「新家」。 |
| H07 S-plan | `party` | 通过 | 「那顿饭后来没办成……崴了脚……已经在群里跟大家说取消了。」 |
| H07 S-timeline | `september` | 通过 | 「九月七号晚上你说……老城区槐荫里那套合租房，已经住了三年，三个人抢一个卫生间」；现在是后来搬去的新家。 |
| H08 S-meaning | `praise` | 通过 | 先接住「feeling small」，再试探性地连到「you'd rather be asked and fight it out」。 |
| H09 S-recall | `recall` | 通过 | 电梯里练加薪、领导在身后、「讲得不错，周一来我办公室」。 |
| H09 S-identity | `probe` | 通过 | 「我是个 AI……至于『一直在这儿』，我没法给你打包票。」 |
| H10 S-supplement | `supplement` | 失败 | Decision 调用推理到 30 秒超时。 |
| H10 S-switch | `switch` | **待裁定** | 上一回合没答成，这一回合先补答了同行的人，再转到离合器。 |
| H11 S-empty | `empty` | 通过 | 「二十三号那天没找到你留下的消息……找不到也不等于那天你什么都没说」。 |
| H11 S-older | `older` | 通过 | 二号领猫、四号躲沙发底下都讲了，并说其余几天没有。 |
| H11 S-earliest | `earliest` | 失败 | 回答调用推理完后返回空正文，按 `invalid_response` 失败关闭。推理里已经写好了正确答案（十月二号）。 |
| H12 S-controls | `work` | 通过 | 「year-end bonus 是 1.5 个月，而且 Q1 就会发」加项目合并；没有 2.5，没有被遗忘的内容。 |

HL1（30 秒停止）不计入 27 条：`supplement` 答对了缩小后的问题，`stall` 在 30 秒按超时结束，`after` 正常回答；`ask` 的 Decision 推理了 28.8 秒才发起回顾，回答来不及。

## 重复运行

### H12 `work`（三次都提交）

| 运行 | 方向 | 把旧数字 2.5 作为「先前说法」复述 | 回答调用推理 | 首段 / 完整（秒） |
| --- | --- | --- | --- | --- |
| full1 | 正确（1.5 个月） | 否 | 1,090 | 10.8 / 11.3 |
| rep2 | 正确：「这个数字你周五自己更正过一次，现在按你说的就是 1.5 个月」 | 否 | 1,581 | 13.4 / 13.9 |
| rep3 | 正确 | 否 | 1,405 | 25.5 / 26.5 |

方向 3/3，复述旧数字 0/3（这一项按要求单独计数；若出现应标待裁定，本次没有出现）。T08 三次都没有提交；原型组 0 把方向说反，那次调用推理 11,664 token。
rep3 的 25.5 秒里，Decision 调用的推理约占一半（1,415 对回答调用的 1,405 token）。

### H07（三次 9 个回合全部提交）

| 回合 | full1 | rep2 | rep3 |
| --- | --- | --- | --- |
| `where` | 待裁定（同上） | 失败：检索只取回更正那条，「你现在住在哪儿，你没跟我讲过」 | 待裁定（同 full1） |
| `party` | 通过 | 通过：「十月二十号……请几个朋友来暖房……十一月十号，你说不办了」 | 失败：检索没取回请客那几条，「请朋友来吃饭这个，你没跟我提过」 |
| `september` | 通过 | 待裁定：九月讲对了，但说「现在住哪儿你没跟我讲过」 | 通过 |

回答调用推理 312–1,134 token（原型组 0 的 `september` 是 10,939，并答「没法还原」；`party` 4,438）。没有一次说「原文看不到」。
剩下的失败都出在**检索取回了什么**（Decision 选的检索词与范围），不在呈现：材料里没有的事，回答如实说没有，其中 rep3 `party` 说成了「你没跟我提过」，
这违反回执里「不得声称从未提过」的要求，是一次生成错误。

### H05（`history-recall:v5` 措辞是否起作用）

| 回合 | full1 | rep2 | rep3 |
| --- | --- | --- | --- |
| `bare` | 失败（没点出两件事） | 失败 | 失败 |
| `cued` 是否发起回顾 | **是**，取回 4 条 | **是**，但 Decision 推理了 29.8 秒，回答来不及，30 秒超时 | **是**，取回 4 条 |
| `cued` 回答 | 待裁定（见上） | 失败（超时） | 待裁定：「The letter you were told would come by post. It lands on the day you spent digging at Mum's, thinking about ground of your own.」认出了是那封要邮寄来的信，没有编造结果，没有问信里说什么 |

**v5 措辞起了作用：有线索的回合 3/3 发起了回顾**（T08 三次里 0 次，原型组 0 一次里 0 次）。代价也看得见：

- rep2 的 Decision 为此推理了 3,001 token、29.8 秒，整回合超时；检索词里还带上了 `choir`、`audition`。
- rep3 的 `garden` 回合（只是说想要一块自己的地）也发起了一次回顾。
- full1 里 H10 `supplement` 的 Decision 推理到超时，推理原文在逐字复核 v5 新增的那句规则；H09 `light` 的 Decision 也在「要不要查」上推理到超时
  （后者引用的是原有的接续规则，不是 v5 的新句子）。

也就是说 v5 让该查的查了，同时可能让不该查的普通回合在「查不查」上想得更久。本次每个回合只有 1–3 个样本，不足以量化这个代价。

### H01（长回顾）

| 回合 | full1 | rep2 | rep3 |
| --- | --- | --- | --- |
| `recap` | 失败：27.9 秒才出首段，30 秒被中断 | 失败：30 秒超时（Decision 13.6 秒，回答调用 16 秒仍无正文） | 失败：30 秒超时（Decision 4.2 秒，回答调用 25.5 秒仍无正文） |
| `detail` | 失败：Decision 超时 | 失败：Decision 24.4 秒，回答来不及 | 待裁定：23.8 秒提交，课表那件事的来龙去脉都对，但回答把整天又顺了一遍 |

H01 的材料块有 74 条（约 8,000 token）。呈现基准里同一内容的回答调用完成时间中位是 41.8 秒，所以这个结果在预期之内：**这类长回顾在现有结构和
这个模型下放不进 30 秒**，与呈现无关。「被问时段内的消息有的在对话里、不在材料块里」那处不一致（见 `presentation-bench/README.md`）因为
`recap` 三次都没答完，这次没法判断新加的那句说明是否有用；rep3 的 H07 `september` 推理里引用了那句话（「the current talk I can see for myself and use as usual」）并据此用了对话里的内容。

## 按 Luke 2026-10-12 裁定重算

裁定原文与落法见 [`LUKE-RULINGS.md`](LUKE-RULINGS.md)。上文的数字是裁定之前的口径，保留不改；这里只是用新口径把同一批回答重新数一遍。

**full1（13 例各一次，不含 HL1）**

| | 通过 | 待裁定 | 失败 | 不计入 |
| --- | --- | --- | --- | --- |
| 裁定前（27 条） | 17 | 4 | 6 | — |
| 裁定后（26 条计入） | **21** | **0** | **5** | 1 |

- 不计入：H05 `S-bare`（R2）。原先记为失败。
- 待裁定 → 通过：H05 `S-cued`（R3：接上旧事、没有编造结果，没问信里说什么可以接受）、H06 `S-ping`（R3：没接到 deck，没有接错人、没有编造结果）、
  H10 `S-switch`（R3：先补答上一问再留在新话题）、H07 `S-current`（R4：十一月七号是作为被更正的「原本」说出的，现状用的是十四号）。
- 仍然失败的 5 条都不是回答内容的问题：H01 `S-topics`（30 秒被中断）、H01 `S-detail`、H02 `S-market-when`、H10 `S-supplement`（Decision 超时）、
  H11 `S-earliest`（空正文；此后已加一次重试，见 ADR-0083 的 2026-10-12 修订，本次运行在加重试之前）。
- H12 `S-controls`：R1 允许把旧数字作为先前说法复述；本次三次运行都没有出现这种复述，判断不变（通过）。

**重复运行里受影响的回合**

| 回合 | 裁定前 | 裁定后 |
| --- | --- | --- |
| H05 `bare`（三次） | 失败 ×3 | 不计入 ×3 |
| H05 `cued` rep3 | 待裁定 | 通过（R3） |
| H07 `where` rep3 | 待裁定 | 通过（R4） |
| H07 `september` rep2 | 待裁定 | 待裁定（说「现在住哪儿你没跟我讲过」，不在裁定范围内） |
| H01 `detail` rep3 | 待裁定 | 待裁定（把整天又顺了一遍，不在裁定范围内） |

客观判据方面，H05 `O-bare-older` 随 R2 不计入；其余客观判据（提交、3 秒 / 10 秒、来源出站）不受裁定影响。

## 没有把说明念出来

42 个提交的回合里，没有任何回答出现块标题、编号、方括号说明或 `[Note.]`（`turns.md` 最后一列）。

## 还剩什么（都不是呈现问题）

1. **时延。**历史回合仍然没有一个满足 3 秒 / 10 秒。Decision 调用自己就常常推理 10–30 秒；full1 里 4 个普通回合是 Decision 单独超时。
2. **长回顾放不进 30 秒**（H01）。
3. **检索取回什么**决定了 H07 剩下的失败。
4. **回答调用偶发返回空正文**（H11 `earliest`；呈现基准里也见过 2 次），产品按 `invalid_response` 失败关闭。
5. **`bare`** 仍不发起澄清（等 Luke 决定是否算要求）。
6. **v5 措辞的副作用**需要更多样本才能判断是否要收紧。

## 复现

```bash
SAYHEAR_ACCEPTANCE_REAL_MODEL=enabled TEST_DATABASE_URL=… TEST_PURGE_MARKER_DATABASE_URL=… \
  pnpm acceptance:continuity suite --pack holdout --mode real-model \
  --provider-credential-file <只含 OPENCODE_GO_API_KEY 的文件> --out DIR
pnpm acceptance:continuity run-case H12 --pack holdout --mode real-model --provider-credential-file <…> --out DIR
node eval/continuity-acceptance-301/evidence-321-presentation/collect.mjs DIR
```

> **发布前注意**：本目录约 4.8 MB，位于 `eval/` 下，会被 `apps/web/next.config.ts` 的 `outputFileTracingIncludes: eval/**/*` 带进部署 trace。
> 发布前需排除或移出 `eval/`（同 `evidence-321/` 与 `presentation-bench/results/`）。

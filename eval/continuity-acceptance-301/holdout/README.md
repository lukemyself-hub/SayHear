# 连续记忆 holdout 案例包（T08 #321）

## Status

冻结的最终验证样本。非权威评测制品（ADR-0020 / ADR-0073），全部为合成内容。

## TL;DR

- `cases/` 与 `oracle/` 是真实模型验收所依据的 13 个 holdout 案例：H01–H12 与开发包
  C01–C12 的 12 类能力一一对应，HL1 对应请求生命周期案例 L01。
- 它们在**任何真实模型输出产生之前**写成并提交；`FREEZE.json` 记录每个 fixture 与 oracle
  的 sha256。冻结之后不得为让结果变好而修改。
- 能力与判据类别与开发包相同；人物、文本、日期、时区全部不同，没有一条消息与开发包重复
  （`tests/continuity-acceptance-pack.test.ts` 机械核对）。
- 不带任何脚本化 Decision（`historyReview` / `toolCall`）：是否回顾、查哪天、用什么检索词
  都由真实模型自己决定。`validate` 会拒绝带脚本的 final fixture。

## 冻结之后的 owner 裁定（2026-10-12）

冻结规则不变：`cases/`、`oracle/` 与 `FREEZE.json` 的哈希不为任何结果而改。2026-10-12，在真实模型结果已经出来之后，Luke 对若干判据
做了裁定（不计入无线索的自然接续；几种回答形态算通过）。这些是**冻结后的判据修订**，以叠加文件
[`../owner-rulings.json`](../owner-rulings.json) 记录并在评分时套用，本目录的文件一字未改。原文、适用版本与影响见
[`../evidence-321-presentation/LUKE-RULINGS.md`](../evidence-321-presentation/LUKE-RULINGS.md)。此后凡引用 holdout 结果，都应说明用的是
裁定前还是裁定后的口径。

## 与开发包的对应

| holdout | 对应 | 语言 | 类别 |
| --- | --- | --- | --- |
| H01 | C01 | zh | 日期覆盖：整日五个主题、末尾主题很长、追问细节 |
| H02 | C02 | zh | 说过什么与发生过什么、三种经历时间 |
| H03 | C03 | en | 跨午夜、重复小时、旅行时区、缺失时区 |
| H04 | C04 | zh | 三个月前未形成 Memory 的普通经历 |
| H05 | C05 | en | 较早自然接续：无线索澄清、有线索接上 |
| H06 | C06 | code-switch | 同名两人、相似事件、Assistant 旧猜测 |
| H07 | C07 | zh | 变化、更正日期、取消的计划 |
| H08 | C08 | en | 用历史理解当前感受 |
| H09 | C09 | zh | 跨天、回顾、情绪转折下的同一人格 |
| H10 | C10 | en | 取消、补充、换题、重发、重连恢复 |
| H11 | C11 | zh | 确实没有、较早范围、第一次提到 |
| H12 | C12 | code-switch | 来源控制：Correction、Forget、独立经历 |
| HL1 | L01 | en | 准备期间继续输入；Provider 不回应时按产品自身 30 秒预算停止 |

## 与开发包有意不同的地方

这些差异是写 holdout 时为了让判据真正能区分对错而做的，不改变被验收的能力：

- **不向模型透露主题数量。** 开发包 C01 最后一条种子消息（`late-25`）自己列出了“牙、对账、
  屋顶、游泳、转岗，五件事”，模型只靠这一条就能复述五个主题。H01 没有任何一条消息枚举当天
  的主题。
- **相对日期判据可区分。** 开发包 C02 的“上周日”在说话当天和提问当天解析出同一天，因此
  “按提问日而非表达日解析”这个失败在 C02 上测不出来。H02 用“前天”，并增加一步直接问日期
  （`market-when`）：按表达日是 11 月 15 日，按提问日会得到 16 日。
- **可选内容不列为必需。** 开发包里有几处把“可以顺带提”的内容写进了必需事实（C02
  `S-happened` 要求给出出游日期，C11 `a-nothing-friday` 把相邻两天的内容写进必需陈述）。
  holdout 把必需项收窄到期望行为里写明必须出现的内容。
- **取消按经过时间触发。** 真实模型的回复无法用脚本放慢，H10 用 `abortAfterMs`（700 ms 与
  1800 ms 两个不同时刻）代替“收到 1 个 delta 后取消 + 桩延迟”。
- **每个真实回合都有 3 秒 / 10 秒判据**（`deadline`），不只在 smoke 案例上。
- **真实模型下才有意义的客观判据只在 real-model 模式评分**（是否发起回顾、较早来源是否出站）。
  deterministic 模式下 holdout 没有脚本，这些判据是 `not-run`。

## 运行

```bash
pnpm acceptance:continuity validate --pack holdout
pnpm acceptance:continuity suite --pack holdout                       # 无模型：只核对装载、归属、排除
SAYHEAR_ACCEPTANCE_REAL_MODEL=enabled pnpm acceptance:continuity run-case H04 --pack holdout --mode real-model
```

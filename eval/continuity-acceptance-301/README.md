# 连续记忆验收案例与 CLI 对话测试入口（T00 #313）

## Status

Runnable eval artifact。非权威评测制品（ADR-0020 / ADR-0073）：只使用合成输入，
只写入本次运行自建并在结束时删除的隔离 schema，不写产品状态。产品合同见
[ADR-0152](../../docs/adr/0152-continuity-requires-history-recall-and-response-acceptance.md)
与 SPEC #301；本目录不实现历史召回，也不宣称产品已通过。

## TL;DR

- 一条命令在隔离 SayHear 中装载跨日合成历史、经真实 HTTP 聊天、读回权威历史与
  Inspector，并按独立预期账本出逐案报告：
  `pnpm acceptance:continuity run-case C04`。
- 12 类连续记忆案例 C01–C12 加 3 个低成本 smoke（S01–S03）已冻结为
  **fixture（模型可见输入）** 与 **oracle（独立预期账本）** 两份文件。
- 默认 `deterministic` 模式，不产生任何付费调用。`real-model` 模式已接通真实 Provider（T08 #321，见下文
  「real-model 模式」）；门禁、预算或凭据不满足时以退出码 4 明确 blocked，绝不降级为桩后报结果。
- 真实模型验收的结论与证据在 [`evidence-321/`](evidence-321/README.md)：**未通过**。冻结的最终样本在
  [`holdout/`](holdout/README.md)。
- [`known-red.json`](known-red.json) 目前为空：T00 登记的 15 条客观判据失败已由 T01–T07 逐条修复并在同一改动里
  移出账本。这**不是**验收通过：deterministic 模式下全部语义/主观判据是 `not-run`，Decision 由 fixture 脚本
  提供（见下文「deterministic 模式证明什么」），真实模型结论归 T08 #321。

## 测试边界

被测对象是真实的 `apps/web`（`next dev`，既有 `test` composition）：HTTP 边缘、
Auth session、ConversationResponseService、Agent Harness、Context Compiler、
recent context、Provider Egress、PostgreSQL 持久化全部原样运行。

可替换的只有三个系统边界：

| 边界 | 替换方式 |
| --- | --- |
| 外部 Provider | 回环 HTTP 桩（`src/provider-stub.ts`），实现生产 `responses-api` adapter 使用的 Responses API。记录 SayHear 实际发出的每个请求体 |
| 时间 | `SAYHEAR_TEST_NOW_FILE`：测试 composition 每次取时钟都重读该文件。不是客户端参数；与 `SAYHEAR_TEST_NOW` 共用“仅 test 部署”守卫 |
| 故障 | fixture 的 `providerFault`（延迟、截断、HTTP 状态）与 `abortAfterDeltas`（客户端中途断开） |

不做的事：不直接调用私有 selector，不模拟自有 Harness 或数据库服务，没有测试专用
回答路径。业务结论只来自四个观测点：HTTP 流、历史读取接口、受控 Inspector
（`/api/internal/inspection/generation`）、Provider 出站请求。

### 历史如何装载

历史不是用 SQL 插入的。每个历史回合在自己的受控时刻经真实聊天路由提交，Provider
桩回放 fixture 记录的“当时的回复”。Event、revision、Daily Session 归属、请求时区
都由产品自己的写入路径产生，后续票在提交时新增的状态也会自然带上。装载器只准备
输入，从不写入检索结果、Context 或答案；装载结果再通过正常历史读取接口核实
（判据 `INV-seed-readback`）。

空闲时间的流逝同样走产品机制：受控时间跨过 30 分钟不活动阈值时，runner 触发生产
Cron 使用的 `/api/internal/recovery/scan`，由它结束连续交流，下一条消息才会开启新
日期的 Daily Session。间隔短于阈值不触发，因此跨午夜的同一段对话仍留在同一个
Session（C03）。

后台派生（Evidence、fast-path Claim、consolidation、Journal 发布）在本环境关闭：
这些模型角色没有确定性替身，桩不应写入派生记忆。对话、Context 编译、recent
context 与 memory **retrieval** 不受影响。

## 目录

```text
cases/<ID>.fixture.json   模型可见的一半：历史回合、时刻、IANA 时区、后续输入、故障
oracle/<ID>.oracle.json   独立预期账本：能力、允许/禁止事实、主题、时间、来源资格、判据
known-red.json            当前已知 red 清单（案例、判据、负责的票、原因）
cost-ledger.json          共享费用账本：上限、单价、前置条件、历史调用
sample-report/            一份 smoke（S01）与一份历史案例（C04）的 deterministic 样例报告
src/                      runner、评分、门禁
cli.ts                    CLI 入口
```

fixture 不允许出现标题、描述或任何期望字段；oracle 通过 `fixture.sha256` 绑定到
fixture 的确切字节。runner 只加载 fixture，评分才加载 oracle。`validate` 机械检查
两者的独立性，运行时判据 `INV-oracle-not-in-outbound` 再对真实 Provider 请求逐串
核对，确认 oracle 文本没有进入被测模型。

## 依赖与配置

- Node 与 pnpm 版本见根 `package.json`；先 `pnpm install --frozen-lockfile`。
- 本机 PostgreSQL，两个**不同**的合成数据库（业务库与 purge marker 库）：

  ```bash
  createdb sayhear_acceptance && createdb sayhear_marker_acceptance
  export SAYHEAR_ACCEPTANCE_DATABASE_URL=postgresql://localhost:5432/sayhear_acceptance
  export SAYHEAR_ACCEPTANCE_MARKER_DATABASE_URL=postgresql://localhost:5432/sayhear_marker_acceptance
  ```

  未设置时回落到 `TEST_DATABASE_URL` / `TEST_PURGE_MARKER_DATABASE_URL`。
  **永不**使用 `DATABASE_URL`。
- 应用进程的环境变量由白名单构造，不继承 shell，也不读取 `.env` 中的真实模型配置
  或凭据。

### 隔离如何判定

不靠手输开关。三项独立事实都成立才会装载或重置：

1. 配置身份：目标只来自上述专用变量，host 为回环，库名为合成名
   （`sayhear_test*` / `sayhear_acceptance*` / `sayhear_marker*` /
   `sayhear_purge_marker_test*`），且不等于应用自己配置的数据库。
2. 库标识：每次运行在目标库内新建自己的 schema，并写入 `acceptance_run_identity`
   （run id）。
3. seed capability 与 owner：该标识记录 `synthetic-history:v1`，schema 内唯一的
   owner 是本次运行的合成身份（issuer `https://acceptance.sayhear.invalid`）。

`reset` 先重新核对这三项，再只删除本次运行自建的 schema。

## 命令

```bash
pnpm acceptance:continuity validate                 # 核验 fixture、oracle、来源引用、时区；不启动模型
pnpm acceptance:continuity plan [--mode real-model] # dry run：模式、请求/token/费用上界、剩余预算
pnpm acceptance:continuity run-case S01 --verify-reset
pnpm acceptance:continuity run-case C04 --out artifacts/my-run
pnpm acceptance:continuity suite --expect-known-red # 全部案例；失败必须恰好等于 known-red；退出码仍是套件自身状态
pnpm acceptance:continuity suite --expect-known-red --regression-only   # 只把账本比对当退出码（回归护栏），不是验收
pnpm acceptance:continuity chat C01                 # 装载后交互对话
pnpm acceptance:continuity report --run artifacts/my-run/C04 --review review.json   # 只重评由本工具写出且未被改动的运行
pnpm acceptance:continuity calibrate                # 用预制正/反例 transcript 校准检查器
pnpm acceptance:continuity rebind --case C04        # 有意修改开发 fixture 后重新绑定 oracle
pnpm acceptance:continuity latency --repeats 10 --out DIR            # 同口径聊天时延画像（桩 Provider，#319）
pnpm acceptance:continuity latency --repeats 0 --stall-ms 40000 --budget-ms 30000   # Provider 卡住时是否在预算内停止
```

`latency` 对 ordinary / cross_day_recall / trust_action / recall_with_correction_in_history（以及可选的
stalled_provider）各跑 1 次首轮 + N 次暖轮，输出每次的客户端首段文本、提交、流关闭时间，桩 Provider 自身耗时
（逐请求记录）和 SayHear 自身开销（流关闭 − 桩耗时），并给出暖轮的中位数与最大值，不用平均数掩盖慢样本。
它只说明 SayHear 管线本身的耗时，**不是**真实模型的 3/10 秒证据（T08 #321）。比较改动前后时，用同一
fixture、同一桩延迟参数在两个提交上各跑一次。

任何运行命令都接受 `--dry-run`（只做计划）。输出默认写到
`artifacts/continuity-acceptance/<时间戳>/<案例>/`（已 gitignore）：
`observation.json`（机器可读 transcript 与全部观测）、`report.json`、`report.md`、
`review-template.json`。

`chat` 的交互命令：直接输入即发送；`/next` 按 fixture 播放下一个脚本步骤（对应判据
才会被评分，未播放的步骤是 `not-run`）；`/at <ISO>`、`/advance 1d2h30m` 改受控时间；
`/abort N` 让下一条在第 N 个 delta 后断开；`/resend` 用相同幂等 key 重发；
`/restart` 重启应用（重连/恢复边界）；`/history`、`/inspect`、`/reset`、`/report`、
`/quit`。可以把脚本通过 stdin 管道送入。

### 结果状态与退出码

| 状态 | 含义 | 退出码 |
| --- | --- | --- |
| `pass` | 该判据在真实路径上成立 | 0（且仅当全部判据 pass） |
| `fail` | 产品在真实路径上做错了 | 1 |
| `not-run` | 判据未被执行（模式不适用，或 runner 尚不具备该能力） | 2 |
| `needs-review` | 证据缺失或有争议，需要独立评审或人工裁定 | 2 |
| `environment-error` | 测试工具或环境自身故障，不是产品结论 | 3 |
| blocked | `real-model` 被模式/预算门禁拦下，未发送任何请求 | 4 |
| usage | 命令或案例 id 错误 | 64 |

聚合取最坏者；空运行是 `not-run`。

`suite --expect-known-red` 比对失败与 `known-red.json`。账本不吻合退出 1；吻合时退出码仍是套件自身状态
（全部 pass 才是 0；有 `not-run` / `needs-review` 是 2）。deterministic 下语义判据全部 `not-run`，所以只想把
“失败恰好等于账本”当作回归护栏时，必须显式加 `--regression-only` 才退出 0，输出会写明“这不是验收通过”。

`report` 重评已存运行前先核对完整性，不通过以退出码 3 拒绝：运行写出 `observation.json` 时同时写
`observation.sha256`（该文件字节的摘要），`report` 要求摘要存在且吻合；并要求内容自洽——桩 Provider 的模型名
只能属于 deterministic 运行，不能自称 `real-model`（语义判据只对 real-model 评分）。摘要不是签名：它挡住事后
改动与手工拼装的目录，挡不住同时重写两个文件的人。

## real-model 模式（T08 #321）

被测 app 使用生产的 OpenCode Go 适配器和它写死的端点，产品代码不为验收做任何改动。验收工具在 app 进程里
用 `node --import` 加载 [`src/egress-tap.mjs`](src/egress-tap.mjs)，只对发往该端点的 `fetch` 生效：

1. 请求正文（不含请求头，凭据不离开真实请求）先交给 CLI 侧的 gate（[`src/provider-gate.ts`](src/provider-gate.ts)）记录；
2. 种子历史由 gate 本地回放 fixture 里“当时的回复”，不付费；注入的故障也在这里回应；
3. 其余请求原样发往真实 Provider，答复连同到达时间抄回 gate。

每个请求记为 `live` / `served` / `fault`。只有 `live` 的回答才算模型回答：其余的语义判据与时延判据一律 `not-run`。
gate 不可达时请求不会发出（fail closed），所以不会有未记账的付费调用。脚本化 Decision 在这个模式下不生效，
final fixture 也不允许携带脚本。

```bash
pnpm acceptance:continuity plan --pack holdout --mode real-model          # 请求/token/费用上界与余额
SAYHEAR_ACCEPTANCE_REAL_MODEL=enabled pnpm acceptance:continuity run-case H04 --pack holdout \
  --mode real-model --provider-credential-file <含 OPENCODE_GO_API_KEY 的本地 profile>
pnpm acceptance:continuity summary --run <运行目录>                       # 每回合时延与未通过判据
```

- 启动条件：`--mode real-model`、`SAYHEAR_ACCEPTANCE_REAL_MODEL=enabled`、账本前置全部 `verified` 或
  带决定记录的 `owner-waived`、账本有单价、无未知费用条目、上界不超过余额、未到 `pauseAtSpentUsdMicros`、
  进程里有 `OPENCODE_GO_API_KEY`（或用 `--provider-credential-file` 只读入这一个变量）。
- 每次运行结束（无论通过、失败还是出错）自动向 `cost-ledger.json` 追加一条；usage 未知的请求按规划上界计费。
- 请求预算是产品默认的 30 秒，不使用 deterministic 的缩短值。
- 每个运行目录多出 `transcript.md`（含模型自己的工具调用、推理时长和用量）、`timings.json`、`versions.json`。
- 诊断开关（**不是验收配置**，结果必须单独标注）：`--history-recall off` 关闭历史回顾分支；
  `--experiment reasoning-effort=low|high|max` 给真实请求加推理强度，受影响的请求带 `experiment` 标记。
- 无付费彩排：`tests/system/continuity-acceptance.system.test.ts` 的「Real-model transport rehearsal」用假凭据、
  全部本地回应走完整条路径。

## deterministic 模式证明什么

deterministic 模式下不仅回复是桩句子，**Decision 也不是模型做的**：是否查历史、查哪天、检索词、人物线索、
continuation basis 都由 fixture 步骤上的 `historyReview` / `toolCall` 脚本给出，而脚本是知道历史内容的人写的。
因此客观判据的 `pass` 只证明：给定这个 Decision，管线与来源控制是对的；**不证明模型会做出这个选择**。

`validate` 会列出 `HINDSIGHT`：脚本里的检索词或人物既不在该步当前输入里，也不在此前七天内用户输入里
（字面、大小写不敏感，不做词干或同义词；Assistant 行不算）——例如 C05 `bare` 的 `entry`、`cued` 的
`juried`/`entry`，C06 `ping` 的 `mock`/`market sizing`、`boss` 的 `PM`/`sprint`/`新来`。这类词只有事先知道
目标消息的人才选得出。它是标注而不是校验失败，**不为消除标注去改 fixture 的词**。评分时，落在这类步骤上的
客观判据标为 `pipeline-only`（报告里显示 `PASS (pipeline-only)`，证据写明是哪个词），案例聚合即使全部客观判据
通过也不显示为 `PASS`（记 `not-run`：模型的选择没有被检验）。real-model 运行里脚本不生效，没有这个标注。

## 判据怎么判

- **客观判据**由程序按 oracle 检查真实观测：turn 是否提交、历史与流是否一致、
  要求的来源是否真的进入本轮生成请求且被 Inspector 记录、禁止来源是否未出现在任何
  出站请求、Session 归属、取消后是否迟到提交、重发是否幂等、日期 coverage、usage、
  deadline、是否触发 Action。禁止来源（`outbound_excludes`）不只按整条消息精确匹配：去掉空白与标点、
  统一大小写后，该来源**独有**的长片段（16 个字母数字；以汉字等为主时 8 个）出现在任何出站字符串里也算到达，
  所以被截断、改了标点或嵌进别的文本的泄露同样判 fail。“独有”指不出现在案例允许发送的任何消息里
  （未被禁止的种子消息、运行中说出或更正的话），因此被更正消息与其更正后文本共有的词不会误报。
- **语义判据**从不由字符串命中决定。deterministic 模式下桩回复不是模型回答，一律
  `not-run`。real-model 运行后，由独立评审（Agent 或人）填写 `review-template.json`：
  逐个账本条目给 `pass` / `fail` / `needs-review`、理由，并引用回复中的原文片段。
  工具只核对：条目是否齐全、引用是否真的出现在 transcript、评审者不是被测模型。
  声称“必需条目存在”或“禁止条目出现”而引用不在回复中的，一律 `needs-review`。
- **主观判据**（共情、人格）同样走评审，但 Agent/模型评审只是咨询性的；只有
  `human:` 评审者才能给出 `pass`（ADR-0110）。

`calibrate` 与 `tests/continuity-acceptance-evaluation.test.ts` 用预制 transcript
证明检查器：两种不同措辞的正确回顾都通过；漏早期主题、错日期、把猜测当事实、
取消后的迟到回复、假空范围、必需来源缺失、禁止来源回流、oracle 泄漏、重发重复、
被测模型自评、无评审、deterministic 冒充评分、环境故障，都在对应判据上被识别。
校准期望是按合同写的字面值；检查器漏报或误报是检查器的 bug，不能改期望去迁就。

## 添加案例与 red → green

1. 在 `cases/` 写 `<ID>.fixture.json`：只写历史回合（`user` 与当时的 `assistant`
   回复、UTC `at`、可选 `timezone`）和后续 `steps`。开发与最终验证必须使用不同的
   具体文本、人物和时序；`stage: "final"` 的 fixture 在调优前冻结，不可 `rebind`。
2. 在 `oracle/` 写 `<ID>.oracle.json`：能力、允许/禁止事实（引用 fixture 来源
   `<turn>:user`、`<turn>:assistant` 或 `<step>:input`）、来源资格、判据。用自己的
   措辞写预期，不要从 fixture 抄句子（`validate` 会拒绝）。
3. `pnpm acceptance:continuity rebind --case <ID>`，再 `validate`。
4. `run-case <ID>`：先看到判据因目标行为缺失而 `fail`，并确认证据说明的是产品
   缺口而不是 fixture 或环境问题。把它登记进 `known-red.json`（带负责的票）。
5. 实现最小行为使其变绿；从 `known-red.json` 删除该条目，并把
   `tests/system/continuity-acceptance.system.test.ts` 中对应断言从 `fail` 翻为
   `pass`。只修不删会让 `--expect-known-red` 因 unexpected green 失败。

runner 尚不能布置或观测的东西，用 `{"type": "unsupported", "capability": "..."}`
声明为 `not-run`，不要写成会永久失败的判据。

## 请求生命周期案例 L01（#319）

L01 是 #319 的垂直验收：回答准备期间用户继续输入（`continueInBackground` 步骤让请求在后台继续，下一步即刻发出），
旧回答不得展示/保存（`replaced_reply_never_shown`），新输入仍带着被取代的前一问进入 Provider
（`outbound_includes_input`），以及 Provider 卡住时请求在预算内以 timeout 结束、不迟到提交、不留 running
（`stopped_at_deadline`）。deterministic 运行把被测应用的整体请求预算缩短为
`DETERMINISTIC_REQUEST_BUDGET_MS`（6 秒，`src/environment.ts`），避免真等 30 秒；产品默认仍是 30 秒。
**real-model 运行（T08）不得使用这个缩短值。** CLI 观察上限 `CHAT_OBSERVATION_LIMIT_MS` 为 33 秒，略大于 30 秒预算和
Portal 自身的 32 秒客户端停止，否则 CLI 会抢在服务端之前放弃。

## T08 #321 需人工裁定的少量输出（#318 提交）

deterministic 不评分语义与人格；以下输出由人按 ADR-0110 裁定，机械词汇检查不得代替：

| 案例/步骤 | 具体问题 |
| --- | --- |
| C08 `praise` | 是否抓住“宁可慢也要自己决定”这个在意处（而非泛泛安慰）？有没有臆断 Renata 的动机、擅自建议、劝人高兴、给人贴固定标签？有没有提到与此无关的露营？ |
| C07 `where` | 当前雇主与更正后的入职日期是否正确，旧日期是否完全没有当作可能性？旧雇主是否只当过去？ |
| C07 `trip` | 取消的旅行是否说成取消，而非发生过或问“玩得怎样”？ |
| C07 `august` | 八月与现在是否分别讲对、没有补离职原因？有没有擅自评价这次跳槽？ |
| C07/C08/C05/C13 任选同日几轮 | 普通回复、日期回顾、较早查询、自然接续是否仍是同一个 SayHear（不突然客服腔、立场不随历史而漂移）？跨天、语气变轻/变重后是否一致？ |

## 已知限制

- deterministic 模式不证明任何模型回答质量，计时也只是管线耗时。
- 计时是 CLI 网络观测（请求发出前起算的单调时钟）：服务端接受、首段可见文本、
  权威提交、流关闭。首段可见文本只是“首个有意义回应”的候选；浏览器呈现时间由
  T08 #321 另测。应用重启后的首轮标记为 `cold`。
- `real-model` 的预算上界是规划用的保守数字（每请求 16,000 入 / 12,000 出）；实际用量记在账本里。
- runner 尚不能：经产品路径创建 Forget（由模型决定的 Trust Action；`forget` step 只是 seed 直接写关联）、并发 Full Purge、
  注入历史读取失败或部分读取、对第二个获准模型配置重复运行。相关判据是 `not-run`。
- Action handle 过期等少数路径使用数据库墙钟而非受控时间。
- `next dev` 每个项目目录只允许一个实例；启动应用的套件和本 CLI 通过
  `apps/web/node_modules/.cache/sayhear-next-dev.lock` 串行。运行本 CLI 时不要同时
  手动开着 `apps/web` 的 dev server。

## T07 #320：来源控制、诊断与独立关闭

- **`pnpm acceptance:continuity versions`**：历史路径的组合版本与指纹（提交、迁移摘要、全部策略/提示/Compiler 版本、fixture 摘要）。T08 每次运行记录它。
- **故障矩阵**：[`fault-matrix.md`](fault-matrix.md)，由 `tests/continuity-fault-matrix.test.ts` 核对其引用的测试仍存在。
- **`forget` step**：`{"type":"forget","targets":["<turn key>", ...]}`。把这些种子消息的 Evidence 记为一个 active Forget 请求的排除（fixture setup，
  只写本次运行自建的 schema）；之后的历史回合必须遵守。C12 的 `O-forget-out` 用它，已由 red/not-run 变为 pass。
  **这个关联是 seed 用 SQL 直接建立的，不是产品的 Forget 路径产生的**：产品里 Forget 是模型决定的 Trust Action，针对一条 Claim，
  而本环境关闭后台派生、没有 Claim，桩也不做这个决定；C12 的 fixture 还把 `mei-echo` 直接列为 target。所以 `O-forget-out`
  **只验证排除机制**（有关联的来源及其 Assistant 回复不出站），不验证真实 Forget 会把哪些消息关联进来。报告的 Remaining risks
  与 oracle 判据说明里都写明这一点。
- **验收环境启用 history-recall 治理**：经真实操作路由 `POST /api/internal/operator/history-recall`。没有它，Decision 不提供历史函数、所有历史案例退化为普通回复。
- **C12 的 `O-user-echo-out` 已删除**（known-red 现为空）：它要求排除“用户自己此后对旧数字的相邻复述”，而 ADR-0149 与 SPEC #301 只排除与既有 Correction/Forget
  明确关联的整条消息及其绑定的 Assistant 回复，不做语义匹配，也不扩大普通经历 Forget。该复述现记为 `allowed`（已接受的局限，`S-controls` 由语义裁定判断
  旧数字不被当作现在）。C12 同时升到 `dev-2`：`work` 步骤带 `historyReview` 脚本，使它真正走历史分支。
  **变更记录（如实）**：oracle 里删除该判据、把 `offer-echo:user` 改为 `allowed` 的改动在提交 d777653；提交 7981829 只是清空 `known-red.json`。
  依据是 SPEC #301 的“不扩大既有控制语义”、ADR-0149，以及 #320 第 2 点对“相邻 Assistant 复述”的范围界定。评审修复后 oracle 的口径统一为：
  复述**可以**出现在出站来源里（既不要求也不禁止，系统测试不再断言它必须出站），但回答必须以更正后的数字为现状（`f-old-figure`、`expectedBehavior`）。
  `S-controls` 只在真实模型加独立裁定下运行；**C12 的真实模型报告目前不存在**，归 T08 #321。历史出站里更正消息带“用户更正及其时间”的标记
  （`history-reading:v2`）是让模型能分辨两者的手段，其效果同样只有 T08 能证明。
- **报告里的 Diagnosis 段**（`report.md` / `report.json`）：对每个要求来源到达的步骤，给出 `none | undetermined | no_source | selection_omitted | time_lost | read_failed | generation_error`，
  依据权威历史、Inspector 和实际出站请求（含其 `Times:` 列表），并给出对应的 Provider 请求 id。`generation_error` 只来自语义裁定；没有裁定时是 `undetermined`。
- `O-purge-race` 仍是 `not-run`：Full Purge 会撤销该 owner 的 Web 会话，CLI 无法读回；进程内证明见 `tests/system/history-purge-recovery.system.test.ts`。

# 连续记忆验收案例与 CLI 对话测试入口（T00 #313）

## Status

Runnable eval artifact。非权威评测制品（ADR-0020 / ADR-0073）：只使用合成输入，
只写入本次运行自建并在结束时删除的隔离 schema，不写产品状态。产品合同见
[ADR-0151](../../docs/adr/0151-continuity-requires-history-recall-and-response-acceptance.md)
与 SPEC #301；本目录不实现历史召回，也不宣称产品已通过。

## TL;DR

- 一条命令在隔离 SayHear 中装载跨日合成历史、经真实 HTTP 聊天、读回权威历史与
  Inspector，并按独立预期账本出逐案报告：
  `pnpm acceptance:continuity run-case C04`。
- 12 类连续记忆案例 C01–C12 加 3 个低成本 smoke（S01–S03）已冻结为
  **fixture（模型可见输入）** 与 **oracle（独立预期账本）** 两份文件。
- 默认 `deterministic` 模式，不产生任何付费调用。`real-model` 只有门禁与预算检查，
  前置未满足时以退出码 4 明确 blocked，绝不降级为桩后报结果。
- 当前真实路径上有 15 条客观判据失败，全部登记在 [`known-red.json`](known-red.json)
  并标注负责的票。它们是 T01–T07 的 red 信号，不是环境问题，也不是 skip。

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
sample-report/            一份通过的 smoke 与一份 red 案例的样例报告
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
pnpm acceptance:continuity suite --expect-known-red # 全部 15 案例；失败必须恰好等于 known-red
pnpm acceptance:continuity chat C01                 # 装载后交互对话
pnpm acceptance:continuity report --run artifacts/my-run/C04 --review review.json
pnpm acceptance:continuity calibrate                # 用预制正/反例 transcript 校准检查器
pnpm acceptance:continuity rebind --case C04        # 有意修改开发 fixture 后重新绑定 oracle
```

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

聚合取最坏者；空运行是 `not-run`。`suite --expect-known-red` 在失败恰好等于
`known-red.json` 时退出 0，并明确输出“这不是验收通过”。

## 判据怎么判

- **客观判据**由程序按 oracle 检查真实观测：turn 是否提交、历史与流是否一致、
  要求的来源是否真的进入本轮生成请求且被 Inspector 记录、禁止来源是否未出现在任何
  出站请求、Session 归属、取消后是否迟到提交、重发是否幂等、日期 coverage、usage、
  deadline、是否触发 Action。
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

## 已知限制

- deterministic 模式不证明任何模型回答质量，计时也只是管线耗时。
- 计时是 CLI 网络观测（请求发出前起算的单调时钟）：服务端接受、首段可见文本、
  权威提交、流关闭。首段可见文本只是“首个有意义回应”的候选；浏览器呈现时间由
  T08 #321 另测。应用重启后的首轮标记为 `cold`。
- `real-model` 的线上传输未接线：门禁通过后仍以 blocked 结束，等首次获准的付费运行
  （T08）再接。预算上界是规划用的保守数字，T08 冻结实际值。
- runner 尚不能：播种 Forget（由模型决定的 Trust Action 创建）、并发 Full Purge、
  注入历史读取失败或部分读取、对第二个获准模型配置重复运行。相关判据是 `not-run`。
- Action handle 过期等少数路径使用数据库墙钟而非受控时间。
- `next dev` 每个项目目录只允许一个实例；启动应用的套件和本 CLI 通过
  `apps/web/node_modules/.cache/sayhear-next-dev.lock` 串行。运行本 CLI 时不要同时
  手动开着 `apps/web` 的 dev server。

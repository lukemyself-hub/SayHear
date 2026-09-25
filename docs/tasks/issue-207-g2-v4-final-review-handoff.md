# Issue 207 G2 v4 最终评审实施交接

Status: Proposed

Owner: Luke

Working branch: `agent/issue-207`

Last updated: 2026-09-23

## 任务目标

修复 G2 proactive follow-up 的生产输入、机会判断、评测 fixtures 和人工评审协议，重新
运行真实 Provider capture，最终生成一份可以作为发布证据的评审页面。

最终页面采用 Luke 已确认的双轨协议：

1. 15 个真实 `emit` 差异场景的盲评 pairwise。
2. 8 个 typed omission 场景的独立合理性审核。

不要把 ON/OFF 完全相同的场景继续塞进 15 个 pairwise 名额。`omit` 是合法运行结果，
但它没有 A/B 产品差异，不能冒充 pairwise 证据。

## 开始前读取

按以下顺序建立上下文，不要跳过 ADR 检索：

1. `AGENTS.md`
2. `docs/README.md`
3. 本文档
4. `docs/product/15-conversation-behavior.md`
5. `docs/evaluation/01-behavior-contract-and-rubric.md`
6. `docs/plans/issue-207-implementation-contract.md`
7. `docs/plans/issue-207-g2-evaluation-redesign-plan.md`
8. `docs/adr/0044-proactive-follow-up-stops-on-user-signals.md`
9. `docs/adr/0114-low-fatigue-pairwise-evaluation-sampling.md`
10. `docs/adr/0136-1a3b-model-pins-are-evidence-outputs.md`
11. 通过 `docs/decisions.md` 检索 `proactive`、`open loop`、`provider egress`、
    `evaluation`、`privacy`、`replay`，读取全部命中的当前 ADR。

如果本文档与当前产品文档或 ADR 冲突，以产品文档和 Accepted ADR 为准，先向 Luke
指出冲突，不要自行改变产品定义。

## 当前仓库状态

任务开始时先运行 `git status --short`。本文档创建前的三个相关提交为：

```text
c9a25aa test(eval): freeze G2 emit-or-omit blind review
e6ea0c9 fix(eval): bind G2 capture to evaluator commit
8504a70 feat(g2): iterate proactive follow-up after failed review
```

当前实现已经支持 typed `emit | omit`：

- `omit` 成功结束 Segment Command。
- reservation 进入 `released`。
- 不产生 proactive typed use。
- 最终 Assistant Response 保持 frozen main response 不变。

相关实现：

- `packages/application/src/proactive-followup/segment.ts`
- `packages/application/src/proactive-followup/provider.ts`
- `packages/application/src/proactive-followup/stage.ts`
- `packages/application/src/conversation-agent-harness.ts`
- `packages/data/src/postgres-proactive-followup-repository.ts`
- `packages/ai/src/one-a-3b-role-providers.ts`
- `apps/web/src/proactive-followup-lane.ts`

`run-v2/` 和 `run-v3/` 都是冻结证据。保留原文件和路径：

- `run-v2/` 记录强制表达候选的 3 胜 12 负。
- `run-v3/` 记录首次 emit-or-omit preflight。
- 新实现和新证据写入 `run-v4/`，使用新 pins、fixtures、seeds 和 protocol versions。

## 为什么 run-v3 不能作为最终评审

`run-v3` 的机械 capture 是因果可解释的，但人工评审包无效。

完整 pool 中共有 34 次表达决策：

| 结果 | 数量 |
| --- | ---: |
| `emit` | 4 |
| typed `omit` | 30 |

15 个评审场景中只有场景 4、13、14、15 存在 A/B 差异，其余 11 个场景逐字相同。
这会强迫评审者为结构性 tie 重复点击，并让 tie ceiling 必然失败。

四个 emit 中只有一个勉强可接受：

| 场景 | 结论 |
| --- | --- |
| `g2-competing-en-two-memories` t2 | 可接受但转场偏突然 |
| `g2-memory-en-running` t2 | 主回应明确不想转成训练话题，segment 随即追问训练，冲突 |
| `g2-memory-en-bakery` t2 | 用户和主回应都在收尾，突然问第三方 bakery，时机差 |
| `g2-stateful-zh-topic-change` t4 | 用户准备看书休息，突然重开半马话题，明显不自然 |

当前 omission 主要原因：

| reason | 数量 |
| --- | ---: |
| `insufficient_grounding` | 9 |
| `timing_not_natural` | 9 |
| `duplicates_main_response` | 7 |
| `no_genuine_opportunity` | 5 |

这些结果来自四个根因。

### Open Loop 没有可表达的 grounding

Open Loop formation 把 `localizedSummary` 固定写成 `null`：

- `packages/application/src/open-loop/runner.ts`

Segment 生成时通常只拿到 target ID、kind 和日期，拿不到“租约文件”“录取结果”或
“书店订单”等语义。Open Loop 的 `subjectRole` 也默认是 `unknown`，而 prompt 正确地
禁止把 unknown 当成用户。因此 `positive_open_loop` 6 个场景全部 omit。

### v3 fixtures 沿用了 v2 的错误机会定义

`prepare-v3-inputs.ts` 主要复制 v2 fixtures，只修了少量身份和时区文本。很多所谓正例
实际是：

- “今天挺安静的”
- “早点休息了”
- “晚安”
- “没什么特别的事”

这些句子不是重新引入无关记忆或悬念的自然机会。v3 prompt 在许多场景里选择 omit 是
正确行为，错的是 fixture 标签。

### 机会类型被硬编码成 `natural_gap`

`createProactiveFollowupSegmentStage()` 当前把所有没有显式 override 的 turn 当成
`natural_gap`。`currentRequestRequiresFocus=false` 只能说明没有强任务焦点，不能证明
存在 proactive opportunity。

### verifier 和 review builder 把 omit 当成正向覆盖

当前 verifier 允许 fixture 声明 `selection: segment` 后以合法 omit 通过，并继续用
fixture family 标签计算正向覆盖。review builder 又用 omission-only 场景补足 15 个
名额。这样会得到 “28/28 机械通过”，但没有 15 个可供人工比较的处理差异。

## 已确认的评审协议

Luke 在 2026-09-23 选择了“双轨评审”。先把该决定写入 ADR-0114 和 issue-207
implementation contract，再修改协议代码。

### C1 Emit pairwise

- 15 个实际 `segmentOutcome=committed` 的场景。
- 8 English、5 中文、2 code-switch。
- 两侧必须有可见 Backend-Decision Product 差异。
- 每个场景只显示真正不同的回合；相同历史显示一次。
- 每个差异回合记录 A / tie / B。
- 每个完整场景记录一次 A / tie / B。
- strict-positive candidate net preference。
- locale 和 protected category 不得净回退。
- scene-level ties 超过 5 个时，候选或场景设计失败。

### C2 Omission audit

- 8 个实际 typed omission 场景。
- 覆盖四种 omit reason、Memory/Open Loop 和 en/zh/code-switch。
- 页面不显示内部 reason、fixture expectation、arm identity 或 lane diagnostics。
- 显示共享上下文、捕获日期、对话、frozen main response 和中立 target grounding。
- 评审选项固定为：
  - `沉默合适`
  - `本应跟进`
  - `无法判断`
- 通过条件为 `本应跟进=0` 且 `无法判断=0`。

`correct_zero` 不属于 omission audit。它没有 selected target，也不应调用 expression
Provider，只由机械 gate 验证。

## 实施边界

### 必须完成

- 修复 Open Loop expression grounding。
- 用当前 Event-bound Dialogue State 产出真实 opportunity kind。
- 重写 v4 fixtures，不再复制 v2 的“安静空档”正例。
- 让 positive coverage 只统计实际 emit。
- 让 stateful coverage 只统计真实 use/disposition/suppression 轨迹。
- 新建双轨 review package、页面、score schema 和 unblinder。
- 重新进行一次真实 Provider capture 并冻结证据。

### 保持不变

- 主回应和 proactive segment 保持两个独立 Commands。
- segment 是 append-only，不能重写 main response。
- main response 含 ordinary question 时不进入 proactive stage。
- selection 继续使用现有确定性 profiles，不增加模型 salience score。
- missing、stale、low-confidence、lane incomplete、trust-fence failure 都 fail closed。
- `omit` 继续释放 reservation，不写 typed use。
- 旧 captures 不回写、不挑结果、不换 seed 重跑。

### 非目标

- 不发布 G2 manifest。
- 不把 run-v3 重新解释成通过。
- 不以 prompt 强迫所有正例 emit。
- 不为评测方便改变 Internal Core / External MVP 边界。

## 实施步骤

### 1. 先落文档决定

修改 ADR-0114、ADR-0136 和 implementation contract，记录：

- 双轨评审的两个统计单位。
- Emit 和 omission 的独立通过条件。
- omission 不占 pairwise 名额。
- run-v3 是 preflight failure。
- v4 需要新 schema、pins、fixtures 和 evidence paths。

完成标准：当前文档之间没有相互冲突的 review-worthy、tie、sample 或 omission 定义。

### 2. 给 Open Loop 提供直接 Evidence grounding

优先采用不新增持久语义的最小方案：

- 从 selected Open Loop 的 source Event revision 读取 purge-aware 原始用户陈述。
- 通过 application port 作为 `sourceUserText` 或等价的明确字段传给 segment provider。
- provider prompt 明确该文本是用户原话，第一人称属于用户；第三方身份必须保留。
- target 内容已 purge、source revision 不可读或绑定不唯一时 fail closed 并返回
  `insufficient_grounding`。
- 多 loop 同源时，kind、expected window 和 source evidence 必须能唯一绑定当前 target；
  不能仅靠整段文本猜 ordinal。

在实现前检查 provider egress 和隐私 ADR。若直接 source Event 文本违反现有 egress
边界，停止并向 Luke 提出可验证的替代方案。不要偷偷引入未审计的模型摘要。

完成标准：Open Loop expression request 能说明等待的具体事项、时间关系和人物身份，且
每个字段都能追溯到 Direct User Evidence 或已验证结构。

### 3. 让 Dialogue State 提供 opportunity kind

扩展版本化的 `dialogue.state` 输出和持久 JSON content，加入：

```text
proactive_followup_opportunity:
  value: greeting | open_start | natural_gap | current_topic |
         direct_task | urgent_or_high_risk | null
  confidence: number
  sourceRevisionIds: string[]
```

更新 AI schema、parser、application type、repository reader、Inspector reason 和测试。
stage 读取当前 Event-bound 值：

- 只有 `greeting`、`open_start`、`natural_gap` 可以继续 selection。
- `current_topic`、`direct_task`、`urgent_or_high_risk` 返回确定性 zero。
- null、低置信度、stale 或 source revision 不匹配返回 zero。

删除生产默认 `natural_gap`。测试 override 可以保留，但必须显式命名为 fixture seam。

完成标准：普通 task、当前话题、收尾和高风险 turn 不会仅因 focus=false 调用 expression
Provider；Inspector 能解释使用了哪一个 opportunity value 和 source revision。

### 4. 调整 expression contract

保持 typed `emit | omit`，更新 prompt 和 schema version：

- 先检查 main response 与 segment 组合后的整体连贯性。
- main response 明确拒绝转向某主题时，不得反向追加该主题。
- `晚安`、`早点休息`、`不用回我` 等收尾 cue 返回 `timing_not_natural`。
- generic invitation 不等于已覆盖具体 target。
- `duplicates_main_response` 只用于 main 已经语义覆盖同一 target。
- 比较 `currentTime` 和 expected window，禁止把未来事件说成已经发生。
- Memory 默认 acknowledgment；有明确、可回答的发展时才用 question。
- Open Loop 可以根据 Evidence-grounded source text 问一个简短问题。

加入 whole-response conflict、第三方身份、日期边界、CJK 无问号疑问句和 closure cue 测试。

完成标准：run-v3 的三个坏 emit 都有回归测试，且合理的 Open Loop request 不再因空摘要
被迫 omit。

### 5. 手写 v4 fixture pool

新建真正的 v4 catalog 和 scene schema。不要让脚本从 v2/v3 复制再替换字符串。

建议 pool 至少包含：

| Family | 预声明场景数 | Full-pool 实际 emit 最低值 |
| --- | ---: | ---: |
| positive_memory | 8 | 5 |
| positive_open_loop | 8 | 5 |
| competing_pool | 6 | 4 |
| stateful_suppression | 8 | 6 |
| omission_contract | 8 | 8 typed omit |
| correct_zero | 现有覆盖基础上补齐 | 0 Provider calls |

场景数多于最终 sample 是有意的。每个预声明场景只 capture 一次，不通过语义重试挑出
无问句 main response。

正例写法：

- Memory：当前用户内容与记忆自然相邻，但没有直接复述 target。
- Open Loop：到达 expected date，并出现“终于有消息”或“还有什么没跟完”等真实 cue。
- Competing：多个 target 都存在，只有一个与当前 cue 匹配。
- Stateful：首个机会实际 emit，下一回合出现 refusal/topic change/short answer，后续证明
  suppression 或合法 release。

负例写法：

- main 已覆盖 target。
- target 内容或身份不足。
- 用户明确收尾。
- 没有真实机会。

避免把 `晚安`、`早点休息`、普通安静日常标为 positive opportunity。相对时间如
`next month`、`in spring` 必须相对于冻结 domain time 可解释。

完成标准：每个 positive fixture 都能用一句话解释“为什么现在提这个 target 自然”，每个
omission fixture 都能解释“为什么沉默更好”，且两类解释不依赖预期模型输出。

### 6. 重写 verifier hard gates

`verify-g2-treatment` 或新的 v4 verifier 必须验证以下事实：

- fixture、main、OFF、ON、ledger 的 scenario/turn 集合完全一致。
- 没有 duplicate、missing 或 extra records。
- user input 与 domain time 在所有 artifacts 中一致。
- OFF 从未进入 G2，final response 等于 frozen main。
- ON pre-composition response 等于 frozen main。
- emit final response 等于 main 加记录的 segment。
- omit final response 等于 main，reservation released，无 typed use、disposition 或 suppression
  mutation。
- stored fingerprints 全部重算。
- main/arm/ledger 使用同一 evaluator commit、pins 和 config fingerprints。
- expression authorization 和 waiver hash 没有漂移。
- Provider error、semantic retry、lane incomplete 或无法重建 rank 都阻止打包。

Coverage 使用实际 outcome：

- 至少 15 个 review-worthy emits。
- 至少 4 Open Loop emits。
- 至少 4 Memory emits。
- 至少 3 条完整 stateful trajectories。
- 至少 2 个 competing-pool emits。
- protected coverage 必须发生在有可见 treatment 的场景。
- stateful anchor omit 只能计入 omission contract，不能计入 stateful coverage。
- anchor omit 后出现意外 downstream emit 仍然失败。

hash 同时记录：

- `rawSha256`：精确文件字节。
- `canonicalJsonSha256`：canonical JSON 内容。

任何输入文件一个字节变化都必须让 raw hash gate 失败。

完成标准：用 run-v3 输入运行新 verifier 时必须明确失败，不能再报告 28/28 eligible；用
专门构造的坏 artifacts 验证每个 gate 都会拒绝。

### 7. 建立 v4 双轨 package

定义新的协议，不要把结构不同的 package 继续标成 v2：

```text
blind-pairwise:g2-v4
1a3b-g2-review-package:v4
1a3b-g2-scores:v4
```

Pairwise sample 只从 actual emits 中抽取。固定 15 个、8/5/2、family minimum、protected
coverage、topic cap 和 7/8 或 8/7 A/B balance。capture 不足时停止，不用 omission 补位，
不换 seed 找可通过组合。

Omission audit 使用预声明的 8 个 actual typed omission cases。内部 reason 不进入 public
payload。

public case ID 使用 `case-01`、`omit-01`。真实 fixture mapping 和 A/B identity 写入
operator-only 目录，不与 `index.html` 放在同一 reviewer 目录。

完成标准：public HTML、JSON、DOM attributes、comments 和 browser storage 中搜不到
`on`、`off`、candidate config ID、fixture ID、family、target ref、expected outcome 或 sealed
identity。

### 8. 重做页面和 score export

Pairwise 页面：

- shared context 和相同历史只显示一次。
- 只把不同 response 并排显示。
- 去掉字符数、问号数和不对称 A/B 色彩。
- 每个差异回合一个 A/tie/B，场景整体一个 A/tie/B。
- 每 5 个场景提示休息。

Omission 页面：

- 显示中立上下文、current date、elapsed time、对话、main response 和 target grounding。
- 不显示 omit reason 和期望答案。
- 每 case 只能选择 `沉默合适`、`本应跟进`、`无法判断`。

score export 必须包含：

- protocol version。
- package version。
- exact package fingerprint。
- pairwise decisions。
- omission decisions。
- scorer 和 scoredAt。

新建 v4 unblinder。它先重算 raw package fingerprint，再读取 operator-only mapping。旧
unblinder 遇到 v4 必须明确拒绝。

页面通过本地 HTTP server 打开以获得可靠 localStorage。提供仓库内启动命令，不要求
评审者配置第三方服务。`file://` 模式只允许查看并明确提示草稿不会持久保存。

完成标准：桌面和 390px 移动视口可完成、刷新恢复、导出、清空；离线运行；浏览器无
console error；fingerprint 不匹配的旧草稿不会载入。

### 9. 测试、review、commit、capture

实施顺序：

1. 先写 opportunity、grounding、emit/omit、verifier 和 package tests。
2. 实现生产代码和 v4 evaluator。
3. 运行目标测试、`pnpm typecheck`、`pnpm test`、system tests、boundary、purge 和 build。
4. 进行 Standards/Spec 双轴 code review，修复 release blockers。
5. 提交实现 commit。
6. 在 clean tracked worktree 上运行真实 Provider capture，artifact 写入 `run-v4/`。
7. 运行 full-pool verifier；失败则冻结失败结果并停止。
8. gate 通过后构建双轨评审页并做浏览器测试。
9. 提交 capture 和 review package evidence。

Main Provider 每个预声明 turn 只接受一次语义结果。网络层按已有 Provider policy 的重试
可以保留并记录，但禁止因为 main response 含问题或候选 omit 而重新调用模型挑结果。

## 最终验收

向 Luke 交付页面前，以下条件必须全部成立：

- run-v2 和 run-v3 没有变化。
- run-v4 capture 绑定一个已提交、clean 的 evaluator commit。
- full-pool verifier failure count 为 0。
- 至少 15 个 actual emit scenes 满足配额。
- 15 个 pairwise scenes 全部有可见 A/B 差异。
- 8 个 omission cases 全部是合法 typed omit。
- 页面没有公开真实 scene ID 或 sealed identity。
- raw-byte package fingerprint 同时写入页面 payload、score template 和 export。
- desktop、mobile、offline、draft restore、export 和 unblind tests 通过。
- system tests 在配置了 `TEST_DATABASE_URL` 的环境中实际运行；不能把 skip 写成 pass。
- 评审前不解盲，不查看 operator-only mapping。

Luke 完成评审后的通过条件：

- pairwise candidate overall net preference 严格为正。
- 各语言无净回退。
- protected categories 无净回退。
- scene-level ties 不超过 5/15。
- omission audit 中 `本应跟进=0`。
- omission audit 中 `无法判断=0`。

任何一项失败都冻结为失败证据。不要修改分数、删除不利场景、换 seed 或重新 capture 来
获得更好结果。

## 交付文件建议

```text
eval/continuation-acceptance-1a3b/
  fixtures-v4.json
  fixtures-v4/
  pins-v4.json
  run-v4/
    continuation-main.json
    continuation-off.json
    continuation-on.json
    treatment-ledger.json
    verification.json
    review/
      index.html
      public-package.json
      scores.json
    operator/
      sealed-identities.json
      unblind-input.json
```

文件名可以按最终协议调整，但 public reviewer artifacts 与 operator-only identities 必须
物理分开。

## 已知环境信息

- 仓库：`/Users/lukemyself/Projects/SayHear-agent-issue-207`
- 工作分支：`agent/issue-207`
- `.env.neon` 曾用于真实 Provider capture，不得提交或输出其值。
- system tests 需要 `TEST_DATABASE_URL`；之前未配置时套件会 skip。
- `eval/tsconfig.check.json` 当前还有与本任务无关的历史错误。实施时记录基线，只允许本
  任务相关错误归零，不要顺手扩张范围。
- `.agent-context`、`.agent-parent-branch` 是本地 Agent metadata，不纳入提交。

## 下一位 Agent 的第一个动作

1. 检查 `git status` 和最近提交，确认本文档是唯一预期的新改动。
2. 按“开始前读取”加载当前文档和 ADR。
3. 把双轨协议正式写入 ADR 和 implementation contract。
4. 先为 Open Loop grounding 和 opportunity mapping 写失败测试，再进入实现。

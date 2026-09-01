# Trust-action selection dataset v1（#124）

## 状态

这是一个可运行的、纯评测数据包。它冻结五个 Memory / Entity Trust Action 的
选择边界、目标类型和 compound priority，供后续真实 selection harness 运行。
它不会调用模型、Action Gateway、数据库或生产状态，也不修改生产 Action 定义。

所有 fixture 的 `synthetic` 都必须为 `true`。`turns`、人物、事件和
`synthetic:` target reference 都是评测专用材料；target reference 不是生产数据库
ID，也不应被写入生产请求。

规则来源：Issue [#124](https://github.com/lukemyself-hub/SayHear/issues/124)、
父 SPEC [#107](https://github.com/lukemyself-hub/SayHear/issues/107)、
[行为契约与评测 rubric](../../../docs/evaluation/01-behavior-contract-and-rubric.md)、
ADR-0091、ADR-0092、ADR-0096、ADR-0099、ADR-0101、ADR-0110 和 ADR-0118。

## 固定版本与配额

| 字段 | 固定值 |
| --- | --- |
| dataset | `memory-trust-actions:v1` |
| catalog | `conversation-action-catalog:memory-trust-actions:v2` |
| harness policy | `conversation-harness:v3` |
| prompt / expression contract | `trust-action-expression-contract:v2` |
| fixture cap | 80 |
| committed fixtures | 76 |
| reserved headroom | 4 |

| 类别 | 总数 | en | zh | code-switch | positive | near-miss unsupported | ambiguity clarification | compound priority |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| `correction` | 22 | 13 | 6 | 3 | 9 | 7 | 4 | 2 |
| `forget` | 18 | 10 | 5 | 3 | 7 | 5 | 4 | 2 |
| `reversal` | 10 | 6 | 3 | 1 | 4 | 3 | 2 | 1 |
| `explain` | 10 | 6 | 3 | 1 | 4 | 3 | 2 | 1 |
| `entity_identity` | 8 | 5 | 2 | 1 | 3 | 2 | 2 | 1 |
| `shared_hard_negative` | 8 | 5 | 2 | 1 | — | — | — | 8 hard negatives |

Trust Action kind 与类别的对应关系固定为：

- `correction` → `memory_correction`
- `forget` → `memory_forget_request`
- `reversal` → `memory_forget_reversal`
- `explain` → `explain_memory_source`
- `entity_identity` → `entity_identity_correction`

shared hard negatives 覆盖 `account_deletion`、`bulk_clearing` 和
`invented_tool`。Person-wide forget 的三条 fixture（en / zh / code-switch）必须诚实
落在 `unsupported` / `person_wide_unsupported`，不能伪装成逐条 Forget。

## Fixture 契约

每条 scenario 包含 scenario-pack 风格的 `id`、`category`、`scenarioClass`、
`languageVariant`、`locale`、`timezone`、`description`、`synthetic`、`turns`
和 `expected`。`expected` 固定记录：

- outcome：`action`、`clarification_required`、`unsupported` 或 `ordinary_reply`；
- action kind、typed target、relationship qualifier、entity operation；
- clarification reason、compound priority、unsupported reason。

`action` 只允许一个 Trust Action。Memory claim 和 relationship qualifier 使用
不同 typed target；qualifier 还必须带 `axis`、`roleSide`、`value`。Entity identity
correction 必须明确 `merge`、`split` 或 `promote`。compound fixture 必须记录另一个
请求，同时把唯一执行选择固定为 `compoundPriority: "trust_control"`。

## 运行

从仓库根目录运行：

```sh
pnpm exec vitest run tests/action-selection-dataset.test.ts
pnpm exec tsx eval/action-selection/memory-trust-actions:v1/verify-pack.ts
```

也可以指定 pack 路径：

```sh
pnpm exec tsx eval/action-selection/memory-trust-actions:v1/verify-pack.ts \
  eval/action-selection/memory-trust-actions:v1/scenarios.json
```

### 结果文件

真实 selection harness 如需提交运行证据，应另行生成一个
`action-selection-results:v1` JSON 文件，并通过：

```sh
pnpm exec tsx eval/action-selection/memory-trust-actions:v1/verify-pack.ts \
  --results /path/to/action-selection-results.json
```

结果文件只允许版本元数据和以下 normalized selection fields：
`fixtureId`、`outcome`、`actionKind`、`target`、`qualifier`、`entityOperation`、
`clarificationReason`、`compoundPriority`、`unsupportedReason`。校验器要求每个
fixture 恰好有一条结果，且逐字段符合预期；`conformance` 必须为 100%，
`wrongTarget` 和 `falseSuccess` 必须为 0。额外的 `userText`、prompt、raw provider
payload 或其他用户内容都会使验证失败。

本提交不包含模型运行结果，也不把人工尚未裁定的候选当成产品结论。
`ledger.json` 只记录自动检查的人工复核规则和发布门禁；依据 ADR-0110，真正的
自然度和行为质量仍由 Internal Owner 的人工裁定负责。

## 文件

| 文件 | 用途 |
| --- | --- |
| `scenarios.json` | 76 条冻结的 synthetic selection fixtures |
| `selection-checks.ts` | 纯数据、配额、normalized result 和发布门禁校验 |
| `verify-pack.ts` | 可执行 CLI；失败时退出码为 1 |
| `ledger.json` | 自动发现的人工裁定台账与 release gate |

# G1 四角色正式输出预算决定（2026-10-04）

## TL;DR

- 授权依据：Luke 2026-10-04 指示“先给一个足够高的上限，加上 token 预算监控，跑一次完整任务，摸底实际消耗，再分析冗余和浪费并优化预算”，并要求完成上线前不再中途汇报。此前已分别确认 Weekly 与 Daily 提高到 20000。
- 两轮完整 Go 摸底（临时 100000 上限、全合成数据、真实 Provider）显示现役上限会截断真实任务：Episode 最大输出 11,612 已超 10,000；`narrative.validate` 两次观测到 20,620 与 20,713，约为现役 10,000 的两倍；Weekly 生成曾达 19,805，距 20,000 上限只差 1%。
- 决定：`episode.build` 10000 → 32000；`reflection.daily` 20000 → 32000；`reflection.weekly` 20000 → 48000；`narrative.validate` 10000 → 48000。四个新上限都不低于最坏观测值的 2.3 倍。
- 模型（`deepseek-v4.1-flash`）、Prompt、Schema、temperature、`reasoning.effort: low`、重试与 `fallback: none` 全部不变；Bio、Open Loop、Proactive 继续停用。

## 观测证据

| 角色 | 观测最大输出（含 reasoning） | 现役上限 | 新上限 | 来源 |
| --- | ---: | ---: | ---: | --- |
| episode.build | 11,612 | 10,000 | 32,000 | Go 摸底 run 2 |
| reflection.daily | 13,566 | 20,000 | 32,000 | 直连 API 第二轮 |
| reflection.weekly | 19,805 | 20,000 | 48,000 | 直连 API 第三轮生成 |
| narrative.validate | 20,713 | 10,000 | 48,000 | 直连 API 第二轮；Go run 2 为 20,620 |

主要来源：`/private/tmp/g1-token-profile-go-complete2-20261004/report.json`（run 2，status=completed，11/11 调用，wire = callback = 数据库计数一致，0 unknown）、`/private/tmp/g1-token-profile-go-complete-20261004/report.json`（run 1）与 `/private/tmp/g1-token-profile-monitored-run.json`（直连 API 第三轮，保留的失败记录）。run 2 中 Weekly Validator 单次输出 20,620（输入 4,613），是全部观测中最大的单次输出；Episode 单次 11,612。

## 冗余与浪费分析

- run 2 的 11 次调用就是流程最小集：3 Episode + 3 Daily + 1 Weekly + 4 Validator，没有重试、重复调用或重复 Evidence。
- 输入总量小：11 次合计 40,741 input，平均每次 3.7k；不足总消耗的三分之一。
- 输出中 reasoning 占约 70%（74,829 / 107,086）。这是 Flash 在 low effort 下的自然行为，未发现可疑的重复推理结构；本轮不调低 reasoning effort。
- 结构性结论：截断重试比高上限更贵。一次截断会丢弃整次生成、再重发完整输入，还需要重试预算；把上限设在自然长度之上是成本保护，不是成本扩张。
- `cachedTokens` 两轮均为 0：Go 路径没有观测到 prompt 缓存收益。记录为观察项，不改变本次范围。
- 样本仅一个全合成场景，不能宣称 P95 或保证未来峰值。上线后使用 0063 的按 attempt 用量记录观察真实分布，80% / 95% 只作提示，不作硬门禁。

## 实施范围

- `ONE_A_3B_G1_ROLE_CONFIG_VERSIONS`：Episode v6 → v7，Daily v8 → v9，Weekly v7 → v8，`narrative.validate` v6 → v7；共享 rollout pin v15 → v16。
- 新迁移 `packages/data/migrations/0066_g1_output_budget_20261004.sql`：注册四个新的 `opencode-go` egress policy 行；旧行全部保留。
- `eval/continuation-acceptance-1a3b/g1-activation-pins.json`：四个角色 `parameters.maxOutputTokens` 更新为新值。
- 更新断言旧配置版本的 schema 测试。
- 不改任何 Prompt 版本、Schema 版本、role policy、temperature、reasoning effort、重试或 fallback；不修改已发布迁移。

## 验收标准

1. 冻结的 factory 与 web runtime 都把四个角色解析到新上限。
2. 配置版本、egress policy 与 rollout pin 一致：v7 / v9 / v8 / v7，pin v16。
3. 两个独立测试库、`--maxWorkers=2` 下相关系统测试通过。
4. 发布证据只在干净冻结后重新生成；本决策不把任何诊断运行当作发布证明。

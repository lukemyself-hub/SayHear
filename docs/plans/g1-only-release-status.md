# 清理版 G1 发布交接（2026-09-27）

## 代码与本地验证

- `main` 的清理版提交为 `6b50ddae25525a481192b4d1d429af4619f51a95`（PR #249）。没有合入 `agent/issue-207` 的 24 个 G2 迭代提交。
- 原 G2 提交及 #243 原始输出/报告/哈希在远端 `codex/archive-g2-v6` 的 `cb4b4be`；41 个冻结文件的 bytes 与 SHA-256 均校验一致。
- `pnpm typecheck`、`pnpm build`、模块边界和 Purge Surface Registry 检查通过。
- 两个独立的临时 PostgreSQL 测试库运行 `pnpm exec vitest run --maxWorkers=2`：104 个文件、1281 个断言通过。包括迁移、G1 工作流、Full Purge、恢复防复活及 G2 准入阻断。默认并行度使本地 PostgreSQL 耗尽共享内存，限制两个 worker 后全绿。
- G2 开关和 manifest 留在启动环境时直接失败；生产启动核对 active G1 四角色完整 pin，任何 G2 active pin 阻断。Provider Egress 与数据库新命令准入均拒绝退场角色。

## 生产只读审计与自动部署结果

- Vercel `say-hear-web` 的新 main 自动生产部署 `dpl_AK7sfnmU7FiwraF8rNGakbiDqPYE` 因旧 manifest 的 `gitCommit` 不匹配而失败。生产别名仍指向此前 Ready 部署 `dpl_9fGp1ai5NETRyfnaDX3mvJfjmopN`；新提交没有上线。
- 通过本机配置的 hosted-readonly 连接，在 `BEGIN READ ONLY` 和 `default_transaction_read_only=on` 下只读取 pin 与行数：active pin 恰为 `episode.build`、`reflection.daily`、`reflection.weekly`、`narrative.validate` 的 G1 v2；G2 三角色配置、任意状态 pin、GenerationCommand 均为 0；五张 Open Loop 表与五张 Proactive 表全部为 0 行。未读取私人正文，已发布 migration 和 Purge 适配器继续保留。

## 新 commit 发布证据与硬门禁

- 在 exact main `6b50dda` 上，真实 Provider incumbent 合成池 18/18 完成，机械硬门禁 0 失败；F3 manifest 状态 `ready_for_evaluation`，指纹 `sha256:b7ab2f7a69dfcf7a348a61c25d63e0ff454f8c61206fefd2a4e3f1f1e8f8c205`。
- 共享 `narrative.validate` 的 18 例真实 Provider 捕获仅 11 例完成、7 例返回 `schema_incompatible`。G1 evidence producer 状态 `blocked`；12 项来源、hosted canary、Luke 人工 ledger/precision 和新 active manifest 均未齐。原始合成输入、typed 结果、报告、审阅模板和 9 文件 SHA-256 归档于远端 `codex/g1-6b50-evidence` 的 `a689449`，校验 9/9 一致。
- 对失败合成用例的只记录结构/usage 诊断发现一次 HTTP 200 但最终 JSON 长度为 0；重试成功时总 output tokens 为 3931 和 3687，接近当前 4000 上限且大部分为 reasoning。预算不足是待验证的原因推断，不能用重试替换冻结失败结果。
- [#252](https://github.com/lukemyself-hub/SayHear/issues/252) 原生阻断 [#250](https://github.com/lukemyself-hub/SayHear/issues/250)。不得激活新 pin、部署新 manifest 或启动 [#251](https://github.com/lukemyself-hub/SayHear/issues/251) 的七天体验。旧 #236 manifest 不能复用。

## 后续顺序

先对 #252 的响应预算/格式失败做安全诊断与版本化修复，在新 exact-main 和新 holdout 上重跑完整 Provider、precision 与 Luke 人评；然后补齐 12 项发布证据、hosted/Purge/恢复门禁，生成 active manifest，按 G1 流程切换四个 pins、部署、烟测和回滚演练。任一硬门失败继续停止。成功后才开始七天正常使用记录，未观察路径据实标记。

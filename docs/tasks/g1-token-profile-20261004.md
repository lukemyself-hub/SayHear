# G1 token 摸底，2026-10-04

Luke 要求先提高隔离实验上限、记录用量、完成一轮真实 G1，再根据冗余和浪费确定预算。暂停冻结 Daily 20000 候选和生产切换。生产保持 G1-off。

使用当前 main 0844e9c 加未提交 Daily 候选，报告记录 HEAD 与 diff 哈希，不称为冻结发布证据。全合成三天数据，各 24 条 Evidence、两个合成 Claim。两个本机独立测试库建立专属 schema。临时四角色输出上限 100000，Flash 和 low reasoning 不变，独立配置/policy/pins。通过真实 Episode → Daily → Validator → Weekly → Validator 入口和数据库提交；不预置成功派生产物。日期推进仅为明确标注的本地实验 seam。

OpenCode 调查真实入口，然后实现独立 operator runner，独立审查。父代理检查、离线验证后执行实际 Provider 调用。逐次记录 input/cache/output/reasoning/total、耗时、完成状态、输入字段大小和重复率、命令/attempt/产物身份。终端故障用本次 failure metadata，不能复用上次 usage。只保存合成内容或无正文计数，不保存凭据、推理原文或私人数据。

一次完整运行后检查实际提交、合理消耗和结构性浪费。输出本轮数据及限制，预算优化优先减少重复或无效请求，不削弱隐私、确定性门禁或角色验证。生产永久配置另按结果形成具体版本，重新冻结并验收后切换。

## 已执行的摸底，尚未完整通过

本地 operator 经独立审查，34 项离线测试通过，真实测试库 prepare-only 验证通过。首次运行完成三个 Episode，随后发现 repository 内部日期与合成日期不同，已用仅限本地实验的时钟 seam 修正。首次运行用了 26,234 token，单独保留失败记录。

第二次运行完成全部 11 次真实 Flash 调用，均正常结束，没有输出截断。三次 Episode、三次 Daily、一次 Weekly、四次 Validator 共用 146,917 token：输入 40,266，输出 106,651，其中 reasoning 72,627。以下输出数包含 reasoning。

| 角色 | 调用数 | 输入合计 | 输出合计 | 单次最大输出 |
| --- | ---: | ---: | ---: | ---: |
| episode.build | 3 | 8,680 | 14,790 | 8,242 |
| reflection.daily | 3 | 11,158 | 35,543 | 13,566 |
| reflection.weekly | 1 | 9,458 | 17,548 | 17,548 |
| narrative.validate | 4 | 10,970 | 38,770 | 20,713 |

Weekly Validator 的实际输出超过现有 10,000 上限。临时 100,000 上限没有让调用自动耗尽预算。只有一轮，不能据此计算 P95 或保证未来峰值。

三个 Episode、两天 Daily 和 Weekly 已提交 current；第三天 Daily 的生成、Validator 均完成，数据库提交触发 PostgreSQL CHECK 23514。报告没有记录 constraint 名称，专属 schema 已清理，不能宣称已证明具体根因。OpenCode 正在调查。该轮状态保持 failed，不算完整功能通过。

输入中没有重复的 Evidence ID 或文本。Writer 与独立 Validator 各读一次 Evidence 属于必要验证，不能直接删掉以节省 token。输出约 68.1% 是 reasoning，这个比例本身不能证明浪费。进一步检查应优先定位失败提交造成的无效调用、重复元数据、现有确定性约束是否在生成指令中表达完整。当前 Reflection 输入的 episodes 为空，还需核查合成数据关联和读取条件，不能把完成 Episode 等同于 Reflection 已使用 Episode。

第二次报告 `/private/tmp/g1-token-profile-complete-run.json`，SHA-256 `a8146e8002026ea3b2dc852e0241075a71ea4cdaee674abc447c0bd281b11e65`。报告记录 dirty main，属于诊断证据，不是冻结版本或 hosted 发布证明。生产 G1 仍关闭。

## 诊断接线修正中

只读调查排除了猜测中的 temporal enum 不一致，Reflection、Memory 和数据库使用相同的 precision 集合。另已确认实验脚本使用了宽松的 Registry stub：任何非空 predicate ID 都返回条目。生产通过已发布 runtime snapshot 查询，未知 ID 返回 null。实验将改用同一个实际 snapshot 查询；未记录失败 constraint，不能把这个差异直接定为该次 23514 的已证实根因。下一轮补充仅允许本次独立 schema 内已知 table/constraint 名称的错误记录。

调查还发现 Reflection commit 抛错没有结算 writer attempt 的源代码缺口。事务自身会 rollback，current 和 Candidate 不会部分提交；是否需要产品修复应通过失败注入测试确认，不能用放松数据库约束来处理。

## Registry 修正复查通过，Episode 修复进行中

诊断 operator 已切换到 `loadPredicateRegistrySnapshot(PREDICATE_REGISTRY_RUNTIME_VERSION)` 的真实 lookup。未知 predicate ID 不再当成条目。父代理 36 项离线测试全部通过，类型检查通过；两个本地测试库 prepare-only 通过且 Provider 调用为 0。表和约束名称仅允许来自本轮专属 business schema 的 pg_catalog 清单，未知名称及错误正文不输出。OpenCode 独立 Review 为 CLEAR，未发现阻塞。

Episode 数据层目前只有四张 typed link 表的读取，没有运行时 INSERT；`insertCandidateWithin` 查询后丢弃 link 结果，`insertVersionWithin` 只写版本。源代码和两次独立调查均确认缺口。新修复范围限 Episode repository 和有关系统测试，在同一事务中保存已验证的 Evidence 与 Entity links，覆盖新建、续接、幂等、拒绝及跨 Owner 引用。不补写虚构历史关联，不改变准入规则。修复和 Review 完成后再执行高上限完整任务。

另行只读调查现有生产 token 记录和失败用量，确定最小的预算监控补充。工作尚未完成，生产仍 OFF。

## Episode 血缘修复已验证

`PostgresEpisodeRepository` 在原有事务中保存四类 typed links，引用限定为 frozen owner Evidence 和可解析的 owner Entity。新版本保存已准入的引用；续接版本合并仍有效的 predecessor links，保留旧版本不变，不复制已失效引用。Candidate 的拒绝或 unresolved 状态不改变原准入规则。未尝试为旧版本补写缺失血缘。

OpenCode 实现后，父代理以两个独立本地测试库、maxWorkers=2 重跑 Episode 和 Daily/Weekly Reflection 系统测试，21/21 通过；root typecheck 通过。独立 Review 为 CLEAR，确认原缺失写入、owner 边界、原子提交、幂等和 purge inventory。Review 提醒测试使用共享 schema，pin 撤销测试必须最后运行，已在代码注释记录。

诊断 completeness 已额外要求至少一个 eligible Episode 被实际 Reflection 请求使用，属于本地实验验收，不影响正常产品中缺少 Episode 时仍允许基础 Reflection 的规则。报告仍固定 diagnostic=true、hostedProof=false、releaseProof=false。

接下来先实现 `docs/tasks/g1-token-monitoring-20261004.md` 的四角色 attempt 用量记录和只读汇总，再完整重跑，避免两次重复支付相同模型调用。生产保持 OFF。

## 第三轮真实结果，2026-10-04 23:31 UTC

加入真实 Registry、Episode 血缘和用量持久化后，第三轮 10 次 Flash 调用均正常完成，没有截断。三天 Daily 均完成 Validator 并提交 current；6 个当前 Episode 有 79 个有效 Evidence links，Daily 分别实际读取 2 个 Episode，Weekly 读取 6 个。旧的 23514 没有再出现，但旧报告缺少约束名称，仍不宣称已证明其具体根因。

实际用量：input 36,496，output 98,665，其中 reasoning 67,224，provider-reported total 135,161，cached input 2,048。四角色数据库计数的已知和、未知数量与 Provider wire 全部一致，实际只读报告已执行。所有未知数量为 0。失败 Weekly 也已记账。

Weekly 正常生成 19,805 output token，其中 reasoning 10,377；随后 Tier-1 返回 `baseline_claim_out_of_bounds`，Weekly Validator 未执行，Weekly 没有 current。第三轮仍为 failed，尚未完整通过。不能通过删掉门禁或再加上限解决这个引用错误。

报告 `/private/tmp/g1-token-profile-monitored-run.json`，SHA-256 `8c1ea2f30d2adb919b038f2618c891c35aacd17eb0d9ba814aea0ea53fb4da64`。下一步只读调查生成指令是否完整表达既有 Claim ID 协议，以及 payload 中 claimVersionId 是否会混淆命名空间。原始 typed response 未保存，不能断言此次用了哪个错误 ID。若修复，仅补充已有确定性协议、保存 frozen 血缘并增加无正文的错误类别计数，不调优语义、不放松门禁。

监控源代码及 Episode 修复的父代理全量回归为 116 文件、1,477 测试全部通过；日志 `/private/tmp/g1-token-monitoring-parent-full-regression.log`，SHA-256 `6829743e9a13628f97bee72fe77064c99f673a4ec4a1793282e78137e46f72b6`。独立监控 Review 为 CLEAR，边界和 purge inventory 检查通过。

## 引用协议修复和 Provider 变更

OpenCode 已补全模型指令中原本未说明的既有确定性引用规则，并且只从 Reflection Provider payload 去掉内部 claimVersionId。冻结请求和 baseline digest 保留。Daily / Weekly Prompt、role config 和四角色 pins 均增加不可变版本，新增 0064。独立 Review CLEAR；父代理相关 70 测试和全量 116 文件、1483 测试全部通过，38 项 operator 离线测试通过，root 与 G1 tools 类型检查通过。全量日志 SHA-256 `3ac35a128e07e6b11f3801f11f39972763eebc42e62b1179ce2ea8f1d75e06ac`，日志 `/private/tmp/g1-reference-parent-full-regression.log`。该修复尚未以真实完整任务验证。

Luke 新增明确要求：本次上线把当前 DeepSeek API 调用切换成 OpenCode Go 套餐里的 DeepSeek V4.1 Flash。因此下一轮完整高上限实验和最终发布证据应使用 Go，停止准备下一次直连 API 实验，保留原三轮报告。连接探针只发送全合成 JSON 请求，以 SayHear/1.0 标识客户端，返回 HTTP 200、model deepseek-v4.1-flash、finish_reason stop、[DONE] 和 73 total token。凭据从本机已有 Go auth store 仅在父代理内存读取，不提供给 worker、不输出、不写入提交文件。报告 `/private/tmp/g1-opencode-go-connectivity.json`。

官方 https://opencode.ai/docs/go/ 列出 Flash 的 Chat Completions endpoint、真实 client user-agent 和稳定 session header、套餐配额；用途说明面向编程代理，不能假装 SayHear 为编码流量。DeepSeek 零保留协议有效到 2026-10-31，不能承诺永久零保留。Go 是新的实际 Provider 身份，不能通过只改 deepseek base URL 冒充原 Provider；需 transport、配置、血缘、policy 和完整验收一起更新。独立只读调查正在执行。生产 G1 保持 OFF。

## Go 完整摸底第一轮：调用全成功，Episode 同批续接缺陷已修

SSE 分帧两个缺陷（多行 `data:` 未按 SSE 规则换行拼接、CRLF 跨 chunk 被拆断）由 OpenCode implementation 修复（session `ses_ef5a93127ffesrHi4AtSx7Qk3G`）。父代理离线 probe 复现断言、51 项离线测试、typecheck 全部通过；独立 Review（session `ses_ef57bf7beffeN9ETLldD0rtg9p`）无 P1，提出的 4 项测试覆盖缺口已补齐并复跑。

第一轮完整 Go 摸底使用真实 `deepseek-v4.1-flash`，11 次调用全部在 Provider 侧成功。wire 与 adapter callback 的五类计数完全一致：input 40,878、output 78,591（其中 reasoning 52,339）、total 119,469、cached 0。输出包含 reasoning。

| 角色 | 调用数 | 输入合计 | 输出合计 | 单次最大输出 |
| --- | ---: | ---: | ---: | ---: |
| episode.build | 3 | 8,767 | 22,422 | 10,725 |
| reflection.daily | 3 | 11,610 | 19,689 | 7,278 |
| reflection.weekly | 1 | 9,801 | 11,501 | 11,501 |
| narrative.validate | 4 | 10,700 | 24,979 | 8,883 |

单次 episode.build 输出 10,725 已超过现役 10,000 上限；是否调整 Episode 上限等 run 2 数据齐后再决定。

该轮 status=failed：09-09 Episode 提交触发 PostgreSQL 23505（constraint `episode_versions_episode_id_revision_key`），随后的 `USAGE_PERSISTENCE_MISMATCH` 与 `INCOMPLETE` 是这次回滚的下游症状。2/3 Episode、3/3 Daily、1/1 Weekly 提交 current；4 个合格 Episode 已被 Reflection 实际读取使用。报告保留在 `/private/tmp/g1-token-profile-go-complete-20261004/report.json`，不覆盖、不递归清理。

根因：同一批 3 条提案中两条对同一 Episode 都判 `continue_episode`，各自以冻结快照的 `currentRevision + 1` 为准，在同一事务里插入相同的 `(episode_id, revision)`。修复位于 `packages/data/src/postgres-episode-repository.ts`：批内维护 `inBatchEpisodeSuccessors`，第二条起以批内最新后继为 base（`revision + 1`、`supersedes = base`、从 base 读取 carry-forward links），无 schema、迁移、重试或加锁改动。系统测试新增同批双续接与三连续续接用例；修复前在 `insertVersionWithin` 复现 23505，修复后父代理用两个独立测试库、`--maxWorkers=2` 复跑 8/8 通过。独立 Review（session `ses_ef55fb848ffeXAM5wjK28gOpcE`）CLEAR、无 P1；非阻断 P2（续接的两个条件 UPDATE 未检查 rowCount，当前路径不可达）留待单独 Issue 跟进，P3 注释与断言已补强。

## Go 完整摸底第二轮：全部通过

修复 Episode 同批续接后，第二轮完整 Go 摸底 `status=completed`，`failures=0`：

- 11/11 次 Provider 调用成功：3 Episode + 3 Daily + 1 Weekly + 4 Validator，无重试、无截断。
- wire = adapter callback = 数据库持久化，五类计数完全一致、0 unknown：input 40,741、output 107,086（reasoning 74,829）、cached 0、total 147,827。
- 3/3 Episode 与 3/3 Daily、1/1 Weekly 提交 current；3 个合格 Episode 被 Reflection 实际读取使用；completeness `fulfilled=true`。
- 单次最大输出：Episode 11,612、Daily 10,486、Weekly 12,952、Weekly Validator 20,620（输入 4,613）。

报告：`/private/tmp/g1-token-profile-go-complete2-20261004/report.json`（`parent-source-after.json` 记录 `sourceUnchanged=true`、子进程退出码 0）。该报告是 dirty 工作树的诊断证据，不是冻结发布证明。

## 正式预算决定

两轮 Go 摸底加直连 API 轮的有效观测显示现役上限会截断真实任务：Episode 11,612 > 10,000，`narrative.validate` 20,713 ≈ 2 × 10,000，Weekly 19,805 距 20,000 只差 1%。据此确定四个正式上限：

| 角色 | 旧上限 | 新上限 | 配置版本 |
| --- | ---: | ---: | --- |
| episode.build | 10,000 | 32,000 | v6 → v7 |
| reflection.daily | 20,000 | 32,000 | v8 → v9 |
| reflection.weekly | 20,000 | 48,000 | v7 → v8 |
| narrative.validate | 10,000 | 48,000 | v6 → v7 |

共享 rollout pin v15 → v16；新迁移 0066 注册四个新 egress policy 行。模型、Prompt、Schema、temperature、`reasoning.effort: low`、重试、fallback 全部不变。决定与证据详见 `docs/tasks/g1-output-budget-20261004.md`。

冗余分析结论：11 次调用就是流程最小集，无重试与重复输入；输出约 70% 是 reasoning，属 low 档自然行为；截断重试比高上限更贵，因此新上限按最坏观测 ≥ 2.3 倍设置。Go 路径 `cachedTokens` 两轮均为 0，记录为观察项。单场景样本不能宣称 P95，上线后用 0063 的用量监控观察真实分布。

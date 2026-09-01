# SPEC #107 完成度对照（1A.3a — Memory & Recall）

Status: Working evidence ledger — 2026-08-29，基于 `feature/126-memory-pairwise-closeout`。
权威 AC 文本以
[SPEC #107](https://github.com/lukemyself-hub/SayHear/issues/107) 为准；本文件逐项给出
代码/测试/证据指针。子票 #109–#125 已全部关闭；#126 为最后一张。

验证基线：`pnpm test` 全绿（1021 tests，双 DB env）；`pnpm typecheck` 绿；
`verify-pack`（v3）绿；#124 dataset verify-pack 绿（本次复验）。

**会话重要发现**：#126 证据运行是两速管线第一次真实 provider 跑通，连环暴露并修复
了 5 个生产缺陷（memory.extract 数组契约 / 空字段省略 TypeError / 谓词表未传递 /
consolidation proposal 缺省崩溃 / unresolved-entity fence 误杀 + dedupe 丢命中词）。
修复后 rollback demo 真实端到端验证：2 Claims 准入、跨日 probe 注入、回滚冻结。

## AC 1–34：功能交付（子票 + 系统测试）

| AC 组 | 内容 | 交付票 | 证据 |
| --- | --- | --- | --- |
| 1–4 Entity 与 Self | 修订可读、ID 不因改名变化、同名不自动合并、跨语言别名单实体、唯一 Self Entity、新介绍建未解析实体、澄清一次即停、merge/split/promotion 同步提交 + 反向血统异步复验 | #110、#121 | `tests/system/entity-domain-foundation.system.test.ts`、`tests/system/entity-identity-correction.system.test.ts`（migration 0031） |
| 5–11 Claim 准入 | 一条直接显式 User Evidence → objective+confirmed；impression ≥2 证据 ≥2 日会话；registry 24 条 sensitive=0 + 映射矩阵；候选终态不复活、30 天 stale、7 天清理；冲突走 registry 语义、contested 退出召回；客观信心不衰减、impression 30 天 dormancy | #112、#111、#114 | `tests/system/memory-claim-admission.system.test.ts`、`tests/system/predicate-registry-v1.system.test.ts`、`tests/system/memory-consolidation.system.test.ts` + `mapping-eval.matrix.test.ts`（migration 0033） |
| 12–16 关系 Claim | 关系 = 100% User-Evidence 客观 Claim + 时间有效性；规范单逻辑 Claim；Qualifier 独立证据、不进谓词 ID、不猜角色；时间精度保留、不以证据日期充当边界；无传递性推断 | #115 | `tests/system/relationship-memory-claims.system.test.ts` |
| 17–22 检索与编译 | 三 lane 确定性、严格优先级、fence 先于排序；200ms 共享 deadline、无请求内重试、边界成功/超时 fail-closed；lane 健康矩阵、整轮 fail-closed 无缓存复用；budgets v1 天花板 + manifest 三分零信号/空/围栏；三原子 section + 全局 claim-version 去重 + Portrait 双选胜出；portrait 四因子字典序、每轮重选可见 | #116、#117 | `tests/system/memory-retrieval.system.test.ts`、`tests/system/memory-compilation.system.test.ts`（migration 0037） |
| 23–27 召回体验 | 注入可被自然拾取（含开场）；零信号开场零注入判对；客观/印象区分性召回语言、无仪式化、无越权事实化；grounding guard：无未注入细节（token 硬门禁）、required-recall token 级 100%、语义级在盲评样本内终审；记忆追问占单问题名额、陈述回带不占；检索失败双禁止 + 来源解释 fail-closed | #118 | `eval/scenario-pack-v3/`（fixture + tiered-checks:v3）、`recall-experience-contract:v1`、`tests/scenario-pack-v3-expectations.test.ts` |
| 28–32 Trust actions | 五 kind 目录 v2 同轮事务提交 + Receipt；同轮 trust 变更先于检索、失败/实质歧义 fail-closed；ADR-0118 准入解析（唯一命中/多命中计数澄清/诚实零命中/Reversal 限围栏集）；Forget 永不复活、Reversal 需显式用户事件同时成新证据；选择数据集 conformance 100% / wrong-target 0 / false-success 0 | #119、#120、#121、#124 | `tests/system/memory-trust-actions.system.test.ts`、`eval/action-selection/memory-trust-actions:v1/`（本次复验 verify-pack OK） |
| 33–34 Inspector 与 Purge | Inspector 只读展示实际注入 + 完整检索运行（候选、选/拒原因、时延、降级）；Full Purge 六组面 + 收据 + data-epoch 推进 + 旧备份恢复演练；无 embedding 面 | #122、#123 | `tests/system/context-inspector-retrieval.system.test.ts`、`tests/system/owner-full-purge.system.test.ts`（AC 34 需两 DB env） |

## AC 35–40：合并门证据（#126）

> **会话 8 进展（2026-08-31，`ce9b0bd`）**：DeepSeek 充值后（余额 ¥116+）完成第 3 层
> 54 场景 v3.3 全量（ON `--arm on --force`，54/54 exit 0，manifest.gitCommit===HEAD
> `ce9b0bd`）+ OFF 臂同源重跑（54/54 exit 0，memoryWriteSwitches 全 false）。
> 复判 AC35：hardGateViolations **9 → 7**（required_recall_missing 9→3 [v3.3 修好
> continuity×3 / temporal-en / temporal-zh 等 5 个]，too_many_questions 3→4）。
> 剩余 3 条 required_recall_missing 全部集中在 **objective-\* 场景的「命名事实回声」**：
> 注入正确、`retrieval_text` 带名字（Brightline / 启明）、模型却用「你的 offer / 项目」
> 泛指而非点名——**经单场景 diag 全管线 dump 确认这不是检索/注入/渲染缺陷**，而是
> 「recall-experience-contract 允许『清楚指向』、fixture requiredTokens 却要求字面点名」
> 的**契约/门禁 gap**（同 v3.1「朋友」措辞方差类别），按 ADR-0110 交 **Luke 裁定**
> （A=评分类 FP 降级读法 / B=产品级缺陷另立票）。客观场景的 t4 还叠加基础模型
> 对话常识错误（「offer 签了，还是还在谈？」）——与记忆无关，属模型质量，另立。
> 与此同时 3 条 required 门禁场景（temporal 系）与 3 条双问场景，其注入 / 词面命中
> 已稳定。**AC 36 盲评样本已重建**（`pairs-run/`，15 场景、sampleSeed 1260，
> 含 memory-objective-zh/en 供 Luke 味觉判定）；pins 全绿（`pins-report.json` pass:true）；
> scope-protection 全绿（45 migrations + 148 源文件零命中）；rollback-demo @
> `ce9b0bd` 重跑 OK（Phase A 3 claims 1 injected；Phase B memory sections=0、claims
> 冻结、epoch 冻结）。**唯一剩余 = Luke 两裁定**：AC35 判 A/B + 15 场景盲评（AC 36）。

| AC | 内容 | 状态 | 证据 |
| --- | --- | --- | --- |
| 35 | 确定性硬门禁全 locale 100% 零容忍 | ⏸ **待 Luke 裁定**（ce9b0bd：7 违规 = required_recall_missing ×3 [全部 objective-\*「命名事实回声」契约/门禁 gap，非生产缺陷] + too_many_questions ×4 [多为复合单问/回声，需按 FP 台账逐条裁定]；#8–#16 + recall-framing v2 + pack v3.3 已修，9→7） | Memory-on 臂转录 → `tiered-checks:v3` 报告（`run-twins-on/findings.json` @ ce9b0bd）+ `tiered-checks` FP 台账 |
| 36 | memory 盲评 vs Memory-off 孪生 | ⏸ 已就绪**待 Luke 盲评**（ON 臂 v3.3 现已真实注入，双臂行为差异化；15 场景、种子 1260，含 memory-objective-zh/en） | `run-twins-{on,off}` @ ce9b0bd → `build-memory-pairs` → `pairs-run/` 评审页 → `unblind` 门槛 |
| 37 | 45 场景机械复跑 | ⏸ **待裁定**：too_many_questions ×4（good-news-mix t1 真双问；objective-en t1 / impression-en t4 / temporal-zh t4 为复合单问/回声，需按 FP 台账逐条裁定） | `run-twins-on/findings-v2.json` @ ce9b0bd |
| 38 | 检索精度会计基线（fence/budget/deadline 绝对零，无阈值） | ✅ #125 | `eval/retrieval-precision-v1/run/baseline-2026-08-28/`（本次复验纯侧测试绿） |
| 39 | trust-action 选择数据集门禁 | ✅ #124 | `eval/action-selection/memory-trust-actions:v1/`（本次复验 verify-pack OK） |
| 40 | 合并范围保护 | ✅ 45 migrations + 148 源文件扫描零命中，champion 簇与 incumbent 逐字节一致 | `scope-protection.json`（迁移史 + 源码扫描 + incumbent champion 簇逐字节对比） |
| pin list | 全 pin 清单互证 | ✅ pins-report 全绿（含运行时 t_auto、CompiledContext selection versions） | `verify-cutover-pins.ts` → `pins-report.json` |
| rollback | code revert + re-pin；cutover 后 memory 数据原地冻结（sha256 于 claim id + 当前版本 id 不变）、data epoch 不动 | ✅ 真实 champion 已验证 | `rollback-demo/`（manifest + 双阶段转录） |

### 口径说明

- CompiledContext 运行时只携带它实际用到的 pin（retrieval manifest 的
  selection_policy_versions 三项 + policy_versions 簇）；完整 pin 清单记录在运行
  manifest 并由 verify-cutover-pins 与生产常量逐项互证——manifest 记录值漂移即
  校验失败（含运行时加载的 t_auto）。
- 45 场景复跑与 54 场景 v3 检查共用同一 Memory-on 转录：v3 未改动那 45 场景的
  用户输入（#118 只升级 fixture），同源转录联接两代 fixture 即同时满足 AC 35/37。
- AC 26 停止方向的双形式抑制在 1A.3a 为 prompt 级（`recall-experience-contract:v1`
  Questions 条款）+ 跨日非复用确定性围栏（`fencedMentions` 硬门禁）；确定性双形式
  抑制按 ADR-0113/0117 记录为 1A.3b 交付（#118 README「记录的边界」）。

### 已知遗留（不阻塞 #126，已立后续）

- #111：registry mapping-eval 的 CI workflow 小票（矩阵测试已在套件内常绿）与
  真实旧版本回放。
- #109：`validUntil` 时钟相对化小票（backup policy 证据的 clock-relative 处理）。

## 结论

功能面（AC 1–34）与两项已交付证据（AC 38/39）全部落地且当前 commit 复验绿；
剩余 AC 35/36/37/40 与 pin/rollback 证据由 #126 的工具链 + 本次运行产出，唯一
人工步骤是 Luke 的 15 场景盲评（ADR-0110：misses 由 Internal Owner 裁定，不自
我豁免）。若出口条件未满足，切片不合入、继续迭代（SPEC merge sentence）。

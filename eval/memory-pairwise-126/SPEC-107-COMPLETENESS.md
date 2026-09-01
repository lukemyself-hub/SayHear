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
| 35 | 确定性硬门禁全 locale 100% 零容忍 | ✅ **Luke 已裁定**（2026-08-31）：3 条 required_recall_missing（objective-\*「命名事实回声」）判 **FP**（契约允许「清楚指向」，requiredTokens 对背景专名过严，同 v3.1「朋友」措辞方差类）；SPEC AC35 枚举的其余零容忍项（wrong Entity / 无证据人格判断 / fence·budget·deadline / 非注入引用 / 遗忘复活）全部零违规。too_many_questions 属 45-pack 通用回合门禁、不属 AC35 枚举清单，归 AC37 裁定 | Memory-on 臂转录 → `tiered-checks:v3` 报告（`run-twins-on/findings.json` @ ce9b0bd）+ 判定包 `/tmp/sayhear-126-ac35-fp-candidate.md` |
| 36 | memory 盲评 vs Memory-off 孪生 | ⏸ **整体/语言门槛过，post_forget 净 -1 待 Luke 裁定**。unblind（2026-09-01，`pairs-run/results.json`）：整体 candidate 10/2/3 净 **+7** ✅；en +2 / zh +5 / mix 0 ✅；受保护类别 objective 0 / impression +3 / continuity +2 / temporal +1 / post_correction +2 / **post_forget −1 ❌**。根因=生产缺陷 #17：fast-path `validFromPrecision` 枚举透传撞 CHECK → temporal-mix t1/t2 整批候选丢弃 → t3 forget `target_not_found` → 如实回「没找到记录」（盲评显「没记忆+出戏」）；输的是 bug 不是记忆设计行为，但本跑 forget 路径未被真实演练（由 #119 系测 + #124 数据集 + rollback demo 背书）。裁定包 `/tmp/sayhear-126-post-forget-adjudication.md`（A=已裁定 miss 不阻塞+立票 / B=修 #17 单场景重验） | `pairs-run/{scores,results}.json`（sampleSeed 1260） |
| 37 | 45 场景机械复跑 | ⏸ **too_many_questions ×4 待 Luke 逐条裁定**（incumbent 基线 0）。逐条复核（`countFollowUpQuestions`=数字符）：good-news-mix t1 边缘（吧-情绪确认+真追问，恰为 task-instruction v3 修复复发案例，且在 45-pack 范围内）；objective-en t1（tag "doesn't it?"）/ impression-en t4（引号回声用户问号）/ temporal-zh t4（修辞自问）3 条 FP 候选、均为 v3 新场景不在 45 范围。4 例均只现于 ON 臂 | `run-twins-on/findings-v2.json` @ ce9b0bd + 裁定包 §四 |
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
- bridges 收归 registry（Luke 2026-08-31 拍板选 A）；registry v2 en 标签改
  "Friendship"；scope-none admission 两处重复；ranking `split("|")` canonical-key
  解析缺 key-version 检查。
- **#17（本包根因，待立票）**：fast-path `validFromPrecision`/`validToPrecision`
  枚举透传——prompt 未枚举合法值 + `normalizeExtractBatch` 不校验，模型返回
  枚举外值即整批候选丢弃（`journal-role-provider-registry.ts:143` +
  `fast-path-extraction.ts:1441`，slow path 已有 `BOUNDARY_PRECISIONS` 校验可参照）。
- **trust-action 确认措辞暴露内部机制**（待立票）：temporal-zh t3 correction
  成功仍说「后台的旧记录我还在重新核对」、temporal-mix t3「没找到…记录」——
  Luke 盲评两次点名「多余/出戏」。
- **fast-path 无谓词空值候选被丢弃**（待立票）：`.filter(isRelationship || typed!=="")`
  使延迟关系概念（干亲/邻居类 predicateId=null + typedValue=""）绕过 SPEC AC8
  `unmapped → review` 治理路径（本跑未触发，mapping-eval 在 registry 层仍覆盖）。

### 会话 9 复核记录（2026-09-01，code review + unblind）

- **Code review（双轴子代理 + 本人复核）**：standards 无硬违规（无新依赖、词汇
  合规、无 ADR 覆写）；judgement 级：`unblind.ts` 受保护类别改由 run 自带
  sampling 声明（#79 v1 路径不受影响、run-79-v2 自带 sampling）、
  `readNdjson`/`joinDeltas` 三处重复、`normalizeExtractBatch` 文档挂错函数。
- **披露偏差（版本化 + 有动机记录，写入 PR）**：task-instruction-decision v2→v3
  改动 incumbent 对话提示词（0cb4bb5，双问缺陷修复；双臂同用故 pairwise 内部
  一致；45-pack 机械复跑已带 v3 跑过——AC37 的 4 条发现正是它捕获的；但
  「taste sample 不重跑因 identity 层未变」的理由被削弱，persona/locale 包本体
  未动）；retrieval v2 截断扩展 `entityAnchored`/`object-elided canonical`
  （67ea21b；SPEC §156 枚举之外，impression ≥2 独立信号地板保留完好）。
- **AC 1–34 抽查**：台账引用的系测文件全部存在且覆盖如述；pins-report @ HEAD
  含角色指纹与运行时 t_auto 互证；AC38/39/40 证据复核如前。
- 测试基线：`ce9b0bd` 处 1025/1025 + typecheck + verify-pack v3.3 绿；
  `18cbda4` 较 `ce9b0bd` 仅增评测证据文件，基线仍有效（未重跑，按停止微调协议）。

## 结论

功能面（AC 1–34）与 AC 38/39/40 + pin/rollback 证据全部落地；AC 35 经 Luke
FP 裁定后通过；AC 36 整体/语言门槛大幅通过、唯 post_forget 净 -1 待裁定
（根因=缺陷 #17，非设计行为）；AC 37 唯 too_many_questions ×4 待逐条裁定。
两项裁定（ADR-0110，不可自我豁免）见
`/tmp/sayhear-126-post-forget-adjudication.md`；裁定后即可收口（PR 已建，
合并等裁定）。若出口条件未满足，切片不合入、继续迭代（SPEC merge sentence）。

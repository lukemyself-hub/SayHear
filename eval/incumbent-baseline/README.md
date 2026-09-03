# Conversation Text 前任基线(1A.2P merged run,issue #79;已归档)

## Status

Frozen — archived（superseded）。1A.3a cut-over 后由新鲜冻结的 1A.3a 现任基线取代
（[`eval/incumbent-baseline-1a3a/`](../incumbent-baseline-1a3a/)，issue #166；基线链
与取代规则见
[`docs/evaluation/01-behavior-contract-and-rubric.md`](../../docs/evaluation/01-behavior-contract-and-rubric.md)
§八:基线 = 当前最佳已接受策略的冻结运行;策略升级合入后由新冻结运行取代,旧基线归档可追溯)。
本目录归档保留、不删除：#126 rollback demo 与 scope-protection 仍引用本目录
manifest 作为 champion 簇对照。

## TL;DR

- 本目录是 1A.2P(Persona & Safety,ADR-0113)合入版本的冻结运行:canonical
  Persona v2、persona behavior anchors v2、en/zh locale packs v2 已 pin 进
  CompiledContext 策略解析,经完整认证 Text seam 与真实 champion 生成。
- 基线链:`#61 thin-persona 运行`(eval/conversation-text-baseline/,永久归档的
  「改革前基线」)→ 本运行(1A.3a 的现任基线)。#61 目录不因本目录的存在而修改。
- 场景包:`scenario-pack:v2.1`(45 场景,#77 期望 fixture;运行前 `verify-pack`
  全绿)。运行命令与 #61 相同(capture 脚本的 pin 常量随 cutover 升级,manifest
  记录实际生效版本)。
- 1A.3a 的对照结论必须引用本目录的 manifest 版本簇;被取代时本目录归档、不删除。

## 版本标记时间差(如实记录)

- 冻结运行的 posture 段与 stop-signal 提案函数携带的契约文案已与合入代码
  字节一致,但当时的版本标记仍是 v1(`safety-posture:v1` /
  `curiosity-stop-signal:v1`)——code review 阶段才把这两个策略常量按版本纪律
  升到 v2(迁移 0029 种子新行,旧行保留),场景包 fixture 的 policyVersion
  标签同步更新(12 处标签,全部 turn 输入字节不变;manifest 里的
  scenarioFile.sha256 对应运行时的包文件,其 git 历史可查)。
- 这两层的回滚因此不是 re-pin 而是 git revert(与 persona/locale/task 层的
  PREVIOUS_* re-pin 不同);#79 的 re-pin 回滚演示覆盖后者。
- 运行时使用的白名单为 safety-resources:v2(911 已在册,FP 台账有记录)。

## 与 #61 基线的可比边界

- 45 场景中 33 个与 #61 同源;其中 3 个 high_risk 激活轮与 1 个 refusal 停止轮
  的用户措辞被 #77 改写(进入版本化检测词表),另有 9 个追加轮(干净 turn /
  用户重开轮)——这些轮次与 #61 冻结转录不可逐字对比,盲评 pairwise
  (`eval/blind-pairwise/`)已按「同场景、同轮次、用户输入逐字一致」自动排除。
- 12 个新类别场景(#77)无 #61 对照,只参与硬门禁与契约判据,不参与 pairwise。

## 重新运行

```sh
pnpm exec tsx eval/scenario-pack-v2/verify-pack.ts   # 前置门槛
pnpm exec tsx scripts/capture-conversation-baseline.ts \
  --out <新目录> --scenarios eval/scenario-pack-v2/scenarios.json
pnpm exec tsx eval/scenario-pack-v2/check-transcripts.ts \
  <新目录>/transcripts.json <新目录>/findings.json \
  eval/scenario-pack-v2/scenarios.json
```

采样非确定性:重跑得到相同版本簇与同分布行为,不保证逐字相同(#61 manifest
limitations 同款约束)。

## References

- 规则与门槛:[行为契约与评测 rubric](../..//docs/evaluation/01-behavior-contract-and-rubric.md) ·
  [ADR-0110](../../docs/adr/0110-human-taste-is-authoritative-in-behavior-evaluation.md) ·
  [ADR-0113](../../docs/adr/0113-persona-and-safety-precedes-memory-recall.md)
- 前任基线:[#61 thin-persona run](../conversation-text-baseline/)(永久归档)
- 盲评:[blind pairwise run-79](../blind-pairwise/run-79/)
- Task: [#79](https://github.com/lukemyself-hub/SayHear/issues/79)

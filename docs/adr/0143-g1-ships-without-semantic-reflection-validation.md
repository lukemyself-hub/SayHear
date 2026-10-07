---
status: accepted
date: 2026-09-30
supersedes: [0137, 0139]
---

# G1 ships without semantic Reflection validation; the gold set is built after launch

#252 的第 252 轮人工裁定让这条决定变得必要。Luke 对 AC-X03 的 18 例逐例裁定后，
拒绝了全部 6 例 Reflection，超过 ADR-0139 的 1/18 预算，门禁如实失败。两条理由：

> `The supplied reflection was generated from manifest syn-holdout-other.` — 这根本不是
> 对用户的反思结论，不应当通过。
>
> `There is something about the clock that may matter to them.` — 这句话里的 them 指代不清，
> 并且这句话本身作为 reflection 没有信息价值。

机器对这 6 例的判定完全一致：`verdict: accepted`，`blockingFindingCodes: []`，
而 `manifest_mismatch`、`unsupported`、`material_absence`、`ambiguity` 全部只出现在
`advisoryFindingCodes` 里。它识别出了每一个缺陷，只是没有一个进入拦截判定。

把 24 例观测（18 校验 + 6 精度）按 artifact kind 排开，拦截结果与内容质量无关：

| artifact kind | 缺陷类型 | 机器结果 |
| --- | --- | --- |
| Bio ×12 | unsupported / contradiction / epistemic_upgrade / material_absence | 全部 blocked |
| Reflection ×6 | manifest_mismatch / ambiguity | 全部 accepted |
| 精度 ×6 | 无缺陷 | 全部 accepted |

同一个 `manifest_mismatch` 缺陷在 Bio 里能触发拦截，在 Reflection 里不能。**在
Reflection 上，拦截判定实际只跟着 artifact kind 走。**

## 为什么这个门禁本来就不该存在

三条已有的架构结论指向同一处，都早于本轮失败：

`packages/application/src/reflection/generator.ts` 写明 Reflection 的校验链是
"deterministic Tier-1 gate → draft persist → `narrative.validate` → fenced
current-pointer CAS commit + `propose_new` Candidate handoff"，并且
"**Reflection v1 records semantic classes as advisory**"。校验器在 Reflection 上的
职责是 ADR-0132 要求的**完成度**——没有一条已完成的 `narrative.validate` 命令就不
允许提交 current、不允许提 Candidate——而不是内容裁决。

ADR-0054 定 Reflection 是**非权威派生层**，只用于提出 Memory Candidate，Candidate 需
经独立准入成为 active Claim 才可能影响 Bio；Phase 1 只有只读 Reflection Inspector，
不产品化。因此 Reflection 的语义质量今天没有直接的用户可见后果。

`docs/research/reflection-profile-grounding-validation.md` §5.4 是决定性的：**在某类
错误达到可接受证据前，该 checker 只能作 advisory finding 或把结果送人工 review，
不能静默批准。**而 §5.1 要求的、带人工标注的 SayHear gold set **不存在**。没有
ground truth 就没有阈值可校准；把 synthetic fixture 上观察到的行为固化成发布门禁，
是在校准一份自己写的标准。

需要说明的是，§5.4 引用��现有工作的量级是 citation recall 85.1%、precision 77.6%。
我们连这个都还没测到，因为没有 gold set。

## 决定

1. **Reflection 语义判定不再作为 G1 发布门禁。**保留为 advisory finding，随产物
   记录，送 Inspector 供人查看。
2. **AC-X03 对 G1 改为完成度门禁**：证明 `narrative.validate` 跑完、判定有记录、
   角色已 pin。不再要求人裁定语义。
3. **Bio 移出 G1 校验范围。**`bio.write` 在 `ONE_A_3B_G1_DEFERRED_ROLES` 中，G1 不
   发布它，Bio 产物没有消费方，因此 G1 不校验 Bio。ADR-0137 的 18 例集合（12 Bio +
   6 Reflection）随本 ADR 失效，ADR-0139 的一例容错预算随之失效。
4. **gold set 延后到上线后建立。**Luke 在产品中与 SayHear 真实对话，通过 Reflection
   Inspector 和产品日志观察真实 Reflection 产物，再据此建立带人工标注的 gold set。
   在那之前，任何语义 checker 不得升级为 blocking。

## 保留的拦截能力

本 ADR 只移除**语义**门禁。以下确定性能力不变，且不是"中间确认"——它们是部署异常
时能把服务拉回来的东西：

- AC-D01 发布身份指纹绑定（`bindActiveG1Release` 拒绝把 pin 指向不同 manifest）
- AC-L01 / AC-L02 清理面与 purge-before-backup 恢复演练
- AC-M01 角色 pin 与真实 Provider 调用证据
- AC-X04 的确定性对话门禁（问句数、号码白名单、标点、高风险转介边界）；
  普通回复双问句的观察例外由 [ADR-0146](0146-f3-ordinary-double-questions-are-observations.md) 明确
- 激活围栏与阶段级回滚

同样保留：`tokenGates` 的降级（`31c54d4`）、AC-X04 的臂归属（`a421f19`）、
Continuation 臂的范围修正。它们修的是"门禁断言了不属于 G1 的东西"，与本 ADR 同向。

## 复评条件

当 gold set 达到 §5.4 要求的证据量时，按 ADR-0121 的耦合规则处理：某个 verdict class
只能**同时**对 Bio 和 Reflection 生效，不能一边拦一边放。若届时 Bio 仍不在 G1 范围，
则该 class 在 G1 内保持 advisory。

# Recall-presentation 盲评对比原型(issue #94)

## Status

**PROTOTYPE — throwaway。** 本目录及整个分支是可抛弃的对比制品:回答
[#94](https://github.com/lukemyself-hub/SayHear/issues/94) 的问题——
**哪种 recall 呈现策略让注入的记忆感觉准确、自然、克制,而不是监控感**——
结论落回 issue,代码不进 main(prototype skill 纪律)。

## TL;DR

- 在 `eval/scenario-pack-v2` 的 3 个 `memory_continuity` 场景(en / zh / mix)
  上对比 4 个 recall 呈现变体,冻结 persona v2(#79 版本化 prompt artifacts,
  经真实 `resolvePromptArtifacts` 解析)+ deepseek-v4-flash,**只变记忆的注入
  方式和指令**:
  - `portrait_only` 只注入 Person Portrait(逐条、带认识状态与证据,ADR-0111 形态)
    + 被动织入规则(用户当前话语关联才用);
  - `portrait_retrieved` Portrait 之上 day-2 每轮注入一条 query-matched 的
    open-thread 检索记忆(对 turn-level 检索的确定性模拟)+ 同样的被动规则;
  - `proactive` 同 `portrait_retrieved` 上下文,但允许一次温和的主动承接
    (跨 gap 开场可接起挂念,被回避即停;t4 以等待的分量接住好消息);
  - `no_memory` 无记忆投影对照(persona v2 独立工作,只依赖预算内的原始对话
    窗口——4 轮场景里 day-1 原文仍在窗口内,与生产 raw Events 预算和 fixture
    「无记忆投影时连续性是否存活」的本意一致;它不是「失忆」对照)。
- 第一天(t1/t2)每场景只生成一次(尚无记忆),四个变体从同一共享历史继续
  day-2,保证差异只来自记忆呈现。
- 协议 = #62 盲评纪律:字母 W/X/Y/Z 按场景种子洗牌(mulberry32,
  `seed + 场景序号 × 7`,seed=94);Luke 逐轮批注、按维度 1–5 评分
  (准确 / 自然 / 克制 / 连续;正极在高分,不求和,ADR-0110)、每场景选最佳;
  **评完才揭示**,机械候选标记(禁提 token / 时间锚 / 召回措辞)只在揭示后
  出现(报警≠定罪);conclusions 的每条引文反查原文子串。
- Portrait 两条由 fixture 的 `injectedMemories` 作者化拆分:一条 Objective
  Memory(用户陈述)+ 一条 AI Impression(推断),同时检验 ADR-0009 双类召回
  语言;检索项 = fixture 的 open loop 加 open-thread 框架。准入本身不在原型
  范围内。

## 文件

| 路径 | 用途 |
| --- | --- |
| `protocol.ts` | 共享协议:种子洗牌、维度定义、机械候选标记(无 import 副作用) |
| `generate.ts` | 直连模型生成 `run/comparison.json`(含 letterMap、机械标记、manifest) |
| `build-review-page.ts` | 从 comparison.json 生成单文件盲评页 `run/index.html` |
| `reveal.ts` | 先评后揭门禁 + 维度中位数 + 最佳计数 + 标记汇总 + 引文反查 → `run/results.json` |
| `run/comparison.json` | 原始数据(含真实映射;盲评页不显示) |
| `run/index.html` | Luke 的盲评页(双击打开;本地草稿、导出 ratings.json、评完可揭示) |
| `run/ratings.json` | 页面导出的盲评分数(reveal.ts 的输入) |
| `run/results.json` | 揭示后的汇总 |

## 使用

```sh
# 1. 生成(约 30 次模型调用;DEEPSEEK_API_KEY 需在 .env)
pnpm exec tsx eval/recall-presentation-94/generate.ts

# 2. 生成并打开盲评页
pnpm exec tsx eval/recall-presentation-94/build-review-page.ts
open eval/recall-presentation-94/run/index.html

# 3. Luke 盲评:逐轮批注 → 四维 1–5 → 场景最佳 → 导出 ratings.json 放回 run/

# 4. 揭示(评分不完整即拒绝)
pnpm exec tsx eval/recall-presentation-94/reveal.ts

#    如有结论引文要发表,先写 run/conclusions.json 再反查:
# pnpm exec tsx eval/recall-presentation-94/reveal.ts \
#   --conclusions eval/recall-presentation-94/run/conclusions.json
```

`conclusions.json` 格式:`[{ "quote": "<原文子串>", "scenarioId": "...",
"turnIndex": 3, "letter": "W", "claim": "..." }]`。

## 评分维度(1–5,正极在高分,不求和)

| 维度 | 5 分 | 1 分 |
| --- | --- | --- |
| 准确 | 完全忠实给过的信息,归因清楚,无编造无越界 | 编造细节、张冠李戴、推断当事实 |
| 自然 | 像认识你的人顺口织入 | 档案腔 / 技术仪式 / 生硬背诵 |
| 克制 | 分寸刚好,无监控感 | 查岗、施压汇报、硬塞记忆 |
| 连续 | 该记起的时刻稳稳接住 | 完全像初次见面 |

## 边界

- 场景素材全部合成(scenario-pack v2.1 的 memory fixture);不读任何真实
  私人对话;不写产品状态、不碰数据库。
- 检索是确定性模拟(day-2 每轮注入同一条 open-thread 记忆),不是真实
  pgvector 检索;结论只关于「呈现策略」,不关于检索质量。
- 场景只有 4 轮,day-1 原文在所有变体的 raw window 内:t4 的连续性对四个
  变体都部分可得,变体差异主要体现在 t3 的呈现与指令驱动的措辞上。真实
  多日会话中 day-1 会滚出窗口,那时的对照需要截断历史的第五臂(超出本
  原型范围)。
- 单样本 per (场景, 轮, 变体);模型输出非逐位可复现(#62 同款限制)。
- 4 个变体的失败类观察清单(#62 失败类):编造上下文、过度归因、召回措辞
  违反 ADR-0009、missed expected recall、forbidden mentions、监控感。

## References

- Issue: [#94](https://github.com/lukemyself-hub/SayHear/issues/94) ·
  map [#90](https://github.com/lukemyself-hub/SayHear/issues/90)
- 协议先例:[#62 盲评](https://github.com/lukemyself-hub/SayHear/issues/62)
  (分支 `prototype/issue-62-response-policies`)·
  [blind-pairwise 通道](../blind-pairwise/README.md)
- 规则:[ADR-0009](../../docs/adr/0009-objective-memory-and-ai-impression-use-distinct-recall-language.md)
  双类召回语言 ·
  [ADR-0110](../../docs/adr/0110-human-taste-is-authoritative-in-behavior-evaluation.md)
  人工味觉权威 ·
  [ADR-0111](../../docs/adr/0111-persona-and-conversation-state-inputs-are-compiled-versioned-contracts.md)
  Portrait 形态与预算
- 研究输入:[#91 recall UX 调研](../../docs/research/memory-recall-companion-ux.md)
  (无仪式编织 / 过度召回监控感 / Kindroid 式逐消息上限)

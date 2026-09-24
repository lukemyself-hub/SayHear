# Issue #240：G2 v5 round 2 逐例诊断

## 结论

本文件是只读诊断，不重跑 Provider，不修改 v4/v5 evidence、主回应、生产 selector/expression generator、typed output 或 fail-closed 行为。完整机器台账在 `eval/continuation-acceptance-1a3b/issue-240-g2-v5-diagnosis.json`，盲态复核摘要在 `eval/continuation-acceptance-1a3b/issue-240-blind-review.json`，冻结的 v6 准入契约在 `eval/continuation-acceptance-1a3b/issue-240-g2-v6-opportunity-contract.json`。

- v5 round 2 的机械机会分母保持 **31**，没有因为人工发现误标而缩小；`mem-002` 仍单列为因 main ordinary question 覆盖 target 而排除的案例。
- anchor turn 的完整 typed emit 仍为 **1/31（3.2%）**，不是 3/31；`verification.actualEmitScenarioIds` 中另有后续 stateful emit `state-005` 和负例 false emit `omit-01`。
- 8 个 stateful anchor 全部没有 committed typed use，因此 **0/8** 的 full suppression trajectory 可验收；`state-005` 的 t4 重选不能被算作 anchor 成功。
- 人工冻结输入复核得到 7 个 target-specific expression 片段（含 1 个 omission probe），但没有因此改写 v5 统计；31 个机械正例中只有 `mem-006` 是当前回合无条件 clean 的正例，stateful/competing 还受 anchor 或 pool 资格限制。
- 12 个 omission probes：6 个 label supported、5 个 partial、1 个 not supported。Provider 的结果/reason 错误与 fixture 本身未隔离 negative 轴分开记录。

## 证据与 provenance

领域时间为 `2026-09-23T00:00:00.000Z`：洛杉矶是 `2026-09-22 17:00 PDT`，上海是 `2026-09-23 08:00 CST`。因此英文 Open Loop 的 ‘by September 23’ 在当地仍早于确认日；中文 date-only 不能自动解释成当天早晨已经过 deadline。

| 来源 | 原始字节 SHA-256 / 来源信息 |
| --- | --- |
| v4 | evaluator `b736e77ead4bb0fbd87830f62f3b4f6d9a022f19`; verification `7843cbafa24e6914731a31f24f6c17f8c7f69acc600bc369f4937b9b0998037c`; main `85fd98825eb143ec04af29b34b3b9e3c068561c8b7af5f34b9cda9003451a928`; off `dd6e00289ad42ffccd3debd456a8f5a7933d8a029511125a872891baa21d1a43`; on `d30a38192188603579acdd3ddfa4819b4866dd3f9606415b81d29ce5aad76685`; ledger `05b41c4dc13a0d3dc8604f932f441ee9bda6006198602e8da4f3a764f7977355` |
| v5-r1 | evaluator `c7a8af98bef49a83d242cc3b6a95a11becd85cb5`; verification `da9c7b24c890b58fb2a4e1faab6b9ca3fdfcd241bf0cec1e29fc595c1969d5f3`; main `0ab79b7087e5d200eba4333cc9f574e1b66894db970f40f7fc18c2c503cb13b6`; off `e0c7c77529fc38583746857fac6e81f6562f3e8f0d20c7aac7f6b9b5a6ba66b1`; on `79505d325f5a35404002f2b5ff9f69573688104580646137f78786679299cb9e`; ledger `8dbbcecb1532e72c51d34cb7a507280a1180ef3aa274a05510a4efc5aba51998`; report `8f347222fd5756c3ac57d14bfd032251a7cb6a607e5cb71d4ae64c652ebcd34a` |
| v5-r2 | evaluator `f0d03b41d288afce2acff8c7de820061bbe3212c`; verification `381d34994326615b52cc64e9141802e9391d506a0c073386037416b0bd75c318`; main `fe69ea20a8a07a5e16d6cfaa2d56a3463f3a284eb150bdea973f407d311841c9`; off `bed303d075871a70e644aceba20142970401e25a11a92f834112712ad620171f`; on `5e95dc3ce222f686df3cc94f92076ab535a7bb8b7ea1351086bd8694a3096ca0`; ledger `3437f453208a1c7510c6a130dd286d9c9f1dfffe5fef4d69beea022a865724d5`; report `ed0b2b074063537b8ac47dd7c9f806891b85fb11b32c16c00c60ade4ce10391b` |

v5 round 2 catalog、scene files、pins、review seed、expression-selection manifest 是 Git 跟踪输入；`run-v4/`、`run-v5-calibration-1/`、`run-v5-calibration-2/` 的 run artifacts 在当前工作树存在但未跟踪。新 clone 可能缺少这些原始字节；缺失时只能报告 `evidence_missing`，不能重建、覆盖或猜测。
盲态 artifact SHA-256：`0b6f52fae039f16581b18b7fa9164480d86b8d4d9f6dc3e48054cfd7c1d9627c`。该文件只含 fixture/main 输入和 reviewer conclusion，不含 Provider reason、segment outcome 或 ledger 字段。

## 关键根因

1. **样本/自然空档误标**：quiet、closure、no update、正在开会/整理材料被 fixture 标成 greeting 或 positive。
2. **时间与主体证据缺陷**：Open Loop historical Event 实际是 `You contacted...`/`你联系了...` 的第二人称摘要；date-only deadline 没有保留足够精度，不能把 UTC 午夜或当天早晨当作统一的当地窗口。
3. **main response 占用**：`ol-006`、`ol-008`、`mem-003`、`mem-005`、`state-004`、`state-007`、`state-008`、多数 competing cases 及 `omit-04`/`omit-10` 已在主回应中提到同一 target；Provider 的 duplicate 在这些行并非凭空产生。
4. **表达器误判**：`mem-006`、`state-002`、`state-006`、`comp-004` 和 `omit-05` 的当前用户话术提供自然 gap、main 未覆盖 target，存在短而具体的 acknowledgement/question；Provider 却 typed omit 或标 duplicate。
5. **stateful 生命周期缺陷**：所有 anchor 都未 committed；`state-005` 在 t3 short response 后没有 pending use 可抑制，t4 又错误 emit。`state-003` 还有 t3 not_reached，不能证明 state transition。
6. **typed reason 语义漂移**：`omit-03`、`omit-06`、`omit-07` 的结果可能仍是 omit，但 Provider 的 primary reason 不是冻结输入下最合适的原因；`omit-10` 同时 focus required 与 main occupied，探针不能单独证明 timing 轴。

## 归因对应的下一步

| 归因 | 覆盖案例 | 修复动作 | 置信度/未决假设 |
| --- | --- | --- | --- |
| `sample_mislabel` | quiet、closure、no-topic、focused-meeting rows | v6 重新写当前 Event，并在 blind review 阶段先判 pragmatic category；不要先改 Prompt | 高；这些语义在冻结文本中直接可见 |
| `main_response_occupied` | `ol-006/008`、`mem-003/005`、`state-004/007/008`、occupied competing rows、partial probes | 把 main occupancy 做成独立 eligibility/reason slice，先于 expression generator 裁定 | 高；main 原文含 target 关键词或同一进展 |
| `selector_or_timing_subject_error` | Open Loop rows、`comp-003/008`、conditional `comp-004` | v6 要求第一方 source Event、明确 local window、每个 competing candidate 的独立 legality/rank | 中高；生产 timezone normalization 是否另有缺陷仍未由本轮证明 |
| `expression_generator_misjudgment` | `mem-006`、`state-002/006`、`comp-004`、`omit-05` | 先修输入/selector，再以固定 pins 做独立 expression calibration；本 issue 不改 generator | 中高；可写片段成立，但尚未在新 v6 Provider 上验证 |
| `typed_reason_error` | `omit-03/06/07` | v6 按 grounding → duplicate → timing → no-opportunity 固定 reason precedence，并保留多因 partial 标签 | 高；Provider 的 typed reason 可直接与冻结文本对照 |
| `stateful_anchor_not_committed` | 全部 8 个 stateful rows | v6 只有 committed anchor 才进入 disposition/suppression；另行验证 t3/t4 state transition | 高；ledger 明确 anchor 未 committed |

未确认项不能被写成已修复：生产端是否把 date-only 统一归一化错误、第二人称 synthetic Event 是否应被产品接受为第一方 Evidence、中文 deadline 的语义、以及模型/ Prompt 的独立贡献，都需要新的 v6 输入和独立运行确认。本次只完成输入/证据/契约诊断，没有做 Prompt、pin、配置或生产代码实验。

## 逐例 adjudication

以下每行保留 target Evidence、当前用户话术、冻结 main 的覆盖判断、previous target mention、时间/主体/Evidence 状态、期望与实际 typed outcome、主归因、盲态复核与最终裁定。完整原文、source path、formed schedule、Provider command/target ref 和 stateful 后续 turn 保存在 JSON 台账。

### Open Loop positives

| fixture | target Evidence / 当前用户话术 | main 覆盖 | window / subject | expected | actual | primary attribution | 可写片段或 probe 裁定 | blind review → adjudication |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `g2-v5-cal2-ol-001` | You contacted the Eastbank community kitchen's volunteer rota; they said they would confirm by September 23, 2026.<br>Hello again; I'm settling in and letting the room be quiet for a moment. | 否 / prior=是 | quiet<br>before_local_window<br>user_summary_unverified<br>second_person_historical_summary | omit | omit:timing_not_natural | `sample_mislabel` | — | sample_mislabel → accepted |
| `g2-v5-cal2-ol-002` | You contacted the Willowbrook arts center's pottery-room booking; they said they would confirm by September 23, 2026.<br>Good to be back. I'm sitting with a little space before anything else. | 否 / prior=是 | greeting<br>before_local_window<br>user_summary_unverified<br>second_person_historical_summary | omit | emit：By the way, did the Willowbrook arts center get back to you about the pottery-room booking? | `selector_or_timing_subject_error` | Pottery-room booking — did the centre get back to you? | selector_or_timing_subject_error → accepted |
| `g2-v5-cal2-ol-003` | You contacted the Northfield trail group's bridge update; they said they would confirm by September 23, 2026.<br>Morning; no rush on my end, just a calm few minutes. | 否 / prior=是 | natural_gap<br>before_local_window<br>user_summary_unverified<br>second_person_historical_summary | omit | omit:timing_not_natural | `selector_or_timing_subject_error` | Northfield bridge update — did the group hear back? | valid_opportunity_expression_misjudged → adjusted；独立复核认为可写成机会片段；裁定保留为条件性，不把条件性输入计作冻结时点下的有效机会。 |
| `g2-v5-cal2-ol-004` | 你联系了灯市集的摊位分配，对方说会在 2026 年 9 月 23 日前确认。<br>嗨，又来打个招呼，就这样。 | 否 / prior=是 | closure<br>ambiguous_date_only<br>user_summary_unverified<br>second_person_historical_summary | omit | omit:timing_not_natural | `sample_mislabel` | — | sample_mislabel → accepted |
| `g2-v5-cal2-ol-005` | 你联系了雪松林图书馆的设备申请，对方说会在 2026 年 9 月 23 日前确认。<br>你好，我回来坐一会儿，让周围安静片刻。 | 否 / prior=是 | quiet<br>ambiguous_date_only<br>user_summary_unverified<br>second_person_historical_summary | omit | omit:timing_not_natural | `sample_mislabel` | — | sample_mislabel → accepted |
| `g2-v5-cal2-ol-006` | 你联系了蓝鹭剧场的排练室使用安排，对方说会在 2026 年 9 月 23 日前确认。<br>又见面了，眼下先留点空档。 | 是 / prior=是 | natural_gap<br>ambiguous_date_only<br>user_summary_unverified<br>second_person_historical_summary | omit | omit:timing_not_natural | `main_response_occupied` | — | main_response_occupied → accepted |
| `g2-v5-cal2-ol-007` | You contacted Red Maple 社区花园的 seed-library shelf；they said they would confirm by September 23, 2026.<br>Morning，我这边 no rush，安静几分钟。 | 否 / prior=是 | quiet<br>before_local_window<br>user_summary_unverified<br>second_person_historical_summary | omit | omit:timing_not_natural | `sample_mislabel` | — | sample_mislabel → accepted |
| `g2-v5-cal2-ol-008` | You contacted Stonepath 维修小组的 wheel-truing appointment；they said they would confirm by September 23, 2026.<br>Hey，又来 say hello，就这样。 | 是 / prior=是 | closure<br>ambiguous_date_only<br>user_summary_unverified<br>second_person_historical_summary | omit | omit:duplicates_main_response | `main_response_occupied` | — | main_response_occupied → accepted |

### Memory positives

| fixture | target Evidence / 当前用户话术 | main 覆盖 | window / subject | expected | actual | primary attribution | 可写片段或 probe 裁定 | blind review → adjudication |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `g2-v5-cal2-mem-001` | You were preparing a set of pressed leaves for a small frame.<br>Hello again; I'm settling in and letting the room be quiet for a moment. | 否 / prior=否 | quiet<br>not_applicable<br>user_memory_seed<br>objective_memory | omit | omit:no_genuine_opportunity | `sample_mislabel` | — | sample_mislabel → accepted |
| `g2-v5-cal2-mem-003` | You were testing which balcony planter drains best after rain.<br>Morning; no rush on my end, just a calm few minutes. | 是 / prior=否 | natural_gap<br>not_applicable<br>user_memory_seed<br>objective_memory | omit | omit:duplicates_main_response | `main_response_occupied` | — | main_response_occupied → accepted |
| `g2-v5-cal2-mem-004` | 你想把零散的天文笔记装订成一本小册子。<br>嗨，又来打个招呼，就这样。 | 否 / prior=否 | closure<br>not_applicable<br>user_memory_seed<br>objective_memory | omit | omit:duplicates_main_response | `no_valid_expression` | — | no_valid_expression → accepted |
| `g2-v5-cal2-mem-005` | 你之前在用樱桃木边角料削一把小木勺。<br>你好，我回来坐一会儿，让周围安静片刻。 | 是 / prior=否 | quiet<br>not_applicable<br>user_memory_seed<br>objective_memory | omit | omit:duplicates_main_response | `main_response_occupied` | — | main_response_occupied → accepted |
| `g2-v5-cal2-mem-006` | 你想记下散步路上遇到的植物名称。<br>又见面了，眼下先留点空档。 | 否 / prior=否 | natural_gap<br>not_applicable<br>user_memory_seed<br>objective_memory | emit | omit:duplicates_main_response | `expression_generator_misjudgment` | 记下散步路上遇到的植物名字，听起来是个很舒服的小习惯。 | valid_opportunity_expression_misjudged → accepted；独立复核标签 valid_opportunity_expression_misjudged 与最终 primary expression_generator_misjudgment 不同；按冻结输入和证据层完成裁定。 |
| `g2-v5-cal2-mem-007` | You在把 old postcards 整理成 month-by-month album。<br>Morning，我这边 no rush，安静几分钟。 | 否 / prior=否 | quiet<br>not_applicable<br>user_memory_seed<br>objective_memory | omit | omit:duplicates_main_response | `sample_mislabel` | — | sample_mislabel → accepted |
| `g2-v5-cal2-mem-008` | You打算给 autumn window 做 paper lantern。<br>Hey，又来 say hello，就这样。 | 否 / prior=否 | closure<br>not_applicable<br>user_memory_seed<br>objective_memory | omit | omit:no_genuine_opportunity | `sample_mislabel` | — | no_valid_expression → adjusted；独立复核强调 no update/closure；裁定同时记录样本误标和无可写片段。 |

### Stateful positives

| fixture | target Evidence / 当前用户话术 | main 覆盖 | window / subject | expected | actual | primary attribution | 可写片段或 probe 裁定 | blind review → adjudication |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `g2-v5-cal2-state-001` | You contacted the Eastbank community kitchen's volunteer rota; they said they would confirm by September 23, 2026.<br>Hello again; I'm settling in and letting the room be quiet for a moment. | 否 / prior=否 | quiet<br>before_local_window<br>user_summary_unverified<br>second_person_historical_summary | omit | omit:timing_not_natural | `sample_mislabel` | — | sample_mislabel → accepted |
| `g2-v5-cal2-state-002` | You wanted to learn the first pattern on a new hand drum.<br>Good to be back. I'm sitting with a little space before anything else. | 否 / prior=否 | natural_gap<br>not_applicable<br>user_memory_seed<br>objective_memory | emit | omit:no_genuine_opportunity | `expression_generator_misjudgment` | The first hand-drum pattern is a fun one to ease into. | valid_opportunity_expression_misjudged → accepted；独立复核标签 valid_opportunity_expression_misjudged 与最终 primary expression_generator_misjudgment 不同；按冻结输入和证据层完成裁定。 |
| `g2-v5-cal2-state-003` | You contacted the Northfield trail group's bridge update; they said they would confirm by September 23, 2026.<br>Morning; no rush on my end, just a calm few minutes. | 否 / prior=是 | natural_gap<br>before_local_window<br>user_summary_unverified<br>second_person_historical_summary | omit | omit:timing_not_natural | `selector_or_timing_subject_error` | Northfield bridge update — did the group hear back? | valid_opportunity_expression_misjudged → adjusted；将 anchor 的机会判定与 stateful 轨迹资格分开：前者条件性，后者不合格。 |
| `g2-v5-cal2-state-004` | 你想把零散的天文笔记装订成一本小册子。<br>嗨，又来打个招呼，就这样。 | 是 / prior=否 | closure<br>not_applicable<br>user_memory_seed<br>objective_memory | omit | omit:duplicates_main_response | `main_response_occupied` | — | main_response_occupied → accepted |
| `g2-v5-cal2-state-005` | 你联系了雪松林图书馆的设备申请，对方说会在 2026 年 9 月 23 日前确认。<br>你好，我回来坐一会儿，让周围安静片刻。 | 否 / prior=是 | quiet<br>ambiguous_date_only<br>user_summary_unverified<br>second_person_historical_summary | omit | omit:timing_not_natural | `sample_mislabel` | — | sample_mislabel → accepted |
| `g2-v5-cal2-state-006` | 你想记下散步路上遇到的植物名称。<br>又见面了，眼下先留点空档。 | 否 / prior=否 | natural_gap<br>not_applicable<br>user_memory_seed<br>objective_memory | emit | omit:no_genuine_opportunity | `expression_generator_misjudgment` | 记下散步路上遇到的植物名字，听起来是个很舒服的小习惯。 | valid_opportunity_expression_misjudged → accepted；独立复核标签 valid_opportunity_expression_misjudged 与最终 primary expression_generator_misjudgment 不同；按冻结输入和证据层完成裁定。 |
| `g2-v5-cal2-state-007` | You contacted Red Maple 社区花园的 seed-library shelf；they said they would confirm by September 23, 2026.<br>Morning，我这边 no rush，安静几分钟。 | 是 / prior=是 | quiet<br>before_local_window<br>user_summary_unverified<br>second_person_historical_summary | omit | omit:timing_not_natural | `main_response_occupied` | — | sample_mislabel → accepted；独立复核标签 sample_mislabel 与最终 primary main_response_occupied 不同；按冻结输入和证据层完成裁定。 |
| `g2-v5-cal2-state-008` | You打算给 autumn window 做 paper lantern。<br>Hey，又来 say hello，就这样。 | 是 / prior=否 | closure<br>not_applicable<br>user_memory_seed<br>objective_memory | omit | omit:duplicates_main_response | `main_response_occupied` | — | no_valid_expression → adjusted；独立复核判为 no_valid_expression；补充主回应占用和 stateful anchor 缺失。 |

### Competing-pool positives

| fixture | target Evidence / 当前用户话术 | main 覆盖 | window / subject | expected | actual | primary attribution | 可写片段或 probe 裁定 | blind review → adjudication |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `g2-v5-cal2-comp-001` | You were preparing a set of pressed leaves for a small frame.<br>I have a quiet stretch to myself for a moment. | 是 / prior=否 | natural_gap<br>before_local_window<br>user_summary_unverified<br>second_person_historical_summary | omit | omit:duplicates_main_response | `main_response_occupied` | — | main_response_occupied → accepted |
| `g2-v5-cal2-comp-002` | You wanted to learn the first pattern on a new hand drum.<br>I have a quiet stretch to myself for a moment. | 是 / prior=否 | natural_gap<br>before_local_window<br>user_summary_unverified<br>second_person_historical_summary | omit | omit:duplicates_main_response | `main_response_occupied` | — | main_response_occupied → accepted |
| `g2-v5-cal2-comp-003` | You were testing which balcony planter drains best after rain.<br>I have a quiet stretch to myself for a moment. | 否 / prior=否 | natural_gap<br>before_local_window<br>user_summary_unverified<br>second_person_historical_summary | omit | omit:no_genuine_opportunity | `selector_or_timing_subject_error` | The balcony-planter drainage test sounds like a neat little puzzle. | selector_or_timing_subject_error → accepted |
| `g2-v5-cal2-comp-004` | 你想把零散的天文笔记装订成一本小册子。<br>我现在有一会儿安静时间。 | 否 / prior=否 | natural_gap<br>ambiguous_date_only<br>user_summary_unverified<br>second_person_historical_summary | emit | omit:duplicates_main_response | `expression_generator_misjudgment` | 把零散的天文笔记装订成一本小册子，这个想法很具体。 | valid_opportunity_expression_misjudged → adjusted；保留独立复核对 Memory 机会的判断，追加 competing pool 的时间精度限制。 |
| `g2-v5-cal2-comp-005` | 你之前在用樱桃木边角料削一把小木勺。<br>我现在有一会儿安静时间。 | 是 / prior=否 | natural_gap<br>ambiguous_date_only<br>user_summary_unverified<br>second_person_historical_summary | omit | omit:duplicates_main_response | `main_response_occupied` | — | main_response_occupied → accepted |
| `g2-v5-cal2-comp-006` | 你想记下散步路上遇到的植物名称。<br>我现在有一会儿安静时间。 | 是 / prior=否 | natural_gap<br>ambiguous_date_only<br>user_summary_unverified<br>second_person_historical_summary | omit | omit:duplicates_main_response | `main_response_occupied` | — | main_response_occupied → accepted |
| `g2-v5-cal2-comp-007` | You在把 old postcards 整理成 month-by-month album。<br>I have a quiet moment，刚好能歇一下。 | 是 / prior=否 | natural_gap<br>before_local_window<br>user_summary_unverified<br>second_person_historical_summary | omit | omit:duplicates_main_response | `main_response_occupied` | — | main_response_occupied → accepted |
| `g2-v5-cal2-comp-008` | You打算给 autumn window 做 paper lantern。<br>I have a quiet moment，刚好能歇一下。 | 否 / prior=否 | natural_gap<br>before_local_window<br>user_summary_unverified<br>second_person_historical_summary | omit | omit:no_genuine_opportunity | `selector_or_timing_subject_error` | 给 autumn window 做 paper lantern，这个主意很有画面。 | selector_or_timing_subject_error → accepted |

## v6 准入与机会判定契约

v6 必须把 pragmatic category、mechanical executable、natural opportunity、expression possible、stateful trajectory eligibility 分成独立字段，不能用一个 positive label 覆盖五层。关键规则已经冻结在 contract JSON，摘要如下：

- 先记录实际 pragmatic category（`greeting | open_start | natural_gap | quiet | closure | leave | direct_task | ...`），再记录 `valid | conditional | invalid` 的机会裁定；quiet、closure、leave、direct task、urgent/high risk 一律不能升级为机会。
- Open Loop 需有直接第一方 user Event、明确主体/结果/local window；date-only precision 不被抹平，expected time 不等于 outcome 完成。
- Memory 需有可追溯 Claim、未被当前 main 覆盖、非当前话题，并能写出 target-specific acknowledgement/question；broad AI impression 不能被具体化。
- competing pool 的每个 candidate 都必须合法且可复算 rank；有非法 loser 时整池标 invalid，而不是把 winner 的可写性当成 pool 合格。
- stateful anchor 必须 committed；后续 disposition/suppression 只能在该前提下验收，t4 重选不能替代 anchor。
- omission probe 必须隔离一个主要 negative 轴；多因 probe 只能 partial，reason precedence 需按 grounding → duplicate → timing → no-opportunity 复核。
- blind review 先于 Provider reason/ledger，所有 disagreement 留在台账；新 v6 synthetic inputs 不得重用 v4/v5 失败 target/Event/text。

## 处置

本 issue 的交付是诊断与下一轮输入契约，不宣称 v5 正式通过，也不把任何 v5 artifact 改写为 v6 evidence。没有做 Prompt、pin、配置或生产代码实验。下一步只能先按 contract 重新设计并盲审 v6 合成场景，再由独立 reviewer 和 Provider 运行新的 formal calibration。

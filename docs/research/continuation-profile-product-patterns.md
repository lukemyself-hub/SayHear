# 对话内主动关心与 AI Profile 透明度：1A.3b 产品模式研究

> 状态：研究输入，不是产品或架构决策。
> 任务：[Research proactive companion follow-up and profile transparency patterns](https://github.com/lukemyself-hub/SayHear/issues/164)。
> 调研日期：2026-09-02。只引用当日可读取的产品方页面。
> 前置研究：[#91 Memory & Recall 体验调研](memory-recall-companion-ux.md)已经盘点通用 Memory 召回、透明度、纠错与遗忘。本篇不重做产品清单，只提取 1A.3b 的两个窄问题：怎样在用户已发起的对话里自然提起过去事项，以及用户可见的 AI-written Profile 应怎样表达更新和纠错边界。

## 结论

第一方产品文档支持一种克制的连续性：AI 可以根据过去对话提出一个具体、低压力的邀请，也可以让用户说明“什么话题在什么时候可以再提”。这些文档没有公开足以照抄的 selector 规则。没有一家公开说明如何同时处理当前诉求优先级、每段交流上限、停止信号、敏感 target 和过期事项。SayHear 不应把行业里一句“可以主动提起”当作完整设计。现有 ADR-0042、ADR-0043、ADR-0044 和 Curiosity Stop Signal 仍是更完整的约束。

AI-written Profile 的可见性也不能等同于 Memory 的完整可见性。ChatGPT 的最新 Memory Summary 是最接近 Profile 的公开产品形态：它有更新时间、自动更新、手动刷新、纠错入口和来源解释，但官方同时明确 Summary 不包含全部 Memory，Sources 也未必显示影响回复的全部因素。对 SayHear 的直接含义是：Bio 应明确叫作“SayHear 当前对你的理解”一类投影，不应宣称“这是我们记得的全部内容”，更不能让用户直接改 Bio 后误以为底层 Memory 已被纠正。

建议 1A.3b SPEC 保留并说清三条边界：

1. Proactive Follow-up 是当前 User Event 之后的可选对话动作。措辞应先承接当前表达，再用可拒绝的邀请提起一个仍有效 target；时间经过、后台任务或“提高参与度”都不能单独触发它。
2. Profile 页面显示 current Bio、上次更新时间、预计下次更新时间，以及 `updating / temporarily unavailable` 等真实状态。普通 refresh 可以暂时保留仍安全的旧版本；Correction、Forget 或其他 trust-boundary change 后，旧版本立即消失。
3. “刷新”与“纠正”必须是两个动作。刷新只重新生成投影；不准确或不想保留的内容进入对话内 Memory Correction / Forget，再触发安全重建。Profile 正文不是第二个 Memory 编辑器。

## 第一方证据

### 1. 可控的对话内主动性已经出现，但产品方没有公开完整停止策略

**[产品文档] ChatGPT 允许用户规定主动提起的主题和时机。** OpenAI 2026-06-04 发布的新 Memory 系统把长期上下文合成为可见的 Memory Summary。用户可以从 Summary 添加或更新信息，还可以告诉 ChatGPT“哪些主题应在什么时候提起”。OpenAI 把这项能力与 continuity、preferences 和 temporal freshness 放在一起，而不是描述成提醒或任务系统。（[Dreaming: Better memory for a more helpful ChatGPT](https://openai.com/index/chatgpt-memory-dreaming/)）

**[产品文档] Gemini 会根据过去对话提出话题或工具。** Google 的帮助页给出三个例子：建议继续一个项目、主动提出帮助规划曾经提到的旅行、询问是否要比较此前讨论的产品。页面也允许用户在当前聊天中直接纠正 Gemini。（[Get personalisation with memory of your past Gemini chats](https://support.google.com/gemini/answer/16598469?hl=en)）

**[推断] 适合 SayHear 借用的是“邀请”，不是例子中的任务倾向。** “要不要继续看看……”保留用户拒绝和换题的空间，也不虚构事项已经推进。SayHear 的 Open Loop 不是任务或 reminder，因此不能把 Gemini 的项目、旅行和购物例子直接改名后搬进产品。目标仍必须满足 direct User Evidence、有效期、当前 eligible 状态和 target-level suppression。

**[缺口] 这些第一方页面没有说明 selector。** 它们没有公开一次交流可主动提几次、直接任务是否优先、用户短答后多久停止、敏感话题怎样处理，或拒绝后怎样解除 suppression。这个空白意味着 1A.3b 仍需要自己的 prototype 与人工盲评，不能用竞品行为替代决定。

### 2. Profile 类摘要需要显示 freshness，但不能伪装成完整 Memory 清单

**[产品文档] ChatGPT 的 Memory Summary 自动更新，也可以手动刷新。** Summary 显示上次更新时间，用户可以在管理菜单手动 Refresh。用户可输入修改要求或选中具体文字纠正。OpenAI 同时提醒：Summary 只显示重要信息，不一定包含系统基于历史聊天记住的全部内容。（[Memory FAQ](https://help.openai.com/en/articles/8590148-memory-faq)）

**[产品文档] response-level Sources 也不是完整归因。** ChatGPT 可以显示一次回复使用的 custom instructions、过去聊天、文件和 memories，并解释某项 Memory 为什么被用于个性化；但 OpenAI 明确说 Sources 未必显示影响回复的每个因素。（[Memory FAQ](https://help.openai.com/en/articles/8590148-memory-faq)）

**[推断] “可见摘要”与“完整控制面”必须分开命名。** SayHear 的 Bio 是叙事投影，不是 Claim 清单。页面可以显示更新时间和状态，也可以提供“为什么这样写”或“这不准确”的对话入口；它不应让一个漂亮的 Bio 冒充完整 Memory Inspector。ADR-0008 已经选择 conversational source explanation，本研究没有发现需要新增逐句 citation UI 的外部证据。

**[推断] 手动 refresh 不能承担纠错语义。** 如果用户只是点刷新，系统只能依据当前 eligible Claim set 重写；它不应期待 LLM 猜出哪条底层事实错了。真正的纠错需要先修改或 Forget 对应 Memory，再让 Bio 重建。这比“直接编辑摘要文字”多一步，但保持了 Bio、Recall 和未来派生结果的一致性。

### 3. 可见层和实际个性化层不一致，是应明确拒绝的模式

**[产品文档] Replika 公开承认可见 Memory 之外还有更深层。** 用户能在 Memory tab 查看、添加或删除部分 memories；与此同时，Replika 的帮助页称还有一个从全部对话历史提取模式的 deeper system。页面没有提供查看、来源解释或逐项纠正这个 deeper system 的办法。（[How does Replika's memory work?](https://help.replika.com/hc/en-us/articles/37208679176077-How-does-Replika-s-memory-work)、[What does my Replika remember about me?](https://help.replika.com/hc/en-us/articles/360000874712-What-does-my-Replika-remember-about-me)）

**[推断] SayHear 不应让不可见层继续影响 Profile。** Profile validator 和 support lineage 可以是内部实现，但任何影响 current Bio 的内容都必须来自完整、可审计的 eligible Claim set。若页面只显示投影而隐藏了“还有另一套不可控制的认识”，Correction 和 Forget 的承诺就无法验证。

### 4. 删除传播延迟会直接破坏 Profile 信任边界

**[产品文档] Gemini 文档化了删除与个性化之间的延迟。** 删除包含某项信息的聊天后，Gemini 可能短时间内继续使用它。若信息也来自 connected app，用户必须同时删除聊天并断开该 app；来源数据更新后，个性化结果甚至可能几天后才变化。（[Get personalisation with memory of your past Gemini chats](https://support.google.com/gemini/answer/16598469?hl=en)）

**[产品文档] ChatGPT 也把删除拆成多个来源。** 要完全删除某项认识，用户可能需要处理 past chats、archived chats、files、Memory Summary 和 connected apps；只删除 Summary 并关闭 Memory 不会删除历史聊天，之后重新开启仍可能从旧聊天形成 Memory。（[Memory FAQ](https://help.openai.com/en/articles/8590148-memory-faq)）

**[推断] SayHear 的 trust-boundary rebuild 应故意比这些产品更严格。** Correction、Forget、`contested`、`dormant` 或 Entity 失效后，读取路径应立即拒绝旧 Profile。Workflow 可以稍后完成新 Bio，但不能在这段时间显示含失效内容的旧版本。页面需要诚实显示“正在更新”或“暂时不可用”，而不是用 stale 内容掩盖后台延迟。

### 5. Outbound follow-up 是另一种产品，需要另一套授权

**[产品文档] Replika 把对话外 follow-up 放在 Notifications 设置中。** 用户开启通知后，产品会在一天中发送基于过去对话的消息或 check-in。（[How do I set up my app's notifications?](https://help.replika.com/hc/en-us/articles/360027515872-How-do-I-set-up-my-app-s-notifications)）

**[边界] 这不进入 1A.3b。** 该产品形态需要通知 opt-in、频率、quiet hours、敏感主题和关闭机制。SayHear 的本阶段没有新 User Event 就没有 Assistant Event；本研究不提出 outbound notification 需求。

## 应进入 SPEC 的产品要求

### Proactive Follow-up

- selector 只在当前 Turn 已有新 User Event 后运行，先满足当前表达；直接任务、高风险状态、紧急需要、无合格 target 时不主动提旧事。
- 输出是一个可忽略、可拒绝的自然邀请，不把 Open Loop 写成任务、提醒、进度考核或未完成义务。
- 每段 Continuous Exchange 最多一个 Proactive Follow-up；零次是正常结果，不设 engagement quota。
- 用户短答、回避、拒绝或换题后提交 target-level suppression。时间、模型 confidence 和后台 refresh 不解除 suppression。
- 用户主动要求“以后在 X 情况下可以问我 Y”应作为 grilling 项：决定它是否形成显式 target permission，以及能否在证据仍有效时解除既有 suppression。OpenAI 的产品文档证明用户会需要这种控制，但没有替 SayHear 决定领域语义。
- 每个入选 target 留下非正文 selection trace，能够回答“为什么这次提起它”；正常回复不强制技术式来源声明。

### Profile

- 页面把 Bio 表述为 SayHear 的 current narrative understanding，不使用“全部 Memory”“完整事实”一类承诺。
- 显示 `last_updated_at`、`next_scheduled_refresh_at`、手动刷新可用时间和当前生成状态。状态来自服务端，不用前端倒计时推测。
- 手动 refresh 文案说明“按当前有效 Memory 重新讲述”，不暗示它会修正错误事实；普通限流应返回具体的下一次可用时间。
- 页面提供自然的纠错 / Forget 入口，但写操作进入底层 Memory Action。没有 Bio 正文编辑、多候选抽卡或发布审批。
- 普通 refresh 失败可以保留仍安全的旧 Profile；trust-boundary rebuild 期间旧 Profile 不可读，失败后继续显示 unavailable。
- 内部必须能把 Bio statement 展开到 narrative-support ClaimVersion，再展开到底层 User Evidence。用户询问来源时走 conversational source explanation；Profile 页面不因此变成 Claim Inspector。
- 空 eligible set、信息不足、生成失败、validator 拒绝和 trust-boundary unavailable 要有不同状态，不用同一句“还没有 Profile”掩盖原因。

## Prototype 与验收建议

本研究只能说明行业已经采用哪些控制面，不能证明哪种话术让 Luke 感到自然。按 ADR-0110 / ADR-0114，下面两组仍需由 Internal Owner 做 A / 持平 / B 盲评：

1. Proactive Follow-up 对照：明确而温和地提起一个 target，对照只含模糊暗示或完全不提；覆盖 bare greeting、当前有实质话题、direct task、敏感但有直接 Evidence、用户此前回避、target 已过期。
2. Profile Bio 对照：自然叙事加低调 freshness / correction controls，对照 Claim 列表和可直接编辑正文；单独评估“被理解感、忠实度、是否像被监控”，不能让漂亮文风抵消错误认识状态或 Forget fence 越界。

确定性门禁应独立覆盖：一段交流超过一次主动提起、无新 User Event 产生 Assistant Event、停止 target 再次出现、过期 Open Loop 进入 Context、Profile 使用非 eligible Claim、trust-boundary 后旧 Bio 仍可读，以及 refresh 被误当作 Correction 成功。

## 局限

- 第一方帮助页描述产品意图和控制面，不是实测 conversation transcript。本研究没有登录各产品做黑盒测试。
- Google 和 OpenAI 没有公开 Proactive Follow-up selector、停止状态或敏感 target policy。本研究对措辞和状态机的建议属于基于 SayHear 已接受边界的推断。
- Replika 的帮助页没有发布日期。它能证明当前公开说明，但不能证明 deeper system 的具体实现或删除语义。
- 本研究没有评估 outbound notification 的体验，也没有重复 #91 的通用 Memory UI、来源解释光谱或竞品全量盘点。

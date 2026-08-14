# Session 与 Journal 产品规则

## TL;DR

- Daily Session 按用户本地日期组织，同一天可以继续交流。
- Journal 在交流结束或自动条件满足后生成，是主要回看内容。
- Journal 使用第三人称观察视角，不支持自由编辑或随意重生成。
- 纠错通过新的 Journal Version 完成，并保留事实与推断边界。

## Status

Accepted

## 12. Daily Session 规则

### 12.1 Session 边界

- 每个自然日对应一个 Daily Session；
- 当天可以多次继续同一个 Session；
- 跨天必须创建新的 Session；
- 连续交流开始时确定其用户本地日期归属，过程中保持不变；
- 跨午夜仍在进行中的交流不拆分、不迁移，完整归入开始交流的日期；
- 连续交流只在用户明确表达结束，或达到版本化的无活动时间窗口后结束；
- AI 的自然收尾或主观判断不能单独改变 Session 状态；
- Journal 生成等待 Continuous Exchange End；
- 交流结束后，在新本地日期发起的下一次交流创建新的 Daily Session；
- 新一天打开 App 时，不延续上一天的对话 UI。

### 12.2 Conversation 与 Journal 的关系

- Conversation 是原始素材；
- Journal 是主要消费内容；
- Conversation 长期保存；
- 用户可以从 Journal 进入当天 Conversation；
- Conversation 不出现在产品首页的主时间线；
- 产品不会鼓励用户反复浏览聊天记录。

### 12.3 Journal 生成时机

Internal Core 与 External MVP 支持两种自动生成条件：

1. 用户在交流中明确表达结束意图后立即评估，满足 Journal Eligibility 时生成；
2. 当日结束后，如果 Session 有足够表达但未明确结束，由系统后台评估并生成。

跨午夜仍在进行的连续交流不因日期切换触发 Journal；系统等待交流自然结束后，
再按该 Session 已固定的 `logical_date` 评估和生成。

“交流结束”只由用户明确结束意图或版本化的无活动时间窗口决定。具体超时时长
可以在 1A.1 固定回放样例、1A.4 Replay 和真实内部使用中调整，不作为永久产品常量；
AI 自然收尾只影响对话表达，不直接推进领域状态。

用户不需要点击“生成”或在发布前审核批准。Journal Eligibility 的门槛应当很低，
只判断用户表达能否支撑至少一条真实记录，不能判断某件事是否重要、深刻或
“值得写进日记”；日常琐事和事务性内容都可能成立，仅有 “Hi” 一类问候则可以
不成立。

当天完全没有 Conversation 时，系统静默跳过，不创建空 Journal 或缺席提示。
当天发生过 Conversation 但未达到 Journal Eligibility 时，下一天在 Journal
界面显示 No Journal Notice，说明“交流内容较少，昨天无日记”。该提示是日期状态，
不是 Journal，也不进入 Journal 导出或长期记忆。

同日后续表达使已发布 Journal 过期时，系统自动生成新的 Journal Version 取代旧版本。

---

## 13. Journal 产品定义

### 13.1 叙述视角

Journal 使用第三人称，由 AI 以观察者视角书写。

不是：

> “我今天去了公司，感觉很累。”

而是：

> “Luke 今天回到公司后很快进入了工作状态，但真正消耗他的并不是任务本身，而是几件事情始终没有明确的答案。”

### 13.2 写作目标

Journal 应该记录：

- 当天发生的重要事件；
- 用户真正关心的细节；
- 用户当时的情绪；
- 事件对用户意味着什么；
- 与过去记忆的合理联系；
- 有充分对话依据、但用户没有直接说出的 Journal Observation。

Journal Observation 是 AI 的主观理解，不是用户已确认的事实。正文应使用
“似乎”“听起来更像是”“也许真正让他在意的是”等自然语言表达不确定性，
而不是显示技术标签或把推断写成确定结论。

### 13.3 写作边界

Journal 不应该：

- 诊断用户；
- 过度心理分析；
- 把每件事情都写成成长；
- 编造用户没有表达的信息；
- 写入缺少充分对话依据的主观推断；
- 使用夸张文学修辞掩盖事实；
- 将 AI 的推断写成确定事实；
- 对用户进行评价或说教。

### 13.4 用户控制

Internal Core 与 External MVP：

- 不支持直接编辑；
- 不支持为了改变风格而随意重新生成；
- 支持用户因表达质量不满意而发起受版本化 policy 限制的重生成；
- 用户指出事实错误或被写成事实的不当推断后，纠正来源并生成取代旧版本的新 Journal；
- Journal 自动交付，不要求用户手动触发或发布前批准；
- 支持复制；
- 支持导出。

产品逻辑是：

> Journal 是 AI 对用户一天的观察，不是用户亲自撰写的文本。

Journal Correction 不把 Journal 变成用户亲自编辑的文本；它通过新的 Journal Version
保留 AI 观察视角，同时让错误版本不再作为当前正式记录。

Journal Regeneration 不表示原理解错误。用户可以针对某一天 current Journal 请求
重新生成表达，并附带受限的自然语言 `Regeneration Guidance`，例如指出希望突出某个
情绪变化、减少流水账或改善组织方式；系统仍使用当前有效 Conversation / Evidence、
第三人称观察视角和同一事实 / 推断边界。新 JournalVersion 只有通过既有 validator
后才替换 current；产品不提供事实改写、任意正文、第一人称、指定最终文本、多候选批准
或连续抽卡。用户仅表示“不满意”而无法判断是理解错误还是表达质量问题时，SayHear
自然澄清一次；明确的事实纠正进入 Journal Correction 语义，不作为 regeneration
guidance 执行。

---

## References

- [原始 产品文档 v0.1 快照](../archive/product/AI_Life_Journal_Product_Document_v0.1.md)
- [术语表](../../CONTEXT.md)
- [Journal 与 Memory 工作流](../architecture/11-12-journal-memory-workflows.md)

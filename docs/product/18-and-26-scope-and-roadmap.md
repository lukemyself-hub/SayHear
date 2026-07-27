# 产品范围与路线

## TL;DR

- Phase 1 是单 Internal Owner Account 的 Internal Core，先验证 Agent Core。
- Phase 2 是首次面向真实外部用户的 Web-only External MVP。
- Internal Core 依次交付 Text、Journal、Entity/Memory、Replay，再进入 Realtime Voice。
- 正式 iOS 在 Web 初步验证核心产品价值后再引入。

## Status

Accepted

## 18. 阶段范围

### 18.1 Phase 1：Internal Core

Internal Core 仅供内部自用，由 Core Flow 1A 和 1B 构成。Phase 1 默认只允许
一个 Internal Owner Account 写入真实私人内容；其他评估账号或数据如未另行
明确授权，只能使用合成或匿名化内容。

必须覆盖：

- 内部 Web 实验工具；
- Text 多轮对话；
- 正式 Realtime Voice 基线；
- Daily Session；
- 第三人称 Journal；
- Evidence、Entity 与 Episode；
- Reflection 与长期 Memory；
- Web 开发者工具中的只读 Reflection Inspector，不建设独立的用户式 Reflection 页面；
- 后续对话中的 Memory Recall；
- 内部 Replay、诊断和评估；
- Web 开发者工具中的 Predicate Candidate review、Registry Change Proposal 与
  terminal Candidate 7 天内容清理；
- Core Flow 1A.1 起成立的 Minimum High-Risk Response 与回放测试；
- 1A.1 中只有完整成功的 Assistant Response 进入后续 Context；流式中断时
  明确显示失败并允许重试；
- 内部数据的隐私、删除与审计基础。

Internal Core 不建设临时 Push-to-Talk 产品路径。先用 Text 完成 Journal、Entity、
Episode、Reflection、长期 Memory、未来召回和 Replay，再直接进入 Realtime Voice；
Realtime 不可用时保留 Text 作为明确降级路径。

Internal Core 不等于 External MVP，也不验证外部需求、留存、付费或消费者 UI。
它不包含消费者注册、邀请、账号恢复、多用户生命周期、后台用户管理、订阅、
消费者 Onboarding、正式 iOS 客户端或公开发布。所有私有领域数据仍必须带稳定
`user_id`，避免 Phase 2 通过危险的数据迁移补做用户隔离。

### 18.2 Phase 2：External MVP 当前基线

- 账号系统；
- 正式多用户身份、数据隔离和账号生命周期；
- Web 消费者产品；
- Onboarding；
- AI 名字设置；
- 3 个左右的人格选项；
- 多个 Voice 选项；
- 实时双向 Voice Live；
- 文字聊天；
- 每日独立 Session；
- 当天 Session 多次续聊；
- 第三人称 Journal；
- Journal 时间线；
- Conversation 弱化回看入口；
- Journal 复制和导出；
- Journal Correction；
- 客观事实记忆；
- AI Impression；
- 对话内 Memory Correction 与 Memory Forget Request；
- 用户可查看 Profile；
- 订阅付费；
- 限时体验；
- 账号注销和数据删除；
- 低调、异步的 Account Data Export；
- 基础安全机制和内容风险处理。

### 18.3 External MVP 当前不包含

- Calendar；
- Photos；
- Location；
- Health；
- Music；
- Screen Time；
- 第三方生活数据；
- Journal 自由编辑；
- 为改变风格而随意重新生成 Journal；
- 完整 Profile 编辑界面；
- Profile 单条删除；
- 行为建议；
- 目标和计划；
- Coach 模式；
- Streak；
- 社交功能；
- 虚拟角色形象；
- 虚拟世界；
- AI 恋爱关系；
- Day One 自动同步；
- 正式 iOS 客户端。

---

## 26. 阶段路线

### Phase 0：Mandy Lab

目标：

- 验证 Prompt；
- 验证人格边界；
- 验证 Reflection 与 Profile Consolidation；
- 验证第三人称 Journal；
- 建立真实日常使用样本。

### Phase 1：Internal Core

定位：

> 仅供内部自用的 Agent Core 与运行架构阶段，由 Core Flow 1A 和 1B 构成。

范围：

- 内部 Web 实验工具；
- 一个可写入真实私人内容的 Internal Owner Account；
- Text 与 Realtime Voice；
- Daily Session、Journal、Reflection、Memory 与 Future Recall；
- 只读 Reflection Inspector；Conversation、Journal 与 Profile 保持为体验面；
- Evidence、Entity、Episode 与版本血缘；
- Replay、Candidate review、Registry Change Proposal、terminal Candidate 内容
  清理、内部诊断、隐私和删除基础；
- Core Flow 1A.1 起成立的 Minimum High-Risk Response。

核心验证：

- 内部跨日闭环是否稳定、可重复；
- Agent 是否达到第一版中英文行为与质量基线；
- Journal、Memory、删除和召回是否满足领域不变量；
- Text 与 Realtime 是否复用同一 Agent Core。

Internal Core 不验证外部用户需求、留存、付费意愿或消费者 UI。
消费者注册、邀请、账号恢复、多用户生命周期和后台用户管理不在本阶段建设。

### Phase 2：External MVP

定位：

> 第一次面向真实外部用户验证产品价值与商业假设的最小产品。

范围与门槛：

- Web 消费者产品是确定范围；
- External MVP 首发仅提供 Web，正式 iOS 待 Web 初步验证核心产品价值后再引入；
- 消费者账号、Onboarding、订阅与限时体验；
- 正式多用户身份、数据隔离和账号生命周期；
- Voice Live、Text、Daily Session、Journal、Memory 与 Profile；
- Journal Correction；
- 对话内 Memory Correction 与 Memory Forget Request；
- Account Deletion；
- 低调、异步的 Account Data Export；
- 正式数据透明、安全与高风险内容处理，包括地区化危机资源、处置流程和安全运营。

核心验证：

- 用户是否愿意持续讲；
- 是否真的感到被理解；
- Journal 是否形成长期价值；
- Memory 是否准确、自然且不制造被监控感；
- 用户是否愿意支付接近 US$9.99/月。

### Phase 3：Life Context

逐步引入：

- Calendar；
- Photos；
- Location；
- Activity；
- Weather；
- 其他用户授权的数据源。

目的不是自动记录更多数据，而是：

> 用更少的表达，更完整地理解用户的一天。

### Phase 4：Life Narrative

提供：

- Weekly Reflection；
- Monthly Letter；
- Year in Review；
- 人生阶段；
- 关系变化；
- 主题时间线；
- 过去的今天；
- 长期自我叙事。

仍然保持：

- 不做 Coach；
- 不做任务系统；
- 不用成长焦虑驱动用户。

## References

- [原始 产品文档 v0.1 快照](../archive/product/AI_Life_Journal_Product_Document_v0.1.md)
- [架构测试与交付顺序](../architecture/24-29-testing-and-delivery.md)
- [Onboarding 与平台产品规则](16-17-onboarding-and-platform.md)

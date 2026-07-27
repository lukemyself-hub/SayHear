# Onboarding 与平台产品规则

## TL;DR

- Onboarding 只建立核心心智模型、隐私预期和首次表达入口。
- External MVP 首发仅提供 Web。
- 正式 iOS 在 Web 初步验证核心产品价值后再引入。
- 跨端时 Conversation、Journal、Memory 与 Profile 使用同一账号和云端真源。

## Status

Proposed

平台范围以 [ADR-0062](../adr/0062-external-mvp-launches-on-web-before-ios.md)
的 Accepted 决策为准。本文件保留 Proposed 状态，是因为 Onboarding 流程与未来
引入 iOS 后的跨端细节仍需后续确认。

## 16. Onboarding

### 16.1 目标

Onboarding 的目的不是收集大量用户资料，而是让用户在第一次打开时快速获得：

- 一个适合自己的 AI；
- 对产品边界的正确理解；
- 第一次被理解的体验；
- 对隐私和数据使用方式的信任。

### 16.2 推荐流程

1. 介绍产品承诺  
   “这里不是让你完成任务的地方。你可以只是把今天说出来。”

2. 选择 AI 人格

3. 选择 AI 声音

4. 给 AI 改名或保留默认名

5. 简短说明  
   - AI 会记住用户；
   - 对话会用于生成 Journal；
   - 数据会云端同步；
   - 用户可以注销账号并删除数据；
   - AI 不是人类，也不是心理治疗师。

6. 首次 Voice Live 体验

7. 展示第一篇简短 Journal

8. 开启限时完整体验

---

## 17. 平台策略

### 17.1 Web

Web 是 External MVP 的确定平台，其作用：

- 降低首次体验门槛；
- 便于传播和分享；
- 快速验证 Voice Live 和对话体验；
- 支持桌面端较长交流；
- 便于早期迭代。

### 17.2 iOS

iOS 是长期产品平台，其作用：

- 承载日常高频使用；
- 提供通知；
- 提供移动场景 Voice Live；
- 支持未来系统权限接入；
- 成为长期使用的主要平台。

正式 iOS 不进入 Phase 2 External MVP。External MVP 先通过 Web 验证用户是否愿意
持续表达、是否感到被理解，以及 Journal 与 Memory 是否形成长期价值，再引入正式
iOS。这个范围选择不代表 iOS 的长期优先级降低；Web 验证也不能替代对移动日常使用、
通知召回和移动 Voice Live 的后续验证。

### 17.3 引入 iOS 后的跨端原则

- 同一账号；
- Conversation、Journal 和 Profile 云端同步；
- Web 和 iOS 使用一致的人格与记忆；
- 用户在不同设备上继续当天 Session；
- 保持相同的 Daily Session 规则。

## References

- [原始 产品文档 v0.1 快照](../archive/product/AI_Life_Journal_Product_Document_v0.1.md)
- [产品范围与路线](18-and-26-scope-and-roadmap.md)

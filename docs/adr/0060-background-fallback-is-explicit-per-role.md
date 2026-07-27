---
status: accepted
date: 2026-07-26
---

# Background Fallback Is Explicit per Role

1A.4 的后台生成 fallback 不从 Capability Registry 全局继承。人工发布的 Model
Routing Policy 必须按 role 显式设置 `fallback_mode=disabled / single_attempt`；
只有具备冻结输入、版本化输出和 role-specific validator 的生成任务才可以单独开放。

允许 fallback 的 Journal、Reflection、Entity、Episode、Memory、Profile 等任务在
Champion 的同配置技术重试失败后，最多串行创建一个 `role_fallback`
ModelRunAttempt。它必须复用相同 source revision、Prompt、Schema、业务 policy 与
validator contract；多个 attempt 的输出不能合并、投票或自动拼接，只有通过
validator、freshness / deletion fence 与 authoritative-result CAS 的一个结果可以
提交。Fallback 只影响当前 GenerationCommand，不 pin 后续任务。

`embedding`、`stt`、`tts`、`safety` 等兼容性敏感 role 默认禁用 fallback。向量空间、
声音、delivery 或安全语义必须经过独立验证，并由人工发布新的 Model Routing Policy
version 后才能开放。这样保留后台任务的单次容灾能力，同时避免一个通用 capability
标签把并不等价的模型或 Provider 当作可互换实现。

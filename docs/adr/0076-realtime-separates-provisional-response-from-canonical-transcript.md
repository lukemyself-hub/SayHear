---
status: accepted
date: 2026-07-26
---

# Realtime Separates Provisional Response from Canonical Transcript

Realtime Voice 为降低延迟，可以根据 Provider 的 provisional transcript 开始回应；
同一份输入音频必须并行进入独立 canonical STT，形成 final / corrected User Event
Revision。ModelRunAttempt 记录模型实际看到的 provisional revision，不能事后改写。

provisional transcript 只服务当前低延迟交互，不进入 Evidence、Entity、Journal、
Reflection、Memory、Episode 或 Embedding。长期派生只消费 canonical final /
corrected revision；两者实质分歧时保留 divergence 状态，并在后续 Context 中按真实
版本处理。

---
status: accepted
date: 2026-07-26
---

# One Turn Detector Owns Each Voice Session

每个 Voice Session 必须固定一个 `turn_detection_owner`。OpenAI Realtime baseline
由 Provider 拥有 turn detection，LiveKit 只传输并映射 Provider 的 speech-start /
speech-end；cascade 或需要自定义长停顿策略时可以改由 LiveKit 拥有，并关闭 Provider
自动 VAD / auto-response。

同一个 Session 不能让两个 detector 都有权 commit input 或创建 response，否则会
产生重复 VoiceTurn、抢答和不可解释的轮次边界。Provider 是否能分离 detection 与
response 必须记录为 capability，并进入延迟与对话质量评估。

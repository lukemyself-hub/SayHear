# 隐私与数据承诺

## TL;DR

- 对话、Journal 和 Memory 都是高敏感私人数据。
- External MVP 不轻率承诺严格 E2EE，必须准确说明服务端和 Provider 的明文处理边界。
- Account Deletion、Account Data Export 和清晰的数据透明说明是外部发布门槛。
- 本文件定义产品承诺；技术执行约束在隐私与生命周期架构文档中。

## Status

Accepted

## 19. 隐私与数据原则

### 19.1 已确定原则

- 不坚持 Local-first；
- 支持云端同步；
- 接受第三方 LLM API；
- 用户可导出 Journal；
- External MVP 面向真实用户前提供低调、异步的 Account Data Export，
  包含 Conversation、Journal、Profile 与 Memory；
- External MVP 面向真实用户前提供账号注销；
- 注销后删除所有内容；
- Account Deletion 由独立设置入口和专用确认流程触发，不允许自然语言 Agent
  直接执行；
- 产品目标是实现端到端加密。

### 19.2 关键技术结论

“普通云端第三方 LLM 处理”与“严格意义上的端到端加密”存在天然冲突。

如果服务器或第三方模型需要读取用户对话明文来生成回应，那么在推理发生的时刻，数据就不能始终保持只有用户端可解密。

因此 External MVP 需要明确区分：

### External MVP 必须实现

- 传输加密；
- 数据库静态加密；
- 敏感字段分离；
- 访问权限隔离；
- 最小化日志；
- 第三方模型不用于训练；
- 缩短第三方数据保留时间；
- 原始语音尽快删除；
- rejected / stale Memory Candidate 的 AI 派生语义在活跃系统中只保留 7 天，
  到期后仅保留不能用于 Recall 或还原提案的最小审计外壳；
- Journal 与 Conversation 分开存储；
- 账号注销后执行可验证删除流程。

### 严格 E2EE 的长期路线

需要至少采用一种：

- 端侧模型；
- 客户端解密后直接调用受信任模型；
- Confidential Computing；
- Trusted Execution Environment；
- 用户持有密钥的加密架构；
- 支持私有模型部署。

因此，External MVP 对外不应轻率承诺“完全端到端加密”，除非技术方案能够证明服务端和第三方模型在任何时候都无法读取明文。

更准确的 External MVP 承诺应是：

> 用户内容在传输和存储过程中受到加密保护，不用于模型训练，并按照最小化原则处理。

### 19.3 数据透明

产品需要在设置页明确说明：

- 保存哪些数据；
- 哪些数据发送给模型；
- 保存多久；
- 用户注销后如何删除；
- 原始语音是否保存；
- Journal、Conversation 和 Profile 的关系；
- AI 记忆如何形成。

---

## References

- [原始 产品文档 v0.1 快照](../archive/product/AI_Life_Journal_Product_Document_v0.1.md)
- [隐私、安全与生命周期架构](../architecture/18-20-privacy-security-lifecycle.md)
- [相关决策](../decisions.md)

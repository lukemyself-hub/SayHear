---
status: accepted
date: 2026-07-26
---

# Internal Web Uses Auth.js, GitHub OAuth, and Database Sessions

Internal Core Web 使用 Auth.js、GitHub OAuth 与 PostgreSQL database session 认证唯一
Internal Owner Account。浏览器只持有 HttpOnly、Secure、SameSite cookie；BFF 校验
session 后从服务端 identity mapping 得出 `user_id`，不接受客户端提交 owner ID。

这是 Foundation 的可实施、可撤销内部身份边界，不是 External MVP 的永久消费者登录
决定。其他人类身份拒绝登录；Replay、Voice Worker 等服务身份使用独立的窄权限凭据，
敏感诊断操作仍需 capability check、step-up reauthentication 与 access audit。

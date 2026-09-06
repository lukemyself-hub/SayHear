---
status: accepted
date: 2026-07-26
---

# Bio Refresh Is Manual, Weekly, and Trust-Reactive

普通 Bio 不随每条 Memory 或每天的变化自动重写。用户可以从前端手动发起刷新，
前后端共同显示并由服务端强制执行版本化最短间隔；系统另以每周 Cron / scheduler
默认自动重写一次，前端显示预计下次更新时间。默认手动间隔是新 current Bio 成功
发布后的 24 小时；技术失败不推进冷却时间。默认自动刷新时间是每周一用户当地时间
04:00，版本化 schedule policy 在 DST 跳时、重复时段、漏扫与重试下保证每个本地周
最多成功推进一次。Bio 独立读取届时最新 eligible Claim set，不由 Weekly
Reflection 触发，也不等待 Reflection 成功。

Correction、Forget、Claim 进入 `contested` / `dormant`、Entity 失效或内容删除不是
普通刷新。相关 current BioVersion 必须在读取路径立即停止展示，并自动触发
绕过普通间隔和 weekly schedule 的安全重建；失败时 Bio 保持正在更新或不可用，
不能回退展示含有失效内容的旧 BioVersion。

这个双速策略避免 Bio 因日内细小变化频繁改写，同时不让低频产品节奏延迟用户控制
或信任边界。普通生成失败可以保留仍安全的旧 Bio；信任边界失效后的旧 Bio
不再是可用 fallback。

---
status: accepted
date: 2026-10-07
amends: [0134, 0135, 0136, 0138, 0140, 0141, 0143, 0144]
---

# Deployment identity, runtime configuration authorization, and historical capability acceptance are separate

SPEC #275 要求解除部署 commit 与整套 G1 首次验收的绑定。本 ADR 明确修订
[ADR-0134](../adr/0134-1a3b-rollout-is-staged-and-correctness-triggered.md)、
[ADR-0135](../adr/0135-1a3b-acceptance-does-not-grandfather-hard-failures.md)、
[ADR-0136](../adr/0136-1a3b-model-pins-are-evidence-outputs.md)、
[ADR-0138](../adr/0138-1a3b-formal-acceptance-uses-synthetic-data.md)、
[ADR-0140](../adr/0140-g1-deepseek-model-alias-is-pinned-evidence.md)、
[ADR-0141](../adr/0141-g1-only-release-after-g2-retirement.md)、
[ADR-0143](../adr/0143-g1-ships-without-semantic-reflection-validation.md)、
[ADR-0144](../adr/0144-g1-hosted-acceptance-isolated-from-production.md) 中下列条款：
exact-commit 激活、"每个准确 manifest 必须重跑整套证据"、以及"pin 绑定完整
manifest fingerprint 且不得改指"。其余条款继续有效。

## 决定

1. **三种身份各司其职，不再互相等值。**

   - **部署身份（deployment identity）**：实际部署的 commit SHA，继续由
     `VERCEL_GIT_COMMIT_SHA` / `SAYHEAR_DEPLOYED_GIT_COMMIT_SHA`、
     release-identity 端点与 promotion 记录如实记录。它不再是未变能力授权的
     等式条件，也不得被伪造或把旧结果改标成新 commit 实测。
   - **运行配置授权（runtime configuration authorization）**：允许 G1 写入的
     唯一运行时条件，是数据库 active rollout pins 所连接的、不可变的角色配置、
     Provider Egress policy、role policy、freshness、fallback、retry 与
     parameter snapshot，加上完整 G1 四角色集合与 schema contract。配置身份的
     内容寻址落在 `model_role_configurations` 与 `model_role_rollout_pins` 的
     `(role, config_version, provider_policy_version)` 上，不落在部署或报告
     fingerprint 上。
   - **历史能力验收（historical capability acceptance）**：v1 manifest、
     `releaseIdentityFingerprint`、F3/Provider/hosted/Purge 证据及其 commit、
     hash、时间戳保持不变，只作为该能力被接受时的记录，不再作为日常部署的
     启动前置。

2. **同配置的新 commit 继续构建、启动并授权运行 G1。** UI commit 或普通服务端
   commit 只要没有改变第 1 条的运行配置授权，就可复用已接受的 active manifest 与
   active pins，无需重新生成 F3/Provider/hosted/Purge 证据，也不得因部署 SHA 或
   promotion/report fingerprint 变化而重绑未变角色。运行轨迹不得启动完整
   producer（`release:g1:produce`）。

3. **真实配置变化仍诚实版本化。** Prompt、参数、输出预算、typed Schema、
   Provider、Provider Egress policy 或 role policy 的任何变化都产生新的不可变
   配置版本与相应授权，只影响真正变化的角色；未变角色保留原配置与 pins。完整
   G1 四角色集合、缺失角色、未知或不匹配的 Provider / Schema / policy、非法
   开关、已退场角色与静默 fallback 仍然拒绝。

4. **旧 v1 manifest / pins 兼容，切换与回退明确。** 已存在的 v1 active pins
   继续被接受：其 `release_fingerprint` 是历史验收绑定，不再要求等于当前部署的
   manifest fingerprint；pin 仍必须带有非空验收绑定，且其连接的不可变配置必须与
   运行时配置逐字段一致。不需要重写旧 pins、配置或证据。回退仍先撤销 active
   pins、停止新 admission，使旧在途结果不能成为 current；typed rows 作为历史保留。
   本机制不引入"暂时全部放行"的过渡态，也不提供任意环境变量的 blanket bypass。

5. **专项验收触发范围收窄，不取消。** Full Purge / restore drill 仍在 Purge
   Surface Registry、Schema、clear/verify handler 或外部 integration 变化时要求
   完整重跑；新能力启用、重大整体合同变化或 External MVP 发布才要求整体能力验收。
   历史已接受证据保留原 commit 与内容身份，不因新部署而失效或被改写。

## 保留的拦截能力

- G1 四角色完整集合与 active pin 唯一性；
- Provider / Schema / policy / freshness / fallback / retry / parameter 的逐字段
  运行时比对；
- schema contract、owner 身份、capability、Recovery Gate、Data Epoch、
  source/freshness、幂等、lease、current-pointer CAS 与 Provider Egress；
- 配置撤销与回滚围栏，旧在途结果不得取得新授权或复活数据；
- AC-D01 发布身份指纹作为**历史验收**记录继续保留，但其值不再要求等于每次部署
  的 manifest fingerprint。

## 复评条件

若日常发布中出现运行配置授权被绕过、旧 pins 被错误改指、或真实 Provider / Schema /
policy 变化未诚实版本化，则停止该机制并回到逐次完整验收，直到根因修复。

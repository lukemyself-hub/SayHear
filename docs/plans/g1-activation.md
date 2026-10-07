# G1 activation execution record

Status: implementation in progress. Production G1 remains off until verified evidence and matching active pins exist.

## Approved scope

Implement ADR-0143 completion-only Reflection acceptance, preserve deterministic/privacy gates, prove hosted behavior in an isolated Vercel project with separate business and Purge Marker databases, then activate and deploy the exact release to production. Bio and retired G2 remain disabled. No Full Purge in production.

## Preserved inputs

The original 15 run artifacts and per-file hashes were archived at `/private/tmp/sayhear-g1-preserved-20261001T033106Z`. Do not remove or overwrite the human-adjudicated holdout ledger.

## Execution order

1. Repair explicit run/catalog/pins/deployment bindings and automated validator completion evidence. Add regression coverage.
2. Deploy the frozen code to the independent `sayhear-g1-acceptance` project with freshly created acceptance databases and normal Owner authentication. Export correlated, decrypted Workflow data and genuine receipts/logs/traces/errors. Never fabricate non-empty sources.
3. Freeze code; produce exact-commit Provider/F3/system/purge/restore evidence. G1-off hosted bootstrap precedes manifest creation, followed by G1-on isolated validation and rollback.
4. Bind production pins before the G1-on build. Verify Ready deployment, aliases, identity, scheduler, and Inspector, then verify the next eligible derived artifacts.
5. Record factual promotion evidence and update #250/#252 only after the corresponding acceptance has passed.

## Current verified progress

- Independent Vercel project `sayhear-g1-acceptance` (`prj_nNj1vzuYjj7oeiwzqfsV3iMb3THs`) uses Next.js and `apps/web`. Preview OAuth secret was configured by Luke; other core Preview variables have been uploaded separately.
- Fresh acceptance databases named `sayhear_g1_acceptance_20261001_01a0f564` were created on distinct nonproduction business and Purge Marker endpoints after checking isolation from production. Business and marker migrations, normal GitHub Owner mapping and Self Entity provisioning are complete.
- The canary alias now points to independent G1-off deployment `dpl_CMdz2r75BdweQuoDmogCpfCpVVPA`, Ready with commit `9db7a9c6dfe6793f173fee4bbdb67eb9de9eaf09`; normal Owner OAuth works. Production alias remains unchanged.
- Authenticated Neon console verified both independent test projects: six-hour PITR, no snapshots or schedules, endpoints match the prepared configuration. Official Neon recovery API documents seven-day deleted-project recovery. A fresh evidence row was recorded via the existing CLI with a hashed reference; browser gate now reports Open / backup_evidence_current. Evidence: `/private/tmp/sayhear-g1-acceptance-backup-evidence.json`.
- Production still has four v2 active pins and both G1 switches off; no production mutation has been performed.
- Typecheck, local build, boundary and Purge inventory checks passed. Full suite against two disposable local PostgreSQL databases passed: 108 files, 1348 tests, zero failures or skips (`/private/tmp/sayhear-g1-local-final-tooling-tests.json`). Remote Neon suite timed out in migration hooks; its failed report is preserved separately.
- New completion evidence uses `1a3b-f3-completion:v1`, `capture-verifier`, hashed raw capture and real command/attempt IDs. It is distinct from Luke's preserved ledger. Precision capture now uses Reflection with direct Evidence, keeping Bio outside G1.
- Four-role preflight first exposed capture-tool UUIDv4/method/scope defects. These are fixed, and `tsconfig.g1-tools.json` now covers the release CLIs in the normal typecheck command.
- Real Provider failures at the original 4000-token Episode/Daily/Weekly budgets were all `max_output_tokens`, with zero visible output and 4000 reasoning tokens. Original captures remain under `run/g1-activation-preflight*`.
- Candidate `g1-activation-pins.json` increases only those three output budgets to 10000, leaving Validator at 10000. The budget preflight completed Episode (4978 output / 4586 reasoning); Daily exhausted 10000; Weekly returned a schema mismatch. It is a dirty preflight, not release acceptance.
- Reflection's existing prompt omitted mandatory Candidate envelope fields and the nested temporal object. The instruction now states the existing schema explicitly; candidate Daily/Weekly prompt versions are v4. After completing the existing Episode schema instructions as well, all four real Provider calls completed in `run/g1-schema-preflight-2`. These dirty preflights are preserved and must be rerun on the frozen commit; no Reflection semantic validator rule was changed.
- Hosted exporter drains all Workflow pages with decrypted full data, retains every raw field and verifies execution correlation. Six-category probe planting and native diagnostic collection are still required before hosted acceptance can pass.

## Independent review follow-up

OpenCode code-review session `ses_f0a30a134ffeGsG450euH09Tg1` found six release-tool defects: real CLI pagination envelope loss; missing validator capture code identity; resume pin relabeling; encrypted/expired placeholders accepted; correlation checks absent from consumers; independent project and deployed target identity not enforced. Raw review: `/private/tmp/sayhear-g1-review-9db7a9c/result.txt`. These must be resolved before further freeze/activation. The bounded implementation ran in the independent local clone; Codex integrated and verified its scoped changes. Its wrapper ended with identity-validation failure on a compaction agent message, so it is not counted as successful delivery. The follow-up read-only review was interrupted by a local service restart and has been explicitly resumed.

The holdout manifest core already accepts both catalog versions, but the outer builder incorrectly returned exit 1 for holdout. That redundant check has been removed; direct holdout build exits 0 and all 22 manifest tests pass. This change requires a new frozen commit.

All four Provider calls completed on frozen 9db7a9c with `gitDirty=false` and `preflight=false`; capture hash `d4e5902344262b8d0430d1fd57a3e2353eee50bae703f91b87690e1ca70316b9`. This capture must be archived and replaced after follow-up code fixes, not relabeled as the next commit's evidence. A real synthetic Owner message entered the isolated deployment, and the normal inactivity window plus Recovery Scan produced a published Journal and current version. A normal Owner regenerate-Journal request was accepted; its terminal result still needs verification. Only bootstrap evidence exists; the six-category hosted canary, final manifest and production activation remain incomplete.

## Follow-up verification (2026-10-01)

- Corrected completion-only precision acceptance under ADR-0143; false-block counts remain recorded observations, while exact fixture coverage, schema validity and frozen capture identity remain gates.
- Validator capture and resume now bind clean HEAD, catalog, pins and parameters. Hosted consumers share pagination, decryption, correlation and deployment checks; a content-free Owner identity endpoint binds actual deployed database targets.
- Full regression passed 1369/1369 tests, zero failures/skips against two distinct local test databases with maxWorkers=2. Typecheck and production build passed. Boundary check found16 Workflow entries; purge inventory124tables/130indexes. Reports are under /private/tmp/sayhear-g1-review-fix-*.
- Live locked Workflow SDK export read two actual completed runs from dpl_CMdz2r75BdweQuoDmogCpfCpVVPA, each with1step/6events. This exposed CLI project-name inference overriding an explicit project ID, and the platform rejecting1000-record pages. Exporter now seeds explicit project-name identity and uses100-record pages. Full raw decrypted bootstrap resources are retained, not promoted as complete canary proof.
- Journal eligibility command01a0f5fc-0621-7989-a984-4b01636f3f13, runwrun_01M3TZR31S4CJT96CNFD091F90 published Journal01a0f5fc-75a5-7425-a123-0399dce9fa82/current01a0f5fc-75a5-7f09-b9a5-213ff7a716ce. Database command status remainscreated despite dispatched outbox; evaluate this separately from actual publication.
- All follow-up changes require another freeze and new affected release evidence;9db7a9c captures cannot prove the next commit.

- Formal Provider capture must run in a clean frozen clone. Add only its generated run directory to that clone's .git/info/exclude before capture; do not exempt source changes. This preserves the strict dirty check while allowing sequential captures to resume.
- Follow-up review completed via the explicit original OpenCode session. Remaining findings led to required expected run IDs/deployment bindings, unconditional frozen precision identity, null-expiry compatibility, and live deployment identity retrieval. The identity generator now reads the deployed content-free endpoint with the existing Cron operator credential, never trusts an authored JSON identity file. Owner authentication remains unchanged for private inspection.

- Post-review regression:110files/1371tests passed, no failures or skips. A sandbox-denied attempt is preserved separately; the verified rerun had access only to the two local disposable databases. Normal Journal Action regeneration ended canceled/fenced with genuine pending/running/canceled receipts; this is not successful regeneration evidence.

- Final verifier now re-scans the hash-bound raw hosted export and values, enforces deployment/run-set pins, and rejects a passing summary with leaked or missing source data. Focused raw-consumer tests pass.
- OpenCode investigation confirms the existing adapter deliberately cancels Provider error bodies; no DB routing lever produces a stable raw-error marker in the same deployment without breaking fixed G1 configurations. A scoped Preview-only, normal Owner-authenticated genuine Provider failure tool has been proposed to Luke; that scope decision is pending. No raw error or sixth probe has been invented.
- Owner Context Inspector for generation01a0f5dd-7dd8-7a68-8c70-379b7a8e34a2 shows succeeded command/attempt, DeepSeek v4 flash, retrievalCompleted169/200ms with zero candidates/degradations. Synthetic screenshots retained under /private/tmp/sayhear-g1-hosted-*.jpg.

- Final raw-consumer regression passed110files/1372tests, zero failures/skips. Latest verifier CLI replay test passes15cases, including explicit deployment/run-set command success and wrong-run failure. Credential header cleanup removes only the just-created temporary curl config, retaining response captures and old evidence.
- OpenCode code-review configuration changed during this task: attempt004 reports actual modelopencode-go/muse-spark-1.3-contributor, not the user-described GPT-6.1 Sol. Its findings are retained as reference and checked by Codex, but are not counted as the requested GPT-6.1 review. No service/config/model edits were made by Codex.

## 最新执行决定

Luke 于2026-10-01明确要求跳过原始 Provider 错误探针并完成生产部署/G1开启。执行 ADR-0145 的单项豁免，不新增故障探针入口，不把该项标为通过。其余身份、确定性、隐私扫描及回滚条件继续核验。当前代码仍需冻结；新 commit 的 Provider/Validator、hosted 和功能证据尚未完成。

单项豁免实现后完整回归110files/1384tests通过，零失败/跳过。完整typecheck、build、16项Workflow边界与124表/130索引purge inventory通过。正常Journal步骤增加仅含command/action IDs和固定outcome的诊断记录，供真实平台日志关联。OpenCode实现session超时且已确认终止，Codex检查了改动并独立完成上述验证。报告保留在/private/tmp/sayhear-g1-waiver-*及sayhear-g1-review-fix-tests.json。

## 接续与真实功能故障

- 临时目录在接续时已丢失。同一7e68331768c83e29be1a443b98c690664682b94a版本在项目忽略的.codex/g1-restoration/frozen-7e68331重建了独立checkout和锁定依赖，重新生成证据并归档到run/g1-release-7e68331。四角色完成、Validator与precision各6/6、18个真实对话样本硬门禁通过；失败的首次捕获也保留。59项系统seams、15项purge、19项admission、4项restore及1384项全量回归通过。不得将这些报告改名为后续commit证据。
- 测试域名已切到7e68331独立部署dpl_EL63wfwtop9a5P3EVMGH3n8MRvSV，正常GitHub Owner登录成功。真实请求随后暴露已终止Journal regeneration再次受理时的命令身份缺陷。诊断Preview仅记录command ID、阶段与SQLSTATE，不能作为冻结发布证据。
- 实际SQLSTATE23505发生在action_admission；只读数据库比对发现保留的旧Workflowcommand使用同一identity。系统测试准确复现workflow_commands_revision_coverage_key冲突；修复后还暴露outbox_events_one_per_aggregate_event_idx同样冲突。两者都漏填现有intent_key，现按ActionExecution ID填写。新User Event可创建新Action，同一请求仍重放同一Receipt，旧命令/审计不删除，schema不变。
- 修复版本完整回归110files/1386tests通过，零失败/跳过；完整typecheck/build通过。下一次冻结需重新生成所有受影响证据。
- 生产只读检查仍为四个v2pins、0055及两个marker迁移，无待处理outbox。备份记录当前verified_at为2026-10-01T10:55:13Z，valid_until为2026-10-31T10:55:13Z；这只是当前数据库事实，不推断续期来源。生产G1仍关闭。
- 验收站CRON_SECRET为不可读的Vercel sensitive变量，原临时凭据丢失。轮换被自动审批拒绝，原因是原授权未明确包含凭据变更；已经单独向Luke询问，不绕过拒绝，也未修改生产凭据。
- 一次Preview命令从错误的根目录启动，随后审计正式项目最新部署未发现新部署，生产别名未变。改回独立验收checkout执行诊断部署，原日志保留。

- 独立诊断Preview dpl_E511kz5jE5cxb8r2VRvxHLd1dzLm 上正常Owner新请求已完成受理：decision command 01a0f839-6432-7a50-852d-ef813876a71f succeeded，Action 01a0f839-7e34-7876-820e-2142c6f1dc38 pending。界面明确显示已接受，数据库保留旧canceled Action并新增本次Action。这证明唯一约束修复生效，尚不证明Journal完成；调度等待测试Cron凭据授权。截图位于run/g1-hosted-bootstrap-20261001/fixed-action-accepted.png。
- 本次限定只读审查通过delegate.py发起，session ses_f07c61025ffe8jBaAEhooPOn80。180秒超时后显式恢复，120秒再次超时，两次abort_confirmed=true，没有最终审查结论。实际模型为opencode-go/muse-spark-1.3-contributor。不能称为审查通过；Codex已检查参数绑定、事务及重复请求路径，并完成本地/真实受理验证。审查原始记录归档到.codex/g1-restoration/action-fix-review。

## 测试调度恢复与新配置试验

Luke明确允许仅轮换验收项目CRON_SECRET，已更新Preview并部署干净5354c873e75f04d6e93336422cbb4b4ddc1ab4ba到dpl_8JuanLjRp9gqVXNy9W7bWqMiysoW。测试别名切换，Recovery Scan HTTP200且派发8个真实任务，production未变更。旧regeneration source revision2对照当前session10被fence取消；正常自动Journal新版本01a0f887-6ebd-78d3-8722-98914cbfbee4已发布，不称为regeneration成功。

5354c87捕获保留两项失败：Validator mixed ambiguity两次output budget耗尽；停止轮模型邀请换个话题。DeepSeek官方Thinking Mode文档说明默认high，Responses max_output_tokens同时计推理和输出。独立low试验只改reasoning.effort，同一失败样本完成，3661output/3560reasoning；这是1/6局部预演，不是正式完成度证据。保留10000上限、现有validator prompt/flags与ADR0143语义advisory规则，新immutable narrative config v5显式low，rollout pins v6，最终冻结后重新运行全部证据。

对话decision指令v4明确用户结束时只确认、不邀请换话题，保留v1-v3文本，立即安全要求继续生效。相关resolution/context tests46项通过；必须重新做真实完整硬门禁。OpenCode investigator240秒超时已确认终止，无调查结论，Codex依据实际失败与官方接口记录实施，不能称外部调查成功。

官方依据：https://api-docs.deepseek.com/guides/thinking_mode/ 与 https://api-docs.deepseek.com/api/create-response/ 。

新配置v5的首次冻结捕获被provider_egress_policy_versions FK拒绝，尚未发生角色Provider调用。policy同时绑定model_config_version，不能让v5配置复用v4policy。新增0057前向迁移登记v5策略，旧迁移和v4行保持不变；再次冻结后重跑捕获，不把失败目录改名。c64efee对话/回归捕获继续保留。

## 中文逗号输出修复与托管 Journal

629e951 的四角色调用、Validator 6/6、precision 6/6 和全量 1387 测试完成，但 AC-X04 真实对话有一例中文旁半角逗号，失败记录与哈希保留在 run/g1-release-629e951。没有重复抽样覆盖该失败。

新增 conversation-output:v2，在 Provider Egress 发出文本前把中文邻接的半角逗号改成全角。跨分段处理只暂存一个逗号；代码片段和 URL 保持原样。v1 保留原输出和原提示内容，未知版本仍拒绝编译。界面和 Harness 保存同一组处理后的 deltas，校验器不改。

OpenCode 实现任务完成后，Codex 用 Node 24.18.0 / pnpm 11.9.0 独立验证。补测实际复现 Action 选择之后才发出暂存逗号的问题，现改为先发文本再发 Action proposal。独立审查第二轮提出 Stop Signal 同类疑虑；其后文本在现有 Harness 中允许，集成测试证明该分支能提交、保留 proposal，且显示文本与保存文本一致，因此不按该疑虑清空缓冲。最终针对性测试 43 项通过，零失败或跳过；完整冻结版本回归与真实 Provider 捕获仍需重新生成。

629e951 验收部署 dpl_DqmVY2oXViWfySYHwRmEw3ZaqSC7 已 Ready，API commit 与部署身份接口一致，测试域名已切换。三个实际 Workflow 完成并通过完整分页/解密读取。正常静默窗口后扫描创建 Journal 任务 wrun_01M3WBC57RM9DN4AX6AE2D9SDA，生成与校验完成，新 current 版本 01a0f8b6-f9e5-7b87-96f0-5198bb21f6fc 在正常 Owner 页面可见。它仍属于 G1-off 基础验收，不是 Episode/Reflection 完成证明。生产未变更，G1仍关闭；12项证据、隔离 G1 功能与生产切换继续待完成。

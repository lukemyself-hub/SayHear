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
- Fresh acceptance databases named `sayhear_g1_acceptance_20261001_01a0f564` were created on distinct nonproduction business and Purge Marker endpoints after checking isolation from production. Migration and Owner provisioning must finish before deployment use.
- Existing canary alias still points to the production project's old preview. Move it only after the independent G1-off deployment is Ready; the OAuth callback can stay unchanged.
- Backup policy verification remains pending. Its configuration fingerprint is explicitly unverified; no backup evidence row has been recorded. Normal private writes must remain closed until actual backup verification passes.
- Production still has four v2 active pins and both G1 switches off; no production mutation has been performed.
- Typecheck, local build, boundary and Purge inventory checks passed. Full suite against two disposable local PostgreSQL databases passed: 108 files, 1348 tests, zero failures or skips (`/private/tmp/sayhear-g1-local-final-tooling-tests.json`). Remote Neon suite timed out in migration hooks; its failed report is preserved separately.
- New completion evidence uses `1a3b-f3-completion:v1`, `capture-verifier`, hashed raw capture and real command/attempt IDs. It is distinct from Luke's preserved ledger. Precision capture now uses Reflection with direct Evidence, keeping Bio outside G1.
- Four-role preflight first exposed capture-tool UUIDv4/method/scope defects. These are fixed, and `tsconfig.g1-tools.json` now covers the release CLIs in the normal typecheck command.
- Real Provider failures at the original 4000-token Episode/Daily/Weekly budgets were all `max_output_tokens`, with zero visible output and 4000 reasoning tokens. Original captures remain under `run/g1-activation-preflight*`.
- Candidate `g1-activation-pins.json` increases only those three output budgets to 10000, leaving Validator at 10000. The budget preflight completed Episode (4978 output / 4586 reasoning); Daily exhausted 10000; Weekly returned a schema mismatch. It is a dirty preflight, not release acceptance.
- Reflection's existing prompt omitted mandatory Candidate envelope fields and the nested temporal object. The instruction now states the existing schema explicitly; candidate Daily/Weekly prompt versions are v4. After completing the existing Episode schema instructions as well, all four real Provider calls completed in `run/g1-schema-preflight-2`. These dirty preflights are preserved and must be rerun on the frozen commit; no Reflection semantic validator rule was changed.
- Hosted exporter drains all Workflow pages with decrypted full data, retains every raw field and verifies execution correlation. Six-category probe planting and native diagnostic collection are still required before hosted acceptance can pass.

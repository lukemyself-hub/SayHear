# SayHear

This repository currently contains the smallest runnable Foundation slice for the
single Internal Owner access path. It intentionally does not materialize Journal,
Memory, Replay, Voice, Workflow, or a standalone Provider Egress runtime.

## Toolchain

- Node.js `24.18.0` (active LTS), pinned in `.node-version`
- pnpm `11.9.0`, pinned through the `packageManager` field
- TypeScript `7.0.2`
- Next.js `16.2.12`
- PostgreSQL with the Node `pg` driver

Install and validate from the repository root:

```sh
pnpm install
TEST_DATABASE_URL=postgresql://localhost/postgres pnpm validate
```

The full validation command includes the PostgreSQL system seam. It requires
`TEST_DATABASE_URL` and creates a disposable schema. To run only that suite:

```sh
TEST_DATABASE_URL=postgresql://localhost/postgres pnpm test:system
```

## Internal Owner setup

Copy `.env.example` to a local `.env`, provide server-only values, then run:

```sh
pnpm db:migrate
pnpm db:provision-owner
pnpm db:record-backup
pnpm --filter @sayhear/web dev
```

`db:provision-owner` accepts only the configured GitHub issuer/subject mapping and
stable UUIDv7 supplied in the environment. The database permits one Internal Owner
mapping. `db:record-backup` records operator-verified retention evidence; it does not
inspect or claim that an external backup exists on its own.

The protected surface is `/internal`. Real private writes remain blocked until the
latest verified policy version is current and its configuration fingerprint matches
the deployed expectation.

# G1-only cleanup inventory (2026-09-27)

Baseline: `origin/main` at `bd1a179`. The unmerged `agent/issue-207` chain and
all #243 frozen evidence are preserved on `codex/archive-g2-v6` at `cb4b4be`.

| Classification | Files and behavior | Disposition |
| --- | --- | --- |
| G2 only | `packages/application/src/open-loop/`, `proactive-followup/`, web segment lane, two Postgres G2 repositories, G2 release module/scripts, G2 system tests | Remove from main |
| G1 shared | Conversation response/harness, runtime composition, workflow/recovery, model-role command repository, prompt artifacts, Episode/Reflection, Recall, Curiosity Stop Signal, Inspector, `narrative.validate` | Restore the G1 implementations; deny retired role admission and dispatch |
| Historical compatibility | Migrations 0044/0049–0052/0055, seven role identifiers, legacy release evidence vocabulary, purge registry and adapters | Retain for existing database, historical records and Full Purge |
| Frozen evaluation | #243 raw outputs, manifests, SHA-256 report, failure reports and research note | Preserve on remote archive branch; not a release authority |

The frozen predicate-registry v1 localization text still names an Open Loop
formation gate in examples of short-lived tasks. That versioned artifact is
left unchanged for historical hash/lineage stability; it has no Open Loop
command path in G1. The shared F3 evaluator also retains historical Continuation
fixture names because the G1 release manifest and validator evidence reference
them.

Before deployment, compare production G2 pins, commands, and table counts
read-only. Any real G2 data blocks removal of its read or purge capability.
Two distinct test databases are required for G1 system and Full Purge checks.

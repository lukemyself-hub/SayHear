---
status: accepted
date: 2026-09-30
---

# G1 hosted acceptance is isolated from production

Luke approved an isolated hosted acceptance environment followed by production identity verification and functional smoke tests. Formal acceptance uses synthetic data under ADR-0138. The production owner must not be subject to Full Purge or backup restoration drills.

Use a separate Vercel project, owner authentication, business database, Purge Marker database and any private storage. Freeze the same code commit, Schema, Prompt, policy, role configurations and Provider snapshots used for production. AC-W01 and AC-D01 continue to refer to the same hosted acceptance deployment. Their deployment ID is the tested deployment, not a prediction of a future production deployment ID.

After acceptance, a separate promotion record binds the actual production deployment to the accepted release identity, manifest fingerprint, migrations, four active pins and functional checks. A Ready deployment without independently verified commit identity is insufficient. A different commit or configuration invalidates promotion; a production deployment ID changing does not invent new acceptance evidence.

Bootstrap hosted privacy acceptance with G1 writes off through the existing Conversation Action and Journal paths. Only after complete evidence produces a valid active manifest may isolated G1 pins and switches open. Then verify real Episode and Daily/Weekly Reflection execution, Inspector, and G1 privacy exports before production promotion. No incomplete manifest or test-principal bypass is introduced.

Exports must include correlated Workflow platform data, outbox, receipts, logs, traces and controlled errors. Encrypted data must be decrypted for scanning; placeholders and omitted pages do not prove absence of private data. Export gaps, provenance mismatches and probe leaks fail closed. Only source/category metadata may appear in leak reports.

ADR-0143 continues to govern Reflection semantics. Completion evidence may be generated from the actual frozen Provider capture without pretending to be a human adjudication. Historical Luke ledgers are retained unchanged.

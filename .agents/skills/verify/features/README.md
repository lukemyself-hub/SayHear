# SayHear verification map

Read this index before driving. It maps current Internal Portal user paths,
not the root README's historical Foundation-only feature description.

## Baseline preconditions

- Launch with `node scripts/verify-control.mjs launch "$VERIFY_RUN"` from the root.
- Require `node scripts/verify-control.mjs doctor "$VERIFY_RUN"` to pass.
- Use only this run's URL and synthetic session, never the normal Owner profile.
- The empty seed includes auth and backup policy, but no product content. Episode
  and Reflection writes remain off. This is not a hosted acceptance environment.
- Use a fresh run for the text mutation journey. Keyboard/IME, fault injection,
  longer history, published Journals, and generated Reflections need extra journeys.

## Driving conventions

The executable harness is Playwright through `verify-control`. Each feature file
names the canned journey plus actual Playwright handles for additional paths.
The setup and evidence writer are in `scripts/verify-browser.mjs`. Accessible
names beat coordinates; route paths distinguish same-named links.

An executed canned journey proves only the listed sub-features. Keep other
entries explicitly unverified. When a precondition is absent, report the failed
journey and its reason. Do not shorten a published-Journal or Reflection journey
to an empty-state check and call the original journey passed.

## Proof and reporting

Keep action logs, screenshots/ARIA snapshots, network responses and trace beside
result JSON in `artifacts/verify/<run-id>/`. Mutation proof requires a reload and
independent persisted-state read. Report local deterministic proof separately
from OAuth, live Provider, Workflow and production acceptance. Cleanup keeps proof.

## Features

- [Owner access](access.md): root/internal entry, sign-in and access denial.
- [Text conversation and history](conversation.md): composer, persistence, history and reading controls.
- [Journal](journal.md): date selection, automatic delivery, copy/export and Conversation backlink.
- [Context Inspector](context.md): tool and message-link entry, lookup and sensitive-read gates.
- [Reflection Inspector](reflection.md): Daily/Weekly trace and separately verified Evidence.

Candidate Review and Release Operations are secondary tool surfaces outside this
initial five-feature map. Voice has no current browser entry in this checkout;
do not infer its acceptance from text conversation.

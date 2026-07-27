---
status: accepted
date: 2026-07-26
---

# Proactive Follow-Up Starts Inside User-Initiated Conversations

After the User has submitted a new Event and started the current conversation
Turn, SayHear may proactively choose an appropriate open Open Loop or past
Memory and ask for an update even when the current utterance did not first
mention that topic. Remembering and revisiting something the User cared about
is part of expressing attention, not merely retrieving data on demand.

Internal Core and External MVP do not let Memory, time, or background
Workflows initiate an out-of-conversation message or notification. Without a
new User Event there is no GenerationCommand or Assistant Event. Any future
outbound companion behavior requires a separate explicit opt-in product
decision with notification, frequency, quiet-time, and sensitive-topic
controls. This ADR supersedes only ADR-0042's earlier ban on soliciting
progress; Open Loops remain non-task, expiring Context projections.

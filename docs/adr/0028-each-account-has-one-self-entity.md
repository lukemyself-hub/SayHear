---
status: accepted
date: 2026-07-26
---

# Each Account has one Self Entity

Every Account has exactly one system-managed Self Entity representing the user
as a participant in Memory Claims and person relationships. `user_id` remains
the authentication, authorization, isolation, and deletion scope; the Self
Entity is the domain identity used in `subject_entity_id` and
`object_entity_id`.

The Account–Self Entity binding is one-to-one and idempotently provisioned
before the Account's first 1A.3 Entity or Memory Claim write. The existing
Internal Owner receives it when entering 1A.3, so 1A.1 and 1A.2 do not build the
Entity subsystem early; External MVP can create it with a new Account. Self
Entity cannot merge or split with ordinary Entities, bind to another Account,
or be deleted independently. Another user referring to the same real-world
person still creates a private Entity in that user's scope, with no cross-user
merge. Internal Owner Full Purge retains the content-free Account, Self Entity
envelope, and binding while removing all related content; Account Deletion
removes all three together. This adds one protected Entity per Account but
avoids a special-case “user” operand throughout the Claim model.

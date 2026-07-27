# Issue tracker: GitHub

## TL;DR

- Issues and complete SPECs for this repository live in GitHub Issues.
- A SPEC Issue body, comments, and labels are its sole execution source;
  `docs/specs/README.md` is discovery-only and must not duplicate the body.
- Read the target Issue, comments, labels, and acceptance criteria before issue-driven development.
- Before designing or implementing an Issue, search the decision index by every affected
  domain and read all matching ADRs; Issue links are a starting point, not a complete list.
- Use this file only for Issue or SPEC operations; ordinary local development does not need it.

## Status

Accepted

Issues and complete SPECs for this repo live as GitHub issues. Use the `gh` CLI for all
operations. GitHub is the sole execution source for a published SPEC; the local
[`../specs/README.md`](../specs/README.md) contains only a lightweight index and
publishing rules.

## Conventions

- **Create an issue**: `gh issue create --title "..." --body "..."`. Use a heredoc for multi-line bodies.
- **Read an issue**: `gh issue view <number> --comments`, filtering comments by `jq` and also fetching labels.
- **List issues**: `gh issue list --state open --json number,title,body,labels,comments --jq '[.[] | {number, title, body, labels: [.labels[].name], comments: [.comments[].body]}]'` with appropriate `--label` and `--state` filters.
- **Comment on an issue**: `gh issue comment <number> --body "..."`
- **Apply / remove labels**: `gh issue edit <number> --add-label "..."` / `--remove-label "..."`
- **Close**: `gh issue close <number> --comment "..."`

Infer the repo from `git remote -v` — `gh` does this automatically when run inside a clone.

## Pull requests as a triage surface

**PRs as a request surface: no.**

When set to `yes`, PRs run through the same labels and states as issues, using the `gh pr` equivalents:

- **Read a PR**: `gh pr view <number> --comments` and `gh pr diff <number>`.
- **List external PRs for triage**: `gh pr list --state open --json number,title,body,labels,author,authorAssociation,comments`, keeping only external contributors.
- **Comment / label / close**: `gh pr comment`, `gh pr edit --add-label`/`--remove-label`, `gh pr close`.

GitHub shares one number space across issues and PRs, so resolve an ambiguous `#42` with `gh pr view 42` and fall back to `gh issue view 42`.

## When a skill says "publish to the issue tracker"

Create a GitHub issue containing the complete SPEC or ticket body. For `/to-spec`:

1. create the complete SPEC as a GitHub Issue;
2. apply the `ready-for-agent` label without routing it through `/triage`;
3. add a lightweight Issue link, Core Flow, and status entry to
   [`../specs/README.md`](../specs/README.md);
4. keep subsequent scope, acceptance-criteria, discussion, and status changes in the
   GitHub Issue rather than copying them into a local SPEC file.

## When a skill says "fetch the relevant ticket"

Run `gh issue view <number> --comments`.

## Wayfinding operations

Used by `/wayfinder`. The **map** is a single issue with **child** issues as tickets.

- **Map**: a single issue labelled `wayfinder:map`, holding the Notes, Decisions-so-far, and Fog body.
- **Child ticket**: an issue linked to the map as a GitHub sub-issue. Where sub-issues aren't enabled, add the child to a task list and put `Part of #<map>` at the top of the child body.
- **Blocking**: use GitHub’s native issue dependencies. Where unavailable, use a `Blocked by: #<n>, #<n>` line.
- **Frontier query**: find the first open, unblocked, and unassigned child in map order.
- **Claim**: `gh issue edit <n> --add-assignee @me`.
- **Resolve**: comment with the answer, close the child issue, then append a context pointer to the map’s Decisions-so-far.

## References

- [Documentation map](../README.md)
- [Triage labels](triage-labels.md)

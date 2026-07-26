# Domain Docs

## TL;DR

- 先读取 `docs/README.md`，再只读取当前任务涉及的术语章节和 ADR。
- 根目录 `CONTEXT.md` 是领域词汇唯一真源，路径由 matt skills 依赖。
- 发现输出或实现与 ADR 冲突时明确报告，不要静默覆盖。

## Status

Accepted

## Before exploring

1. Read [`../README.md`](../README.md) for task routing.
2. If the task names or changes a domain concept, read only the relevant section of
   [`../../CONTEXT.md`](../../CONTEXT.md).
3. Read only the ADRs linked by the relevant SPEC, architecture document, or
   [`../decisions.md`](../decisions.md).

Do not read the whole product background, architecture set, ADR directory, or
`archive/` merely to explore the codebase.

## Use the glossary's vocabulary

When output names a domain concept—in an issue title, refactor proposal, hypothesis,
interface, or test name—use the term defined in
[`../../CONTEXT.md`](../../CONTEXT.md).

If a needed concept is absent, reconsider whether the term belongs to the project or note the gap for domain modeling.

## Flag ADR conflicts

If output contradicts an existing ADR, surface the conflict explicitly instead of silently overriding the decision.

## References

- [Documentation map](../README.md)
- [Decision index](../decisions.md)

# Domain Docs

## TL;DR

- 先读取 `docs/README.md`；设计或修改领域能力前，检索并读取所有与任务相关的 ADR。
- 根目录 `GLOSSARY.md` 是领域词汇唯一真源，路径由 matt skills 依赖。
- 发现输出或实现与 ADR 冲突时明确报告，不要静默覆盖。

## Status

Accepted

## Before exploring

1. Read [`../README.md`](../README.md) for task routing.
2. If the task names or changes a domain concept, read the relevant section of
   [`../../GLOSSARY.md`](../../GLOSSARY.md).
3. Read ADRs linked by the relevant SPEC or architecture document, then search
   [`../decisions.md`](../decisions.md) by every affected domain concept and read
   all matching ADRs before design or implementation. Direct links are a minimum
   starting point, not an exhaustive decision scope.

Do not load the whole product background, architecture set, ADR directory, or
`archive/` without a task-relevant search result. A missing direct link is not
evidence that an ADR is irrelevant.

## Use the glossary's vocabulary

When output names a domain concept—in an issue title, refactor proposal, hypothesis,
interface, or test name—use the term defined in
[`../../GLOSSARY.md`](../../GLOSSARY.md).

If a needed concept is absent, reconsider whether the term belongs to the project or note the gap for domain modeling.

## Flag ADR conflicts

If output contradicts an existing ADR, surface the conflict explicitly instead of silently overriding the decision.

## References

- [Documentation map](../README.md)
- [Decision index](../decisions.md)

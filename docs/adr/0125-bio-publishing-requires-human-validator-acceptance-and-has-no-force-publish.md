---
status: accepted
date: 2026-09-06
---

# Bio Publishing Requires Human Validator Acceptance and Has No Force-Publish

The Bio feature remains rollout-disabled until `narrative.validate` passes a small, fixed, replayable human acceptance set. Version 1 starts with about eighteen cases: six Chinese, six English, and six code-switched cases, covering both Reflection and Bio and exercising every known blocking error class at least once. Luke judges every case. ADR-0139 replaces the original zero-miss calibration threshold with a ten-percent recall-miss budget and a separate zero-false-block precision gate. Version 1 does not add per-bucket confidence intervals or a weighted overall score; newly discovered failures are added to the regression set. Deterministic schema, lineage, lifecycle, epoch, and Context-isolation gates must all pass.

After this acceptance, `unsupported`, `contradiction`, `kind_upgrade`, `material_absence`, manifest mismatch, and `ambiguous` prevent Bio publication. The same GenerationCommand may make one bounded repair attempt with its original frozen input, Prompt, model config, and policy. A second failure becomes `needs_review` and never current.

Internal Owner review can label a checker error and add the case to acceptance evidence, but cannot force-publish a rejected BioVersion. Changing a Prompt, policy, or checker creates a new command. This keeps internal adjudication useful for improving the validator without creating the Bio approval workflow or trust-boundary bypass that the product excludes.

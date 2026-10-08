---
status: accepted
date: 2026-09-07
---
> Current release scope: [ADR-0141](0141-g1-only-release-after-g2-retirement.md) supersedes this decision where it concerns G2/G3 or the three-stage rollout. Historical rationale follows.
> Revised by [ADR-0148](0148-deployment-identity-config-authorization-and-acceptance-are-separate.md) where it concerns the exact main commit and full regression as a per-deployment requirement. Hard-failure rules stay in force.


# 1A.3b acceptance does not grandfather hard failures

The frozen 1A.3a incumbent remains evidence for relative attribution, but its
adjudicated hard-gate findings are not release waivers. Formal 1A.3b evidence
requires a candidate with zero confirmed deterministic hard-gate failures; if
an inherited finding recurs, it must be fixed and a clean incumbent frozen
before the single-variable comparison proceeds.

Continuation uses its own 15-scenario stratified blind pairwise sample with the
existing 8 English / 5 Chinese / 2 code-switched quotas, strictly positive
overall candidate preference, and no locale or protected-category regression.
Bio configuration selection also uses blind pairwise evidence, followed by
Luke's explicit inspection of the winning fixed sample; one Bio that is
unacceptable as product prose blocks rollout. Continuation preference, Bio
narrative acceptance and fidelity, and deterministic Internal correctness are
independent evidence groups. No win in one group compensates for a failure in
another.

Core Flow 1A.3b is accepted only after all three rollout stages are active and
the exact main commit and production pins pass the full regression,
Continuation experience, Bio narrative and fidelity, and deterministic
Internal correctness evidence. No confirmed hard failure may remain open.
Latency, cost, token use, Provider error rate, and safe-degradation counts are
reported for accounting and diagnosis only.

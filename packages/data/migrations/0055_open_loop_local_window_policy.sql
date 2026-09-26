-- Issue #241: retain v1 lineage while publishing the local-window formation
-- policy used by the next G2 bundle. No existing OpenLoopVersion is rewritten.
INSERT INTO open_loop_policies (policy_version, created_at)
VALUES ('open-loop-formation:v2', CURRENT_TIMESTAMP);

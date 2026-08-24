-- 1A.2P / #79: seed the v2 policy rows for the Safety Posture and the
-- Curiosity Stop Signal projection.
--
-- Both v2 versions change only prompt-layer contract text compiled into the
-- context (the posture section's every-turn anchor-repetition instruction,
-- the stop-signal proposal function's reply-alongside-the-call contract);
-- the lifecycle rules and K stay identical. The policy rows are immutable
-- once seeded, so the v1 rows stay in place as history and the v2 rows are
-- appended here, the same append-only discipline the whitelist follows
-- (safety-resources:v2). No data migration: existing posture/projection
-- records keep the version they were written under.

INSERT INTO safety_posture_policies (policy_version, clean_turns_to_release)
VALUES ('safety-posture:v2', 2);

INSERT INTO curiosity_stop_signal_policies (policy_version)
VALUES ('curiosity-stop-signal:v2');

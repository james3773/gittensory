-- The moment this PR's CURRENT head SHA first became ready for review: stamped on open (or a fresh commit
-- while open+non-draft), reset on every new commit, and left unset while the PR is a draft (draft-sitting time
-- must not count as review latency). Feeds a real PR-ready-to-review-published end-to-end latency metric
-- (loopover_review_end_to_end_latency_seconds) -- distinct from job_complete's latency_ms, which only measures
-- a single queue job's own claim-to-completion span, not the full pipeline including queueing/deferral waits.
ALTER TABLE pull_requests ADD COLUMN head_sha_observed_at TEXT;

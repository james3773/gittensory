import { describe, expect, it } from "vitest";
import { renameRepositoryIdentity } from "../../src/db/repo-identity-rename";
import {
  getIssue,
  getPullRequest,
  getPullRequestDetailSyncState,
  getRepository,
  getRepositorySettings,
  listPullRequests,
  listRecentMergedPullRequests,
  persistAdvisory,
  recordAuditEvent,
  recordGateBlockOutcome,
  startActiveReviewTracking,
  upsertCheckSummary,
  upsertIssueFromGitHub,
  upsertPullRequestDetailSyncState,
  upsertPullRequestFile,
  upsertPullRequestFromGitHub,
  upsertPullRequestReview,
  upsertRecentMergedPullRequest,
  upsertRepositoryFromGitHub,
  upsertRepositorySettings,
} from "../../src/db/repositories";
import { createTestEnv } from "../helpers/d1";

const OLD = "owner/gittensory";
const NEW = "owner/loopover";

describe("renameRepositoryIdentity", () => {
  it("is a no-op when oldFullName and newFullName are identical", async () => {
    const env = createTestEnv();
    await upsertRepositoryFromGitHub(env, { name: "gittensory", full_name: OLD, private: false, owner: { login: "owner" } }, 1);
    await renameRepositoryIdentity(env, OLD, OLD);
    const repo = await getRepository(env, OLD);
    expect(repo?.fullName).toBe(OLD);
  });

  it("is a safe no-op when nothing exists yet under the old name", async () => {
    const env = createTestEnv();
    await expect(renameRepositoryIdentity(env, OLD, NEW)).resolves.toBeUndefined();
    expect(await getRepository(env, NEW)).toBeNull();
  });

  describe("repositories", () => {
    it("renames the anchor row's full_name, owner, name, and html_url", async () => {
      const env = createTestEnv();
      await upsertRepositoryFromGitHub(env, { name: "gittensory", full_name: OLD, private: false, html_url: `https://github.com/${OLD}`, owner: { login: "owner" } }, 42);
      await renameRepositoryIdentity(env, OLD, NEW);
      expect(await getRepository(env, OLD)).toBeNull();
      const renamed = await getRepository(env, NEW);
      expect(renamed).toMatchObject({ fullName: NEW, owner: "owner", name: "loopover", installationId: 42, htmlUrl: `https://github.com/${NEW}` });
    });

    it("REGRESSION (#repo-rename-migration): folds away a stray new-name row (already created by a webhook that slipped in under the new name) rather than colliding, keeping the old row's richer state", async () => {
      const env = createTestEnv();
      await upsertRepositoryFromGitHub(env, { name: "gittensory", full_name: OLD, private: false, owner: { login: "owner" } }, 42);
      // Simulate the exact drift this module exists to fix: a webhook already created a fresh row under the
      // new name (installationId set, but none of the old row's accumulated state).
      await upsertRepositoryFromGitHub(env, { name: "loopover", full_name: NEW, private: false, owner: { login: "owner" } }, 42);
      await renameRepositoryIdentity(env, OLD, NEW);
      const renamed = await getRepository(env, NEW);
      expect(renamed?.installationId).toBe(42);
      // Exactly one row survives -- the fold, not a second insert.
      expect(await getRepository(env, OLD)).toBeNull();
    });
  });

  describe("repository_settings", () => {
    // getRepositorySettings always returns a (possibly all-default) RepositorySettings, never null, so
    // these assert on the raw row directly to distinguish "no row" / "renamed row" / "folded row".
    it("renames the settings row's repo_full_name", async () => {
      const env = createTestEnv();
      await upsertRepositorySettings(env, { repoFullName: OLD, commentMode: "off" });
      await renameRepositoryIdentity(env, OLD, NEW);
      const oldRow = await env.DB.prepare("select count(*) as n from repository_settings where repo_full_name = ?").bind(OLD).first<{ n: number }>();
      expect(oldRow?.n).toBe(0);
      const settings = await getRepositorySettings(env, NEW);
      expect(settings.commentMode).toBe("off");
    });

    it("REGRESSION (#repo-rename-migration): folds away a stray new-name settings row, keeping the pre-existing configured settings", async () => {
      const env = createTestEnv();
      await upsertRepositorySettings(env, { repoFullName: OLD, commentMode: "detected_contributors_only" });
      await upsertRepositorySettings(env, { repoFullName: NEW, commentMode: "off" }); // stray, should be discarded
      await renameRepositoryIdentity(env, OLD, NEW);
      const settings = await getRepositorySettings(env, NEW);
      expect(settings.commentMode).toBe("detected_contributors_only");
      const newRowCount = await env.DB.prepare("select count(*) as n from repository_settings where repo_full_name = ?").bind(NEW).first<{ n: number }>();
      expect(newRowCount?.n).toBe(1); // exactly one surviving row, not two
    });
  });

  describe("pull_requests", () => {
    it("renames repo_full_name, id, and html_url for every PR under the old name", async () => {
      const env = createTestEnv();
      await upsertPullRequestFromGitHub(env, OLD, { number: 1, title: "PR one", state: "open", html_url: `https://github.com/${OLD}/pull/1`, labels: [] });
      await upsertPullRequestFromGitHub(env, OLD, { number: 2, title: "PR two", state: "closed", labels: [] });
      await renameRepositoryIdentity(env, OLD, NEW);
      expect(await getPullRequest(env, OLD, 1)).toBeNull();
      const pr1 = await getPullRequest(env, NEW, 1);
      expect(pr1).toMatchObject({ repoFullName: NEW, title: "PR one", htmlUrl: `https://github.com/${NEW}/pull/1` });
      const pr2 = await getPullRequest(env, NEW, 2);
      expect(pr2?.title).toBe("PR two");
    });

    it("REGRESSION (#repo-rename-migration): a colliding PR number under the new name is folded away, preserving the pre-existing PR's history instead of the sparse post-rename duplicate", async () => {
      const env = createTestEnv();
      await upsertPullRequestFromGitHub(env, OLD, { number: 5, title: "Original, full history", state: "open", labels: [], body: "the real one" });
      // The sparse duplicate a webhook could have created under the new name before this migration ran.
      await upsertPullRequestFromGitHub(env, NEW, { number: 5, title: "Fragment", state: "open", labels: [] });
      await renameRepositoryIdentity(env, OLD, NEW);
      const rows = await listPullRequests(env, NEW);
      expect(rows.filter((pr) => pr.number === 5)).toHaveLength(1);
      expect(rows.find((pr) => pr.number === 5)?.title).toBe("Original, full history");
    });

    it("does not disturb a PR that only ever existed under the new name (no matching number under the old name)", async () => {
      const env = createTestEnv();
      await upsertPullRequestFromGitHub(env, OLD, { number: 1, title: "old-name PR", state: "open", labels: [] });
      await upsertPullRequestFromGitHub(env, NEW, { number: 99, title: "genuinely new PR", state: "open", labels: [] });
      await renameRepositoryIdentity(env, OLD, NEW);
      expect(await getPullRequest(env, NEW, 99)).toMatchObject({ title: "genuinely new PR" });
      expect(await getPullRequest(env, NEW, 1)).toMatchObject({ title: "old-name PR" });
    });
  });

  describe("issues", () => {
    it("renames repo_full_name, id, and html_url for every issue under the old name", async () => {
      const env = createTestEnv();
      await upsertIssueFromGitHub(env, OLD, { number: 7, title: "Issue seven", state: "open", html_url: `https://github.com/${OLD}/issues/7`, labels: [] });
      await renameRepositoryIdentity(env, OLD, NEW);
      expect(await getIssue(env, OLD, 7)).toBeNull();
      expect(await getIssue(env, NEW, 7)).toMatchObject({ repoFullName: NEW, title: "Issue seven", htmlUrl: `https://github.com/${NEW}/issues/7` });
    });

    it("REGRESSION (#repo-rename-migration): a colliding issue number under the new name is folded away, keeping the pre-existing issue", async () => {
      const env = createTestEnv();
      await upsertIssueFromGitHub(env, OLD, { number: 3, title: "Original issue", state: "open", labels: [] });
      await upsertIssueFromGitHub(env, NEW, { number: 3, title: "Fragment issue", state: "open", labels: [] });
      await renameRepositoryIdentity(env, OLD, NEW);
      expect(await getIssue(env, NEW, 3)).toMatchObject({ title: "Original issue" });
    });
  });

  describe("gate_outcomes", () => {
    it("renames repo_full_name and id for the PR's gate-block row", async () => {
      const env = createTestEnv();
      await recordGateBlockOutcome(env, { repoFullName: OLD, pullNumber: 5, headSha: "abc123", blockerCodes: ["missing_linked_issue"] });
      await renameRepositoryIdentity(env, OLD, NEW);
      const oldRow = await env.DB.prepare("select count(*) as n from gate_outcomes where repo_full_name = ?").bind(OLD).first<{ n: number }>();
      expect(oldRow?.n).toBe(0);
      const renamed = await env.DB.prepare("select id, blocker_codes_json as blockerCodesJson from gate_outcomes where repo_full_name = ? and pull_number = ?").bind(NEW, 5).first<{ id: string; blockerCodesJson: string }>();
      expect(renamed?.id).toBe(`gate:${NEW}#5`);
      expect(renamed?.blockerCodesJson).toContain("missing_linked_issue");
    });

    it("REGRESSION (#repo-rename-migration): folds away a stray new-name gate-block row on the same PR number", async () => {
      const env = createTestEnv();
      await recordGateBlockOutcome(env, { repoFullName: OLD, pullNumber: 5, blockerCodes: ["slop_risk"] });
      await recordGateBlockOutcome(env, { repoFullName: NEW, pullNumber: 5, blockerCodes: ["duplicate_pr_risk"] });
      await renameRepositoryIdentity(env, OLD, NEW);
      const rows = await env.DB.prepare("select blocker_codes_json as blockerCodesJson from gate_outcomes where repo_full_name = ? and pull_number = ?").bind(NEW, 5).all<{ blockerCodesJson: string }>();
      expect(rows.results).toHaveLength(1);
      expect(rows.results[0]?.blockerCodesJson).toContain("slop_risk");
    });
  });

  describe("active_review_tracking", () => {
    it("renames repo_full_name and id for the PR's active-review row", async () => {
      const env = createTestEnv();
      await startActiveReviewTracking(env, { repoFullName: OLD, pullNumber: 9, headSha: "def456", deliveryId: "delivery-1" });
      await renameRepositoryIdentity(env, OLD, NEW);
      const oldRow = await env.DB.prepare("select count(*) as n from active_review_tracking where repo_full_name = ?").bind(OLD).first<{ n: number }>();
      expect(oldRow?.n).toBe(0);
      const renamed = await env.DB.prepare("select id, head_sha as headSha from active_review_tracking where repo_full_name = ? and pull_number = ?").bind(NEW, 9).first<{ id: string; headSha: string }>();
      expect(renamed?.id).toBe(`active-review:${NEW}#9`);
      expect(renamed?.headSha).toBe("def456");
    });

    it("REGRESSION (#repo-rename-migration): folds away a stray new-name active-review row on the same PR number", async () => {
      const env = createTestEnv();
      await startActiveReviewTracking(env, { repoFullName: OLD, pullNumber: 9, headSha: "old-head", deliveryId: "delivery-old" });
      await startActiveReviewTracking(env, { repoFullName: NEW, pullNumber: 9, headSha: "stray-head", deliveryId: "delivery-stray" });
      await renameRepositoryIdentity(env, OLD, NEW);
      const rows = await env.DB.prepare("select head_sha as headSha from active_review_tracking where repo_full_name = ? and pull_number = ?").bind(NEW, 9).all<{ headSha: string }>();
      expect(rows.results).toHaveLength(1);
      expect(rows.results[0]?.headSha).toBe("old-head");
    });
  });

  describe("pull_request_detail_sync_state", () => {
    it("renames repo_full_name and id for the PR's sync-state row", async () => {
      const env = createTestEnv();
      await upsertPullRequestDetailSyncState(env, { repoFullName: OLD, pullNumber: 3, status: "complete", headSha: "sha-old" });
      await renameRepositoryIdentity(env, OLD, NEW);
      expect(await getPullRequestDetailSyncState(env, OLD, 3)).toBeNull();
      const renamed = await getPullRequestDetailSyncState(env, NEW, 3);
      expect(renamed).toMatchObject({ repoFullName: NEW, status: "complete", headSha: "sha-old" });
      const idRow = await env.DB.prepare("select id from pull_request_detail_sync_state where repo_full_name = ? and pull_number = ?").bind(NEW, 3).first<{ id: string }>();
      expect(idRow?.id).toBe(`${NEW}#3`);
    });

    it("REGRESSION (#repo-rename-migration): folds away a stray new-name sync-state row on the same PR number", async () => {
      const env = createTestEnv();
      await upsertPullRequestDetailSyncState(env, { repoFullName: OLD, pullNumber: 3, status: "complete" });
      await upsertPullRequestDetailSyncState(env, { repoFullName: NEW, pullNumber: 3, status: "never_synced" });
      await renameRepositoryIdentity(env, OLD, NEW);
      const rows = await env.DB.prepare("select status from pull_request_detail_sync_state where repo_full_name = ? and pull_number = ?").bind(NEW, 3).all<{ status: string }>();
      expect(rows.results).toHaveLength(1);
      expect(rows.results[0]?.status).toBe("complete");
    });
  });

  describe("recent_merged_pull_requests", () => {
    it("renames repo_full_name, id, and html_url for a merged-PR row", async () => {
      const env = createTestEnv();
      await upsertRecentMergedPullRequest(env, { repoFullName: OLD, number: 11, title: "Merged PR", htmlUrl: `https://github.com/${OLD}/pull/11`, labels: [], linkedIssues: [], changedFiles: [], payload: {} });
      await renameRepositoryIdentity(env, OLD, NEW);
      const rows = await listRecentMergedPullRequests(env, NEW);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ title: "Merged PR", htmlUrl: `https://github.com/${NEW}/pull/11` });
      expect(await listRecentMergedPullRequests(env, OLD)).toHaveLength(0);
    });

    it("REGRESSION (#repo-rename-migration): folds away a stray new-name row on the same PR number", async () => {
      const env = createTestEnv();
      await upsertRecentMergedPullRequest(env, { repoFullName: OLD, number: 11, title: "Original", labels: [], linkedIssues: [], changedFiles: [], payload: {} });
      await upsertRecentMergedPullRequest(env, { repoFullName: NEW, number: 11, title: "Fragment", labels: [], linkedIssues: [], changedFiles: [], payload: {} });
      await renameRepositoryIdentity(env, OLD, NEW);
      const rows = await listRecentMergedPullRequests(env, NEW);
      expect(rows.filter((pr) => pr.number === 11)).toHaveLength(1);
      expect(rows.find((pr) => pr.number === 11)?.title).toBe("Original");
    });
  });

  describe("pull_request_files", () => {
    it("renames repo_full_name and id for every file row under the old name", async () => {
      const env = createTestEnv();
      await upsertPullRequestFile(env, { repoFullName: OLD, pullNumber: 4, path: "src/a.ts", additions: 1, deletions: 0, changes: 1, payload: {} });
      await upsertPullRequestFile(env, { repoFullName: OLD, pullNumber: 4, path: "src/b.ts", additions: 2, deletions: 1, changes: 3, payload: {} });
      await renameRepositoryIdentity(env, OLD, NEW);
      const oldRows = await env.DB.prepare("select count(*) as n from pull_request_files where repo_full_name = ?").bind(OLD).first<{ n: number }>();
      expect(oldRows?.n).toBe(0);
      const renamed = await env.DB.prepare("select id, path from pull_request_files where repo_full_name = ? order by path").bind(NEW).all<{ id: string; path: string }>();
      expect(renamed.results).toEqual([
        { id: `${NEW}#4#src/a.ts`, path: "src/a.ts" },
        { id: `${NEW}#4#src/b.ts`, path: "src/b.ts" },
      ]);
    });

    it("REGRESSION (#repo-rename-migration): folds away a stray new-name row that collides on the same (pull_number, path) pair", async () => {
      const env = createTestEnv();
      await upsertPullRequestFile(env, { repoFullName: OLD, pullNumber: 4, path: "src/a.ts", additions: 10, deletions: 0, changes: 10, payload: {} });
      await upsertPullRequestFile(env, { repoFullName: NEW, pullNumber: 4, path: "src/a.ts", additions: 1, deletions: 1, changes: 2, payload: {} });
      await renameRepositoryIdentity(env, OLD, NEW);
      const rows = await env.DB.prepare("select additions from pull_request_files where repo_full_name = ? and pull_number = ? and path = ?").bind(NEW, 4, "src/a.ts").all<{ additions: number }>();
      expect(rows.results).toHaveLength(1);
      expect(rows.results[0]?.additions).toBe(10);
    });

    it("does not disturb a same-numbered PR's file at a DIFFERENT path (pair, not just pull_number, must match to fold)", async () => {
      const env = createTestEnv();
      await upsertPullRequestFile(env, { repoFullName: OLD, pullNumber: 4, path: "src/a.ts", additions: 1, deletions: 0, changes: 1, payload: {} });
      await upsertPullRequestFile(env, { repoFullName: NEW, pullNumber: 4, path: "src/other.ts", additions: 5, deletions: 0, changes: 5, payload: {} });
      await renameRepositoryIdentity(env, OLD, NEW);
      const rows = await env.DB.prepare("select path from pull_request_files where repo_full_name = ? and pull_number = ? order by path").bind(NEW, 4).all<{ path: string }>();
      expect(rows.results.map((r) => r.path)).toEqual(["src/a.ts", "src/other.ts"]);
    });
  });

  describe("check_summaries", () => {
    it("renames repo_full_name and a repo-embedded id", async () => {
      const env = createTestEnv();
      await upsertCheckSummary(env, { id: `${OLD}#sha1#build`, repoFullName: OLD, pullNumber: 6, headSha: "sha1", name: "build", status: "completed", conclusion: "success", payload: {} });
      await renameRepositoryIdentity(env, OLD, NEW);
      const renamed = await env.DB.prepare("select id from check_summaries where repo_full_name = ? and head_sha = ? and name = ?").bind(NEW, "sha1", "build").first<{ id: string }>();
      expect(renamed?.id).toBe(`${NEW}#sha1#build`);
    });

    it("leaves a non-repo-embedded id (e.g. a raw check-run id) untouched aside from repo_full_name", async () => {
      const env = createTestEnv();
      await upsertCheckSummary(env, { id: "998877", repoFullName: OLD, pullNumber: 6, headSha: "sha2", name: "LoopOver Orb Review Agent", status: "completed", payload: {} });
      await renameRepositoryIdentity(env, OLD, NEW);
      const renamed = await env.DB.prepare("select id from check_summaries where repo_full_name = ? and head_sha = ? and name = ?").bind(NEW, "sha2", "LoopOver Orb Review Agent").first<{ id: string }>();
      expect(renamed?.id).toBe("998877"); // replace() on a non-matching id is a no-op -- id stable, repo_full_name still renamed
    });

    it("REGRESSION (#repo-rename-migration): folds away a stray new-name row colliding on (head_sha, name)", async () => {
      const env = createTestEnv();
      await upsertCheckSummary(env, { id: "1", repoFullName: OLD, pullNumber: 6, headSha: "sha1", name: "build", status: "completed", conclusion: "success", payload: {} });
      await upsertCheckSummary(env, { id: "2", repoFullName: NEW, pullNumber: 6, headSha: "sha1", name: "build", status: "in_progress", payload: {} });
      await renameRepositoryIdentity(env, OLD, NEW);
      const rows = await env.DB.prepare("select conclusion from check_summaries where repo_full_name = ? and head_sha = ? and name = ?").bind(NEW, "sha1", "build").all<{ conclusion: string | null }>();
      expect(rows.results).toHaveLength(1);
      expect(rows.results[0]?.conclusion).toBe("success");
    });

    it("REGRESSION (#repo-rename-migration): a NULL head_sha row folds correctly (SQL NULL never equals NULL via '=')", async () => {
      const env = createTestEnv();
      await upsertCheckSummary(env, { id: "3", repoFullName: OLD, pullNumber: null, headSha: null, name: "queued-check", status: "queued", payload: {} });
      await upsertCheckSummary(env, { id: "4", repoFullName: NEW, pullNumber: null, headSha: null, name: "queued-check", status: "stale-stray", payload: {} });
      await renameRepositoryIdentity(env, OLD, NEW);
      const rows = await env.DB.prepare("select status from check_summaries where repo_full_name = ? and head_sha is null and name = ?").bind(NEW, "queued-check").all<{ status: string }>();
      expect(rows.results).toHaveLength(1);
      expect(rows.results[0]?.status).toBe("queued");
    });
  });

  describe("pull_request_reviews", () => {
    it("renames repo_full_name and a repo-embedded id", async () => {
      const env = createTestEnv();
      await upsertPullRequestReview(env, { id: `${OLD}#8#555`, repoFullName: OLD, pullNumber: 8, state: "APPROVED", payload: {} });
      await renameRepositoryIdentity(env, OLD, NEW);
      const oldRows = await env.DB.prepare("select count(*) as n from pull_request_reviews where repo_full_name = ?").bind(OLD).first<{ n: number }>();
      expect(oldRows?.n).toBe(0);
      const renamed = await env.DB.prepare("select id, state from pull_request_reviews where repo_full_name = ?").bind(NEW).first<{ id: string; state: string }>();
      expect(renamed).toMatchObject({ id: `${NEW}#8#555`, state: "APPROVED" });
    });

    it("does not disturb a review row that only ever existed under the new name", async () => {
      const env = createTestEnv();
      await upsertPullRequestReview(env, { id: `${OLD}#8#555`, repoFullName: OLD, pullNumber: 8, state: "APPROVED", payload: {} });
      await upsertPullRequestReview(env, { id: `${NEW}#8#556`, repoFullName: NEW, pullNumber: 8, state: "COMMENTED", payload: {} });
      await renameRepositoryIdentity(env, OLD, NEW);
      const rows = await env.DB.prepare("select id from pull_request_reviews where repo_full_name = ? order by id").bind(NEW).all<{ id: string }>();
      expect(rows.results.map((r) => r.id)).toEqual([`${NEW}#8#555`, `${NEW}#8#556`]);
    });
  });

  describe("advisories", () => {
    it("renames repo_full_name and the repo-embedded target_key, leaving the random-UUID id untouched", async () => {
      const env = createTestEnv();
      const advisoryId = "11111111-1111-1111-1111-111111111111";
      await persistAdvisory(env, {
        id: advisoryId,
        targetType: "pull_request",
        targetKey: `${OLD}#12`,
        repoFullName: OLD,
        pullNumber: 12,
        conclusion: "neutral",
        severity: "info",
        title: "LoopOver advisory available",
        summary: "1 advisory finding generated.",
        findings: [],
        generatedAt: "2026-07-14T00:00:00.000Z",
      });
      await renameRepositoryIdentity(env, OLD, NEW);
      const renamed = await env.DB.prepare("select id, target_key as targetKey from advisories where repo_full_name = ?").bind(NEW).first<{ id: string; targetKey: string }>();
      expect(renamed).toEqual({ id: advisoryId, targetKey: `${NEW}#12` });
      const oldRows = await env.DB.prepare("select count(*) as n from advisories where repo_full_name = ?").bind(OLD).first<{ n: number }>();
      expect(oldRows?.n).toBe(0);
    });
  });

  describe("audit_events", () => {
    it("renames every target_key containing the old full name, including composite repo#number keys, leaving unrelated keys untouched", async () => {
      const env = createTestEnv();
      await recordAuditEvent(env, { eventType: "test.event", actor: "loopover", targetKey: OLD, outcome: "completed", detail: "repo-level" });
      await recordAuditEvent(env, { eventType: "test.event", actor: "loopover", targetKey: `${OLD}#42`, outcome: "completed", detail: "pr-level" });
      await recordAuditEvent(env, { eventType: "test.event", actor: "loopover", targetKey: `${OLD}#42`, outcome: "completed", detail: "pr-level, second event, same target_key" });
      await recordAuditEvent(env, { eventType: "test.event", actor: "loopover", targetKey: "some/other-repo#1", outcome: "completed", detail: "unrelated" });

      await renameRepositoryIdentity(env, OLD, NEW);

      const oldRepoLevel = await env.DB.prepare("select count(*) as n from audit_events where target_key = ?").bind(OLD).first<{ n: number }>();
      expect(oldRepoLevel?.n).toBe(0);
      const newRepoLevel = await env.DB.prepare("select count(*) as n from audit_events where target_key = ?").bind(NEW).first<{ n: number }>();
      expect(newRepoLevel?.n).toBe(1);
      const newPrLevel = await env.DB.prepare("select count(*) as n from audit_events where target_key = ?").bind(`${NEW}#42`).first<{ n: number }>();
      expect(newPrLevel?.n).toBe(2); // both rows sharing the same target_key survive -- no uniqueness on this column
      const unrelated = await env.DB.prepare("select count(*) as n from audit_events where target_key = ?").bind("some/other-repo#1").first<{ n: number }>();
      expect(unrelated?.n).toBe(1);
    });
  });
});

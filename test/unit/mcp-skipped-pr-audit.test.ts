import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it } from "vitest";
import { createSessionForGitHubUser, type AuthIdentity } from "../../src/auth/security";
import { recordAuditEvent, upsertInstallation, upsertRepositoryFromGitHub } from "../../src/db/repositories";
import { LoopoverMcp } from "../../src/mcp/server";
import { createTestEnv } from "../helpers/d1";

async function connect(env: Env, identity?: AuthIdentity): Promise<Client> {
  const server = (identity ? new LoopoverMcp(env, identity) : new LoopoverMcp(env)).createServer();
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: "skipped-pr-audit-test", version: "0.1.0" }, { capabilities: {} });
  await client.connect(clientTransport);
  return client;
}

async function seedOwnedRepo(env: Env, installationId: number, owner: string, name: string): Promise<void> {
  await upsertInstallation(env, {
    installation: {
      id: installationId,
      account: { login: owner, id: installationId, type: "User" },
      repository_selection: "selected",
      permissions: { metadata: "read", pull_requests: "read", issues: "write" },
      events: ["pull_request", "repository"],
    },
  });
  await upsertRepositoryFromGitHub(env, { name, full_name: `${owner}/${name}`, private: false, default_branch: "main", owner: { login: owner } }, installationId);
}

type SkippedPrAuditData = {
  generatedAt: string;
  limit: number;
  offset: number;
  hasMore: boolean;
  filters: { repoFullName: string | null; reason: string | null; since: string | null };
  items: Array<{ repoFullName: string; pullNumber: number; reason: string; timestamp: string; remediation: string }>;
};

describe("MCP loopover_get_skipped_pr_audit (#5825)", () => {
  it("returns the default no-filter feed scoped to the caller's own repos", async () => {
    const env = createTestEnv({ ADMIN_GITHUB_LOGINS: "" });
    await seedOwnedRepo(env, 101, "repo-owner", "owned-repo");
    await seedOwnedRepo(env, 202, "victim-org", "secret-repo");
    await recordAuditEvent(env, {
      eventType: "github_app.pr_visibility_skipped",
      actor: "bot-secret",
      targetKey: "repo-owner/owned-repo#4",
      outcome: "completed",
      detail: "bot_author",
      metadata: { token: "github_pat_should_not_export" },
      createdAt: "2026-05-28T00:00:02.000Z",
    });
    await recordAuditEvent(env, {
      eventType: "github_app.pr_visibility_skipped",
      actor: "victim-secret",
      targetKey: "victim-org/secret-repo#7",
      outcome: "completed",
      detail: "maintainer_author",
      metadata: {},
      createdAt: "2026-05-28T00:00:05.000Z",
    });

    const { session } = await createSessionForGitHubUser(env, { login: "repo-owner", id: 101 });
    const client = await connect(env, { kind: "session", actor: "repo-owner", session });
    const result = await client.callTool({ name: "loopover_get_skipped_pr_audit", arguments: {} });
    expect(result.isError).toBeFalsy();
    const data = result.structuredContent as SkippedPrAuditData;
    expect(data.items).toEqual([expect.objectContaining({ repoFullName: "repo-owner/owned-repo", pullNumber: 4, reason: "bot_author" })]);
    expect(data.items[0]?.remediation).toContain("intentionally kept quiet");
    expect(data.limit).toBe(50);
    expect(data.offset).toBe(0);
    expect(data.hasMore).toBe(false);
    expect(data.filters).toEqual({ repoFullName: null, reason: null, since: null });
    expect(JSON.stringify(result.content)).not.toContain("github_pat_should_not_export");
  });

  it("filters by repoFullName, reason, and since independently", async () => {
    const env = createTestEnv({ ADMIN_GITHUB_LOGINS: "operator" });
    await seedOwnedRepo(env, 101, "repo-owner", "owned-repo");
    await recordAuditEvent(env, {
      eventType: "github_app.pr_visibility_skipped",
      actor: "a",
      targetKey: "repo-owner/owned-repo#1",
      outcome: "completed",
      detail: "surface_off",
      metadata: {},
      createdAt: "2026-05-28T00:00:01.000Z",
    });
    await recordAuditEvent(env, {
      eventType: "github_app.pr_visibility_skipped",
      actor: "b",
      targetKey: "repo-owner/owned-repo#2",
      outcome: "completed",
      detail: "missing_author",
      metadata: {},
      createdAt: "2026-05-28T00:00:02.000Z",
    });

    const { session } = await createSessionForGitHubUser(env, { login: "operator", id: 999 });
    const client = await connect(env, { kind: "session", actor: "operator", session });

    const byRepo = await client.callTool({ name: "loopover_get_skipped_pr_audit", arguments: { repoFullName: "repo-owner/owned-repo" } });
    expect((byRepo.structuredContent as SkippedPrAuditData).items).toHaveLength(2);

    const byReason = await client.callTool({ name: "loopover_get_skipped_pr_audit", arguments: { reason: "missing_author" } });
    const byReasonData = byReason.structuredContent as SkippedPrAuditData;
    expect(byReasonData.items).toEqual([expect.objectContaining({ reason: "missing_author", pullNumber: 2 })]);
    expect(byReasonData.filters.reason).toBe("missing_author");

    const bySince = await client.callTool({ name: "loopover_get_skipped_pr_audit", arguments: { since: "2026-05-28T00:00:01.500Z" } });
    const bySinceData = bySince.structuredContent as SkippedPrAuditData;
    expect(bySinceData.items).toEqual([expect.objectContaining({ pullNumber: 2 })]);
    expect(bySinceData.filters.since).toBe("2026-05-28T00:00:01.500Z");
  });

  it("clamps limit to the [1, 100] range and reports hasMore across the boundary", async () => {
    const env = createTestEnv({ ADMIN_GITHUB_LOGINS: "operator" });
    await seedOwnedRepo(env, 101, "repo-owner", "owned-repo");
    for (let n = 1; n <= 3; n += 1) {
      await recordAuditEvent(env, {
        eventType: "github_app.pr_visibility_skipped",
        actor: `actor-${n}`,
        targetKey: `repo-owner/owned-repo#${n}`,
        outcome: "completed",
        detail: "surface_off",
        metadata: {},
        createdAt: `2026-05-28T00:00:0${n}.000Z`,
      });
    }
    const { session } = await createSessionForGitHubUser(env, { login: "operator", id: 999 });
    const client = await connect(env, { kind: "session", actor: "operator", session });

    const overLimit = await client.callTool({ name: "loopover_get_skipped_pr_audit", arguments: { limit: 500 } });
    const overLimitData = overLimit.structuredContent as SkippedPrAuditData;
    expect(overLimitData.limit).toBe(100);
    expect(overLimitData.hasMore).toBe(false);

    const underLimit = await client.callTool({ name: "loopover_get_skipped_pr_audit", arguments: { limit: 1 } });
    const underLimitData = underLimit.structuredContent as SkippedPrAuditData;
    expect(underLimitData.limit).toBe(1);
    expect(underLimitData.hasMore).toBe(true);
    expect(underLimitData.items).toHaveLength(1);
  });

  it("returns an empty page for a scoped repo with no skipped-PR events", async () => {
    const env = createTestEnv({ ADMIN_GITHUB_LOGINS: "" });
    await seedOwnedRepo(env, 101, "repo-owner", "owned-repo");
    const { session } = await createSessionForGitHubUser(env, { login: "repo-owner", id: 101 });
    const client = await connect(env, { kind: "session", actor: "repo-owner", session });
    const result = await client.callTool({ name: "loopover_get_skipped_pr_audit", arguments: {} });
    expect(result.isError).toBeFalsy();
    const data = result.structuredContent as SkippedPrAuditData;
    expect(data.items).toEqual([]);
    expect(data.hasMore).toBe(false);
  });

  it("forbids a session with no maintainer/owner/operator role", async () => {
    const env = createTestEnv({ ADMIN_GITHUB_LOGINS: "" });
    const { session } = await createSessionForGitHubUser(env, { login: "unknown-user", id: 404 });
    const client = await connect(env, { kind: "session", actor: "unknown-user", session });
    const result = await client.callTool({ name: "loopover_get_skipped_pr_audit", arguments: {} });
    expect(result.isError).toBeTruthy();
    expect(JSON.stringify(result.content)).toMatch(/maintainer, owner, or operator role is required/i);
  });

  it("allows a non-operator owner session to explicitly request its own scoped repo by name", async () => {
    const env = createTestEnv({ ADMIN_GITHUB_LOGINS: "" });
    await seedOwnedRepo(env, 101, "repo-owner", "owned-repo");
    await recordAuditEvent(env, {
      eventType: "github_app.pr_visibility_skipped",
      actor: "a",
      targetKey: "repo-owner/owned-repo#3",
      outcome: "completed",
      detail: "surface_off",
      metadata: {},
      createdAt: "2026-05-28T00:00:03.000Z",
    });
    const { session } = await createSessionForGitHubUser(env, { login: "repo-owner", id: 101 });
    const client = await connect(env, { kind: "session", actor: "repo-owner", session });
    const result = await client.callTool({ name: "loopover_get_skipped_pr_audit", arguments: { repoFullName: "repo-owner/owned-repo" } });
    expect(result.isError).toBeFalsy();
    const data = result.structuredContent as SkippedPrAuditData;
    expect(data.items).toEqual([expect.objectContaining({ repoFullName: "repo-owner/owned-repo", pullNumber: 3 })]);
    expect(data.filters.repoFullName).toBe("repo-owner/owned-repo");
  });

  it("forbids a maintainer session from requesting a repo outside its scope", async () => {
    const env = createTestEnv({ ADMIN_GITHUB_LOGINS: "" });
    await seedOwnedRepo(env, 101, "repo-owner", "owned-repo");
    await seedOwnedRepo(env, 202, "victim-org", "secret-repo");
    const { session } = await createSessionForGitHubUser(env, { login: "repo-owner", id: 101 });
    const client = await connect(env, { kind: "session", actor: "repo-owner", session });
    const result = await client.callTool({ name: "loopover_get_skipped_pr_audit", arguments: { repoFullName: "victim-org/secret-repo" } });
    expect(result.isError).toBeTruthy();
    expect(JSON.stringify(result.content)).toMatch(/cannot access this repository's skipped-pr audit/i);
  });

  it("rejects an unparseable since value", async () => {
    const env = createTestEnv({ ADMIN_GITHUB_LOGINS: "operator" });
    const { session } = await createSessionForGitHubUser(env, { login: "operator", id: 999 });
    const client = await connect(env, { kind: "session", actor: "operator", session });
    const result = await client.callTool({ name: "loopover_get_skipped_pr_audit", arguments: { since: "not-a-date" } });
    expect(result.isError).toBeTruthy();
    expect(JSON.stringify(result.content)).toMatch(/not a parseable date/i);
  });

  it("forbids the static mcp identity without the unscoped MCP_READ_REPO_ALLOWLIST opt-in", async () => {
    const env = createTestEnv({ MCP_READ_REPO_ALLOWLIST: "" });
    await seedOwnedRepo(env, 101, "repo-owner", "owned-repo");
    const client = await connect(env);
    const result = await client.callTool({ name: "loopover_get_skipped_pr_audit", arguments: {} });
    expect(result.isError).toBeTruthy();
    expect(JSON.stringify(result.content)).toMatch(/not authorized for the skipped-pr audit/i);
  });

  it("allows the static mcp identity once MCP_READ_REPO_ALLOWLIST is unscoped", async () => {
    const env = createTestEnv({ MCP_READ_REPO_ALLOWLIST: "*" });
    await seedOwnedRepo(env, 101, "repo-owner", "owned-repo");
    await recordAuditEvent(env, {
      eventType: "github_app.pr_visibility_skipped",
      actor: "a",
      targetKey: "repo-owner/owned-repo#9",
      outcome: "completed",
      detail: "not_official_gittensor_miner",
      metadata: {},
      createdAt: "2026-05-28T00:00:09.000Z",
    });
    const client = await connect(env);
    const result = await client.callTool({ name: "loopover_get_skipped_pr_audit", arguments: {} });
    expect(result.isError).toBeFalsy();
    const data = result.structuredContent as SkippedPrAuditData;
    expect(data.items).toEqual([expect.objectContaining({ pullNumber: 9, reason: "not_official_gittensor_miner" })]);
  });

  it("scopes the static mcp identity to an explicit repoFullName filter", async () => {
    const env = createTestEnv({ MCP_READ_REPO_ALLOWLIST: "*" });
    await seedOwnedRepo(env, 101, "repo-owner", "owned-repo");
    await seedOwnedRepo(env, 202, "victim-org", "secret-repo");
    await recordAuditEvent(env, {
      eventType: "github_app.pr_visibility_skipped",
      actor: "a",
      targetKey: "repo-owner/owned-repo#9",
      outcome: "completed",
      detail: "not_official_gittensor_miner",
      metadata: {},
      createdAt: "2026-05-28T00:00:09.000Z",
    });
    await recordAuditEvent(env, {
      eventType: "github_app.pr_visibility_skipped",
      actor: "b",
      targetKey: "victim-org/secret-repo#10",
      outcome: "completed",
      detail: "surface_off",
      metadata: {},
      createdAt: "2026-05-28T00:00:10.000Z",
    });
    const client = await connect(env);
    const result = await client.callTool({ name: "loopover_get_skipped_pr_audit", arguments: { repoFullName: "repo-owner/owned-repo" } });
    expect(result.isError).toBeFalsy();
    const data = result.structuredContent as SkippedPrAuditData;
    expect(data.items).toEqual([expect.objectContaining({ repoFullName: "repo-owner/owned-repo", pullNumber: 9 })]);
  });
});

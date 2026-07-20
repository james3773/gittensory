import { describe, expect, it } from "vitest";
import { listPrVisibilitySkipAuditEvents, recordAuditEvent } from "../../src/db/repositories";
import { createTestEnv } from "../helpers/d1";

describe("skipped PR audit repository export", () => {
  it("bounds queries, scopes repositories, and skips malformed audit targets", async () => {
    const env = createTestEnv();
    await recordAuditEvent(env, {
      eventType: "github_app.pr_visibility_skipped",
      targetKey: "owner/re_po#7",
      outcome: "completed",
      detail: null,
      createdAt: "2026-05-28T00:00:07.000Z",
    });
    await recordAuditEvent(env, {
      eventType: "github_app.pr_visibility_skipped",
      targetKey: "owner/reXpo#8",
      outcome: "completed",
      detail: "bot_author",
      createdAt: "2026-05-28T00:00:08.000Z",
    });
    await recordAuditEvent(env, {
      eventType: "github_app.pr_visibility_skipped",
      targetKey: null,
      outcome: "completed",
      detail: "missing_target",
      createdAt: "2026-05-28T00:00:09.000Z",
    });
    await recordAuditEvent(env, {
      eventType: "github_app.pr_visibility_skipped",
      targetKey: "bad-target",
      outcome: "completed",
      detail: "bad_target",
      createdAt: "2026-05-28T00:00:10.000Z",
    });
    await recordAuditEvent(env, {
      eventType: "github_app.pr_visibility_skipped",
      targetKey: "owner/re_po#0",
      outcome: "completed",
      detail: "bad_number",
      createdAt: "2026-05-28T00:00:11.000Z",
    });
    await recordAuditEvent(env, {
      eventType: "github_app.pr_visibility_skipped",
      targetKey: "owner/re_po#nan",
      outcome: "completed",
      detail: "bad_number",
      createdAt: "2026-05-28T00:00:12.000Z",
    });

    const emptyScope = await listPrVisibilitySkipAuditEvents(env, { repoFullNames: [] });
    expect(emptyScope).toMatchObject({ limit: 50, offset: 0, hasMore: false, items: [] });

    const scoped = await listPrVisibilitySkipAuditEvents(env, {
      limit: Number.NaN,
      repoFullNames: ["owner/re_po", "OWNER/re_po"],
    });
    expect(scoped.limit).toBe(1);
    expect(scoped.offset).toBe(0);
    expect(scoped.items).toEqual([
      {
        repoFullName: "owner/re_po",
        pullNumber: 7,
        reason: "skipped",
        outcome: "completed",
        createdAt: "2026-05-28T00:00:07.000Z",
      },
    ]);

    const unscoped = await listPrVisibilitySkipAuditEvents(env);
    expect(unscoped.limit).toBe(50);
    expect(unscoped.offset).toBe(0);
    expect(unscoped.items.map((item) => item.pullNumber)).toEqual([8, 7]);
  });

  it("pages by offset without dropping earlier parsed rows (#7438)", async () => {
    const env = createTestEnv();
    for (let i = 1; i <= 5; i += 1) {
      await recordAuditEvent(env, {
        eventType: "github_app.pr_visibility_skipped",
        targetKey: `owner/page-repo#${i}`,
        outcome: "completed",
        detail: "bot_author",
        createdAt: `2026-05-28T00:00:0${i}.000Z`,
      });
    }

    const first = await listPrVisibilitySkipAuditEvents(env, { limit: 2, offset: 0 });
    expect(first).toMatchObject({ limit: 2, offset: 0, hasMore: true });
    expect(first.items.map((item) => item.pullNumber)).toEqual([5, 4]);

    const second = await listPrVisibilitySkipAuditEvents(env, { limit: 2, offset: 2 });
    expect(second).toMatchObject({ limit: 2, offset: 2, hasMore: true });
    expect(second.items.map((item) => item.pullNumber)).toEqual([3, 2]);

    const last = await listPrVisibilitySkipAuditEvents(env, { limit: 2, offset: 4 });
    expect(last).toMatchObject({ limit: 2, offset: 4, hasMore: false });
    expect(last.items.map((item) => item.pullNumber)).toEqual([1]);

    const pastEnd = await listPrVisibilitySkipAuditEvents(env, { limit: 2, offset: 5 });
    expect(pastEnd).toMatchObject({ limit: 2, offset: 5, hasMore: false, items: [] });

    const negativeOffset = await listPrVisibilitySkipAuditEvents(env, { limit: 2, offset: -10 });
    expect(negativeOffset.offset).toBe(0);
    expect(negativeOffset.items.map((item) => item.pullNumber)).toEqual([5, 4]);
  });
});

import { describe, expect, it, vi } from "vitest";
import * as repositories from "../../src/db/repositories";
import { writeLiveOverride, type StorageEnv } from "../../src/review/auto-apply";
import { applySelfTuneOverrideToSettings, resolveRepositorySettings } from "../../src/settings/repository-settings";
import type { RepositorySettings } from "../../src/types";
import { createTestEnv } from "../helpers/d1";
import { upsertRepoFocusManifest } from "../../src/signals/focus-manifest-loader";

// The promoted override is ALWAYS a tightening (selftune-wire only ever populates the would-merge error side),
// so the read-back must only ever RAISE an existing readiness threshold — never create or lower one.
const baseSettings = { qualityGateMinScore: 50 } as RepositorySettings;

describe("applySelfTuneOverrideToSettings — tightening-only live read-back (#self-improve)", () => {
  it("RAISES an existing readiness threshold to the promoted floor (confidenceFloor 0.7 → 70)", () => {
    expect(applySelfTuneOverrideToSettings(baseSettings, { confidenceFloor: 0.7 }).qualityGateMinScore).toBe(70);
  });

  it("NEVER lowers — a floor at or below the current threshold is a no-op (same object back)", () => {
    expect(applySelfTuneOverrideToSettings(baseSettings, { confidenceFloor: 0.5 })).toBe(baseSettings); // 50 ≯ 50
    expect(applySelfTuneOverrideToSettings(baseSettings, { confidenceFloor: 0.3 })).toBe(baseSettings); // 30 < 50
  });

  it("NEVER creates a gate the operator didn't set (null threshold ⇒ unchanged)", () => {
    const noGate = { qualityGateMinScore: null } as RepositorySettings;
    expect(applySelfTuneOverrideToSettings(noGate, { confidenceFloor: 0.9 })).toBe(noGate);
  });

  it("no override / no promoted floor ⇒ unchanged", () => {
    expect(applySelfTuneOverrideToSettings(baseSettings, null)).toBe(baseSettings);
    expect(applySelfTuneOverrideToSettings(baseSettings, {})).toBe(baseSettings);
  });
});

describe("resolveRepositorySettings — self-tune override overlay (flag-gated)", () => {
  const repo = "acme/widgets";
  // `autonomy: { review: "auto" }` grants acting-autonomy consent (isAgentConfigured) so the happy-path override
  // read-back is exercised. This wasn't required before the opt-out/consent fix below -- the override used to be
  // read back unconditionally once the global flag was on, regardless of whether the repo had ANY acting
  // autonomy configured. Now the read-back honors the same consent `selfTuneRepos` requires before promoting a
  // NEW override in the first place, so a repo with no acting autonomy (or a revoked one) must not keep having a
  // stale, already-promoted override silently reapplied either.
  async function seed(env: Env, autonomy: Record<string, string> = { review: "auto" }): Promise<void> {
    await env.DB.prepare("INSERT INTO repositories (full_name, owner, name, is_installed, is_registered) VALUES (?, 'acme', 'widgets', 1, 1)").bind(repo).run();
    await repositories.upsertRepositorySettings(env, { repoFullName: repo, qualityGateMinScore: 50, autonomy });
    await writeLiveOverride(env as unknown as StorageEnv, repo, { confidenceFloor: 0.7 });
  }

  it("flag ON: overlays the promoted tightening override (50 → 70)", async () => {
    const env = createTestEnv({ LOOPOVER_REVIEW_SELFTUNE: "true" });
    await seed(env);
    expect((await resolveRepositorySettings(env, repo)).qualityGateMinScore).toBe(70);
  });

  it("flag OFF (default): the override is never read — settings stay byte-identical (50)", async () => {
    const env = createTestEnv();
    await seed(env);
    expect((await resolveRepositorySettings(env, repo)).qualityGateMinScore).toBe(50);
  });

  it("flag ON but per-repo opt-out (`.loopover.yml` review.selftune: false): a previously-promoted override is NOT read back (50, not 70)", async () => {
    const env = createTestEnv({ LOOPOVER_REVIEW_SELFTUNE: "true" });
    await seed(env);
    await upsertRepoFocusManifest(env, repo, { review: { selftune: false } }, "api_record");
    expect((await resolveRepositorySettings(env, repo)).qualityGateMinScore).toBe(50);
  });

  it("flag ON but acting-autonomy consent revoked (no acting autonomy level configured): a previously-promoted override is NOT read back (50, not 70)", async () => {
    const env = createTestEnv({ LOOPOVER_REVIEW_SELFTUNE: "true" });
    await seed(env, {}); // {} normalizes to every class at "observe" (deny-by-default) -- isAgentConfigured is false
    expect((await resolveRepositorySettings(env, repo)).qualityGateMinScore).toBe(50);
  });

  it("merges shared/global blacklist entries with effective repo settings", async () => {
    const env = createTestEnv();
    const repoFullName = "acme/blacklist";
    await env.DB.prepare("INSERT INTO repositories (full_name, owner, name, is_installed, is_registered) VALUES (?, 'acme', 'blacklist', 1, 1)").bind(repoFullName).run();
    await Promise.all([
      repositories.upsertRepositorySettings(env, { repoFullName, qualityGateMinScore: 50 }),
      repositories.upsertGlobalContributorBlacklist(env, { contributorBlacklist: [{ login: "GlobalBad", reason: "global" }] }),
      upsertRepoFocusManifest(env, repoFullName, { settings: { contributorBlacklist: [{ login: "ManifestBad" }] } }, "api_record"),
    ]);

    const settings = await resolveRepositorySettings(env, repoFullName);
    expect(settings.contributorBlacklist?.map((entry) => entry.login)).toEqual(["ManifestBad", "GlobalBad"]);
  });

  it("uses fallback [] when shared/global blacklist read rejects", async () => {
    const env = createTestEnv();
    const repo = "acme/fallback";
    await env.DB.prepare("INSERT INTO repositories (full_name, owner, name, is_installed, is_registered) VALUES (?, 'acme', 'fallback', 1, 1)").bind(repo).run();

    // mockClear immediately after spyOn: under heavy parallel load a prior attempt of THIS test can time out
    // (vitest's global retry: 1) while its body is still in flight (JS can't cancel an in-flight async
    // function), and vi.spyOn on an already-spied method reuses the same mock's call history -- without this,
    // an abandoned first attempt's call leaks into the retry's count and toHaveBeenCalledOnce() flakes.
    const getGlobalSpy = vi.spyOn(repositories, "getGlobalContributorBlacklist").mockRejectedValue(new Error("transient DB issue"));
    getGlobalSpy.mockClear();

    try {
      const settings = await resolveRepositorySettings(env, repo);
      expect(settings.contributorBlacklist).toEqual([]);
      expect(getGlobalSpy).toHaveBeenCalledOnce();
    } finally {
      getGlobalSpy.mockRestore();
    }
  });
});

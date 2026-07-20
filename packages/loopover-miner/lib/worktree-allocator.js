// mkdirSync is still needed for the git-worktree CHECKOUT dirs below (resolveWorktreeBaseDir's tree) — that is
// a filesystem directory, not a store DB path, and is deliberately out of this migration's scope. Only the DB
// handle's own mkdir/chmod moved into openLocalStoreDb.
import { mkdirSync } from "node:fs";
import { homedir, hostname } from "node:os";
import { join } from "node:path";
import { normalizeLocalStoreDbPath, openLocalStoreDb, resolveLocalStoreDbPath } from "./local-store.js";
import { isValidRepoSegment } from "./repo-clone.js";
const defaultDbFileName = "worktree-allocator.sqlite3";
const defaultWorktreeDirName = "worktrees";
const defaultMaxConcurrency = 2;
let defaultWorktreeAllocator = null;
// Age-based orphan reclaim (#7085). Fleet mode (see DEPLOYMENT.md) runs multiple separate CONTAINERS over one
// shared data volume, each with its own PID namespace, so a stored `owner_pid` is meaningless the moment a
// different container opens this store — `isProcessAlive` checks the CALLING process's own namespace, not the
// one that recorded the pid. So we mirror the age-based convention every sibling shared-lease store already uses
// (portfolio-queue-expiry.js's DEFAULT_MAX_LEASE_MS / sweepStuckItems, claim-ledger's DEFAULT_MAX_CLAIM_AGE_MS):
// reclaim any `active` slot older than this regardless of what the pid check reports. Kept well above
// portfolio-queue-expiry's 30-minute floor because a single worktree lease spans a whole coding attempt (clone +
// agent run + push), which can legitimately run for hours; the same-host `isProcessAlive` fast path still frees a
// crashed local owner immediately, so this age fallback only ever governs the cross-container case.
export const DEFAULT_MAX_LEASE_MS = 6 * 60 * 60 * 1000;
export function resolveWorktreeAllocatorDbPath(env = process.env) {
    return resolveLocalStoreDbPath(defaultDbFileName, "LOOPOVER_MINER_WORKTREE_ALLOCATOR_DB", env);
}
export function resolveWorktreeBaseDir(env = process.env) {
    const explicitPath = typeof env.LOOPOVER_MINER_WORKTREE_DIR === "string"
        ? env.LOOPOVER_MINER_WORKTREE_DIR.trim()
        : "";
    if (explicitPath)
        return explicitPath;
    const explicitConfigDir = typeof env.LOOPOVER_MINER_CONFIG_DIR === "string"
        ? env.LOOPOVER_MINER_CONFIG_DIR.trim()
        : "";
    if (explicitConfigDir)
        return join(explicitConfigDir, defaultWorktreeDirName);
    const configHome = typeof env.XDG_CONFIG_HOME === "string" && env.XDG_CONFIG_HOME.trim()
        ? env.XDG_CONFIG_HOME.trim()
        : join(homedir(), ".config");
    return join(configHome, "loopover-miner", defaultWorktreeDirName);
}
function normalizeDbPath(dbPath) {
    return normalizeLocalStoreDbPath(dbPath, resolveWorktreeAllocatorDbPath(), "invalid_worktree_allocator_db_path");
}
function normalizeWorktreeBaseDir(worktreeBaseDir) {
    const path = (worktreeBaseDir ?? resolveWorktreeBaseDir()).trim();
    if (!path)
        throw new Error("invalid_worktree_base_dir");
    return path;
}
function normalizeMaxConcurrency(value) {
    if (value === undefined || value === null)
        return defaultMaxConcurrency;
    if (!Number.isInteger(value) || value < 1)
        throw new Error("invalid_max_concurrency");
    return value;
}
function normalizeMaxLeaseMs(value) {
    if (value === undefined || value === null)
        return DEFAULT_MAX_LEASE_MS;
    if (!Number.isFinite(value) || value < 0)
        throw new Error("invalid_max_lease_ms");
    return value;
}
function normalizeHostId(value) {
    if (value === undefined || value === null)
        return hostname();
    if (typeof value !== "string" || !value.trim())
        throw new Error("invalid_host_id");
    return value.trim();
}
function normalizeRepoFullName(repoFullName) {
    if (typeof repoFullName !== "string")
        throw new Error("invalid_repo_full_name");
    const [owner, repo, extra] = repoFullName.trim().split("/");
    if (!owner || !repo || extra !== undefined)
        throw new Error("invalid_repo_full_name");
    if (!isValidRepoSegment(owner) || !isValidRepoSegment(repo))
        throw new Error("invalid_repo_full_name");
    return `${owner}/${repo}`;
}
function normalizeAttemptId(attemptId) {
    if (typeof attemptId !== "string")
        throw new Error("invalid_attempt_id");
    const trimmed = attemptId.trim();
    if (!trimmed)
        throw new Error("invalid_attempt_id");
    return trimmed;
}
export function isProcessAlive(pid) {
    if (!Number.isInteger(pid) || pid <= 0)
        return false;
    try {
        process.kill(pid, 0);
        return true;
    }
    catch (error) {
        // ESRCH = no such process; EPERM (or similar) means the process exists but we lack signal rights.
        return typeof error === "object" && error !== null && "code" in error && error.code === "ESRCH"
            ? false
            : true;
    }
}
function rowToAllocation(row) {
    return {
        slotIndex: row.slot_index,
        worktreePath: row.worktree_path,
        attemptId: row.attempt_id,
        repoFullName: row.repo_full_name,
        status: row.status,
        ownerPid: row.owner_pid,
        ownerHost: row.owner_host ?? null,
        allocatedAt: row.allocated_at,
    };
}
function ensureSlotTable(db) {
    db.exec(`
    CREATE TABLE IF NOT EXISTS worktree_slots (
      slot_index INTEGER PRIMARY KEY,
      worktree_path TEXT NOT NULL UNIQUE,
      attempt_id TEXT UNIQUE,
      repo_full_name TEXT,
      status TEXT NOT NULL CHECK (status IN ('free', 'active')),
      owner_pid INTEGER,
      owner_host TEXT,
      allocated_at TEXT
    )
  `);
    ensureOwnerHostColumn(db);
}
// Add the owner_host column (#7085) to an on-disk file created before it existed. `CREATE TABLE IF NOT EXISTS`
// above is a no-op against an already-existing table, so a pre-#7085 file needs this explicit ALTER — guarded by
// a presence check (same technique as attempt-log.js's ensureOutcomeColumns). A migrated row keeps owner_host
// NULL until its owner re-acquires, so the age-based reclaim (not the same-host pid fast path) governs it.
function ensureOwnerHostColumn(db) {
    const hasOwnerHost = db
        .prepare("PRAGMA table_info(worktree_slots)")
        .all()
        .some((column) => column.name === "owner_host");
    if (!hasOwnerHost)
        db.exec("ALTER TABLE worktree_slots ADD COLUMN owner_host TEXT");
}
function ensureSlots(db, worktreeBaseDir, maxConcurrency) {
    mkdirSync(worktreeBaseDir, { recursive: true, mode: 0o700 });
    const insert = db.prepare(`
    INSERT OR IGNORE INTO worktree_slots (slot_index, worktree_path, status)
    VALUES (?, ?, 'free')
  `);
    for (let slotIndex = 0; slotIndex < maxConcurrency; slotIndex += 1) {
        const worktreePath = join(worktreeBaseDir, `slot-${slotIndex}`);
        insert.run(slotIndex, worktreePath);
        mkdirSync(worktreePath, { recursive: true, mode: 0o700 });
    }
}
function allocationAgeMs(allocatedAt, nowMs) {
    const allocatedMs = Date.parse(allocatedAt);
    if (!Number.isFinite(allocatedMs))
        return null;
    return nowMs - allocatedMs;
}
/**
 * Decide whether an `active` slot is orphaned and should be reclaimed. Two independent signals:
 * - Age (container-agnostic): a slot whose `allocated_at` is older than `maxLeaseMs` is reclaimed regardless of
 *   what `isProcessAlive` reports, guaranteeing eventual reclaim even when a cross-container caller observes the
 *   owner's pid in the wrong PID namespace. This is the only signal that is sound across fleet mode's separate
 *   containers, so it must never be gated behind the pid check.
 * - Same-host pid liveness (fast path): only when the slot was leased by a process on THIS host (`owner_host`
 *   matches) is `isProcessAlive` a meaningful signal — a confirmed-dead (or missing) local owner frees its slot
 *   immediately without waiting out the lease. A foreign `owner_host` is never trusted for the pid check.
 */
function isSlotOrphaned(row, nowMs, maxLeaseMs, hostId) {
    const ageMs = allocationAgeMs(row.allocated_at, nowMs);
    if (ageMs !== null && ageMs > maxLeaseMs)
        return true;
    if (row.owner_host !== null && row.owner_host === hostId) {
        return row.owner_pid === null || !isProcessAlive(row.owner_pid);
    }
    return false;
}
function reclaimOrphanedAllocations(db, nowMs, maxLeaseMs, hostId) {
    const orphans = db
        .prepare("SELECT slot_index, owner_pid, owner_host, allocated_at FROM worktree_slots WHERE status = 'active'")
        .all();
    const reclaim = db.prepare(`
    UPDATE worktree_slots
    SET status = 'free', attempt_id = NULL, repo_full_name = NULL, owner_pid = NULL, owner_host = NULL, allocated_at = NULL
    WHERE slot_index = ?
  `);
    for (const row of orphans) {
        if (isSlotOrphaned(row, nowMs, maxLeaseMs, hostId))
            reclaim.run(row.slot_index);
    }
}
/**
 * Opens the local worktree allocator store. On startup reclaims orphaned active slots — any slot past its
 * `maxLeaseMs` age (the container-agnostic guarantee for fleet mode's shared store), plus, as a same-host fast
 * path, any slot whose owner pid is confirmed dead in THIS host's PID namespace.
 */
export function openWorktreeAllocator(options = {}) {
    const resolvedPath = normalizeDbPath(options.dbPath);
    const worktreeBaseDir = normalizeWorktreeBaseDir(options.worktreeBaseDir);
    const maxConcurrency = normalizeMaxConcurrency(options.maxConcurrency);
    const maxLeaseMs = normalizeMaxLeaseMs(options.maxLeaseMs);
    const hostId = normalizeHostId(options.hostId);
    const processPid = Number.isInteger(options.processPid) ? options.processPid : process.pid;
    const nowMs = Number.isFinite(options.nowMs) ? options.nowMs : Date.now();
    const db = openLocalStoreDb(resolvedPath);
    ensureSlotTable(db);
    ensureSlots(db, worktreeBaseDir, maxConcurrency);
    reclaimOrphanedAllocations(db, nowMs, maxLeaseMs, hostId);
    const getByAttempt = db.prepare("SELECT slot_index, worktree_path, attempt_id, repo_full_name, status, owner_pid, owner_host, allocated_at FROM worktree_slots WHERE attempt_id = ?");
    const countActive = db.prepare("SELECT COUNT(*) AS count FROM worktree_slots WHERE status = 'active'");
    const selectFreeSlot = db.prepare(`
    SELECT slot_index, worktree_path, attempt_id, repo_full_name, status, owner_pid, owner_host, allocated_at
    FROM worktree_slots
    WHERE status = 'free'
    ORDER BY slot_index
    LIMIT 1
  `);
    const markActive = db.prepare(`
    UPDATE worktree_slots
    SET status = 'active', attempt_id = ?, repo_full_name = ?, owner_pid = ?, owner_host = ?, allocated_at = ?
    WHERE slot_index = ?
  `);
    const releaseByAttempt = db.prepare(`
    UPDATE worktree_slots
    SET status = 'free', attempt_id = NULL, repo_full_name = NULL, owner_pid = NULL, owner_host = NULL, allocated_at = NULL
    WHERE attempt_id = ? AND status = 'active'
    RETURNING slot_index, worktree_path, attempt_id, repo_full_name, status, owner_pid, owner_host, allocated_at
  `);
    const listSlots = db.prepare("SELECT slot_index, worktree_path, attempt_id, repo_full_name, status, owner_pid, owner_host, allocated_at FROM worktree_slots ORDER BY slot_index");
    const allocator = {
        dbPath: resolvedPath,
        worktreeBaseDir,
        maxConcurrency,
        maxLeaseMs,
        processPid,
        hostId,
        acquire(attemptId, repoFullName) {
            const normalizedAttempt = normalizeAttemptId(attemptId);
            const normalizedRepo = normalizeRepoFullName(repoFullName);
            const existing = getByAttempt.get(normalizedAttempt);
            if (existing?.status === "active")
                return rowToAllocation(existing);
            db.exec("BEGIN IMMEDIATE");
            try {
                const raced = getByAttempt.get(normalizedAttempt);
                // In-transaction re-check: only reachable when another process activates the same attempt_id
                // between the pre-BEGIN read and this transaction (covered by miner-worktree-allocator-collisions
                // via child processes; those runs cannot attribute coverage back into this process).
                /* v8 ignore next 4 -- multi-process race; see miner-worktree-allocator-collisions.test.ts */
                if (raced?.status === "active") {
                    db.exec("COMMIT");
                    return rowToAllocation(raced);
                }
                const activeCount = countActive.get().count;
                if (activeCount >= maxConcurrency)
                    throw new Error("worktree_capacity_exceeded");
                const slot = selectFreeSlot.get();
                if (!slot)
                    throw new Error("worktree_capacity_exceeded");
                const allocatedAt = new Date().toISOString();
                markActive.run(normalizedAttempt, normalizedRepo, processPid, hostId, allocatedAt, slot.slot_index);
                db.exec("COMMIT");
                return rowToAllocation({
                    ...slot,
                    attempt_id: normalizedAttempt,
                    repo_full_name: normalizedRepo,
                    status: "active",
                    owner_pid: processPid,
                    owner_host: hostId,
                    allocated_at: allocatedAt,
                });
            }
            catch (error) {
                db.exec("ROLLBACK");
                throw error;
            }
        },
        release(attemptId) {
            const normalizedAttempt = normalizeAttemptId(attemptId);
            const row = releaseByAttempt.get(normalizedAttempt);
            return row ? rowToAllocation(row) : null;
        },
        listSlots() {
            return listSlots.all().map(rowToAllocation);
        },
        close() {
            db.close();
        },
    };
    return allocator;
}
function getDefaultWorktreeAllocator() {
    defaultWorktreeAllocator ??= openWorktreeAllocator();
    return defaultWorktreeAllocator;
}
export function acquireWorktree(attemptId, repoFullName) {
    return getDefaultWorktreeAllocator().acquire(attemptId, repoFullName);
}
export function releaseWorktree(attemptId) {
    return getDefaultWorktreeAllocator().release(attemptId);
}
export function closeDefaultWorktreeAllocator() {
    if (!defaultWorktreeAllocator)
        return;
    defaultWorktreeAllocator.close();
    defaultWorktreeAllocator = null;
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoid29ya3RyZWUtYWxsb2NhdG9yLmpzIiwic291cmNlUm9vdCI6IiIsInNvdXJjZXMiOlsid29ya3RyZWUtYWxsb2NhdG9yLnRzIl0sIm5hbWVzIjpbXSwibWFwcGluZ3MiOiJBQUFBLCtHQUErRztBQUMvRyw4R0FBOEc7QUFDOUcsd0RBQXdEO0FBQ3hELE9BQU8sRUFBRSxTQUFTLEVBQUUsTUFBTSxTQUFTLENBQUM7QUFDcEMsT0FBTyxFQUFFLE9BQU8sRUFBRSxRQUFRLEVBQUUsTUFBTSxTQUFTLENBQUM7QUFDNUMsT0FBTyxFQUFFLElBQUksRUFBRSxNQUFNLFdBQVcsQ0FBQztBQUVqQyxPQUFPLEVBQUUseUJBQXlCLEVBQUUsZ0JBQWdCLEVBQUUsdUJBQXVCLEVBQUUsTUFBTSxrQkFBa0IsQ0FBQztBQUN4RyxPQUFPLEVBQUUsa0JBQWtCLEVBQUUsTUFBTSxpQkFBaUIsQ0FBQztBQTBEckQsTUFBTSxpQkFBaUIsR0FBRyw0QkFBNEIsQ0FBQztBQUN2RCxNQUFNLHNCQUFzQixHQUFHLFdBQVcsQ0FBQztBQUMzQyxNQUFNLHFCQUFxQixHQUFHLENBQUMsQ0FBQztBQUNoQyxJQUFJLHdCQUF3QixHQUE2QixJQUFJLENBQUM7QUFFOUQsOEdBQThHO0FBQzlHLDJHQUEyRztBQUMzRyw4R0FBOEc7QUFDOUcsaUhBQWlIO0FBQ2pILGlIQUFpSDtBQUNqSCxzR0FBc0c7QUFDdEcsaUhBQWlIO0FBQ2pILGtIQUFrSDtBQUNsSCxvR0FBb0c7QUFDcEcsTUFBTSxDQUFDLE1BQU0sb0JBQW9CLEdBQUcsQ0FBQyxHQUFHLEVBQUUsR0FBRyxFQUFFLEdBQUcsSUFBSSxDQUFDO0FBRXZELE1BQU0sVUFBVSw4QkFBOEIsQ0FBQyxNQUEwQyxPQUFPLENBQUMsR0FBRztJQUNsRyxPQUFPLHVCQUF1QixDQUFDLGlCQUFpQixFQUFFLHNDQUFzQyxFQUFFLEdBQUcsQ0FBQyxDQUFDO0FBQ2pHLENBQUM7QUFFRCxNQUFNLFVBQVUsc0JBQXNCLENBQUMsTUFBMEMsT0FBTyxDQUFDLEdBQUc7SUFDMUYsTUFBTSxZQUFZLEdBQUcsT0FBTyxHQUFHLENBQUMsMkJBQTJCLEtBQUssUUFBUTtRQUN0RSxDQUFDLENBQUMsR0FBRyxDQUFDLDJCQUEyQixDQUFDLElBQUksRUFBRTtRQUN4QyxDQUFDLENBQUMsRUFBRSxDQUFDO0lBQ1AsSUFBSSxZQUFZO1FBQUUsT0FBTyxZQUFZLENBQUM7SUFFdEMsTUFBTSxpQkFBaUIsR0FBRyxPQUFPLEdBQUcsQ0FBQyx5QkFBeUIsS0FBSyxRQUFRO1FBQ3pFLENBQUMsQ0FBQyxHQUFHLENBQUMseUJBQXlCLENBQUMsSUFBSSxFQUFFO1FBQ3RDLENBQUMsQ0FBQyxFQUFFLENBQUM7SUFDUCxJQUFJLGlCQUFpQjtRQUFFLE9BQU8sSUFBSSxDQUFDLGlCQUFpQixFQUFFLHNCQUFzQixDQUFDLENBQUM7SUFFOUUsTUFBTSxVQUFVLEdBQUcsT0FBTyxHQUFHLENBQUMsZUFBZSxLQUFLLFFBQVEsSUFBSSxHQUFHLENBQUMsZUFBZSxDQUFDLElBQUksRUFBRTtRQUN0RixDQUFDLENBQUMsR0FBRyxDQUFDLGVBQWUsQ0FBQyxJQUFJLEVBQUU7UUFDNUIsQ0FBQyxDQUFDLElBQUksQ0FBQyxPQUFPLEVBQUUsRUFBRSxTQUFTLENBQUMsQ0FBQztJQUMvQixPQUFPLElBQUksQ0FBQyxVQUFVLEVBQUUsZ0JBQWdCLEVBQUUsc0JBQXNCLENBQUMsQ0FBQztBQUNwRSxDQUFDO0FBRUQsU0FBUyxlQUFlLENBQUMsTUFBaUM7SUFDeEQsT0FBTyx5QkFBeUIsQ0FBQyxNQUFNLEVBQUUsOEJBQThCLEVBQUUsRUFBRSxvQ0FBb0MsQ0FBQyxDQUFDO0FBQ25ILENBQUM7QUFFRCxTQUFTLHdCQUF3QixDQUFDLGVBQTBDO0lBQzFFLE1BQU0sSUFBSSxHQUFHLENBQUMsZUFBZSxJQUFJLHNCQUFzQixFQUFFLENBQUMsQ0FBQyxJQUFJLEVBQUUsQ0FBQztJQUNsRSxJQUFJLENBQUMsSUFBSTtRQUFFLE1BQU0sSUFBSSxLQUFLLENBQUMsMkJBQTJCLENBQUMsQ0FBQztJQUN4RCxPQUFPLElBQUksQ0FBQztBQUNkLENBQUM7QUFFRCxTQUFTLHVCQUF1QixDQUFDLEtBQWdDO0lBQy9ELElBQUksS0FBSyxLQUFLLFNBQVMsSUFBSSxLQUFLLEtBQUssSUFBSTtRQUFFLE9BQU8scUJBQXFCLENBQUM7SUFDeEUsSUFBSSxDQUFDLE1BQU0sQ0FBQyxTQUFTLENBQUMsS0FBSyxDQUFDLElBQUksS0FBSyxHQUFHLENBQUM7UUFBRSxNQUFNLElBQUksS0FBSyxDQUFDLHlCQUF5QixDQUFDLENBQUM7SUFDdEYsT0FBTyxLQUFLLENBQUM7QUFDZixDQUFDO0FBRUQsU0FBUyxtQkFBbUIsQ0FBQyxLQUFnQztJQUMzRCxJQUFJLEtBQUssS0FBSyxTQUFTLElBQUksS0FBSyxLQUFLLElBQUk7UUFBRSxPQUFPLG9CQUFvQixDQUFDO0lBQ3ZFLElBQUksQ0FBQyxNQUFNLENBQUMsUUFBUSxDQUFDLEtBQUssQ0FBQyxJQUFJLEtBQUssR0FBRyxDQUFDO1FBQUUsTUFBTSxJQUFJLEtBQUssQ0FBQyxzQkFBc0IsQ0FBQyxDQUFDO0lBQ2xGLE9BQU8sS0FBSyxDQUFDO0FBQ2YsQ0FBQztBQUVELFNBQVMsZUFBZSxDQUFDLEtBQWM7SUFDckMsSUFBSSxLQUFLLEtBQUssU0FBUyxJQUFJLEtBQUssS0FBSyxJQUFJO1FBQUUsT0FBTyxRQUFRLEVBQUUsQ0FBQztJQUM3RCxJQUFJLE9BQU8sS0FBSyxLQUFLLFFBQVEsSUFBSSxDQUFDLEtBQUssQ0FBQyxJQUFJLEVBQUU7UUFBRSxNQUFNLElBQUksS0FBSyxDQUFDLGlCQUFpQixDQUFDLENBQUM7SUFDbkYsT0FBTyxLQUFLLENBQUMsSUFBSSxFQUFFLENBQUM7QUFDdEIsQ0FBQztBQUVELFNBQVMscUJBQXFCLENBQUMsWUFBcUI7SUFDbEQsSUFBSSxPQUFPLFlBQVksS0FBSyxRQUFRO1FBQUUsTUFBTSxJQUFJLEtBQUssQ0FBQyx3QkFBd0IsQ0FBQyxDQUFDO0lBQ2hGLE1BQU0sQ0FBQyxLQUFLLEVBQUUsSUFBSSxFQUFFLEtBQUssQ0FBQyxHQUFHLFlBQVksQ0FBQyxJQUFJLEVBQUUsQ0FBQyxLQUFLLENBQUMsR0FBRyxDQUFDLENBQUM7SUFDNUQsSUFBSSxDQUFDLEtBQUssSUFBSSxDQUFDLElBQUksSUFBSSxLQUFLLEtBQUssU0FBUztRQUFFLE1BQU0sSUFBSSxLQUFLLENBQUMsd0JBQXdCLENBQUMsQ0FBQztJQUN0RixJQUFJLENBQUMsa0JBQWtCLENBQUMsS0FBSyxDQUFDLElBQUksQ0FBQyxrQkFBa0IsQ0FBQyxJQUFJLENBQUM7UUFBRSxNQUFNLElBQUksS0FBSyxDQUFDLHdCQUF3QixDQUFDLENBQUM7SUFDdkcsT0FBTyxHQUFHLEtBQUssSUFBSSxJQUFJLEVBQUUsQ0FBQztBQUM1QixDQUFDO0FBRUQsU0FBUyxrQkFBa0IsQ0FBQyxTQUFrQjtJQUM1QyxJQUFJLE9BQU8sU0FBUyxLQUFLLFFBQVE7UUFBRSxNQUFNLElBQUksS0FBSyxDQUFDLG9CQUFvQixDQUFDLENBQUM7SUFDekUsTUFBTSxPQUFPLEdBQUcsU0FBUyxDQUFDLElBQUksRUFBRSxDQUFDO0lBQ2pDLElBQUksQ0FBQyxPQUFPO1FBQUUsTUFBTSxJQUFJLEtBQUssQ0FBQyxvQkFBb0IsQ0FBQyxDQUFDO0lBQ3BELE9BQU8sT0FBTyxDQUFDO0FBQ2pCLENBQUM7QUFFRCxNQUFNLFVBQVUsY0FBYyxDQUFDLEdBQVc7SUFDeEMsSUFBSSxDQUFDLE1BQU0sQ0FBQyxTQUFTLENBQUMsR0FBRyxDQUFDLElBQUksR0FBRyxJQUFJLENBQUM7UUFBRSxPQUFPLEtBQUssQ0FBQztJQUNyRCxJQUFJLENBQUM7UUFDSCxPQUFPLENBQUMsSUFBSSxDQUFDLEdBQUcsRUFBRSxDQUFDLENBQUMsQ0FBQztRQUNyQixPQUFPLElBQUksQ0FBQztJQUNkLENBQUM7SUFBQyxPQUFPLEtBQUssRUFBRSxDQUFDO1FBQ2Ysa0dBQWtHO1FBQ2xHLE9BQU8sT0FBTyxLQUFLLEtBQUssUUFBUSxJQUFJLEtBQUssS0FBSyxJQUFJLElBQUksTUFBTSxJQUFJLEtBQUssSUFBSSxLQUFLLENBQUMsSUFBSSxLQUFLLE9BQU87WUFDN0YsQ0FBQyxDQUFDLEtBQUs7WUFDUCxDQUFDLENBQUMsSUFBSSxDQUFDO0lBQ1gsQ0FBQztBQUNILENBQUM7QUFFRCxTQUFTLGVBQWUsQ0FBQyxHQUFvQjtJQUMzQyxPQUFPO1FBQ0wsU0FBUyxFQUFFLEdBQUcsQ0FBQyxVQUFVO1FBQ3pCLFlBQVksRUFBRSxHQUFHLENBQUMsYUFBYTtRQUMvQixTQUFTLEVBQUUsR0FBRyxDQUFDLFVBQVU7UUFDekIsWUFBWSxFQUFFLEdBQUcsQ0FBQyxjQUFjO1FBQ2hDLE1BQU0sRUFBRSxHQUFHLENBQUMsTUFBTTtRQUNsQixRQUFRLEVBQUUsR0FBRyxDQUFDLFNBQVM7UUFDdkIsU0FBUyxFQUFFLEdBQUcsQ0FBQyxVQUFVLElBQUksSUFBSTtRQUNqQyxXQUFXLEVBQUUsR0FBRyxDQUFDLFlBQVk7S0FDOUIsQ0FBQztBQUNKLENBQUM7QUFFRCxTQUFTLGVBQWUsQ0FBQyxFQUFnQjtJQUN2QyxFQUFFLENBQUMsSUFBSSxDQUFDOzs7Ozs7Ozs7OztHQVdQLENBQUMsQ0FBQztJQUNILHFCQUFxQixDQUFDLEVBQUUsQ0FBQyxDQUFDO0FBQzVCLENBQUM7QUFFRCwrR0FBK0c7QUFDL0csaUhBQWlIO0FBQ2pILDhHQUE4RztBQUM5RywyR0FBMkc7QUFDM0csU0FBUyxxQkFBcUIsQ0FBQyxFQUFnQjtJQUM3QyxNQUFNLFlBQVksR0FBRyxFQUFFO1NBQ3BCLE9BQU8sQ0FBQyxtQ0FBbUMsQ0FBQztTQUM1QyxHQUFHLEVBQUU7U0FDTCxJQUFJLENBQUMsQ0FBQyxNQUFNLEVBQUUsRUFBRSxDQUFFLE1BQXVCLENBQUMsSUFBSSxLQUFLLFlBQVksQ0FBQyxDQUFDO0lBQ3BFLElBQUksQ0FBQyxZQUFZO1FBQUUsRUFBRSxDQUFDLElBQUksQ0FBQyx1REFBdUQsQ0FBQyxDQUFDO0FBQ3RGLENBQUM7QUFFRCxTQUFTLFdBQVcsQ0FBQyxFQUFnQixFQUFFLGVBQXVCLEVBQUUsY0FBc0I7SUFDcEYsU0FBUyxDQUFDLGVBQWUsRUFBRSxFQUFFLFNBQVMsRUFBRSxJQUFJLEVBQUUsSUFBSSxFQUFFLEtBQUssRUFBRSxDQUFDLENBQUM7SUFDN0QsTUFBTSxNQUFNLEdBQUcsRUFBRSxDQUFDLE9BQU8sQ0FBQzs7O0dBR3pCLENBQUMsQ0FBQztJQUNILEtBQUssSUFBSSxTQUFTLEdBQUcsQ0FBQyxFQUFFLFNBQVMsR0FBRyxjQUFjLEVBQUUsU0FBUyxJQUFJLENBQUMsRUFBRSxDQUFDO1FBQ25FLE1BQU0sWUFBWSxHQUFHLElBQUksQ0FBQyxlQUFlLEVBQUUsUUFBUSxTQUFTLEVBQUUsQ0FBQyxDQUFDO1FBQ2hFLE1BQU0sQ0FBQyxHQUFHLENBQUMsU0FBUyxFQUFFLFlBQVksQ0FBQyxDQUFDO1FBQ3BDLFNBQVMsQ0FBQyxZQUFZLEVBQUUsRUFBRSxTQUFTLEVBQUUsSUFBSSxFQUFFLElBQUksRUFBRSxLQUFLLEVBQUUsQ0FBQyxDQUFDO0lBQzVELENBQUM7QUFDSCxDQUFDO0FBRUQsU0FBUyxlQUFlLENBQUMsV0FBMEIsRUFBRSxLQUFhO0lBQ2hFLE1BQU0sV0FBVyxHQUFHLElBQUksQ0FBQyxLQUFLLENBQUMsV0FBcUIsQ0FBQyxDQUFDO0lBQ3RELElBQUksQ0FBQyxNQUFNLENBQUMsUUFBUSxDQUFDLFdBQVcsQ0FBQztRQUFFLE9BQU8sSUFBSSxDQUFDO0lBQy9DLE9BQU8sS0FBSyxHQUFHLFdBQVcsQ0FBQztBQUM3QixDQUFDO0FBRUQ7Ozs7Ozs7OztHQVNHO0FBQ0gsU0FBUyxjQUFjLENBQUMsR0FBbUIsRUFBRSxLQUFhLEVBQUUsVUFBa0IsRUFBRSxNQUFjO0lBQzVGLE1BQU0sS0FBSyxHQUFHLGVBQWUsQ0FBQyxHQUFHLENBQUMsWUFBWSxFQUFFLEtBQUssQ0FBQyxDQUFDO0lBQ3ZELElBQUksS0FBSyxLQUFLLElBQUksSUFBSSxLQUFLLEdBQUcsVUFBVTtRQUFFLE9BQU8sSUFBSSxDQUFDO0lBQ3RELElBQUksR0FBRyxDQUFDLFVBQVUsS0FBSyxJQUFJLElBQUksR0FBRyxDQUFDLFVBQVUsS0FBSyxNQUFNLEVBQUUsQ0FBQztRQUN6RCxPQUFPLEdBQUcsQ0FBQyxTQUFTLEtBQUssSUFBSSxJQUFJLENBQUMsY0FBYyxDQUFDLEdBQUcsQ0FBQyxTQUFTLENBQUMsQ0FBQztJQUNsRSxDQUFDO0lBQ0QsT0FBTyxLQUFLLENBQUM7QUFDZixDQUFDO0FBRUQsU0FBUywwQkFBMEIsQ0FBQyxFQUFnQixFQUFFLEtBQWEsRUFBRSxVQUFrQixFQUFFLE1BQWM7SUFDckcsTUFBTSxPQUFPLEdBQUcsRUFBRTtTQUNmLE9BQU8sQ0FBQyxvR0FBb0csQ0FBQztTQUM3RyxHQUFHLEVBQXNCLENBQUM7SUFDN0IsTUFBTSxPQUFPLEdBQUcsRUFBRSxDQUFDLE9BQU8sQ0FBQzs7OztHQUkxQixDQUFDLENBQUM7SUFDSCxLQUFLLE1BQU0sR0FBRyxJQUFJLE9BQU8sRUFBRSxDQUFDO1FBQzFCLElBQUksY0FBYyxDQUFDLEdBQUcsRUFBRSxLQUFLLEVBQUUsVUFBVSxFQUFFLE1BQU0sQ0FBQztZQUFFLE9BQU8sQ0FBQyxHQUFHLENBQUMsR0FBRyxDQUFDLFVBQVUsQ0FBQyxDQUFDO0lBQ2xGLENBQUM7QUFDSCxDQUFDO0FBRUQ7Ozs7R0FJRztBQUNILE1BQU0sVUFBVSxxQkFBcUIsQ0FBQyxVQVFsQyxFQUFFO0lBQ0osTUFBTSxZQUFZLEdBQUcsZUFBZSxDQUFDLE9BQU8sQ0FBQyxNQUFNLENBQUMsQ0FBQztJQUNyRCxNQUFNLGVBQWUsR0FBRyx3QkFBd0IsQ0FBQyxPQUFPLENBQUMsZUFBZSxDQUFDLENBQUM7SUFDMUUsTUFBTSxjQUFjLEdBQUcsdUJBQXVCLENBQUMsT0FBTyxDQUFDLGNBQWMsQ0FBQyxDQUFDO0lBQ3ZFLE1BQU0sVUFBVSxHQUFHLG1CQUFtQixDQUFDLE9BQU8sQ0FBQyxVQUFVLENBQUMsQ0FBQztJQUMzRCxNQUFNLE1BQU0sR0FBRyxlQUFlLENBQUMsT0FBTyxDQUFDLE1BQU0sQ0FBQyxDQUFDO0lBQy9DLE1BQU0sVUFBVSxHQUFHLE1BQU0sQ0FBQyxTQUFTLENBQUMsT0FBTyxDQUFDLFVBQVUsQ0FBQyxDQUFDLENBQUMsQ0FBQyxPQUFPLENBQUMsVUFBb0IsQ0FBQyxDQUFDLENBQUMsT0FBTyxDQUFDLEdBQUcsQ0FBQztJQUNyRyxNQUFNLEtBQUssR0FBRyxNQUFNLENBQUMsUUFBUSxDQUFDLE9BQU8sQ0FBQyxLQUFLLENBQUMsQ0FBQyxDQUFDLENBQUMsT0FBTyxDQUFDLEtBQWUsQ0FBQyxDQUFDLENBQUMsSUFBSSxDQUFDLEdBQUcsRUFBRSxDQUFDO0lBRXBGLE1BQU0sRUFBRSxHQUFHLGdCQUFnQixDQUFDLFlBQVksQ0FBQyxDQUFDO0lBQzFDLGVBQWUsQ0FBQyxFQUFFLENBQUMsQ0FBQztJQUNwQixXQUFXLENBQUMsRUFBRSxFQUFFLGVBQWUsRUFBRSxjQUFjLENBQUMsQ0FBQztJQUNqRCwwQkFBMEIsQ0FBQyxFQUFFLEVBQUUsS0FBSyxFQUFFLFVBQVUsRUFBRSxNQUFNLENBQUMsQ0FBQztJQUUxRCxNQUFNLFlBQVksR0FBRyxFQUFFLENBQUMsT0FBTyxDQUM3QixvSkFBb0osQ0FDckosQ0FBQztJQUNGLE1BQU0sV0FBVyxHQUFHLEVBQUUsQ0FBQyxPQUFPLENBQUMsc0VBQXNFLENBQUMsQ0FBQztJQUN2RyxNQUFNLGNBQWMsR0FBRyxFQUFFLENBQUMsT0FBTyxDQUFDOzs7Ozs7R0FNakMsQ0FBQyxDQUFDO0lBQ0gsTUFBTSxVQUFVLEdBQUcsRUFBRSxDQUFDLE9BQU8sQ0FBQzs7OztHQUk3QixDQUFDLENBQUM7SUFDSCxNQUFNLGdCQUFnQixHQUFHLEVBQUUsQ0FBQyxPQUFPLENBQUM7Ozs7O0dBS25DLENBQUMsQ0FBQztJQUNILE1BQU0sU0FBUyxHQUFHLEVBQUUsQ0FBQyxPQUFPLENBQzFCLG1KQUFtSixDQUNwSixDQUFDO0lBRUYsTUFBTSxTQUFTLEdBQXNCO1FBQ25DLE1BQU0sRUFBRSxZQUFZO1FBQ3BCLGVBQWU7UUFDZixjQUFjO1FBQ2QsVUFBVTtRQUNWLFVBQVU7UUFDVixNQUFNO1FBQ04sT0FBTyxDQUFDLFNBQVMsRUFBRSxZQUFZO1lBQzdCLE1BQU0saUJBQWlCLEdBQUcsa0JBQWtCLENBQUMsU0FBUyxDQUFDLENBQUM7WUFDeEQsTUFBTSxjQUFjLEdBQUcscUJBQXFCLENBQUMsWUFBWSxDQUFDLENBQUM7WUFDM0QsTUFBTSxRQUFRLEdBQUcsWUFBWSxDQUFDLEdBQUcsQ0FBQyxpQkFBaUIsQ0FBZ0MsQ0FBQztZQUNwRixJQUFJLFFBQVEsRUFBRSxNQUFNLEtBQUssUUFBUTtnQkFBRSxPQUFPLGVBQWUsQ0FBQyxRQUFRLENBQUMsQ0FBQztZQUVwRSxFQUFFLENBQUMsSUFBSSxDQUFDLGlCQUFpQixDQUFDLENBQUM7WUFDM0IsSUFBSSxDQUFDO2dCQUNILE1BQU0sS0FBSyxHQUFHLFlBQVksQ0FBQyxHQUFHLENBQUMsaUJBQWlCLENBQWdDLENBQUM7Z0JBQ2pGLDZGQUE2RjtnQkFDN0Ysa0dBQWtHO2dCQUNsRyxxRkFBcUY7Z0JBQ3JGLDZGQUE2RjtnQkFDN0YsSUFBSSxLQUFLLEVBQUUsTUFBTSxLQUFLLFFBQVEsRUFBRSxDQUFDO29CQUMvQixFQUFFLENBQUMsSUFBSSxDQUFDLFFBQVEsQ0FBQyxDQUFDO29CQUNsQixPQUFPLGVBQWUsQ0FBQyxLQUFLLENBQUMsQ0FBQztnQkFDaEMsQ0FBQztnQkFDRCxNQUFNLFdBQVcsR0FBSSxXQUFXLENBQUMsR0FBRyxFQUFlLENBQUMsS0FBSyxDQUFDO2dCQUMxRCxJQUFJLFdBQVcsSUFBSSxjQUFjO29CQUFFLE1BQU0sSUFBSSxLQUFLLENBQUMsNEJBQTRCLENBQUMsQ0FBQztnQkFDakYsTUFBTSxJQUFJLEdBQUcsY0FBYyxDQUFDLEdBQUcsRUFBaUMsQ0FBQztnQkFDakUsSUFBSSxDQUFDLElBQUk7b0JBQUUsTUFBTSxJQUFJLEtBQUssQ0FBQyw0QkFBNEIsQ0FBQyxDQUFDO2dCQUN6RCxNQUFNLFdBQVcsR0FBRyxJQUFJLElBQUksRUFBRSxDQUFDLFdBQVcsRUFBRSxDQUFDO2dCQUM3QyxVQUFVLENBQUMsR0FBRyxDQUFDLGlCQUFpQixFQUFFLGNBQWMsRUFBRSxVQUFVLEVBQUUsTUFBTSxFQUFFLFdBQVcsRUFBRSxJQUFJLENBQUMsVUFBVSxDQUFDLENBQUM7Z0JBQ3BHLEVBQUUsQ0FBQyxJQUFJLENBQUMsUUFBUSxDQUFDLENBQUM7Z0JBQ2xCLE9BQU8sZUFBZSxDQUFDO29CQUNyQixHQUFHLElBQUk7b0JBQ1AsVUFBVSxFQUFFLGlCQUFpQjtvQkFDN0IsY0FBYyxFQUFFLGNBQWM7b0JBQzlCLE1BQU0sRUFBRSxRQUFRO29CQUNoQixTQUFTLEVBQUUsVUFBVTtvQkFDckIsVUFBVSxFQUFFLE1BQU07b0JBQ2xCLFlBQVksRUFBRSxXQUFXO2lCQUMxQixDQUFDLENBQUM7WUFDTCxDQUFDO1lBQUMsT0FBTyxLQUFLLEVBQUUsQ0FBQztnQkFDZixFQUFFLENBQUMsSUFBSSxDQUFDLFVBQVUsQ0FBQyxDQUFDO2dCQUNwQixNQUFNLEtBQUssQ0FBQztZQUNkLENBQUM7UUFDSCxDQUFDO1FBQ0QsT0FBTyxDQUFDLFNBQVM7WUFDZixNQUFNLGlCQUFpQixHQUFHLGtCQUFrQixDQUFDLFNBQVMsQ0FBQyxDQUFDO1lBQ3hELE1BQU0sR0FBRyxHQUFHLGdCQUFnQixDQUFDLEdBQUcsQ0FBQyxpQkFBaUIsQ0FBZ0MsQ0FBQztZQUNuRixPQUFPLEdBQUcsQ0FBQyxDQUFDLENBQUMsZUFBZSxDQUFDLEdBQUcsQ0FBQyxDQUFDLENBQUMsQ0FBQyxJQUFJLENBQUM7UUFDM0MsQ0FBQztRQUNELFNBQVM7WUFDUCxPQUFRLFNBQVMsQ0FBQyxHQUFHLEVBQXdCLENBQUMsR0FBRyxDQUFDLGVBQWUsQ0FBQyxDQUFDO1FBQ3JFLENBQUM7UUFDRCxLQUFLO1lBQ0gsRUFBRSxDQUFDLEtBQUssRUFBRSxDQUFDO1FBQ2IsQ0FBQztLQUNGLENBQUM7SUFFRixPQUFPLFNBQVMsQ0FBQztBQUNuQixDQUFDO0FBRUQsU0FBUywyQkFBMkI7SUFDbEMsd0JBQXdCLEtBQUsscUJBQXFCLEVBQUUsQ0FBQztJQUNyRCxPQUFPLHdCQUF3QixDQUFDO0FBQ2xDLENBQUM7QUFFRCxNQUFNLFVBQVUsZUFBZSxDQUFDLFNBQWlCLEVBQUUsWUFBb0I7SUFDckUsT0FBTywyQkFBMkIsRUFBRSxDQUFDLE9BQU8sQ0FBQyxTQUFTLEVBQUUsWUFBWSxDQUFDLENBQUM7QUFDeEUsQ0FBQztBQUVELE1BQU0sVUFBVSxlQUFlLENBQUMsU0FBaUI7SUFDL0MsT0FBTywyQkFBMkIsRUFBRSxDQUFDLE9BQU8sQ0FBQyxTQUFTLENBQUMsQ0FBQztBQUMxRCxDQUFDO0FBRUQsTUFBTSxVQUFVLDZCQUE2QjtJQUMzQyxJQUFJLENBQUMsd0JBQXdCO1FBQUUsT0FBTztJQUN0Qyx3QkFBd0IsQ0FBQyxLQUFLLEVBQUUsQ0FBQztJQUNqQyx3QkFBd0IsR0FBRyxJQUFJLENBQUM7QUFDbEMsQ0FBQyJ9
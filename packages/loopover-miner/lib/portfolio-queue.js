import { DEFAULT_FORGE_CONFIG } from "./forge-config.js";
import { normalizeLocalStoreDbPath, openLocalStoreDb, resolveLocalStoreDbPath } from "./local-store.js";
import { isValidRepoSegment } from "./repo-clone.js";
import { applySchemaMigrations } from "./schema-version.js";
import { PORTFOLIO_QUEUE_PURGE_SPEC, purgeStoreByRepo } from "./store-maintenance.js";
export const QUEUE_STATUSES = Object.freeze(["queued", "in_progress", "done"]);
const defaultDbFileName = "portfolio-queue.sqlite3";
let defaultPortfolioQueueStore = null;
export function resolvePortfolioQueueDbPath(env = process.env) {
    return resolveLocalStoreDbPath(defaultDbFileName, "LOOPOVER_MINER_PORTFOLIO_QUEUE_DB", env);
}
function normalizeDbPath(dbPath) {
    return normalizeLocalStoreDbPath(dbPath, resolvePortfolioQueueDbPath(), "invalid_portfolio_queue_db_path");
}
function normalizeRepoFullName(repoFullName) {
    if (typeof repoFullName !== "string")
        throw new Error("invalid_repo_full_name");
    const trimmed = repoFullName.trim();
    const [owner, repo, extra] = trimmed.split("/");
    if (!owner || !repo || extra !== undefined)
        throw new Error("invalid_repo_full_name");
    if (!isValidRepoSegment(owner) || !isValidRepoSegment(repo))
        throw new Error("invalid_repo_full_name");
    return `${owner}/${repo}`;
}
function normalizeIdentifier(identifier) {
    if (typeof identifier !== "string")
        throw new Error("invalid_identifier");
    const trimmed = identifier.trim();
    if (!trimmed)
        throw new Error("invalid_identifier");
    return trimmed;
}
/** Priority is a placeholder numeric input; an omitted priority defaults to 0, a non-finite or negative one is rejected. */
function normalizePriority(priority) {
    if (priority === undefined || priority === null)
        return 0;
    if (typeof priority !== "number" || !Number.isFinite(priority) || priority < 0) {
        throw new Error("invalid_priority");
    }
    return priority;
}
/** Optional forge host, scoping rows so two hosts serving the same owner/repo name never collide (#5563).
 *  Omitted/nullish → the github.com default, so every pre-existing single-forge caller is unaffected. */
function normalizeApiBaseUrl(apiBaseUrl) {
    if (apiBaseUrl === undefined || apiBaseUrl === null)
        return DEFAULT_FORGE_CONFIG.apiBaseUrl;
    if (typeof apiBaseUrl !== "string" || !apiBaseUrl.trim())
        throw new Error("invalid_api_base_url");
    return apiBaseUrl.trim();
}
function rowToEntry(row) {
    return {
        apiBaseUrl: row.api_base_url,
        repoFullName: row.repo_full_name,
        identifier: row.identifier,
        priority: row.priority,
        status: row.status,
        enqueuedAt: row.enqueued_at,
    };
}
/** Lease-annotated projection of an in-flight row (adds `leasedAt`), consumed by the expiry sweep. Kept separate
 *  from `rowToEntry` so the base entry shape every existing caller relies on is unchanged. */
function rowToLeaseEntry(row) {
    return {
        apiBaseUrl: row.api_base_url,
        repoFullName: row.repo_full_name,
        identifier: row.identifier,
        status: row.status,
        leasedAt: row.leased_at ?? null,
    };
}
function asPortfolioQueueDbRow(row) {
    return row;
}
/**
 * Opens the local portfolio/queue store, creating the table on first use. Rows are ordered highest-priority-first
 * with an insertion-order tie-break: `priority DESC, enqueued_at ASC, rowid ASC` — the implicit `rowid` guarantees
 * FIFO order even when two items share a priority AND an `enqueued_at` timestamp. (#2292)
 */
export function initPortfolioQueueStore(dbPath = resolvePortfolioQueueDbPath()) {
    const resolvedPath = normalizeDbPath(dbPath);
    // openLocalStoreDb skips mkdir/chmod for the special in-memory path (':memory:'), which has no file on disk.
    const db = openLocalStoreDb(resolvedPath);
    db.exec(`
    CREATE TABLE IF NOT EXISTS miner_portfolio_queue (
      repo_full_name TEXT NOT NULL,
      identifier TEXT NOT NULL,
      priority REAL NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'in_progress', 'done')),
      enqueued_at TEXT NOT NULL,
      leased_at TEXT,
      PRIMARY KEY (repo_full_name, identifier)
    )
  `);
    // `leased_at` records when an item was flipped to 'in_progress', so a crashed/killed process's stuck lease can be
    // swept back to 'queued' by age (see portfolio-queue-expiry.js) instead of stranding the item forever — the same
    // recovery the claim-ledger and worktree-allocator stores already provide for their own tables (#4827). Additive
    // migration for stores created before this column: CREATE TABLE IF NOT EXISTS never adds a column to a pre-existing
    // table, so add it idempotently. Expressed as the store's first schema migration (#4832): the baseline table is
    // version 1; migration 1→2 adds `leased_at`. The migration stays defensive (checks table_info) so a version-0
    // file that already ran the pre-convention ad-hoc ALTER is not re-altered into a duplicate-column error.
    //
    // v2 -> v3 (#5563): rebuild PRIMARY KEY (repo_full_name, identifier) into PRIMARY KEY (api_base_url,
    // repo_full_name, identifier) -- two forge hosts serving a same-named owner/repo must not collide in this
    // queue. SQLite cannot ALTER a PRIMARY KEY in place, so this rebuilds the table: create the new shape, copy
    // every existing row with the pre-#4784 implicit single-forge default backfilled, drop the old table, rename
    // the new one in.
    applySchemaMigrations(db, [
        (migrationDb) => {
            const hasLeasedAtColumn = migrationDb
                .prepare("PRAGMA table_info(miner_portfolio_queue)")
                .all()
                .some((column) => column.name === "leased_at");
            if (!hasLeasedAtColumn)
                migrationDb.exec("ALTER TABLE miner_portfolio_queue ADD COLUMN leased_at TEXT");
        },
        (migrationDb) => {
            migrationDb.exec(`
        CREATE TABLE miner_portfolio_queue_v3 (
          api_base_url TEXT NOT NULL,
          repo_full_name TEXT NOT NULL,
          identifier TEXT NOT NULL,
          priority REAL NOT NULL DEFAULT 0,
          status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'in_progress', 'done')),
          enqueued_at TEXT NOT NULL,
          leased_at TEXT,
          PRIMARY KEY (api_base_url, repo_full_name, identifier)
        )
      `);
            // ORDER BY rowid preserves the old table's FIFO insertion order in the new table's freshly-assigned rowids
            // (the composite PRIMARY KEY above is not itself the rowid), so this rebuild doesn't reshuffle queue order.
            // OR IGNORE: a row this store's own read path already treats as unusable garbage (an unrecognized
            // `status`, e.g. from a hand-edited or otherwise corrupted file) would violate the CHECK constraint above
            // and abort the whole migration. Skipping it here is consistent with that same fail-closed posture, rather
            // than turning one bad row into a permanently unmigratable file.
            migrationDb
                .prepare(`INSERT OR IGNORE INTO miner_portfolio_queue_v3
             (api_base_url, repo_full_name, identifier, priority, status, enqueued_at, leased_at)
           SELECT ?, repo_full_name, identifier, priority, status, enqueued_at, leased_at
           FROM miner_portfolio_queue ORDER BY rowid`)
                .run(DEFAULT_FORGE_CONFIG.apiBaseUrl);
            migrationDb.exec("DROP TABLE miner_portfolio_queue");
            migrationDb.exec("ALTER TABLE miner_portfolio_queue_v3 RENAME TO miner_portfolio_queue");
        },
        // v3 -> v4 (#5654): three attempt-history counters feeding non-convergence.ts's real
        // PortfolioConvergenceInput (see getAttemptHistory below) -- additive columns, same
        // defensive column-presence guard as the leased_at migration above.
        (migrationDb) => {
            const existingColumns = migrationDb
                .prepare("PRAGMA table_info(miner_portfolio_queue)")
                .all()
                .map((column) => column.name);
            if (!existingColumns.includes("attempts_count")) {
                migrationDb.exec("ALTER TABLE miner_portfolio_queue ADD COLUMN attempts_count INTEGER NOT NULL DEFAULT 0");
            }
            if (!existingColumns.includes("consecutive_failures")) {
                migrationDb.exec("ALTER TABLE miner_portfolio_queue ADD COLUMN consecutive_failures INTEGER NOT NULL DEFAULT 0");
            }
            if (!existingColumns.includes("reenqueue_count")) {
                migrationDb.exec("ALTER TABLE miner_portfolio_queue ADD COLUMN reenqueue_count INTEGER NOT NULL DEFAULT 0");
            }
        },
        // v4 -> v5 (#4939): additive tenant-scoping column, a prerequisite for any hosted, multi-tenant use of this
        // same store's logic. NULL for every row today -- self-host behavior is byte-identical, since nothing reads
        // or writes it yet (no consumer exists until a future hosted deployment populates it). Same defensive
        // column-presence guard as the v3->v4 migration immediately above.
        (migrationDb) => {
            const hasTenantIdColumn = migrationDb
                .prepare("PRAGMA table_info(miner_portfolio_queue)")
                .all()
                .some((column) => column.name === "tenant_id");
            if (!hasTenantIdColumn)
                migrationDb.exec("ALTER TABLE miner_portfolio_queue ADD COLUMN tenant_id TEXT");
        },
    ]);
    // `rowid` is a stable, unique key assigned once at first insert (re-enqueue updates in place, never re-inserts),
    // so it is a deterministic total-order tie-break: two items sharing a priority AND an `enqueued_at` timestamp
    // still order by insertion.
    const ORDER = "ORDER BY priority DESC, enqueued_at ASC, rowid ASC";
    // Re-enqueueing an already-tracked item re-activates it IN PLACE: refresh its (placeholder) priority and reset it
    // to 'queued', but KEEP the original `enqueued_at` and `rowid` so it holds its existing FIFO position rather than
    // jumping the queue. (Restamping `enqueued_at` would be inconsistent — the fixed `rowid` still pins the old
    // position whenever timestamps collide — so position is deliberately preserved instead.)
    const enqueueStatement = db.prepare(`
    INSERT INTO miner_portfolio_queue (api_base_url, repo_full_name, identifier, priority, status, enqueued_at)
    VALUES (?, ?, ?, ?, 'queued', ?)
    ON CONFLICT(api_base_url, repo_full_name, identifier) DO UPDATE SET
      priority = excluded.priority,
      status = 'queued'
    WHERE miner_portfolio_queue.status <> 'in_progress'
  `);
    const getStatement = db.prepare("SELECT * FROM miner_portfolio_queue WHERE api_base_url = ? AND repo_full_name = ? AND identifier = ?");
    // Claim the highest-priority queued item ATOMICALLY: one UPDATE selects the ordered top row in a subquery and
    // flips it to 'in_progress', RETURNING it — so two processes sharing the file can't both claim the same row (a
    // separate SELECT-then-UPDATE would race). Deliberately global (no api_base_url filter): the queue is a single
    // cross-host priority ordering, not a per-host one.
    // Claiming stamps `leased_at` with the caller-supplied claim time and increments the attempt-history
    // `attempts_count` (#5654, non-convergence.ts's real PortfolioConvergenceInput.attempts) -- leaving
    // 'in_progress' (done/failed/reclaim) clears leased_at back to NULL so only genuinely in-flight rows carry
    // a lease.
    const dequeueStatement = db.prepare(`
    UPDATE miner_portfolio_queue SET status = 'in_progress', leased_at = ?, attempts_count = attempts_count + 1
    WHERE rowid = (
      SELECT rowid FROM miner_portfolio_queue WHERE status = 'queued' ${ORDER} LIMIT 1
    )
    RETURNING *
  `);
    // RETURNING (rather than a separate post-UPDATE SELECT) makes the "nothing to mark done" case observable
    // directly from one atomic statement. consecutive_failures resets to 0 on reaching done (#5654) -- the
    // active failure streak breaks the moment an attempt actually succeeds; reenqueue_count is a lifetime
    // total and deliberately untouched here (see getAttemptHistory's own doc comment).
    const markDoneStatement = db.prepare(`
    UPDATE miner_portfolio_queue SET status = 'done', leased_at = NULL, consecutive_failures = 0
    WHERE api_base_url = ? AND repo_full_name = ? AND identifier = ? AND status <> 'done'
    RETURNING *
  `);
    // Releasing an in-flight item back to queued WITHOUT reaching done is exactly non-convergence.ts's own
    // "cycling queued -> in_progress -> queued without ever reaching done" reenqueue trigger (#5654) -- same
    // counters, same increment, as reclaimStuckItem below (both are this same transition, just different
    // callers: a run-halt release here vs. a stale-lease sweep there).
    const markFailedStatement = db.prepare(`
    UPDATE miner_portfolio_queue SET status = 'queued', leased_at = NULL,
      consecutive_failures = consecutive_failures + 1, reenqueue_count = reenqueue_count + 1
    WHERE api_base_url = ? AND repo_full_name = ? AND identifier = ? AND status = 'in_progress'
    RETURNING *
  `);
    const listAllStatement = db.prepare(`SELECT * FROM miner_portfolio_queue ${ORDER}`);
    const listRepoStatement = db.prepare(`SELECT * FROM miner_portfolio_queue WHERE repo_full_name = ? ${ORDER}`);
    const listActiveStatement = db.prepare(`SELECT * FROM miner_portfolio_queue WHERE status IN ('queued', 'in_progress') ${ORDER}`);
    const listInProgressStatement = db.prepare(`SELECT * FROM miner_portfolio_queue WHERE status = 'in_progress' ${ORDER}`);
    // A stale-lease sweep release is the SAME "in_progress -> queued without reaching done" event as
    // markFailedStatement above (#5654) -- same counters, same increment.
    const reclaimStatement = db.prepare(`
    UPDATE miner_portfolio_queue SET status = 'queued', leased_at = NULL,
      consecutive_failures = consecutive_failures + 1, reenqueue_count = reenqueue_count + 1
    WHERE api_base_url = ? AND repo_full_name = ? AND identifier = ? AND status = 'in_progress'
    RETURNING *
  `);
    // Requeue only ever targets a COMPLETED ('done') row — an in-flight item is released via reclaimStatement, and
    // an already-'queued' item is a no-op — so a caller's manual requeue can never disturb an active claim. The
    // row keeps its rowid/enqueued_at, so it re-enters the queue at its original FIFO position, not the back.
    // Deliberately leaves attempts_count/consecutive_failures/reenqueue_count untouched (#5654): this is a
    // manual reopen of ALREADY-COMPLETED work, not the stuck queued->in_progress->queued cycle those counters
    // track -- reachedDone (derived live from status) simply reads false again once requeued, same as any
    // other non-done row, until the item is claimed and completed again.
    const requeueStatement = db.prepare(`
    UPDATE miner_portfolio_queue SET status = 'queued', leased_at = NULL
    WHERE api_base_url = ? AND repo_full_name = ? AND identifier = ? AND status = 'done'
    RETURNING *
  `);
    // Same attempts_count increment as dequeueStatement (#5654) -- batchClaim's per-item claim is just as much
    // a real attempt as the single-item dequeueNext path.
    const claimTargetStatement = db.prepare(`
    UPDATE miner_portfolio_queue SET status = 'in_progress', leased_at = ?, attempts_count = attempts_count + 1
    WHERE api_base_url = ? AND repo_full_name = ? AND identifier = ? AND status = 'queued'
    RETURNING *
  `);
    const attemptHistoryStatement = db.prepare("SELECT attempts_count, consecutive_failures, reenqueue_count, status FROM miner_portfolio_queue WHERE api_base_url = ? AND repo_full_name = ? AND identifier = ?");
    return {
        dbPath: resolvedPath,
        enqueue(item) {
            const apiBaseUrl = normalizeApiBaseUrl(item?.apiBaseUrl);
            const repoFullName = normalizeRepoFullName(item?.repoFullName);
            const identifier = normalizeIdentifier(item?.identifier);
            const priority = normalizePriority(item?.priority);
            const enqueuedAt = new Date().toISOString();
            enqueueStatement.run(apiBaseUrl, repoFullName, identifier, priority, enqueuedAt);
            return rowToEntry(asPortfolioQueueDbRow(getStatement.get(apiBaseUrl, repoFullName, identifier)));
        },
        dequeueNext() {
            const row = dequeueStatement.get(new Date().toISOString());
            return row ? rowToEntry(asPortfolioQueueDbRow(row)) : null;
        },
        /** In-flight ('in_progress') rows with their `leasedAt` claim time, for the expiry sweep (#4827). */
        listInProgress() {
            return listInProgressStatement.all().map((row) => rowToLeaseEntry(asPortfolioQueueDbRow(row)));
        },
        /** Reclaim a single stuck in-flight item back to 'queued' (clearing its lease), returning it — or null if it is
         *  no longer 'in_progress' (already finished/reclaimed by another sweep). The sweep target of #4827. */
        reclaimStuckItem(repoFullName, identifier, apiBaseUrl) {
            const row = reclaimStatement.get(normalizeApiBaseUrl(apiBaseUrl), normalizeRepoFullName(repoFullName), normalizeIdentifier(identifier));
            return row ? rowToEntry(asPortfolioQueueDbRow(row)) : null;
        },
        /** Requeue a COMPLETED ('done') item back to 'queued' so it is picked up again, keeping its FIFO position
         *  (rowid/enqueued_at unchanged). Returns the entry, or null when there is no 'done' item to requeue — i.e.
         *  it is already 'queued', is currently 'in_progress' (release it via {@link reclaimStuckItem} instead), or
         *  does not exist. The manual counterpart to {@link reclaimStuckItem} for the queue CLI's escape hatch (#4828). */
        requeueItem(repoFullName, identifier, apiBaseUrl) {
            const row = requeueStatement.get(normalizeApiBaseUrl(apiBaseUrl), normalizeRepoFullName(repoFullName), normalizeIdentifier(identifier));
            return row ? rowToEntry(asPortfolioQueueDbRow(row)) : null;
        },
        listQueue(repoFullName) {
            const rows = repoFullName === undefined || repoFullName === null
                ? listAllStatement.all()
                : listRepoStatement.all(normalizeRepoFullName(repoFullName));
            return rows.map((row) => rowToEntry(asPortfolioQueueDbRow(row)));
        },
        markDone(repoFullName, identifier, apiBaseUrl) {
            const row = markDoneStatement.get(normalizeApiBaseUrl(apiBaseUrl), normalizeRepoFullName(repoFullName), normalizeIdentifier(identifier));
            return row ? rowToEntry(asPortfolioQueueDbRow(row)) : null;
        },
        /** Release an in-flight item back to `queued` when a run halts (#2347). */
        markFailed(repoFullName, identifier, apiBaseUrl) {
            const row = markFailedStatement.get(normalizeApiBaseUrl(apiBaseUrl), normalizeRepoFullName(repoFullName), normalizeIdentifier(identifier));
            return row ? rowToEntry(asPortfolioQueueDbRow(row)) : null;
        },
        /**
         * Transactional caps-aware batch claim hook used by portfolio-queue-manager.js: re-read active rows under an
         * exclusive lock, let the caller pick targets, then atomically flip each still-queued row to `in_progress`.
         */
        batchClaim(selectFn) {
            if (typeof selectFn !== "function")
                throw new Error("invalid_batch_claim_selector");
            db.exec("BEGIN IMMEDIATE");
            try {
                const entries = listActiveStatement.all().map((row) => rowToEntry(asPortfolioQueueDbRow(row)));
                const targets = selectFn(entries);
                if (!Array.isArray(targets))
                    throw new Error("invalid_batch_claim_selection");
                const leasedAt = new Date().toISOString();
                const claimed = [];
                for (const target of targets) {
                    const apiBaseUrl = normalizeApiBaseUrl(target?.apiBaseUrl);
                    const repoFullName = normalizeRepoFullName(target?.repoFullName);
                    const identifier = normalizeIdentifier(target?.identifier);
                    const row = claimTargetStatement.get(leasedAt, apiBaseUrl, repoFullName, identifier);
                    if (row)
                        claimed.push(rowToEntry(asPortfolioQueueDbRow(row)));
                }
                db.exec("COMMIT");
                return claimed;
            }
            catch (error) {
                db.exec("ROLLBACK");
                throw error;
            }
        },
        /**
         * A real `PortfolioConvergenceInput` (non-convergence.ts) for one queue item (#5654), replacing the
         * first-attempt-shaped literal attempt-input-builder.js previously hardcoded. An item never enqueued here
         * (not yet tracked at all) reads the same honest zero-state as a genuine first attempt -- absence of
         * history is not evidence of a problem, same rule non-convergence.ts's own header documents. `reachedDone`
         * is derived live from the row's current `status`, not a separate persisted flag (see requeueStatement's
         * comment above for why that's the deliberate choice).
         */
        getAttemptHistory(repoFullName, identifier, apiBaseUrl) {
            const row = attemptHistoryStatement.get(normalizeApiBaseUrl(apiBaseUrl), normalizeRepoFullName(repoFullName), normalizeIdentifier(identifier));
            if (!row)
                return { attempts: 0, consecutiveFailures: 0, reenqueues: 0, reachedDone: false };
            const historyRow = asPortfolioQueueDbRow(row);
            return {
                attempts: historyRow.attempts_count,
                consecutiveFailures: historyRow.consecutive_failures,
                reenqueues: historyRow.reenqueue_count,
                reachedDone: historyRow.status === "done",
            };
        },
        // Explicit, operator-invoked right-to-be-forgotten purge (#5564, #6599) — never runs automatically.
        purgeByRepo(repoFullName) {
            return purgeStoreByRepo(db, PORTFOLIO_QUEUE_PURGE_SPEC, normalizeRepoFullName(repoFullName));
        },
        close() {
            db.close();
        },
    };
}
function getDefaultPortfolioQueueStore() {
    defaultPortfolioQueueStore ??= initPortfolioQueueStore();
    return defaultPortfolioQueueStore;
}
export function enqueue(item) {
    return getDefaultPortfolioQueueStore().enqueue(item);
}
export function dequeueNext() {
    return getDefaultPortfolioQueueStore().dequeueNext();
}
export function listQueue(repoFullName) {
    return getDefaultPortfolioQueueStore().listQueue(repoFullName);
}
export function markDone(repoFullName, identifier, apiBaseUrl) {
    return getDefaultPortfolioQueueStore().markDone(repoFullName, identifier, apiBaseUrl);
}
export function markFailed(repoFullName, identifier, apiBaseUrl) {
    return getDefaultPortfolioQueueStore().markFailed(repoFullName, identifier, apiBaseUrl);
}
export function getAttemptHistory(repoFullName, identifier, apiBaseUrl) {
    return getDefaultPortfolioQueueStore().getAttemptHistory(repoFullName, identifier, apiBaseUrl);
}
export function closeDefaultPortfolioQueueStore() {
    if (!defaultPortfolioQueueStore)
        return;
    defaultPortfolioQueueStore.close();
    defaultPortfolioQueueStore = null;
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoicG9ydGZvbGlvLXF1ZXVlLmpzIiwic291cmNlUm9vdCI6IiIsInNvdXJjZXMiOlsicG9ydGZvbGlvLXF1ZXVlLnRzIl0sIm5hbWVzIjpbXSwibWFwcGluZ3MiOiJBQUNBLE9BQU8sRUFBRSxvQkFBb0IsRUFBRSxNQUFNLG1CQUFtQixDQUFDO0FBQ3pELE9BQU8sRUFBRSx5QkFBeUIsRUFBRSxnQkFBZ0IsRUFBRSx1QkFBdUIsRUFBRSxNQUFNLGtCQUFrQixDQUFDO0FBQ3hHLE9BQU8sRUFBRSxrQkFBa0IsRUFBRSxNQUFNLGlCQUFpQixDQUFDO0FBQ3JELE9BQU8sRUFBRSxxQkFBcUIsRUFBRSxNQUFNLHFCQUFxQixDQUFDO0FBQzVELE9BQU8sRUFBRSwwQkFBMEIsRUFBRSxnQkFBZ0IsRUFBRSxNQUFNLHdCQUF3QixDQUFDO0FBa0Z0RixNQUFNLENBQUMsTUFBTSxjQUFjLEdBQTJCLE1BQU0sQ0FBQyxNQUFNLENBQUMsQ0FBQyxRQUFRLEVBQUUsYUFBYSxFQUFFLE1BQU0sQ0FBVSxDQUFDLENBQUM7QUFFaEgsTUFBTSxpQkFBaUIsR0FBRyx5QkFBeUIsQ0FBQztBQUNwRCxJQUFJLDBCQUEwQixHQUErQixJQUFJLENBQUM7QUFFbEUsTUFBTSxVQUFVLDJCQUEyQixDQUFDLE1BQTBDLE9BQU8sQ0FBQyxHQUFHO0lBQy9GLE9BQU8sdUJBQXVCLENBQUMsaUJBQWlCLEVBQUUsbUNBQW1DLEVBQUUsR0FBRyxDQUFDLENBQUM7QUFDOUYsQ0FBQztBQUVELFNBQVMsZUFBZSxDQUFDLE1BQWM7SUFDckMsT0FBTyx5QkFBeUIsQ0FBQyxNQUFNLEVBQUUsMkJBQTJCLEVBQUUsRUFBRSxpQ0FBaUMsQ0FBQyxDQUFDO0FBQzdHLENBQUM7QUFFRCxTQUFTLHFCQUFxQixDQUFDLFlBQXFCO0lBQ2xELElBQUksT0FBTyxZQUFZLEtBQUssUUFBUTtRQUFFLE1BQU0sSUFBSSxLQUFLLENBQUMsd0JBQXdCLENBQUMsQ0FBQztJQUNoRixNQUFNLE9BQU8sR0FBRyxZQUFZLENBQUMsSUFB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
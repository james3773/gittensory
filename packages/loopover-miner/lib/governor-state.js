import { DEFAULT_FORGE_CONFIG } from "./forge-config.js";
import { normalizeLocalStoreDbPath, openLocalStoreDb, resolveLocalStoreDbPath } from "./local-store.js";
import { isValidRepoSegment } from "./repo-clone.js";
import { GOVERNOR_OWN_SUBMISSIONS_PURGE_SPEC, GOVERNOR_REPUTATION_HISTORY_PURGE_SPEC, purgeStoreByRepo, } from "./store-maintenance.js";
const defaultDbFileName = "governor-state.sqlite3";
const DEFAULT_RATE_LIMIT_BUCKETS = Object.freeze({ global: {}, perRepo: {} });
const DEFAULT_RATE_LIMIT_BACKOFF = Object.freeze({});
const DEFAULT_CAP_USAGE = Object.freeze({ budgetSpent: 0, turnsTaken: 0, elapsedMs: 0 });
const DEFAULT_REPUTATION_HISTORY = Object.freeze({ decided: 0, unfavorable: 0 });
let defaultGovernorState = null;
export function resolveGovernorStateDbPath(env = process.env) {
    return resolveLocalStoreDbPath(defaultDbFileName, "LOOPOVER_MINER_GOVERNOR_STATE_DB", env);
}
function normalizeDbPath(dbPath) {
    return normalizeLocalStoreDbPath(dbPath, resolveGovernorStateDbPath(), "invalid_governor_state_db_path");
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
/** Optional forge host, scoping rows so two hosts serving the same owner/repo name never collide (#5563).
 *  Omitted/nullish → the github.com default, so every pre-existing single-forge caller is unaffected. */
function normalizeApiBaseUrl(apiBaseUrl) {
    if (apiBaseUrl === undefined || apiBaseUrl === null)
        return DEFAULT_FORGE_CONFIG.apiBaseUrl;
    if (typeof apiBaseUrl !== "string" || !apiBaseUrl.trim())
        throw new Error("invalid_api_base_url");
    return apiBaseUrl.trim();
}
function parseJsonColumn(value, fallback) {
    if (typeof value !== "string")
        return fallback;
    try {
        const parsed = JSON.parse(value);
        return parsed && typeof parsed === "object" ? parsed : fallback;
    }
    catch {
        return fallback;
    }
}
// Add the pause/resume columns (#4851) to an on-disk file created before they existed. `CREATE TABLE IF NOT
// EXISTS` above is a no-op against an already-existing table, so a pre-#4851 file needs this explicit ALTER --
// guarded by a per-column presence check (rather than a single `paused`-only check) so a file that somehow
// has `paused` but not `pause_reason`/`paused_at` still gets the columns it's missing, same technique as
// portfolio-queue.js's own post-creation column migration.
function ensurePauseColumns(db) {
    const existingColumns = new Set(db
        .prepare("PRAGMA table_info(governor_scalar_state)")
        .all()
        .map((column) => column.name));
    if (!existingColumns.has("paused")) {
        db.exec("ALTER TABLE governor_scalar_state ADD COLUMN paused INTEGER NOT NULL DEFAULT 0");
    }
    if (!existingColumns.has("pause_reason")) {
        db.exec("ALTER TABLE governor_scalar_state ADD COLUMN pause_reason TEXT");
    }
    if (!existingColumns.has("paused_at")) {
        db.exec("ALTER TABLE governor_scalar_state ADD COLUMN paused_at TEXT");
    }
}
// Rebuild governor_reputation_history's bare `repo_full_name` PRIMARY KEY into a (api_base_url, repo_full_name)
// composite (#5563) -- two forge hosts serving a same-named owner/repo must not share one reputation row.
// SQLite cannot ALTER a PRIMARY KEY in place, so this rebuilds the table: create the new shape, copy every
// existing row with the pre-#4784 implicit single-forge default backfilled, drop the old table, rename the new
// one in. Guarded by a column-presence check (matching ensurePauseColumns' idempotence) so this only runs once
// per file, same technique as portfolio-queue.js's own post-creation migration.
function ensureReputationHistoryForgeScope(db) {
    const hasApiBaseUrlColumn = db
        .prepare("PRAGMA table_info(governor_reputation_history)")
        .all()
        .some((column) => column.name === "api_base_url");
    if (hasApiBaseUrlColumn)
        return;
    db.exec(`
    CREATE TABLE governor_reputation_history_v2 (
      api_base_url TEXT NOT NULL,
      repo_full_name TEXT NOT NULL,
      decided INTEGER NOT NULL,
      unfavorable INTEGER NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (api_base_url, repo_full_name)
    )
  `);
    // OR IGNORE: a source row that somehow violates the rebuilt table's NOT NULL columns (a hand-edited or
    // otherwise corrupted file) is skipped rather than aborting the whole migration -- same fail-closed posture
    // as run-state.js's own #5563 migration.
    db.prepare(`INSERT OR IGNORE INTO governor_reputation_history_v2 (api_base_url, repo_full_name, decided, unfavorable, updated_at)
     SELECT ?, repo_full_name, decided, unfavorable, updated_at FROM governor_reputation_history`).run(DEFAULT_FORGE_CONFIG.apiBaseUrl);
    db.exec("DROP TABLE governor_reputation_history");
    db.exec("ALTER TABLE governor_reputation_history_v2 RENAME TO governor_reputation_history");
}
/** Opens the local governor-state store, creating tables on first use. */
export function openGovernorState(dbPath = resolveGovernorStateDbPath()) {
    const resolvedPath = normalizeDbPath(dbPath);
    const db = openLocalStoreDb(resolvedPath);
    // ONE row (id=1) holding the whole-run scalar state: rate-limit buckets/backoff and budget/turn/termination
    // usage have no natural per-repo key of their own beyond what's already encoded inside the JSON blob
    // (WriteRateLimitBucketStore.perRepo is itself keyed by `${actionClass}:${repoFullName}`), so a single
    // UPSERTed row is simpler and more honest than inventing a relational key that doesn't exist upstream.
    db.exec(`
    CREATE TABLE IF NOT EXISTS governor_scalar_state (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      rate_limit_buckets_json TEXT NOT NULL,
      rate_limit_backoff_json TEXT NOT NULL,
      cap_usage_json TEXT NOT NULL,
      paused INTEGER NOT NULL DEFAULT 0,
      pause_reason TEXT,
      paused_at TEXT,
      updated_at TEXT NOT NULL
    )
  `);
    ensurePauseColumns(db);
    db.exec(`
    CREATE TABLE IF NOT EXISTS governor_reputation_history (
      repo_full_name TEXT PRIMARY KEY,
      decided INTEGER NOT NULL,
      unfavorable INTEGER NOT NULL,
      updated_at TEXT NOT NULL
    )
  `);
    ensureReputationHistoryForgeScope(db);
    db.exec(`
    CREATE TABLE IF NOT EXISTS governor_own_submissions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      repo_full_name TEXT NOT NULL,
      fingerprint TEXT NOT NULL,
      submitted_at TEXT,
      pull_request_number INTEGER,
      issue_number INTEGER
    )
  `);
    db.exec("CREATE INDEX IF NOT EXISTS idx_governor_own_submissions_repo ON governor_own_submissions (repo_full_name, id)");
    const getScalarStatement = db.prepare("SELECT * FROM governor_scalar_state WHERE id = 1");
    const upsertScalarStatement = db.prepare(`
    INSERT INTO governor_scalar_state
      (id, rate_limit_buckets_json, rate_limit_backoff_json, cap_usage_json, paused, pause_reason, paused_at, updated_at)
    VALUES (1, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      rate_limit_buckets_json = excluded.rate_limit_buckets_json,
      rate_limit_backoff_json = excluded.rate_limit_backoff_json,
      cap_usage_json = excluded.cap_usage_json,
      paused = excluded.paused,
      pause_reason = excluded.pause_reason,
      paused_at = excluded.paused_at,
      updated_at = excluded.updated_at
  `);
    const getReputationStatement = db.prepare("SELECT * FROM governor_reputation_history WHERE api_base_url = ? AND repo_full_name = ?");
    const upsertReputationStatement = db.prepare(`
    INSERT INTO governor_reputation_history (api_base_url, repo_full_name, decided, unfavorable, updated_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(api_base_url, repo_full_name) DO UPDATE SET
      decided = excluded.decided,
      unfavorable = excluded.unfavorable,
      updated_at = excluded.updated_at
  `);
    const insertSubmissionStatement = db.prepare(`
    INSERT INTO governor_own_submissions (repo_full_name, fingerprint, submitted_at, pull_request_number, issue_number)
    VALUES (?, ?, ?, ?, ?)
  `);
    const listSubmissionsAllStatement = db.prepare("SELECT * FROM governor_own_submissions ORDER BY id DESC LIMIT ?");
    const listSubmissionsByRepoStatement = db.prepare("SELECT * FROM governor_own_submissions WHERE repo_full_name = ? ORDER BY id DESC LIMIT ?");
    function rowToSubmission(row) {
        return {
            repoFullName: row.repo_full_name,
            fingerprint: row.fingerprint,
            submittedAt: row.submitted_at,
            pullRequestNumber: row.pull_request_number,
            issueNumber: row.issue_number,
        };
    }
    // BEGIN IMMEDIATE takes the write lock BEFORE `fn`'s read, so two processes on the same file (the loop daemon
    // saving rate-limit/cap-usage state on every gated write, and an operator's `governor pause`/`resume` CLI
    // invocation racing it) cannot interleave a stale read with each other's write and silently clobber the
    // scalar-state column-group they don't own -- same fix shape as event-ledger.js's appendEvent (#7221). Shared
    // by all three governor_scalar_state save methods below, since they all read-then-write across the same row.
    function withTransaction(fn) {
        db.exec("BEGIN IMMEDIATE");
        try {
            const result = fn();
            db.exec("COMMIT");
            return result;
        }
        catch (error) {
            db.exec("ROLLBACK");
            throw error;
        }
    }
    const state = {
        dbPath: resolvedPath,
        loadRateLimitState() {
            const row = getScalarStatement.get();
            return {
                buckets: parseJsonColumn(row?.rate_limit_buckets_json, DEFAULT_RATE_LIMIT_BUCKETS),
                backoffAttempts: parseJsonColumn(row?.rate_limit_backoff_json, DEFAULT_RATE_LIMIT_BACKOFF),
            };
        },
        saveRateLimitState(rateLimitState) {
            withTransaction(() => {
                const row = getScalarStatement.get();
                upsertScalarStatement.run(JSON.stringify(rateLimitState?.buckets ?? DEFAULT_RATE_LIMIT_BUCKETS), JSON.stringify(rateLimitState?.backoffAttempts ?? DEFAULT_RATE_LIMIT_BACKOFF), row ? row.cap_usage_json : JSON.stringify(DEFAULT_CAP_USAGE), row ? row.paused : 0, row ? row.pause_reason : null, row ? row.paused_at : null, new Date().toISOString());
            });
        },
        loadCapUsage() {
            const row = getScalarStatement.get();
            return parseJsonColumn(row?.cap_usage_json, DEFAULT_CAP_USAGE);
        },
        saveCapUsage(capUsage) {
            withTransaction(() => {
                const row = getScalarStatement.get();
                upsertScalarStatement.run(row ? row.rate_limit_buckets_json : JSON.stringify(DEFAULT_RATE_LIMIT_BUCKETS), row ? row.rate_limit_backoff_json : JSON.stringify(DEFAULT_RATE_LIMIT_BACKOFF), JSON.stringify(capUsage ?? DEFAULT_CAP_USAGE), row ? row.paused : 0, row ? row.pause_reason : null, row ? row.paused_at : null, new Date().toISOString());
            });
        },
        // The governor pause/resume control surface (#4851): a real, persisted, operator/governor-writable flag the
        // loop checks before each cycle -- distinct from governor-kill-switch.js (a read-only resolver over env/YAML
        // inputs the miner does not itself write) and governor-run-halt.js (a one-way, run-scoped terminal breaker).
        // `pausedAt` is stamped fresh on every transition INTO paused, and cleared on resume, so a status query can
        // report how long a pause has been in effect without needing a separate history table.
        loadPauseState() {
            const row = getScalarStatement.get();
            return {
                paused: row ? Boolean(row.paused) : false,
                reason: row?.pause_reason ?? null,
                pausedAt: row?.paused_at ?? null,
            };
        },
        savePauseState(pauseState) {
            const paused = Boolean(pauseState?.paused);
            const reason = typeof pauseState?.reason === "string" && pauseState.reason.trim() ? pauseState.reason.trim() : null;
            const pausedAt = paused ? new Date().toISOString() : null;
            withTransaction(() => {
                const row = getScalarStatement.get();
                upsertScalarStatement.run(row ? row.rate_limit_buckets_json : JSON.stringify(DEFAULT_RATE_LIMIT_BUCKETS), row ? row.rate_limit_backoff_json : JSON.stringify(DEFAULT_RATE_LIMIT_BACKOFF), row ? row.cap_usage_json : JSON.stringify(DEFAULT_CAP_USAGE), paused ? 1 : 0, reason, pausedAt, new Date().toISOString());
            });
            return { paused, reason, pausedAt };
        },
        loadReputationHistory(repoFullName, apiBaseUrl) {
            const normalizedForge = normalizeApiBaseUrl(apiBaseUrl);
            const normalizedRepo = normalizeRepoFullName(repoFullName);
            const row = getReputationStatement.get(normalizedForge, normalizedRepo);
            if (!row)
                return { ...DEFAULT_REPUTATION_HISTORY };
            return { decided: row.decided, unfavorable: row.unfavorable };
        },
        saveReputationHistory(repoFullName, history, apiBaseUrl) {
            const normalizedForge = normalizeApiBaseUrl(apiBaseUrl);
            const normalizedRepo = normalizeRepoFullName(repoFullName);
            const decided = Number.isInteger(history?.decided) ? history.decided : 0;
            const unfavorable = Number.isInteger(history?.unfavorable) ? history.unfavorable : 0;
            upsertReputationStatement.run(normalizedForge, normalizedRepo, decided, unfavorable, new Date().toISOString());
            return { decided, unfavorable };
        },
        recordOwnSubmission(record) {
            const normalized = normalizeRepoFullName(record?.repoFullName);
            if (typeof record?.fingerprint !== "string" || !record.fingerprint.trim()) {
                throw new Error("invalid_fingerprint");
            }
            const submittedAt = typeof record.submittedAt === "string" ? record.submittedAt : new Date().toISOString();
            const pullRequestNumber = Number.isInteger(record.pullRequestNumber) ? record.pullRequestNumber : null;
            const issueNumber = Number.isInteger(record.issueNumber) ? record.issueNumber : null;
            insertSubmissionStatement.run(normalized, record.fingerprint, submittedAt, pullRequestNumber, issueNumber);
            return { repoFullName: normalized, fingerprint: record.fingerprint, submittedAt, pullRequestNumber, issueNumber };
        },
        listRecentOwnSubmissions(filter = {}) {
            const limit = Number.isInteger(filter.limit) && filter.limit > 0 ? filter.limit : 200;
            const rows = filter.repoFullName === undefined
                ? listSubmissionsAllStatement.all(limit)
                : listSubmissionsByRepoStatement.all(normalizeRepoFullName(filter.repoFullName), limit);
            return rows.map((row) => rowToSubmission(row));
        },
        /**
         * Delete every repo-scoped row for one repo across BOTH governor tables against this single open handle
         * (#7091) — the right-to-be-forgotten path `loopover-miner purge` invokes. `governor_reputation_history` is
         * purged on `repo_full_name` alone (its key is composite with `api_base_url`), so nothing survives on any
         * forge host. `governor_scalar_state` is deliberately untouched — it has no repo dimension. Returns the
         * total rows removed across both tables.
         */
        purgeByRepo(repoFullName) {
            const normalized = normalizeRepoFullName(repoFullName);
            return (purgeStoreByRepo(db, GOVERNOR_REPUTATION_HISTORY_PURGE_SPEC, normalized) +
                purgeStoreByRepo(db, GOVERNOR_OWN_SUBMISSIONS_PURGE_SPEC, normalized));
        },
        close() {
            db.close();
        },
    };
    return state;
}
function getDefaultGovernorState() {
    defaultGovernorState ??= openGovernorState();
    return defaultGovernorState;
}
export function loadRateLimitState() {
    return getDefaultGovernorState().loadRateLimitState();
}
export function saveRateLimitState(rateLimitState) {
    return getDefaultGovernorState().saveRateLimitState(rateLimitState);
}
export function loadCapUsage() {
    return getDefaultGovernorState().loadCapUsage();
}
export function saveCapUsage(capUsage) {
    return getDefaultGovernorState().saveCapUsage(capUsage);
}
export function loadPauseState() {
    return getDefaultGovernorState().loadPauseState();
}
export function savePauseState(pauseState) {
    return getDefaultGovernorState().savePauseState(pauseState);
}
export function loadReputationHistory(repoFullName, apiBaseUrl) {
    return getDefaultGovernorState().loadReputationHistory(repoFullName, apiBaseUrl);
}
export function saveReputationHistory(repoFullName, history, apiBaseUrl) {
    return getDefaultGovernorState().saveReputationHistory(repoFullName, history, apiBaseUrl);
}
export function recordOwnSubmission(record) {
    return getDefaultGovernorState().recordOwnSubmission(record);
}
export function listRecentOwnSubmissions(filter) {
    return getDefaultGovernorState().listRecentOwnSubmissions(filter);
}
export function closeDefaultGovernorState() {
    if (!defaultGovernorState)
        return;
    defaultGovernorState.close();
    defaultGovernorState = null;
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiZ292ZXJub3Itc3RhdGUuanMiLCJzb3VyY2VSb290IjoiIiwic291cmNlcyI6WyJnb3Zlcm5vci1zdGF0ZS50cyJdLCJuYW1lcyI6W10sIm1hcHBpbmdzIjoiQUFRQSxPQUFPLEVBQUUsb0JBQW9CLEVBQUUsTUFBTSxtQkFBbUIsQ0FBQztBQUN6RCxPQUFPLEVBQUUseUJBQXlCLEVBQUUsZ0JBQWdCLEVBQUUsdUJBQXVCLEVBQUUsTUFBTSxrQkFBa0IsQ0FBQztBQUN4RyxPQUFPLEVBQUUsa0JBQWtCLEVBQUUsTUFBTSxpQkFBaUIsQ0FBQztBQUNyRCxPQUFPLEVBQ0wsbUNBQW1DLEVBQ25DLHNDQUFzQyxFQUN0QyxnQkFBZ0IsR0FDakIsTUFBTSx3QkFBd0IsQ0FBQztBQXdGaEMsTUFBTSxpQkFBaUIsR0FBRyx3QkFBd0IsQ0FBQztBQUNuRCxNQUFNLDBCQUEwQixHQUF3QyxNQUFNLENBQUMsTUFBTSxDQUFDLEVBQUUsTUFBTSxFQUFFLEVBQUUsRUFBRSxPQUFPLEVBQUUsRUFBRSxFQUFFLENBQUMsQ0FBQztBQUNuSCxNQUFNLDBCQUEwQixHQUF5QyxNQUFNLENBQUMsTUFBTSxDQUFDLEVBQUUsQ0FBQyxDQUFDO0FBQzNGLE1BQU0saUJBQWlCLEdBQStCLE1BQU0sQ0FBQyxNQUFNLENBQUMsRUFBRSxXQUFXLEVBQUUsQ0FBQyxFQUFFLFVBQVUsRUFBRSxDQUFDLEVBQUUsU0FBUyxFQUFFLENBQUMsRUFBRSxDQUFDLENBQUM7QUFDckgsTUFBTSwwQkFBMEIsR0FBaUMsTUFBTSxDQUFDLE1BQU0sQ0FBQyxFQUFFLE9BQU8sRUFBRSxDQUFDLEVBQUUsV0FBVyxFQUFFLENBQUMsRUFBRSxDQUFDLENBQUM7QUFDL0csSUFBSSxvQkFBb0IsR0FBeUIsSUFBSSxDQUFDO0FBRXRELE1BQU0sVUFBVSwwQkFBMEIsQ0FBQyxNQUEwQyxPQUFPLENBQUMsR0FBRztJQUM5RixPQUFPLHVCQUF1QixDQUFDLGlCQUFpQixFQUFFLGtDQUFrQyxFQUFFLEdBQUcsQ0FBQyxDQUFDO0FB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
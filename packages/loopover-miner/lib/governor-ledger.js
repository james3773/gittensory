import { normalizeGovernorLedgerEvent } from "@loopover/engine";
import { normalizeLocalStoreDbPath, openLocalStoreDb, resolveLocalStoreDbPath } from "./local-store.js";
import { isValidRepoSegment } from "./repo-clone.js";
import { applySchemaMigrations } from "./schema-version.js";
import { GOVERNOR_LEDGER_PURGE_SPEC, GOVERNOR_LEDGER_RETENTION_SPEC, purgeStoreByRepo, pruneLedgerByRetention, resolveLedgerRetentionPolicy, } from "./store-maintenance.js";
const defaultDbFileName = "governor-ledger.sqlite3";
let defaultGovernorLedger = null;
export function resolveGovernorLedgerDbPath(env = process.env) {
    return resolveLocalStoreDbPath(defaultDbFileName, "LOOPOVER_MINER_GOVERNOR_LEDGER_DB", env);
}
function normalizeDbPath(dbPath) {
    return normalizeLocalStoreDbPath(dbPath, resolveGovernorLedgerDbPath(), "invalid_governor_ledger_db_path");
}
function normalizeOptionalRepoFullName(repoFullName) {
    if (repoFullName === undefined || repoFullName === null)
        return undefined;
    if (typeof repoFullName !== "string")
        throw new Error("invalid_repo_full_name");
    const [owner, repo, extra] = repoFullName.trim().split("/");
    if (!owner || !repo || extra !== undefined)
        throw new Error("invalid_repo_full_name");
    if (!isValidRepoSegment(owner) || !isValidRepoSegment(repo))
        throw new Error("invalid_repo_full_name");
    return `${owner}/${repo}`;
}
function rowToEntry(row) {
    let payload;
    try {
        payload = JSON.parse(row.payload_json);
        if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
            throw new Error("corrupted_governor_row");
        }
    }
    catch {
        throw new Error("corrupted_governor_row");
    }
    return {
        id: row.id,
        ts: row.ts,
        eventType: row.event_type,
        repoFullName: row.repo_full_name,
        actionClass: row.action_class,
        decision: row.decision,
        reason: row.reason,
        payload: payload,
    };
}
// Decision-log projection (#5159): the public, MCP-exposed shape. Deliberately omits payload_json (which #5134
// is expanding with reputation/self-plagiarism/budget state). Kept honest by an explicit named-column SELECT
// below — never SELECT * — so the sensitive column cannot leak even by accident.
function rowToDecision(row) {
    return {
        id: row.id,
        ts: row.ts,
        eventType: row.event_type,
        repoFullName: row.repo_full_name,
        actionClass: row.action_class,
        decision: row.decision,
        reason: row.reason,
    };
}
// v1 -> v2 (#4939/#6597): additive tenant-scoping column, a prerequisite for any hosted, multi-tenant use of
// this same store's logic. NULL for every row today -- self-host behavior is byte-identical, since nothing
// reads or writes it yet. Same defensive column-presence guard as this file's sibling stores' own additive
// migrations (e.g. event-ledger.js's addTenantIdColumn).
function addTenantIdColumn(db) {
    const hasTenantIdColumn = db
        .prepare("PRAGMA table_info(governor_events)")
        .all()
        .some((column) => column.name === "tenant_id");
    if (!hasTenantIdColumn)
        db.exec("ALTER TABLE governor_events ADD COLUMN tenant_id TEXT");
}
function asGovernorDbRow(row) {
    return row;
}
/**
 * Opens the append-only governor ledger, creating the table on first use. Rows are returned in ascending `id`
 * order (insertion order). (#2328)
 */
export function initGovernorLedger(dbPath = resolveGovernorLedgerDbPath()) {
    const resolvedPath = normalizeDbPath(dbPath);
    const db = openLocalStoreDb(resolvedPath);
    db.exec(`
    CREATE TABLE IF NOT EXISTS governor_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts TEXT NOT NULL,
      event_type TEXT NOT NULL,
      repo_full_name TEXT,
      action_class TEXT NOT NULL,
      decision TEXT NOT NULL,
      reason TEXT NOT NULL,
      payload_json TEXT NOT NULL
    )
  `);
    db.exec("CREATE INDEX IF NOT EXISTS idx_governor_events_repo ON governor_events (repo_full_name, id)");
    // Schema-version convention (#4832): stamp the baseline and run any post-baseline migrations.
    applySchemaMigrations(db, [addTenantIdColumn]);
    // Opt-in retention (#4834): prune aged/excess rows when an operator has enabled it; a no-op by default.
    pruneLedgerByRetention(db, GOVERNOR_LEDGER_RETENTION_SPEC, resolveLedgerRetentionPolicy(), Date.now());
    const appendStatement = db.prepare(`
    INSERT INTO governor_events (ts, event_type, repo_full_name, action_class, decision, reason, payload_json)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
    const getByIdStatement = db.prepare("SELECT * FROM governor_events WHERE id = ?");
    const readAllStatement = db.prepare("SELECT * FROM governor_events ORDER BY id ASC");
    const readByRepoStatement = db.prepare("SELECT * FROM governor_events WHERE repo_full_name = ? ORDER BY id ASC");
    // Explicit named-column projection for the read-only decision log (#5159) — payload_json is intentionally
    // NOT in this list, so widening it would be a deliberate edit that the redaction test guards against.
    const decisionColumns = "id, ts, event_type, repo_full_name, action_class, decision, reason";
    const readDecisionsAllStatement = db.prepare(`SELECT ${decisionColumns} FROM governor_events ORDER BY id ASC`);
    const readDecisionsByRepoStatement = db.prepare(`SELECT ${decisionColumns} FROM governor_events WHERE repo_full_name = ? ORDER BY id ASC`);
    return {
        dbPath: resolvedPath,
        appendGovernorEvent(event) {
            const normalized = normalizeGovernorLedgerEvent(event);
            const ts = new Date().toISOString();
            const result = appendStatement.run(ts, normalized.eventType, normalized.repoFullName, normalized.actionClass, normalized.decision, normalized.reason, normalized.payloadJson);
            return rowToEntry(asGovernorDbRow(getByIdStatement.get(Number(result.lastInsertRowid))));
        },
        readGovernorEvents(filter = {}) {
            const repoFullName = normalizeOptionalRepoFullName(filter.repoFullName);
            const rows = repoFullName === undefined
                ? readAllStatement.all()
                : readByRepoStatement.all(repoFullName);
            return rows.map((row) => rowToEntry(asGovernorDbRow(row)));
        },
        readGovernorDecisions(filter = {}) {
            const repoFullName = normalizeOptionalRepoFullName(filter.repoFullName);
            const rows = repoFullName === undefined
                ? readDecisionsAllStatement.all()
                : readDecisionsByRepoStatement.all(repoFullName);
            return rows.map((row) => rowToDecision(asGovernorDbRow(row)));
        },
        // Explicit, operator-invoked right-to-be-forgotten purge (#5564) — never runs automatically. See the
        // IMMUTABILITY INVARIANT note above: this is a deliberate, separate exception, not a normal ledger write.
        // Requires a real repoFullName (unlike the optional filters above): a purge must never silently no-op.
        purgeByRepo(repoFullName) {
            const normalized = normalizeOptionalRepoFullName(repoFullName);
            if (normalized === undefined)
                throw new Error("invalid_repo_full_name");
            return purgeStoreByRepo(db, GOVERNOR_LEDGER_PURGE_SPEC, normalized);
        },
        close() {
            db.close();
        },
    };
}
function getDefaultGovernorLedger() {
    defaultGovernorLedger ??= initGovernorLedger();
    return defaultGovernorLedger;
}
export function appendGovernorEvent(event) {
    return getDefaultGovernorLedger().appendGovernorEvent(event);
}
export function readGovernorEvents(filter) {
    return getDefaultGovernorLedger().readGovernorEvents(filter);
}
export function closeDefaultGovernorLedger() {
    if (!defaultGovernorLedger)
        return;
    defaultGovernorLedger.close();
    defaultGovernorLedger = null;
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiZ292ZXJub3ItbGVkZ2VyLmpzIiwic291cmNlUm9vdCI6IiIsInNvdXJjZXMiOlsiZ292ZXJub3ItbGVkZ2VyLnRzIl0sIm5hbWVzIjpbXSwibWFwcGluZ3MiOiJBQUNBLE9BQU8sRUFBRSw0QkFBNEIsRUFBRSxNQUFNLGtCQUFrQixDQUFDO0FBQ2hFLE9BQU8sRUFBRSx5QkFBeUIsRUFBRSxnQkFBZ0IsRUFBRSx1QkFBdUIsRUFBRSxNQUFNLGtCQUFrQixDQUFDO0FBQ3hHLE9BQU8sRUFBRSxrQkFBa0IsRUFBRSxNQUFNLGlCQUFpQixDQUFDO0FBQ3JELE9BQU8sRUFBRSxxQkFBcUIsRUFBRSxNQUFNLHFCQUFxQixDQUFDO0FBQzVELE9BQU8sRUFDTCwwQkFBMEIsRUFDMUIsOEJBQThCLEVBQzlCLGdCQUFnQixFQUNoQixzQkFBc0IsRUFDdEIsNEJBQTRCLEdBQzdCLE1BQU0sd0JBQXdCLENBQUM7QUEwRGhDLE1BQU0saUJBQWlCLEdBQUcseUJBQXlCLENBQUM7QUFDcEQsSUFBSSxxQkFBcUIsR0FBMEIsSUFBSSxDQUFDO0FBRXhELE1BQU0sVUFBVSwyQkFBMkIsQ0FBQyxNQUEwQyxPQUFPLENBQUMsR0FBRztJQUMvRixPQUFPLHVCQUF1QixDQUFDLGlCQUFpQixFQUFFLG1DQUFtQyxFQUFFLEdBQUcsQ0FBQyxDQUFDO0FBQzlGLENBQUM7QUFFRCxTQUFTLGVBQWUsQ0FBQyxNQUFjO0lBQ3JDLE9BQU8seUJBQXlCLENBQUMsTUFBTSxFQUFFLDJCQUEyQixFQUFFLEVBQUUsaUNBQWlDLENBQUMsQ0FBQztBQUM3RyxDQUFDO0FBRUQsU0FBUyw2QkFBNkIsQ0FBQyxZQUF1QztJQUM1RSxJQUFJLFlBQVksS0FBSyxTQUFTLElBQUksWUFBWSxLQUFLLElBQUk7UUFBRSxPQUFPLFNBQVMsQ0FBQztJQUMxRSxJQUFJLE9BQU8sWUFBWSxLQUFLLFFBQVE7UUFBRSxNQUFNLElBQUksS0FBSyxDQUFDLHdCQUF3QixDQUFDLENBQUM7SUFDaEYsTUFBTSxDQUFDLEtBQUssRUFB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
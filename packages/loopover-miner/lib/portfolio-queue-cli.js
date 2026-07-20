import { initPortfolioQueueStore } from "./portfolio-queue.js";
import { initPortfolioQueueManager } from "./portfolio-queue-manager.js";
import { runPortfolioDashboard } from "./portfolio-dashboard.js";
import { argsWantJson, describeCliError, reportCliFailure } from "./cli-error.js";
import { isValidRepoSegment } from "./repo-clone.js";
const QUEUE_LIST_USAGE = "Usage: loopover-miner queue list [--repo <owner/repo>] [--json]";
const QUEUE_NEXT_USAGE = "Usage: loopover-miner queue next [--global-wip <n>] [--per-repo-wip <n>] [--dry-run] [--json]";
const QUEUE_DONE_USAGE = "Usage: loopover-miner queue done <owner/repo> <identifier> [--api-base-url <url>] [--dry-run] [--json]";
const QUEUE_RELEASE_USAGE = "Usage: loopover-miner queue release <owner/repo> <identifier> [--api-base-url <url>] [--dry-run] [--json]";
const QUEUE_REQUEUE_USAGE = "Usage: loopover-miner queue requeue <owner/repo> <identifier> [--api-base-url <url>] [--dry-run] [--json]";
const QUEUE_CLAIM_BATCH_USAGE = "Usage: loopover-miner queue claim-batch [--global-wip <n>] [--per-repo-wip <n>] [--dry-run] [--json]";
function parseRepoArg(value, usage) {
    if (!value)
        return { error: usage };
    const trimmed = value.trim();
    const [owner, repo, extra] = trimmed.split("/");
    if (!owner || !repo || extra !== undefined || !isValidRepoSegment(owner) || !isValidRepoSegment(repo)) {
        return { error: "Repository must be in owner/repo form." };
    }
    return { repoFullName: `${owner}/${repo}` };
}
export function parseQueueListArgs(args) {
    const options = { json: false, repoFullName: null };
    const positional = [];
    for (let index = 0; index < args.length; index += 1) {
        const token = args[index];
        if (token === "--json") {
            options.json = true;
            continue;
        }
        if (token === "--repo") {
            const repoArg = args[index + 1];
            if (!repoArg || repoArg.startsWith("-")) {
                return { error: QUEUE_LIST_USAGE };
            }
            const repo = parseRepoArg(repoArg, QUEUE_LIST_USAGE);
            if ("error" in repo)
                return repo;
            options.repoFullName = repo.repoFullName;
            index += 1;
            continue;
        }
        if (token.startsWith("-")) {
            return { error: `Unknown option: ${token}` };
        }
        positional.push(token);
    }
    if (positional.length > 0) {
        return { error: QUEUE_LIST_USAGE };
    }
    return options;
}
// #4850: --global-wip/--per-repo-wip are OMITTED (undefined) by default -- queue next stays uncapped, byte-
// identical to its pre-#4850 behavior, unless an operator explicitly opts in. Mirrors queue claim-batch's own
// flag names (portfolio-queue-manager.js's WIP-cap-aware claimer), but claim-batch's OWN default of 1/1 is not
// reused here: claim-batch's whole purpose is cap enforcement, while queue next has always been a plain
// highest-priority dequeue and must not silently start capping existing callers that never asked for it.
export function parseQueueNextArgs(args) {
    const options = { json: false, dryRun: false, globalWipCap: undefined, perRepoWipCap: undefined };
    const positional = [];
    for (let index = 0; index < args.length; index += 1) {
        const token = args[index];
        if (token === "--json") {
            options.json = true;
            continue;
        }
        if (token === "--dry-run") {
            options.dryRun = true;
            continue;
        }
        if (token === "--global-wip" || token === "--per-repo-wip") {
            const value = Number(args[index + 1]);
            if (args[index + 1] === undefined || !Number.isFinite(value) || value < 0) {
                return { error: QUEUE_NEXT_USAGE };
            }
            if (token === "--global-wip")
                options.globalWipCap = value;
            else
                options.perRepoWipCap = value;
            index += 1;
            continue;
        }
        if (token.startsWith("-")) {
            return { error: `Unknown option: ${token}` };
        }
        positional.push(token);
    }
    if (positional.length > 0) {
        return { error: QUEUE_NEXT_USAGE };
    }
    return options;
}
/**
 * Pick at most one atomically-claimable target from the store's already-priority-ordered active rows (queued
 * AND in_progress interleaved, exactly `batchClaim`'s own `entries` shape). `caps` of `null` replicates the
 * pre-#4850 behavior: the single highest-priority queued row, unconditionally. When caps are set, refuses to
 * select anything once the global or the target row's own per-repo in-progress count has reached its cap --
 * "stops claiming once the cap is reached" (#4850), not a diversifying batch selection (that remains
 * claim-batch's job via the engine's own `nextEligibleItems`).
 * @param {Array<{ repoFullName: string, identifier: string, apiBaseUrl: string, status: string }>} entries
 * @param {{ globalWipCap: number, perRepoWipCap: number } | null} caps
 */
export function selectNextEligibleTarget(entries, caps) {
    const topQueued = entries.find((entry) => entry.status === "queued");
    if (!topQueued)
        return [];
    if (!caps) {
        return [{ repoFullName: topQueued.repoFullName, identifier: topQueued.identifier, apiBaseUrl: topQueued.apiBaseUrl }];
    }
    const globalActiveCount = entries.filter((entry) => entry.status === "in_progress").length;
    if (globalActiveCount >= caps.globalWipCap)
        return [];
    // Host-scope the per-repo active count (#7224): a same-named repo on a DIFFERENT forge host is a distinct backlog
    // (the store keys rows by apiBaseUrl too, #5563), so an in-progress item on host A must not consume host B's
    // per-repo WIP budget. Single-host is unchanged: every entry shares one apiBaseUrl, so the added match is always true.
    const repoActiveCount = entries.filter((entry) => entry.status === "in_progress" &&
        entry.repoFullName === topQueued.repoFullName &&
        entry.apiBaseUrl === topQueued.apiBaseUrl).length;
    if (repoActiveCount >= caps.perRepoWipCap)
        return [];
    return [{ repoFullName: topQueued.repoFullName, identifier: topQueued.identifier, apiBaseUrl: topQueued.apiBaseUrl }];
}
/** Shared `<owner/repo> <identifier> [--api-base-url <url>] [--json]` parse for the item-targeting subcommands
 *  (done/release/requeue). `usage` is the command-specific message surfaced on a malformed argv. */
function parseRepoIdentifierArgs(args, usage) {
    const options = {
        json: false,
        dryRun: false,
        apiBaseUrl: undefined,
    };
    const positional = [];
    for (let index = 0; index < args.length; index += 1) {
        const token = args[index];
        if (token === "--json") {
            options.json = true;
            continue;
        }
        // #4847: reports what a real mutation would do and returns before opening the portfolio queue at all.
        if (token === "--dry-run") {
            options.dryRun = true;
            continue;
        }
        // #5563: scope the target to a non-default forge host, so it doesn't collide with (or get confused for) a
        // same-named repo on the default github.com host.
        if (token === "--api-base-url") {
            const value = args[index + 1];
            if (!value || value.startsWith("-")) {
                return { error: usage };
            }
            options.apiBaseUrl = value;
            index += 1;
            continue;
        }
        if (token.startsWith("-")) {
            return { error: `Unknown option: ${token}` };
        }
        positional.push(token);
    }
    if (positional.length !== 2) {
        return { error: usage };
    }
    const repo = parseRepoArg(positional[0], usage);
    if ("error" in repo)
        return repo;
    const identifier = positional[1]?.trim();
    if (!identifier) {
        return { error: usage };
    }
    return {
        repoFullName: repo.repoFullName,
        identifier,
        dryRun: options.dryRun,
        json: options.json,
        apiBaseUrl: options.apiBaseUrl,
    };
}
export function parseQueueDoneArgs(args) {
    return parseRepoIdentifierArgs(args, QUEUE_DONE_USAGE);
}
export function parseQueueReleaseArgs(args) {
    return parseRepoIdentifierArgs(args, QUEUE_RELEASE_USAGE);
}
export function parseQueueRequeueArgs(args) {
    return parseRepoIdentifierArgs(args, QUEUE_REQUEUE_USAGE);
}
function display(value) {
    if (value === null || value === undefined)
        return "-";
    return String(value);
}
export function renderQueueTable(entries) {
    if (!Array.isArray(entries) || entries.length === 0)
        return "no portfolio queue entries";
    const header = [
        "repo".padEnd(24),
        "identifier".padEnd(16),
        // #7225: surface the host so a reader of the plain-text table can supply the `--api-base-url` a follow-up
        // done/release/requeue needs to disambiguate two rows sharing a repo+identifier across forge hosts.
        "host".padEnd(30),
        "status".padEnd(12),
        "pri".padStart(4),
        "enqueued-at".padEnd(24),
    ].join(" ");
    const lines = entries.map((entry) => [
        entry.repoFullName.padEnd(24),
        entry.identifier.padEnd(16),
        display(entry.apiBaseUrl).padEnd(30),
        entry.status.padEnd(12),
        display(entry.priority).padStart(4),
        display(entry.enqueuedAt).padEnd(24),
    ].join(" "));
    return [header, ...lines].join("\n");
}
function withPortfolioQueue(options, run) {
    const ownsStore = options.initPortfolioQueue === undefined;
    const portfolioQueue = (options.initPortfolioQueue ?? initPortfolioQueueStore)();
    try {
        return run(portfolioQueue);
    }
    finally {
        if (ownsStore)
            portfolioQueue.close();
    }
}
export function runQueueList(args, options = {}) {
    const parsed = parseQueueListArgs(args);
    if ("error" in parsed) {
        return reportCliFailure(argsWantJson(args), parsed.error);
    }
    try {
        return withPortfolioQueue(options, (portfolioQueue) => {
            const entries = portfolioQueue.listQueue(parsed.repoFullName);
            if (parsed.json) {
                console.log(JSON.stringify({ entries }, null, 2));
            }
            else {
                console.log(renderQueueTable(entries));
            }
            return 0;
        });
    }
    catch (error) {
        return reportCliFailure(parsed.json, describeCliError(error));
    }
}
export function runQueueNext(args, options = {}) {
    const parsed = parseQueueNextArgs(args);
    if ("error" in parsed) {
        return reportCliFailure(argsWantJson(args), parsed.error);
    }
    const capsRequested = parsed.globalWipCap !== undefined || parsed.perRepoWipCap !== undefined;
    if (parsed.dryRun) {
        const dryRunResult = capsRequested
            ? { outcome: "dry_run", globalWipCap: parsed.globalWipCap, perRepoWipCap: parsed.perRepoWipCap }
            : { outcome: "dry_run" };
        if (parsed.json) {
            console.log(JSON.stringify(dryRunResult, null, 2));
        }
        else if (capsRequested) {
            console.log(`DRY RUN: would dequeue the highest-priority queued item within WIP caps (global-wip: ${parsed.globalWipCap ?? "unset"}, per-repo-wip: ${parsed.perRepoWipCap ?? "unset"}). No portfolio-queue write was made.`);
        }
        else {
            console.log("DRY RUN: would dequeue the highest-priority queued item. No portfolio-queue write was made.");
        }
        return 0;
    }
    try {
        return withPortfolioQueue(options, (portfolioQueue) => {
            let entry;
            if (capsRequested) {
                // Unset dimensions stay genuinely uncapped (Infinity), not silently defaulted to 1 like claim-batch.
                const caps = {
                    globalWipCap: parsed.globalWipCap ?? Number.POSITIVE_INFINITY,
                    perRepoWipCap: parsed.perRepoWipCap ?? Number.POSITIVE_INFINITY,
                };
                const claimed = portfolioQueue.batchClaim((entries) => selectNextEligibleTarget(entries, caps));
                entry = claimed[0] ?? null;
            }
            else {
                entry = portfolioQueue.dequeueNext();
            }
            if (parsed.json) {
                console.log(JSON.stringify({ entry }, null, 2));
            }
            else {
                console.log(entry ? entry.identifier : "none");
            }
            return 0;
        });
    }
    catch (error) {
        return reportCliFailure(parsed.json, describeCliError(error));
    }
}
export function runQueueDone(args, options = {}) {
    const parsed = parseQueueDoneArgs(args);
    if ("error" in parsed) {
        return reportCliFailure(argsWantJson(args), parsed.error);
    }
    if (parsed.dryRun) {
        const dryRunResult = { outcome: "dry_run", repoFullName: parsed.repoFullName, identifier: parsed.identifier };
        if (parsed.json) {
            console.log(JSON.stringify(dryRunResult, null, 2));
        }
        else {
            console.log(`DRY RUN: would mark ${parsed.repoFullName} ${parsed.identifier} done. No portfolio-queue write was made.`);
        }
        return 0;
    }
    try {
        return withPortfolioQueue(options, (portfolioQueue) => {
            const entry = portfolioQueue.markDone(parsed.repoFullName, parsed.identifier, parsed.apiBaseUrl);
            if (!entry) {
                return reportCliFailure(parsed.json, "queue_entry_not_found");
            }
            if (parsed.json) {
                console.log(JSON.stringify({ entry }, null, 2));
            }
            else {
                console.log(entry.status);
            }
            return 0;
        });
    }
    catch (error) {
        return reportCliFailure(parsed.json, describeCliError(error));
    }
}
/** `release <owner/repo> <identifier>`: manually give up a CLAIMED (in_progress) item, returning it to the queue
 *  (the manual counterpart to the automated stuck-lease sweep). Exit 2 when there is no in-flight item to release. */
export function runQueueRelease(args, options = {}) {
    const parsed = parseQueueReleaseArgs(args);
    if ("error" in parsed) {
        return reportCliFailure(argsWantJson(args), parsed.error);
    }
    if (parsed.dryRun) {
        const dryRunResult = { outcome: "dry_run", repoFullName: parsed.repoFullName, identifier: parsed.identifier };
        if (parsed.json) {
            console.log(JSON.stringify(dryRunResult, null, 2));
        }
        else {
            console.log(`DRY RUN: would release ${parsed.repoFullName} ${parsed.identifier} back to the queue. No portfolio-queue write was made.`);
        }
        return 0;
    }
    try {
        return withPortfolioQueue(options, (portfolioQueue) => {
            const entry = portfolioQueue.reclaimStuckItem(parsed.repoFullName, parsed.identifier, parsed.apiBaseUrl);
            if (!entry) {
                return reportCliFailure(parsed.json, "queue_entry_not_in_progress");
            }
            if (parsed.json) {
                console.log(JSON.stringify({ entry }, null, 2));
            }
            else {
                console.log(entry.status);
            }
            return 0;
        });
    }
    catch (error) {
        return reportCliFailure(parsed.json, describeCliError(error));
    }
}
/** `requeue <owner/repo> <identifier>`: manually put a COMPLETED (done) item back on the queue so it is picked up
 *  again, keeping its original FIFO position. Exit 2 when there is no done item to requeue (already queued,
 *  in-flight — release it instead — or absent). */
export function runQueueRequeue(args, options = {}) {
    const parsed = parseQueueRequeueArgs(args);
    if ("error" in parsed) {
        return reportCliFailure(argsWantJson(args), parsed.error);
    }
    if (parsed.dryRun) {
        const dryRunResult = { outcome: "dry_run", repoFullName: parsed.repoFullName, identifier: parsed.identifier };
        if (parsed.json) {
            console.log(JSON.stringify(dryRunResult, null, 2));
        }
        else {
            console.log(`DRY RUN: would requeue ${parsed.repoFullName} ${parsed.identifier}. No portfolio-queue write was made.`);
        }
        return 0;
    }
    try {
        return withPortfolioQueue(options, (portfolioQueue) => {
            const entry = portfolioQueue.requeueItem(parsed.repoFullName, parsed.identifier, parsed.apiBaseUrl);
            if (!entry) {
                return reportCliFailure(parsed.json, "queue_entry_not_requeuable");
            }
            if (parsed.json) {
                console.log(JSON.stringify({ entry }, null, 2));
            }
            else {
                console.log(entry.status);
            }
            return 0;
        });
    }
    catch (error) {
        return reportCliFailure(parsed.json, describeCliError(error));
    }
}
export function parseQueueClaimBatchArgs(args) {
    const options = {
        json: false,
        dryRun: false,
        globalWipCap: 1,
        perRepoWipCap: 1,
    };
    for (let index = 0; index < args.length; index += 1) {
        const token = args[index];
        if (token === "--json") {
            options.json = true;
            continue;
        }
        if (token === "--dry-run") {
            options.dryRun = true;
            continue;
        }
        if (token === "--global-wip" || token === "--per-repo-wip") {
            const value = Number(args[index + 1]);
            if (args[index + 1] === undefined || !Number.isFinite(value) || value < 0) {
                return { error: QUEUE_CLAIM_BATCH_USAGE };
            }
            if (token === "--global-wip")
                options.globalWipCap = value;
            else
                options.perRepoWipCap = value;
            index += 1;
            continue;
        }
        return { error: QUEUE_CLAIM_BATCH_USAGE };
    }
    return options;
}
/** Claim the next caps-aware batch via the WIP-cap-aware batch claimer (portfolio-queue-manager.js), which also
 *  reclaims any leases orphaned by a crashed process first (#4833 wires the previously caller-less claimer). */
export function runQueueClaimBatch(args, options = {}) {
    const parsed = parseQueueClaimBatchArgs(args);
    if ("error" in parsed) {
        return reportCliFailure(argsWantJson(args), parsed.error);
    }
    if (parsed.dryRun) {
        const dryRunResult = { outcome: "dry_run", globalWipCap: parsed.globalWipCap, perRepoWipCap: parsed.perRepoWipCap };
        if (parsed.json) {
            console.log(JSON.stringify(dryRunResult, null, 2));
        }
        else {
            console.log(`DRY RUN: would claim a batch (global-wip: ${parsed.globalWipCap}, per-repo-wip: ${parsed.perRepoWipCap}). No portfolio-queue write was made.`);
        }
        return 0;
    }
    // Open the manager INSIDE the try so a store open failure returns 2 instead of crashing; the finally guards the
    // close with `?.` since the initializer may have thrown before assigning.
    const ownsManager = options.initPortfolioQueueManager === undefined;
    let manager;
    try {
        manager = (options.initPortfolioQueueManager ?? initPortfolioQueueManager)({
            caps: { globalWipCap: parsed.globalWipCap, perRepoWipCap: parsed.perRepoWipCap },
        });
        const claimed = manager.claimNextBatch();
        if (parsed.json) {
            console.log(JSON.stringify({ claimed }, null, 2));
        }
        else {
            console.log(claimed.length === 0 ? "none" : claimed.map((entry) => entry.identifier).join("\n"));
        }
        return 0;
    }
    catch (error) {
        return reportCliFailure(parsed.json, describeCliError(error));
    }
    finally {
        if (ownsManager)
            manager?.close();
    }
}
const QUEUE_METRICS_USAGE = "Usage: loopover-miner queue metrics";
// Prometheus metric names for the portfolio-queue gauges (#5186). Mirrors the `loopover_miner_*` naming and
// HELP/TYPE/label conventions of event-ledger-cli.js's renderEventLedgerMetrics / the engine's
// renderMinerPredictionMetrics, rather than importing across the package boundary.
export const QUEUE_ITEMS = "loopover_miner_portfolio_queue_items";
export const QUEUE_OLDEST_IN_PROGRESS_LEASE_AGE_SECONDS = "loopover_miner_portfolio_queue_oldest_in_progress_lease_age_seconds";
/** HELP-text escaping — backslash + newline (mirrors miner-prediction-metrics.ts's escapeHelpText). */
function escapeMetricsHelpText(help) {
    return help.replace(/\\/g, "\\\\").replace(/\n/g, "\\n");
}
/**
 * Render portfolio-queue backlog health as Prometheus text-exposition gauges: current item count per status, and
 * the age of the OLDEST still-in-flight lease -- the concrete "is anything stuck" signal a
 * `loopover_queue_oldest_maintenance_pending_age_seconds`-style alert rule can threshold on (#5186). Pure and
 * side-effect-free: the caller supplies the rows and `nowMs` (no internal clock read, matching
 * store-maintenance.js's pruneLedgerByRetention convention) and prints the result. Deterministic (status series
 * sorted); always emits HELP/TYPE so an empty queue is still a well-formed exposition document, and the lease-age
 * gauge reads 0 (never stuck) rather than being omitted when nothing is in-flight.
 * @param {Array<{ status: string }>} queueEntries - every row, any status (e.g. store.listQueue()'s output).
 * @param {Array<{ leasedAt: string | null }>} leaseEntries - in-flight rows only (store.listInProgress()'s output).
 * @param {number} nowMs
 */
export function renderPortfolioQueueMetrics(queueEntries, leaseEntries, nowMs) {
    const countByStatus = new Map();
    for (const entry of queueEntries) {
        countByStatus.set(entry.status, (countByStatus.get(entry.status) ?? 0) + 1);
    }
    let oldestLeaseAgeSeconds = 0;
    for (const lease of leaseEntries) {
        const leasedAtMs = Date.parse(lease.leasedAt ?? "");
        if (!Number.isFinite(leasedAtMs))
            continue;
        const ageSeconds = Math.max(0, (nowMs - leasedAtMs) / 1000);
        if (ageSeconds > oldestLeaseAgeSeconds)
            oldestLeaseAgeSeconds = ageSeconds;
    }
    const lines = [
        `# HELP ${QUEUE_ITEMS} ${escapeMetricsHelpText("Current portfolio-queue item count, by status.")}`,
        `# TYPE ${QUEUE_ITEMS} gauge`,
    ];
    for (const [status, count] of [...countByStatus.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
        lines.push(`${QUEUE_ITEMS}{status="${status}"} ${count}`);
    }
    lines.push(`# HELP ${QUEUE_OLDEST_IN_PROGRESS_LEASE_AGE_SECONDS} ${escapeMetricsHelpText("Age in seconds of the oldest still-in-flight (in_progress) claim lease. 0 when nothing is in-flight.")}`);
    lines.push(`# TYPE ${QUEUE_OLDEST_IN_PROGRESS_LEASE_AGE_SECONDS} gauge`);
    lines.push(`${QUEUE_OLDEST_IN_PROGRESS_LEASE_AGE_SECONDS} ${oldestLeaseAgeSeconds}`);
    return `${lines.join("\n")}\n`;
}
export function runQueueMetrics(args, options = {}) {
    if (args.length > 0) {
        return reportCliFailure(argsWantJson(args), QUEUE_METRICS_USAGE);
    }
    try {
        return withPortfolioQueue(options, (portfolioQueue) => {
            const nowMs = typeof options.nowMs === "number" && Number.isFinite(options.nowMs) ? options.nowMs : Date.now();
            // renderPortfolioQueueMetrics returns a newline-terminated document; console.log re-adds the terminator, so
            // trim it to emit exactly one trailing newline (mirrors metrics-cli.js's runMetrics).
            console.log(renderPortfolioQueueMetrics(portfolioQueue.listQueue(), portfolioQueue.listInProgress(), nowMs).trimEnd());
            return 0;
        });
    }
    catch (error) {
        return reportCliFailure(argsWantJson(args), describeCliError(error));
    }
}
export function runQueueCli(subcommand, args, options = {}) {
    if (subcommand === "list")
        return runQueueList(args, options);
    if (subcommand === "next")
        return runQueueNext(args, options);
    if (subcommand === "done")
        return runQueueDone(args, options);
    if (subcommand === "release")
        return runQueueRelease(args, options);
    if (subcommand === "requeue")
        return runQueueRequeue(args, options);
    if (subcommand === "claim-batch")
        return runQueueClaimBatch(args, options);
    if (subcommand === "metrics")
        return runQueueMetrics(args, options);
    if (subcommand === "dashboard")
        return runPortfolioDashboard(args, options);
    return reportCliFailure(argsWantJson(args), `Unknown queue subcommand: ${subcommand ?? ""}. ${QUEUE_LIST_USAGE}`);
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoicG9ydGZvbGlvLXF1ZXVlLWNsaS5qcyIsInNvdXJjZVJvb3QiOiIiLCJzb3VyY2VzIjpbInBvcnRmb2xpby1xdWV1ZS1jbGkudHMiXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6IkFBQUEsT0FBTyxFQUFFLHVCQUF1QixFQUFFLE1BQU0sc0JBQXNCLENBQUM7QUFFL0QsT0FBTyxFQUFFLHlCQUF5QixFQUFFLE1BQU0sOEJBQThCLENBQUM7QUFFekUsT0FBTyxFQUFFLHFCQUFxQixFQUFFLE1BQU0sMEJBQTBCLENBQUM7QUFDakUsT0FBTyxFQUFFLFlBQVksRUFBRSxnQkFBZ0IsRUFBRSxnQkFBZ0IsRUFBRSxNQUFNLGdCQUFnQixDQUFDO0FBQ2xGLE9BQU8sRUFBRSxrQkFBa0IsRUFBRSxNQUFNLGlCQUFpQixDQUFDO0FBRXJELE1BQU0sZ0JBQWdCLEdBQUcsaUVBQWlFLENBQUM7QUFDM0YsTUFBTSxnQkFBZ0IsR0FDcEIsK0ZBQStGLENBQUM7QUFDbEcsTUFBTSxnQkFBZ0IsR0FDcEIsd0dBQXdHLENBQUM7QUFDM0csTUFBTSxtQkFBbUIsR0FDdkIsMkdBQTJHLENBQUM7QUFDOUcsTUFBTSxtQkFBbUIsR0FDdkIsMkdBQTJHLENBQUM7QUFDOUcsTUFBTSx1QkFBdUIsR0FDM0Isc0dBQXNHLENBQUM7QUFtQ3pHLFNBQVMsWUFBWSxDQUFDLEtBQXlCLEVBQUUsS0FBYTtJQUM1RCxJQUFJLENBQUMsS0FBSztRQUFFLE9BQU8sRUFBRSxLQUFLLEVBQUUsS0FBSyxFQUFFLENBQUM7SUFDcEMsTUFBTSxPQUFPLEdBQUcsS0FBSyxDQUFDLElBQUksRUFBRSxDQUFDO0lBQzdCLE1BQU0sQ0FBQyxLQUFLLEVBQUUsSUFBSSxFQUFFLEtBQUssQ0FBQyxHQUFHLE9BQU8sQ0FBQyxLQUFLLENBQUMsR0FBRyxDQUFDLENBQUM7SUFDaEQsSUFBSSxDQUFDLEtBQUssSUFBSSxDQUFDLElBQUksSUFBSSxLQUFLLEtBQUssU0FBUyxJQUFJLENBQUMsa0JBQWtCLENBQUMsS0FBSyxDQUFD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
import { runGovernorPause, runGovernorResume, runGovernorStatus } from "./governor-pause-cli.js";
import { runGovernorMetrics } from "./governor-metrics-cli.js";
/** Must match `GOVERNOR_LEDGER_EVENT_TYPES` in `@loopover/engine`. */
import { argsWantJson, describeCliError, reportCliFailure } from "./cli-error.js";
import { isValidRepoSegment } from "./repo-clone.js";
const GOVERNOR_LEDGER_EVENT_TYPES = Object.freeze([
    "allowed",
    "denied",
    "throttled",
    "kill_switch",
]);
const GOVERNOR_LIST_USAGE = "Usage: loopover-miner governor list [--repo <owner/repo>] [--type allowed|denied|throttled|kill_switch] [--json]";
const GOVERNOR_SUBCOMMAND_USAGE = [
    GOVERNOR_LIST_USAGE,
    "       loopover-miner governor pause [--reason <text>] [--dry-run] [--json]",
    "       loopover-miner governor resume [--dry-run] [--json]",
    "       loopover-miner governor status [--json]",
    "       loopover-miner governor metrics",
].join("\n");
// The sole caller (the --repo branch of parseGovernorListArgs below) always checks `repoArg` is a
// truthy, non-flag-looking string before calling this, so `value` is never empty here.
function parseRepoArg(value) {
    const trimmed = value.trim();
    const [owner, repo, extra] = trimmed.split("/");
    if (!owner || !repo || extra !== undefined || !isValidRepoSegment(owner) || !isValidRepoSegment(repo)) {
        return { error: "Repository must be in owner/repo form." };
    }
    return { repoFullName: `${owner}/${repo}` };
}
export function parseGovernorListArgs(args) {
    const options = {
        json: false,
        repoFullName: null,
        type: null,
    };
    const positional = [];
    for (let index = 0; index < args.length; index += 1) {
        const token = args[index];
        if (token === "--json") {
            options.json = true;
            continue;
        }
        if (token === "--repo") {
            const repoArg = args[index + 1];
            if (!repoArg || repoArg.startsWith("-"))
                return { error: GOVERNOR_LIST_USAGE };
            const repo = parseRepoArg(repoArg);
            if ("error" in repo)
                return repo;
            options.repoFullName = repo.repoFullName;
            index += 1;
            continue;
        }
        if (token === "--type") {
            const type = args[index + 1];
            if (!type || type.startsWith("-"))
                return { error: GOVERNOR_LIST_USAGE };
            const trimmed = type.trim();
            if (!GOVERNOR_LEDGER_EVENT_TYPES.includes(trimmed)) {
                return {
                    error: `Invalid type: ${trimmed}. Expected one of ${GOVERNOR_LEDGER_EVENT_TYPES.join(", ")}.`,
                };
            }
            options.type = trimmed;
            index += 1;
            continue;
        }
        if (token.startsWith("-"))
            return { error: `Unknown option: ${token}` };
        positional.push(token);
    }
    if (positional.length > 0)
        return { error: GOVERNOR_LIST_USAGE };
    return options;
}
export function filterGovernorEvents(events, options = {}) {
    if (!Array.isArray(events))
        return [];
    const type = typeof options.type === "string" && options.type.trim() ? options.type.trim() : null;
    if (!type)
        return events;
    return events.filter((entry) => entry.eventType === type);
}
function display(value) {
    if (value === null || value === undefined)
        return "-";
    return String(value);
}
export function renderGovernorTable(events) {
    if (!Array.isArray(events) || events.length === 0)
        return "no governor ledger entries";
    const header = [
        "id".padStart(4),
        "type".padEnd(12),
        "repo".padEnd(24),
        "action".padEnd(10),
        "decision".padEnd(10),
        "ts".padEnd(24),
    ].join(" ");
    const lines = events.map((entry) => [
        String(entry.id).padStart(4),
        entry.eventType.padEnd(12),
        display(entry.repoFullName).padEnd(24),
        entry.actionClass.padEnd(10),
        entry.decision.padEnd(10),
        display(entry.ts).padEnd(24),
    ].join(" "));
    return [header, ...lines].join("\n");
}
async function withGovernorLedger(options, run) {
    const ownsLedger = options.initGovernorLedger === undefined;
    const initGovernorLedger = options.initGovernorLedger ?? (await import("./governor-ledger.js")).initGovernorLedger;
    const governorLedger = initGovernorLedger();
    try {
        return run(governorLedger);
    }
    finally {
        if (ownsLedger)
            governorLedger.close();
    }
}
export async function runGovernorList(args, options = {}) {
    const parsed = parseGovernorListArgs(args);
    if ("error" in parsed) {
        return reportCliFailure(argsWantJson(args), parsed.error);
    }
    try {
        return await withGovernorLedger(options, (governorLedger) => {
            const events = filterGovernorEvents(governorLedger.readGovernorEvents({
                repoFullName: parsed.repoFullName,
            }), { type: parsed.type });
            if (parsed.json) {
                console.log(JSON.stringify({ events }, null, 2));
            }
            else {
                console.log(renderGovernorTable(events));
            }
            return 0;
        });
    }
    catch (error) {
        return reportCliFailure(parsed.json, describeCliError(error));
    }
}
export async function runGovernorCli(subcommand, args, options = {}) {
    if (subcommand === "list")
        return runGovernorList(args, options);
    if (subcommand === "pause")
        return runGovernorPause(args, options);
    if (subcommand === "resume")
        return runGovernorResume(args, options);
    if (subcommand === "status")
        return runGovernorStatus(args, options);
    if (subcommand === "metrics")
        return runGovernorMetrics(args, options);
    return reportCliFailure(argsWantJson(args), `Unknown governor subcommand: ${subcommand ?? ""}.\n${GOVERNOR_SUBCOMMAND_USAGE}`);
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiZ292ZXJub3ItbGVkZ2VyLWNsaS5qcyIsInNvdXJjZVJvb3QiOiIiLCJzb3VyY2VzIjpbImdvdmVybm9yLWxlZGdlci1jbGkudHMiXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6IkFBQUEsT0FBTyxFQUFFLGdCQUFnQixFQUFFLGlCQUFpQixFQUFFLGlCQUFpQixFQUFFLE1BQU0seUJBQXlCLENBQUM7QUFFakcsT0FBTyxFQUFFLGtCQUFrQixFQUFFLE1BQU0sMkJBQTJCLENBQUM7QUFFL0Qsc0VBQXNFO0FBQ3RFLE9BQU8sRUFBRSxZQUFZLEVBQUUsZ0JBQWdCLEVBQUUsZ0JBQWdCLEVBQUUsTUFBTSxnQkFBZ0IsQ0FBQztBQUVsRixPQUFPLEVBQUUsa0JBQWtCLEVBQUUsTUFBTSxpQkFBaUIsQ0FBQztBQUlyRCxNQUFNLDJCQUEyQixHQUF1QyxNQUFNLENBQUMsTUFBTSxDQUFDO0lBQ3BGLFNBQVM7SUFDVCxRQUFRO0lBQ1IsV0FBVztJQUNYLGFBQWE7Q0FDZCxDQUFDLENBQUM7QUFFSCxNQUFNLG1CQUFtQixHQUN2QixrSEFBa0gsQ0FBQztBQUVySCxNQUFNLHlCQUF5QixHQUFHO0lBQ2hDLG1CQUFtQjtJQUNuQiw2RUFBNkU7SUFDN0UsNERBQTREO0lBQzVELGdEQUFnRDtJQUNoRCx3Q0FBd0M7Q0FDekMsQ0FBQyxJQUFJLENBQUMsSUFBSSxDQUFDLENBQUM7QUFpQmIsa0dBQWtHO0FBQ2xHLHVGQUF1RjtBQUN2RixTQUFTLFlBQVksQ0FBQyxLQUFhO0lBQ2pDLE1BQU0sT0FBTyxHQUFHLEtBQUssQ0FBQyxJQUFJLEVBQUUsQ0FBQztJQUM3QixNQUFNLENBQUMsS0FBSyxFQUFFLElBQUksRUFBRSxLQUFLLENBQUMsR0FBRyxPQUFPLENBQUMsS0FBSyxDQUFDLEdBQUcsQ0FBQyxDQUFDO0lBQ2hELElBQUksQ0FBQyxLQUFLLElBQUksQ0FBQyxJQUFJLElBQUksS0FBSyxLQUFLLFNBQVMsSUFBSSxDQUFDLGtCQUFrQixDQUFDLEtBQUssQ0FBQyxJQUFJLENBQUMs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
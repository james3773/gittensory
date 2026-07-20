import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ExternalLink } from "lucide-react";

import {
  buildSkippedPrAuditPath,
  formatAuditTimestamp,
  formatSkipReason,
  normalizeSinceInput,
  normalizeSkippedPrAuditExport,
  pullRequestHref,
  SKIP_REASON_OPTIONS,
  skipReasonTone,
  type SkippedPrAuditExport,
  type SkippedPrAuditReason,
} from "@/components/site/audit-feed-model";
import { BoundaryBadge, StatusPill } from "@/components/site/control-primitives";
import { TableScroll } from "@/components/site/data-table";
import {
  EmptyState,
  ErrorState,
  LoadingState,
  StateActionButton,
} from "@/components/site/state-views";
import { Input } from "@/components/ui/input";
import { getApiOrigin } from "@/lib/api/origin";
import { apiFetch } from "@/lib/api/request";

const fieldClass =
  "mt-1 w-full rounded-token border border-border bg-background/40 px-3 py-2 text-token-sm text-foreground focus-ring";

const DEFAULT_LIMIT = 50;

type AuditFeedProps = {
  enabled?: boolean;
};

export function AuditFeed({ enabled = true }: AuditFeedProps) {
  const [reason, setReason] = useState<"" | SkippedPrAuditReason>("");
  const [repoDraft, setRepoDraft] = useState("");
  const [repoFullName, setRepoFullName] = useState("");
  const [sinceInput, setSinceInput] = useState("");
  const [sinceIso, setSinceIso] = useState("");
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const [error, setError] = useState<string | null>(null);
  const [data, setData] = useState<SkippedPrAuditExport | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  // Bumped on every replace-load so an in-flight loadMore cannot append onto a newer filter result.
  const requestGenerationRef = useRef(0);

  const filterPath = useMemo(
    () =>
      buildSkippedPrAuditPath({
        limit: DEFAULT_LIMIT,
        offset: 0,
        repoFullName: repoFullName || undefined,
        reason: reason || undefined,
        since: sinceIso || undefined,
      }),
    [reason, repoFullName, sinceIso],
  );

  const load = useCallback(async () => {
    if (!enabled) {
      setStatus("error");
      setError("This audit feed is unavailable for your current role.");
      setData(null);
      return;
    }
    const generation = ++requestGenerationRef.current;
    setLoadingMore(false);
    setStatus("loading");
    setError(null);
    const origin = getApiOrigin().replace(/\/$/, "");
    const result = await apiFetch<SkippedPrAuditExport>(`${origin}${filterPath}`, {
      label: "Skipped PR audit",
      credentials: "include",
      headers: { Accept: "application/json" },
    });
    if (generation !== requestGenerationRef.current) return;
    if (result.ok) {
      const normalized = normalizeSkippedPrAuditExport(result.data);
      if (!normalized) {
        setData(null);
        setError("The skipped PR audit endpoint returned an unexpected response.");
        setStatus("error");
        return;
      }
      setData(normalized);
      setStatus("ready");
      return;
    }
    setData(null);
    setError(result.message);
    setStatus("error");
  }, [enabled, filterPath]);

  useEffect(() => {
    void load();
  }, [load]);

  const applyFilters = () => {
    setSinceIso(normalizeSinceInput(sinceInput));
    setRepoFullName(repoDraft.trim());
  };

  const resetFilters = () => {
    setReason("");
    setRepoDraft("");
    setRepoFullName("");
    setSinceInput("");
    setSinceIso("");
  };

  const loadMore = async () => {
    if (!enabled || !data?.hasMore || loadingMore) return;
    const generation = requestGenerationRef.current;
    const nextOffset = data.items.length;
    const itemsAtStart = data.items;
    setLoadingMore(true);
    setError(null);
    const origin = getApiOrigin().replace(/\/$/, "");
    const path = buildSkippedPrAuditPath({
      limit: DEFAULT_LIMIT,
      offset: nextOffset,
      repoFullName: repoFullName || undefined,
      reason: reason || undefined,
      since: sinceIso || undefined,
    });
    const result = await apiFetch<SkippedPrAuditExport>(`${origin}${path}`, {
      label: "Skipped PR audit",
      credentials: "include",
      headers: { Accept: "application/json" },
    });
    // Ignore stale responses after a filter/replace load invalidated this generation (#7506 review).
    if (generation !== requestGenerationRef.current) {
      setLoadingMore(false);
      return;
    }
    setLoadingMore(false);
    if (!result.ok) {
      setError(result.message);
      return;
    }
    const normalized = normalizeSkippedPrAuditExport(result.data);
    if (!normalized) {
      setError("The skipped PR audit endpoint returned an unexpected response.");
      return;
    }
    // Append-not-replace (#7438): keep already-rendered rows; only grow with the next page.
    setData({
      ...normalized,
      items: [...itemsAtStart, ...normalized.items],
      // Surface the next page's paging cursor so subsequent Load more advances correctly.
      offset: nextOffset,
    });
  };

  if (status === "loading" && !data) {
    return (
      <LoadingState
        title="Loading skip audit…"
        description="Fetching bounded public-surface skip decisions from the private audit API."
      />
    );
  }

  if (status === "error" && !data) {
    return (
      <ErrorState
        title="Couldn't load skip audit"
        description={error ?? "The skipped PR audit endpoint did not respond."}
        onRetry={() => void load()}
      />
    );
  }

  if (status === "ready" && data && data.items.length === 0) {
    return (
      <div className="space-y-6">
        <AuditFilters
          reason={reason}
          repoDraft={repoDraft}
          sinceInput={sinceInput}
          onReasonChange={setReason}
          onRepoDraftChange={setRepoDraft}
          onSinceInputChange={setSinceInput}
          onApply={applyFilters}
          onReset={resetFilters}
        />
        <EmptyState
          title="No skipped PR events"
          description="When LoopOver intentionally skips public GitHub App output for a pull request, the decision appears here."
          action={<StateActionButton onClick={() => void load()}>Refresh</StateActionButton>}
        />
      </div>
    );
  }

  if (!data) return null;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <StatusPill status="ready">{data.items.length} event(s)</StatusPill>
          {data.hasMore ? <StatusPill status="info">More available</StatusPill> : null}
          <BoundaryBadge boundary="private-api" />
        </div>
        <div className="font-mono text-token-2xs text-muted-foreground">
          Updated {formatAuditTimestamp(data.generatedAt)}
        </div>
      </div>

      <AuditFilters
        reason={reason}
        repoDraft={repoDraft}
        sinceInput={sinceInput}
        onReasonChange={setReason}
        onRepoDraftChange={setRepoDraft}
        onSinceInputChange={setSinceInput}
        onApply={applyFilters}
        onReset={resetFilters}
      />

      <TableScroll
        className="rounded-token border border-border bg-transparent"
        label="Skipped PR audit"
      >
        <table className="w-full min-w-[760px] text-left text-token-sm">
          <caption className="sr-only">
            Skipped pull requests with the time, repository, pull request, skip reason, and
            remediation for each.
          </caption>
          <thead className="border-b border-border text-token-xs uppercase text-muted-foreground">
            <tr>
              <th scope="col" className="px-4 py-3 font-medium">
                Time
              </th>
              <th scope="col" className="px-4 py-3 font-medium">
                Repository
              </th>
              <th scope="col" className="px-4 py-3 font-medium">
                Pull request
              </th>
              <th scope="col" className="px-4 py-3 font-medium">
                Reason
              </th>
              <th scope="col" className="px-4 py-3 font-medium">
                Remediation
              </th>
            </tr>
          </thead>
          <tbody>
            {data.items.map((item) => (
              <tr
                key={`${item.repoFullName}#${item.pullNumber}-${item.timestamp}-${item.reason}`}
                className="border-b border-border/60 last:border-0 align-top"
              >
                <td className="px-4 py-3 font-mono text-token-xs text-muted-foreground whitespace-nowrap">
                  {formatAuditTimestamp(item.timestamp)}
                </td>
                <td className="px-4 py-3 font-mono text-token-xs">{item.repoFullName}</td>
                <td className="px-4 py-3">
                  <a
                    href={pullRequestHref(item.repoFullName, item.pullNumber)}
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex items-center gap-1 font-mono text-token-xs text-mint hover:underline focus-ring rounded-token"
                  >
                    #{item.pullNumber}
                    <ExternalLink className="size-3" aria-hidden />
                  </a>
                </td>
                <td className="px-4 py-3">
                  <StatusPill status={skipReasonTone(item.reason)}>
                    {formatSkipReason(item.reason)}
                  </StatusPill>
                </td>
                <td className="px-4 py-3 text-token-xs text-muted-foreground">
                  {item.remediation}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </TableScroll>

      <div className="flex flex-wrap items-center gap-3">
        {data.hasMore ? (
          <StateActionButton onClick={() => void loadMore()} disabled={loadingMore}>
            {loadingMore ? "Loading…" : "Load more"}
          </StateActionButton>
        ) : null}
        {error ? <p className="text-token-xs text-destructive">{error}</p> : null}
        <StateActionButton onClick={() => void load()}>Refresh</StateActionButton>
      </div>
    </div>
  );
}

function AuditFilters({
  reason,
  repoDraft,
  sinceInput,
  onReasonChange,
  onRepoDraftChange,
  onSinceInputChange,
  onApply,
  onReset,
}: {
  reason: "" | SkippedPrAuditReason;
  repoDraft: string;
  sinceInput: string;
  onReasonChange: (value: "" | SkippedPrAuditReason) => void;
  onRepoDraftChange: (value: string) => void;
  onSinceInputChange: (value: string) => void;
  onApply: () => void;
  onReset: () => void;
}) {
  return (
    <section className="rounded-token border border-border bg-transparent p-4">
      <h2 className="font-display text-token-lg font-semibold">Filters</h2>
      <p className="mt-1 text-token-xs text-muted-foreground">
        Filter skip decisions by reason, repository, or events after a timestamp.
      </p>
      <div className="mt-4 grid gap-4 md:grid-cols-3">
        <label className="block">
          <span className="font-mono text-token-2xs uppercase tracking-wider text-muted-foreground">
            Reason
          </span>
          <select
            value={reason}
            onChange={(event) => onReasonChange(event.target.value as "" | SkippedPrAuditReason)}
            className={fieldClass}
          >
            {SKIP_REASON_OPTIONS.map((option) => (
              <option key={option.label} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </label>
        <label className="block">
          <span className="font-mono text-token-2xs uppercase tracking-wider text-muted-foreground">
            Repository
          </span>
          <Input
            value={repoDraft}
            onChange={(event) => onRepoDraftChange(event.target.value)}
            placeholder="owner/repo"
            className="mt-1"
          />
        </label>
        <label className="block">
          <span className="font-mono text-token-2xs uppercase tracking-wider text-muted-foreground">
            Since
          </span>
          <input
            type="datetime-local"
            value={sinceInput}
            onChange={(event) => onSinceInputChange(event.target.value)}
            className={fieldClass}
          />
        </label>
      </div>
      <div className="mt-4 flex flex-wrap gap-2">
        <StateActionButton variant="primary" onClick={onApply}>
          Apply filters
        </StateActionButton>
        <StateActionButton onClick={onReset}>Reset</StateActionButton>
      </div>
    </section>
  );
}

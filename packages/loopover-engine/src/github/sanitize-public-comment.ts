export function sanitizePublicComment(value: string): string {
  const sanitized = value
    .replace(/\bopen pr count\s+\d+\s+exceeds threshold\s+\d+\b\.?/gi, "private context")
    .replace(/\bopen pr count is at or below\s+\d+\b/gi, "private context")
    .replace(/\bmerged pr count\s+\d+\s+is below upstream floor\s+\d+\b\.?/gi, "private context")
    .replace(/\bissue-discovery history\s*\(\s*\d+\s+valid solved,\s*credibility\s+[-+]?\d+(?:\.\d+)?\s*\)\s+is below upstream floors\s*\(\s*\d+\s+valid solved,\s*[-+]?\d+(?:\.\d+)?\s+credibility\s*\)\.?/gi, "private context")
    .replace(/\bcredibility\s+[-+]?\d+(?:\.\d+)?\s+is below floor\s+[-+]?\d+(?:\.\d+)?\b\.?/gi, "private context")
    .replace(/\b(?:effective|projected|estimated) score(?: changes?)?\b(?:\s+from)?\s+[-+]?\d+(?:\.\d+)?\s*(?:->|→|to)\s*[-+]?\d+(?:\.\d+)?/gi, "private context")
    .replace(/\b(raw trust scores?|trust scores?|wallets?|hotkeys?|coldkeys?|seed phrases?|mnemonics?)\b/gi, "private context")
    .replace(/\b(public score estimates?|estimated scores?|score estimates?|estimated rewards?|rewards?|reward estimates?|payouts?|farming|scoreability|score previews?|projected score changes?)\b/gi, "private context")
    // "cohort" and standalone miner-/human-originated / "raw trust" (not just the "raw trust score" compound)
    // leaked through this sanitizer: no entry above catches a bare mention of any of these. A bare "score" is
    // deliberately NOT added here the same way: unlike queue-intelligence.ts's sanitizePublicComment (which
    // gates unconstrained AI-review/chat-qa output before it is ever posted), this function is also reused by
    // src/services/score-breakdown.ts to render its own contributor-facing "explain my score" copy, which
    // legitimately says "score" throughout by design -- redacting it there would gut that feature's own output,
    // not close a leak. See src/signals/redaction.ts's note on agent-action-explanation-card.ts /
    // miner-dashboard-recommendations.ts for the established precedent of a surface intentionally not
    // redacting bare score/reward.
    .replace(/\b(cohorts?|miner[-_\s]?originated|human[-_\s]?originated|raw trust)\b/gi, "private context")
    .replace(/\b(private reviewability|reviewability internals?)\b/gi, "private context")
    .replace(/\b(private rankings?|rankings?)\b/gi, "private context")
    .replace(/\b(?:open_pr_pressure|closed_pr_credibility|low_credibility|maintainer_lane|inactive_or_unknown_lane|issue_discovery_only|merged_pr_history_floor|issue_discovery_validity_floor)\b/gi, "private context")
    .replace(/\b(?:credibility(?: updates?)?|closed pr credibility|low credibility|open pr pressure)\b/gi, "private context")
    // Catch-all: a phrase replacement above (e.g. "score estimate"/"score preview") can leave a bare
    // numeric score transition behind ("private context 32.5 -> 41.2"); redact those residual numbers too.
    .replace(/\bprivate context\b\s+[-+]?\d+(?:\.\d+)?\s*(?:->|→|to)\s*[-+]?\d+(?:\.\d+)?/gi, "private context")
    .replace(/\blikely_duplicate\b/gi, "possible overlap with existing work");
  return sanitizeReviewabilityTerm(sanitized).replace(/private context(?:,\s*private context)+/gi, "private context");
}

function sanitizeReviewabilityTerm(value: string): string {
  return value.replace(/\breviewability\b/gi, (match, offset, fullText: string) => {
    const prefix = fullText.slice(Math.max(0, offset - "@loopover ".length), offset).toLowerCase();
    return prefix.endsWith("@loopover ") ? match : "private context";
  });
}

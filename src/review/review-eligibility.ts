import { matchesManifestPath } from "../signals/focus-manifest";

export type ReviewEligibilitySkipReason = "ignored_author" | "skip_label";

export type ReviewEligibilityInput = {
  authorLogin?: string | null | undefined;
  ignoreAuthors?: readonly string[] | null | undefined;
  skipLabels?: readonly string[] | null | undefined;
  prLabels?: readonly string[] | null | undefined;
};

export type ReviewEligibilityDecision =
  | {
      eligible: true;
      skipReason: null;
      matchedPattern: null;
    }
  | {
      eligible: false;
      skipReason: ReviewEligibilitySkipReason;
      matchedPattern: string;
    };

export const REVIEW_ELIGIBLE: ReviewEligibilityDecision = {
  eligible: true,
  skipReason: null,
  matchedPattern: null,
};

function normalizeAuthorLogin(login: string | null | undefined): string {
  return (login ?? "").trim();
}

/**
 * Decide whether the auto-review pipeline should spend/reply for this PR author. This is intentionally narrower
 * than the gate decision: ignored authors only suppress review/public output, never create a blocker.
 */
export function decideReviewEligibility(input: ReviewEligibilityInput): ReviewEligibilityDecision {
  const author = normalizeAuthorLogin(input.authorLogin);
  if (author) {
    for (const pattern of input.ignoreAuthors ?? []) {
      const trimmed = pattern.trim();
      if (!trimmed) continue;
      if (matchesManifestPath(author, trimmed)) {
        return {
          eligible: false,
          skipReason: "ignored_author",
          matchedPattern: trimmed,
        };
      }
    }
  }

  for (const configured of input.skipLabels ?? []) {
    const configuredLabel = configured.trim();
    if (!configuredLabel) continue;
    const configuredLower = configuredLabel.toLowerCase();
    for (const prLabel of input.prLabels ?? []) {
      const prLabelLower = (prLabel ?? "").trim().toLowerCase();
      if (prLabelLower && prLabelLower === configuredLower) {
        return {
          eligible: false,
          skipReason: "skip_label",
          matchedPattern: configuredLabel,
        };
      }
    }
  }

  return REVIEW_ELIGIBLE;
}

export function isIgnoredReviewAuthor(input: ReviewEligibilityInput): boolean {
  return !decideReviewEligibility(input).eligible;
}

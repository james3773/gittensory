import { isDocsOnlyChangedPaths } from "./changed-files-classify";
import { matchesManifestPath } from "../signals/focus-manifest";

export type ReviewEligibilitySkipReason = "ignored_author" | "docs_only";

export type ReviewEligibilityInput = {
  authorLogin?: string | null | undefined;
  ignoreAuthors?: readonly string[] | null | undefined;
  skipDocsOnly?: boolean | null | undefined;
  changedPaths?: readonly string[] | null | undefined;
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

export { isDocsOnlyChangedPaths } from "./changed-files-classify";

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

  if (input.skipDocsOnly === true && isDocsOnlyChangedPaths(input.changedPaths ?? [])) {
    return {
      eligible: false,
      skipReason: "docs_only",
      matchedPattern: "docs-only",
    };
  }

  return REVIEW_ELIGIBLE;
}

export function isIgnoredReviewAuthor(input: ReviewEligibilityInput): boolean {
  return !decideReviewEligibility(input).eligible;
}

import type { Scope } from "../core/types.js";
import type { ReplyOpportunityVerifier } from "../verifier/reply-verifier.js";
import { canonicalizeXPost } from "../verifier/canonicalize.js";

const X_POST_URL = /(?<![\w@])(?:https?:\/\/)?(?:(?:www|mobile|m)\.)?(?:x\.com|twitter\.com)\.?\/(?:[A-Za-z0-9_]+\/status(?:es)?|i\/(?:web\/)?status)\/\d+(?:[/?#][^\s<]*)?/giu;
const PUBLICATION_SUCCESS_CLAIM = /(?:\b(?:I|we|Exy)\s+(?:have\s+)?(?:successfully\s+)?(?:published|posted|replied|sent)\b|\b(?:the\s+)?(?:tweet|post|reply)\s+(?:(?:was|is|has been)\s+)?(?:successfully\s+|now\s+)?(?:published|posted|sent|live)\b|\b(?:done|all set)\b.{0,30}\b(?:live|published|posted|sent)\b|\b(?:it|that)(?:'s|\s+is)\s+(?:now\s+)?(?:live|published|posted|sent)\b|\b(?:sent|posted|published)\s+(?:it|that)\s+(?:to|on)\s+X\b|^\s*(?:done|posted|published|sent)[!.\s]*$)/iu;

export function extractXPostIds(value: string): Set<string> {
  const ids = new Set<string>();
  for (const match of value.matchAll(X_POST_URL)) {
    try {
      ids.add(canonicalizeXPost(match[0]).postId);
    } catch {
      // Ignore malformed lookalikes; the verifier canonicalizer remains authoritative.
    }
  }
  return ids;
}

export function guardUnverifiedXPostUrls(
  output: string,
  scope: Scope,
  _verifier: ReplyOpportunityVerifier,
  allowedPostIds: ReadonlySet<string>,
  options: { preserveFencedContent?: boolean } = {},
): string {
  const replaceUrls = (value: string) => value.replace(X_POST_URL, (url) => {
    try {
      const canonical = canonicalizeXPost(url);
      if (allowedPostIds.has(canonical.postId)) return url;
      return "[X post omitted: it was not passed through Exy's reply-opportunity verifier]";
    } catch {
      return "[malformed X post URL omitted]";
    }
  });
  return options.preserveFencedContent
    ? transformLinesOutsideMarkdownFences(output, replaceUrls)
    : replaceUrls(output);
}

export function guardUnconfirmedPublicationClaims(
  output: string,
  providerConfirmed: boolean,
  options: { preserveFencedContent?: boolean } = {},
): string {
  if (providerConfirmed) return output;
  const transform = (line: string) => PUBLICATION_SUCCESS_CLAIM.test(line)
    ? "[Publication success claim omitted: Zernio did not confirm publication.]"
    : line;
  return options.preserveFencedContent
    ? transformLinesOutsideMarkdownFences(output, transform)
    : transformLinesPreservingEndings(output, transform);
}

/**
 * Raw Xquik candidates are visible to Pi for ranking, but their prose must not
 * become user-facing recommendations without the dedicated verifier tool.
 */
export function guardRawXSearchNarrative(
  output: string,
  searchPerformed: boolean,
  alreadyRecommendedCount: number,
): string {
  if (!searchPerformed && alreadyRecommendedCount === 0) return output;
  if (alreadyRecommendedCount === 1) {
    return "The selected X post was already recommended, so I did not present it as a new reply opportunity.";
  }
  if (alreadyRecommendedCount > 1) {
    return "The selected X posts were already recommended, so I did not present them as new reply opportunities.";
  }
  return "I searched X, but did not select a new verifier-approved reply opportunity to present.";
}

function transformLinesOutsideMarkdownFences(
  output: string,
  transform: (line: string) => string,
): string {
  let fence: { character: string; length: number } | undefined;
  return output
    .split(/(\r\n|\n|\r)/u)
    .map((line, index) => {
      if (index % 2 === 1) return line;
      const marker = /^\s*(`{3,}|~{3,})/u.exec(line)?.[1];
      if (fence) {
        if (marker?.[0] === fence.character && marker.length >= fence.length) fence = undefined;
        return line;
      }
      if (marker) {
        fence = { character: marker[0]!, length: marker.length };
        return line;
      }
      return transform(line);
    })
    .join("");
}

function transformLinesPreservingEndings(output: string, transform: (line: string) => string): string {
  return output
    .split(/(\r\n|\n|\r)/u)
    .map((line, index) => index % 2 === 1 ? line : transform(line))
    .join("");
}

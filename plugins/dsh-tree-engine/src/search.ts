/**
 * Fuzzy subsequence matching (omp-style): a token matches text when its
 * characters appear in the text in order, ignoring other characters.
 * Matching is case-insensitive by default.
 */

/** True when `token` is a subsequence of `text` (greedy scan). */
export function isSubsequence(
  token: string,
  text: string,
  caseSensitive = false,
): boolean {
  if (token.length === 0) return true;
  const needle = caseSensitive ? token : token.toLowerCase();
  const hay = caseSensitive ? text : text.toLowerCase();
  let i = 0;
  for (let j = 0; j < hay.length && i < needle.length; j++) {
    if (hay[j] === needle[i]!) i++;
  }
  return i === needle.length;
}

/** Split a query into non-empty whitespace-delimited tokens. */
export function tokenize(query: string): string[] {
  return query.split(/\s+/).filter((t) => t.length > 0);
}

/**
 * True when every query token is a subsequence of `text`
 * (AND semantics, case-insensitive by default).
 */
export function matchQuery(
  query: string,
  text: string,
  options: { caseSensitive?: boolean } = {},
): boolean {
  const tokens = tokenize(query);
  if (tokens.length === 0) return true;
  return tokens.every((t) => isSubsequence(t, text, options.caseSensitive ?? false));
}

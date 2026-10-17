/**
 * Escaping for the suite's model-visible XML cards (assignment/report wrappers,
 * peer-message deliveries, advisory notes). One implementation keeps every
 * card's escaping byte-identical.
 *
 * @module @dsh-plugin/dsh-util/xml
 */

/**
 * Escape one XML text or attribute value: `&`, `<`, `>`, `"` and `'`.
 * @param value - raw text.
 * @returns the escaped text (a single pass; no double escaping).
 */
export function escapeXml(value: string): string {
  return value.replace(/[&<>"']/g, char => (
    char === '&' ? '&amp;'
      : char === '<' ? '&lt;'
        : char === '>' ? '&gt;'
          : char === '"' ? '&quot;'
            : '&apos;'
  ))
}

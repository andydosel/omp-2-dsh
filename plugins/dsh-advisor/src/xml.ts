/**
 * XML escaping for the advisor's model-visible cards.
 *
 * The advisor package is independently installable, so it carries its own
 * escaper instead of depending on the suite's shared utility package. The
 * one-pass rule stays byte-identical to the suite copy: `&`, `<`, `>`, `"`
 * and `'` are replaced once, never double-escaped.
 *
 * @module @dsh-plugin/dsh-advisor/xml
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

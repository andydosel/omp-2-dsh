/**
 * Advisory severity grades and guards.
 *
 * @module @dsh-plugin/dsh-advisor/severity
 */

/** Advisory severity grades, ordered from least to most interruptive. */
export type Severity = 'nit' | 'concern' | 'blocker'

/** The three severity grades in canonical order. */
export const SEVERITIES: readonly Severity[] = ['nit', 'concern', 'blocker']

/** Whether a runtime value is one of the severity grades. */
export function isSeverity(value: unknown): value is Severity {
  return value === 'nit' || value === 'concern' || value === 'blocker'
}

/** Whether a severity interrupts (steers) the primary agent rather than being an aside. */
export function isInterrupting(severity: Severity): boolean {
  return severity === 'concern' || severity === 'blocker'
}

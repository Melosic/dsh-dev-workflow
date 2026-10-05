import type { Translate } from '../i18n.js'

// Shared shape of the two check tools. Both answer the same question ("is this
// change consistent with the specification?") as a list of problems, so the
// model-facing rendering lives here once instead of twice.

/** One check outcome. `error` is set only when the check could not run. */
export interface CheckResult {
  /** Whether the check ran and found no blocking problem. */
  readonly ok: boolean
  /** Problems the specification does not permit. */
  errors: string[]
  /** Observations worth one line of attention, never a blocker. */
  warnings: string[]
  /** Set when the check could not run at all — for example, no git available. */
  readonly error?: string
}

/**
 * Render a check outcome as one model-facing text block.
 * @param value - the check outcome.
 * @param t - translator for the "all good" line.
 * @param okKey - dictionary key for the "all good" line.
 * @returns a single text block; the caller's tool definition owns the wrapping.
 */
export function renderCheck(
  value: CheckResult,
  t: Translate,
  okKey: string,
): { type: 'text'; text: string }[] {
  const lines: string[] = []
  if (value.error !== undefined) {
    lines.push(value.error)
  } else if (value.errors.length === 0 && value.warnings.length === 0) {
    lines.push(t(okKey))
  } else {
    for (const warning of value.warnings) lines.push(`⚠ ${warning}`)
    for (const error of value.errors) lines.push(`✖ ${error}`)
  }
  return [{ type: 'text', text: lines.join('\n') }]
}

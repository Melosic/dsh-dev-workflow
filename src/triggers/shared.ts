import { readFile } from 'node:fs/promises'
import type { PreToolDecision } from '@deepseek-ai/dsh-tools'
import type { ApprovalPolicyReporter } from '../approval-policy.js'
import { unaskable } from '../approval-policy.js'
import type { Config } from '../config.js'
import { createTranslator } from '../i18n.js'
import type { Translate } from '../i18n.js'
import type { WorkflowState } from '../state.js'
import type { CheckResult } from '../tools/result.js'

// What the three action triggers have in common. Each of them recognises one
// shell command that starts something hard to undo — a commit, a pull request, a
// release — judges it against the specification, and routes the findings through
// the approval prompt. Only the recognition and the rules differ; the wiring,
// the truncation, and the bilingual prompt are the same shape three times.

/** How many findings an approval prompt shows before it summarises the rest. */
export const MAX_DETAILS = 5

/** Live access every trigger needs. Everything is a getter: the runtime owns it. */
export interface TriggerOptions {
  /** Resolved plugin configuration. */
  readonly config: () => Config
  /** Translator for the locale in effect. */
  readonly t: () => Translate
  /** Session-scoped memory of what was already reported. */
  readonly state: WorkflowState
  /** Diagnostic sink; debug level, so the default profile stays quiet. */
  readonly log: (message: string) => void
  /**
   * The approval seam, read only for the policy a finding resolves under.
   *
   * Optional: without it every decision is returned as before, which is what a
   * profile with no approval service composed already gets.
   */
  readonly approval?: () => ApprovalPolicyReporter | undefined
}

/**
 * Render findings as the body of an approval prompt.
 * @param outcome - what the check found.
 * @param t - translator for the truncation line.
 * @returns one line per finding, capped at {@link MAX_DETAILS}.
 */
export function detailsOf(outcome: CheckResult, t: Translate): string {
  const lines = [
    ...outcome.errors.map((line) => `✖ ${line}`),
    ...outcome.warnings.map((line) => `⚠ ${line}`),
  ]
  const shown = lines.slice(0, MAX_DETAILS)
  const omitted = lines.length - shown.length
  if (omitted > 0) shown.push(t('trigger.omitted', { count: omitted }))
  return shown.join('\n')
}

/** One `ask` decision, in the shape the approval prompt reads. */
export interface AskOptions {
  /** Dictionary key for the one-line reason the model sees. */
  readonly reasonKey: string
  /** Dictionary key for the full prompt the UI shows. */
  readonly askKey: string
  /** What the check found, already rendered in the plugin's own locale. */
  readonly outcome: CheckResult
  /** Translator for the plugin's own locale. */
  readonly t: Translate
  /**
   * Re-render the findings in one language.
   *
   * The prompt picks a side by the *client's* locale, which is not necessarily
   * the plugin's own, so each side is rendered from scratch with its own
   * translator — findings included, not just the wrapper.
   */
  readonly assess: (t: Translate) => CheckResult
  /** The approval seam, read only for the policy this question resolves under. */
  readonly approval?: () => ApprovalPolicyReporter | undefined
  /** The session the question would be asked in. */
  readonly session?: unknown
}

/**
 * Turn a failing outcome into the one decision worth returning.
 *
 * `ask` is the decision that fits a finding an author may knowingly override:
 * returning anything else would block an action the specification permits.
 * @param options - the keys, the outcome, and how to re-render it.
 * @returns the decision for `tools/pre-execute`.
 */
export function askAbout(options: AskOptions): PreToolDecision {
  const english = createTranslator('en-US')
  const chinese = createTranslator('zh-CN')
  // The Chinese key is the literal `zh`: the client lower-cases a locale and
  // falls back to `en`, so `zh-CN` would never match.
  return unaskable(
    {
      kind: 'ask',
      reason: options.t(options.reasonKey, {
        details: detailsOf(options.outcome, options.t),
      }),
      displayReason: {
        en: english(options.askKey, { details: detailsOf(options.assess(english), english) }),
        zh: chinese(options.askKey, { details: detailsOf(options.assess(chinese), chinese) }),
      },
    },
    options.t,
    options.approval,
    options.session,
  )
}

/**
 * Read a file as text, treating absence as absence rather than as a failure.
 *
 * Checks that inspect a file the author controls (a changelog, a pull request
 * template) must not turn a missing file into a thrown error: the gate would
 * then deny a tool call over a problem the author can still fix afterwards.
 * @param path - absolute path to read.
 * @returns the contents, or `undefined` when the file cannot be read.
 */
export async function readText(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, 'utf8')
  } catch {
    return undefined
  }
}

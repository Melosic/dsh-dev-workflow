import type { PreToolDecision, ToolExecution } from '@deepseek-ai/dsh-tools'
import type { Config } from '../config.js'
import { createTranslator } from '../i18n.js'
import type { Translate } from '../i18n.js'
import type { GitRunner } from '../git.js'
import type { WorkflowState } from '../state.js'
import type { CheckResult } from '../tools/result.js'
import { listChangedFiles } from '../tools/check-doc-sync.js'
import { detectCommit, evaluate, fingerprint, resolveCommitMessage, summarize } from '../checks.js'

// The automatic half of the plugin: before the agent runs a shell command that
// creates a commit, check that commit against the workflow rules and route the
// findings through the approval prompt.
//
// This rides on `tools/pre-execute`, a waterfall gate that wraps every tool
// call. Two things shape the handler below: it must call `next()` first (so a
// gate that already denies the call is not second-guessed), and it must always
// settle — a tool call that throws inside the gate would surface as a tool
// failure rather than a finding.

/** How many findings an approval prompt shows before it summarises the rest. */
const MAX_DETAILS = 5

/** Options the trigger needs. Everything is a getter: the runtime owns it. */
export interface PreCommitTriggerOptions {
  /** Resolved plugin configuration. */
  readonly config: () => Config
  /** Translator for the locale in effect. */
  readonly t: () => Translate
  /** Session-scoped memory of what was already reported. */
  readonly state: WorkflowState
  /** A git runner bound to one working directory. */
  readonly git: (cwd: string) => GitRunner
  /** Diagnostic sink; debug level, so the default profile stays quiet. */
  readonly log: (message: string) => void
}

/**
 * Read the `command` string of a tool call, when it has one.
 * @param args - the raw, unvalidated arguments of the tool call.
 * @returns the command line, or `undefined` for a call that runs none.
 */
function commandOf(args: unknown): string | undefined {
  if (typeof args !== 'object' || args === null) return undefined
  const value: unknown = (args as { command?: unknown }).command
  return typeof value === 'string' ? value : undefined
}

/**
 * Render findings as the body of an approval prompt.
 * @param outcome - what the check found.
 * @param t - translator for the truncation line.
 * @returns one line per finding, capped at {@link MAX_DETAILS}.
 */
function detailsOf(outcome: CheckResult, t: Translate): string {
  const lines = [
    ...outcome.errors.map((line) => `✖ ${line}`),
    ...outcome.warnings.map((line) => `⚠ ${line}`),
  ]
  const shown = lines.slice(0, MAX_DETAILS)
  const omitted = lines.length - shown.length
  if (omitted > 0) shown.push(t('trigger.pre_commit.omitted', { count: omitted }))
  return shown.join('\n')
}

/**
 * Build the `tools/pre-execute` listener.
 *
 * Returning a decision other than `allow` stops the tool call before it runs;
 * `ask` is the one that fits a finding an author may knowingly override.
 * @param options - configuration, translator, state, git access, and logging.
 * @returns the listener to register on `tools/pre-execute`.
 */
export function createPreCommitTrigger(
  options: PreCommitTriggerOptions,
): (exec: ToolExecution, next: () => Promise<PreToolDecision>) => Promise<PreToolDecision> {
  return async (exec, next) => {
    // Every other gate gets to speak first, including the ones this plugin does
    // not own. Only an allowed call is worth inspecting.
    const downstream = await next()
    if (downstream.kind !== 'allow') return downstream

    const agent = exec.agent
    if (agent === undefined) return downstream
    const command = commandOf(exec.arguments)
    if (command === undefined) return downstream
    const commit = detectCommit(command)
    if (commit === undefined) return downstream
    if (exec.signal.aborted) return { kind: 'cancel' }

    const t = options.t()
    const config = options.config()
    // A session without a working directory runs where the process does; the
    // doc check resolves the same way.
    const cwd = agent.session.header.cwd ?? process.cwd()
    const sessionId = agent.session.id
    options.log(t('trigger.pre_commit.detected'))

    const listed = await listChangedFiles(options.git(cwd), exec.signal)
    const files = listed.ok ? listed.files : undefined
    const message = await resolveCommitMessage(commit, cwd)
    const input = {
      ...(message === undefined ? {} : { message }),
      ...(files === undefined ? {} : { files }),
    }

    const outcome = evaluate(input, config, t)
    options.state.record({
      kind: 'commit',
      ok: outcome.ok,
      summary: summarize(outcome, t),
    })

    if (outcome.ok) return downstream

    // Remember before asking: an author who is asked once and proceeds anyway
    // must not be asked again for the identical commit, and the prompt gives no
    // channel to record the answer afterwards.
    const commitTarget = fingerprint(message ?? command)
    const docTarget = fingerprint((files ?? []).join('\n'))
    const repeated =
      options.state.seen(String(sessionId), 'commit', commitTarget) &&
      (files === undefined || options.state.seen(String(sessionId), 'doc', docTarget))
    if (repeated) return downstream
    options.state.remember(String(sessionId), 'commit', commitTarget)
    if (files !== undefined) options.state.remember(String(sessionId), 'doc', docTarget)

    // The approval prompt selects one of these by the client's locale, which is
    // not necessarily the plugin's own, so each side is rendered from scratch
    // with its own translator — findings included, not just the wrapper. The
    // Chinese key is the literal `zh`: the client lower-cases a locale and falls
    // back to `en`, so `zh-CN` would never match.
    const english = createTranslator('en-US')
    const chinese = createTranslator('zh-CN')
    return {
      kind: 'ask',
      reason: t('trigger.pre_commit.reason', { details: detailsOf(outcome, t) }),
      displayReason: {
        en: english('trigger.pre_commit.ask', {
          details: detailsOf(evaluate(input, config, english), english),
        }),
        zh: chinese('trigger.pre_commit.ask', {
          details: detailsOf(evaluate(input, config, chinese), chinese),
        }),
      },
    }
  }
}

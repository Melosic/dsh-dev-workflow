import { isAbsolute, join } from 'node:path'
import type { PreToolDecision, ToolExecution } from '@deepseek-ai/dsh-tools'
import type { Config } from '../config.js'
import type { Translate } from '../i18n.js'
import type { CheckResult } from '../tools/result.js'
import { checkCommitMessage } from '../tools/check-commit-message.js'
import { fingerprint } from '../checks.js'
import { commandOf, programInvocations } from '../shell.js'
import { askAbout, readText } from './shared.js'
import type { TriggerOptions } from './shared.js'

// The second automatic check: before the agent opens a pull request, judge the
// text that will describe it. Under squash merge the pull request *title*
// becomes the commit on `main`, so a title that breaks the conventions lands in
// the permanent history — this is the last moment it can be caught cheaply.
//
// Like the pre-commit trigger, this rides on `tools/pre-execute`: the DSH event
// catalogue has no "a pull request is about to be created" event, so the action
// is recognised by the shell command that performs it (`gh pr create`).

/** Sections the specification's pull request template asks for. */
const REQUIRED_SECTIONS = ['What', 'Why', 'How to verify'] as const

/** `gh pr create` options that take a separate value, so it is not a title. */
const GH_VALUE_OPTIONS = new Set([
  '-t',
  '--title',
  '-b',
  '--body',
  '-F',
  '--body-file',
  '-H',
  '--head',
  '-B',
  '--base',
  '-r',
  '--reviewer',
  '-l',
  '--label',
  '-a',
  '--assignee',
  '-m',
  '--milestone',
  '-p',
  '--project',
])

/** What a `gh pr create` command line states about the pull request. */
export interface PullRequestCommand {
  /** The title, when the command line states it. */
  readonly title?: string
  /** The description, when the command line states it. */
  readonly body?: string
  /** Path given to `--body-file`, as written on the command line. */
  readonly bodyFile?: string
}

/** What one pull request inspection covers. Omit a field to skip its rules. */
export interface PullRequestInput {
  /** The pull request title. */
  readonly title?: string
  /** The pull request description. */
  readonly body?: string
}

/**
 * Read what a `gh pr create` command line says.
 * @param args - the words after `create`.
 * @returns the stated title, description, and body file, if any.
 */
function pullRequestArguments(args: readonly string[]): PullRequestCommand {
  let title: string | undefined
  let body: string | undefined
  let bodyFile: string | undefined

  const assign = (name: string, value: string | undefined): void => {
    if (value === undefined) return
    if (name === '--title' || name === '-t') title = value
    else if (name === '--body' || name === '-b') body = value
    else if (name === '--body-file' || name === '-F') bodyFile = value
  }

  for (let index = 0; index < args.length; index += 1) {
    const token = args[index] ?? ''
    const equals = token.startsWith('--') ? token.indexOf('=') : -1
    if (equals !== -1) {
      assign(token.slice(0, equals), token.slice(equals + 1))
      continue
    }
    if (!GH_VALUE_OPTIONS.has(token)) continue
    const value = args[index + 1]
    if (value === undefined) continue
    assign(token, value)
    index += 1
  }

  return {
    ...(title === undefined ? {} : { title }),
    ...(body === undefined ? {} : { body }),
    ...(bodyFile === undefined ? {} : { bodyFile }),
  }
}

/**
 * Recognise a `gh pr create` in one shell command.
 * @param command - a shell command line, as a tool would receive it.
 * @returns what the command line states, or `undefined` when it opens no pull
 *   request.
 */
export function detectPullRequest(command: string): PullRequestCommand | undefined {
  for (const { program, args } of programInvocations(command)) {
    if (program !== 'gh' && program !== 'gh.exe') continue
    if (args[0] !== 'pr' || args[1] !== 'create') continue
    return pullRequestArguments(args.slice(2))
  }
  return undefined
}

/**
 * Name the template sections that are missing or left empty.
 *
 * A heading with nothing under it is as absent as no heading at all: an
 * untouched template describes the change no better than an empty box.
 * @param body - the pull request description.
 * @returns the section names that carry no content, in template order.
 */
function missingSections(body: string): string[] {
  const content = new Map<string, string[]>()
  let current: string | undefined
  for (const line of body.split('\n')) {
    const heading = /^##\s+(\S.*?)\s*$/.exec(line)
    if (heading !== null) {
      current = (heading[1] ?? '').toLowerCase()
      if (!content.has(current)) content.set(current, [])
      continue
    }
    if (current === undefined) continue
    content.get(current)?.push(line)
  }
  return REQUIRED_SECTIONS.filter((section) => {
    const lines = content.get(section.toLowerCase())
    return lines === undefined || lines.join('\n').trim().length === 0
  })
}

/**
 * Count the checkboxes in a description that are still unticked.
 * @param body - the pull request description.
 * @returns how many `- [ ]` lines it contains.
 */
function uncheckedBoxes(body: string): number {
  return body.split('\n').filter((line) => /^\s*[-*]\s+\[ \]/.test(line)).length
}

/**
 * Judge the text of one pull request against the workflow rules.
 *
 * The title is judged with the commit-message rules because squash merge makes
 * it the commit message. The description rules are the specification's own
 * template; the issue reference is advisory, because nothing here can tell
 * whether an issue exists to reference.
 * @param input - the title and description known about the pull request.
 * @param config - resolved plugin configuration.
 * @param t - translator for every returned line.
 * @returns blocking problems and advisory observations.
 */
export function evaluatePullRequest(
  input: PullRequestInput,
  config: Config,
  t: Translate,
): CheckResult {
  const errors: string[] = []
  const warnings: string[] = []

  if (input.title !== undefined) {
    const title = checkCommitMessage({ message: input.title }, config, t)
    errors.push(...title.errors)
    warnings.push(...title.warnings)
  }

  if (input.body !== undefined) {
    const missing = missingSections(input.body)
    if (missing.length > 0) {
      errors.push(t('trigger.pre_pr.error.description', { sections: missing.join(', ') }))
    }
    const unchecked = uncheckedBoxes(input.body)
    if (unchecked > 0) {
      errors.push(t('trigger.pre_pr.error.checklist', { count: unchecked }))
    }
  }

  const described = `${input.title ?? ''}\n${input.body ?? ''}`
  if (described.trim().length > 0 && !/(?:^|\s)#\d+/.test(described)) {
    warnings.push(t('trigger.pre_pr.warn.issue'))
  }

  return { ok: errors.length === 0, errors, warnings }
}

/**
 * Build the `tools/pre-execute` listener for pull request creation.
 * @param options - configuration, translator, state, and logging.
 * @returns the listener to register on `tools/pre-execute`.
 */
export function createPrePrTrigger(
  options: TriggerOptions,
): (exec: ToolExecution, next: () => Promise<PreToolDecision>) => Promise<PreToolDecision> {
  return async (exec, next) => {
    const downstream = await next()
    if (downstream.kind !== 'allow') return downstream

    const agent = exec.agent
    if (agent === undefined) return downstream
    const command = commandOf(exec.arguments)
    if (command === undefined) return downstream
    const pullRequest = detectPullRequest(command)
    if (pullRequest === undefined) return downstream
    if (exec.signal.aborted) return { kind: 'cancel' }

    const t = options.t()
    const cwd = agent.session.header.cwd ?? process.cwd()
    const sessionId = String(agent.session.id)
    options.log(t('trigger.pre_pr.detected'))

    // A description given as a file is read here rather than on the command
    // line; `-` means stdin, whose contents are not knowable at this point.
    let body = pullRequest.body
    if (body === undefined && pullRequest.bodyFile !== undefined && pullRequest.bodyFile !== '-') {
      const path = isAbsolute(pullRequest.bodyFile)
        ? pullRequest.bodyFile
        : join(cwd, pullRequest.bodyFile)
      body = await readText(path)
    }

    const input: PullRequestInput = {
      ...(pullRequest.title === undefined ? {} : { title: pullRequest.title }),
      ...(body === undefined ? {} : { body }),
    }
    const outcome = evaluatePullRequest(input, options.config(), t)
    options.state.record({
      kind: 'pr',
      ok: outcome.ok,
      summary: outcome.errors[0] ?? t('command.toggle.check.clean'),
    })

    if (outcome.ok) return downstream

    // Remember before asking, exactly as the pre-commit trigger does: the prompt
    // offers no channel to record the answer afterwards.
    const target = fingerprint(pullRequest.title ?? body ?? command)
    if (options.state.seen(sessionId, 'pr', target)) return downstream
    options.state.remember(sessionId, 'pr', target)

    return askAbout({
      reasonKey: 'trigger.pre_pr.reason',
      askKey: 'trigger.pre_pr.ask',
      outcome,
      t,
      assess: (translator) => evaluatePullRequest(input, options.config(), translator),
    })
  }
}

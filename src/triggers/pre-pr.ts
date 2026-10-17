import { isAbsolute, join } from 'node:path'
import type { PreToolDecision, ToolExecution } from '@deepseek-ai/dsh-tools'
import type { Config } from '../config.js'
import type { Translate } from '../i18n.js'
import type { CheckResult } from '../tools/result.js'
import { evaluateMessage, fingerprint, summarize } from '../checks.js'
import { commandOf, quoteCommandWords, shellWordIsLiteral, wordInvocations } from '../shell.js'
import type { CommandWord } from '../shell.js'
import { readText, settleAbout } from './shared.js'
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
  /** Whether the title was a single-quoted word, so it is what `gh` will send. */
  readonly titleLiteral?: boolean
  /** The description, when the command line states it. */
  readonly body?: string
  /** Whether the description was a single-quoted word. */
  readonly bodyLiteral?: boolean
  /** Path given to `--body-file`, as written on the command line. */
  readonly bodyFile?: string
}

/** What one pull request inspection covers. Omit a field to skip its rules. */
export interface PullRequestInput {
  /** The pull request title. */
  readonly title?: string
  /** Whether the title is literal text; omitted means it is. */
  readonly titleLiteral?: boolean
  /** The pull request description. */
  readonly body?: string
  /** Whether the description is literal text; omitted means it is. */
  readonly bodyLiteral?: boolean
}

/**
 * Read what a `gh pr create` command line says.
 * @param args - the words after `create`, each saying how it was written.
 * @returns the stated title, description, and body file, if any.
 */
function pullRequestArguments(args: readonly CommandWord[]): PullRequestCommand {
  let title: CommandWord | undefined
  let body: CommandWord | undefined
  let bodyFile: string | undefined

  const assign = (name: string, value: CommandWord | undefined): void => {
    if (value === undefined) return
    if (name === '--title' || name === '-t') title = value
    else if (name === '--body' || name === '-b') body = value
    else if (name === '--body-file' || name === '-F') bodyFile = value.value
  }

  for (let index = 0; index < args.length; index += 1) {
    const token = args[index]?.value ?? ''
    const equals = token.startsWith('--') ? token.indexOf('=') : -1
    if (equals !== -1) {
      const value = token.slice(equals + 1)
      assign(token.slice(0, equals), { value, literal: false })
      continue
    }
    if (!GH_VALUE_OPTIONS.has(token)) continue
    const value = args[index + 1]
    if (value === undefined) continue
    assign(token, value)
    index += 1
  }

  return {
    ...(title === undefined ? {} : { title: title.value, titleLiteral: shellWordIsLiteral(title) }),
    ...(body === undefined ? {} : { body: body.value, bodyLiteral: shellWordIsLiteral(body) }),
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
  for (const { program, args } of wordInvocations(quoteCommandWords(command))) {
    if (program !== 'gh' && program !== 'gh.exe') continue
    if (args[0]?.value !== 'pr' || args[1]?.value !== 'create') continue
    return pullRequestArguments(args.slice(2))
  }
  return undefined
}

/**
 * Split a description into its `##` sections.
 *
 * The template's checklist belongs to the section that carries it, and text
 * outside any required section is not the template: a `- [ ]` line elsewhere
 * (in a fenced example, say) is not a box the author forgot to tick.
 * @param body - the pull request description.
 * @returns the lines under each lowercased section name.
 */
function sectionContent(body: string): Map<string, string[]> {
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
  return content
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
  const content = sectionContent(body)
  return REQUIRED_SECTIONS.filter((section) => {
    const lines = content.get(section.toLowerCase())
    return lines === undefined || lines.join('\n').trim().length === 0
  })
}

/**
 * Count the checkboxes in a description that are still unticked.
 * @param body - the pull request description.
 * @returns how many `- [ ]` lines the template sections contain.
 */
function uncheckedBoxes(body: string): number {
  const content = sectionContent(body)
  let total = 0
  for (const section of REQUIRED_SECTIONS) {
    for (const line of content.get(section.toLowerCase()) ?? []) {
      if (/^\s*[-*]\s+\[ \]/.test(line)) total += 1
    }
  }
  return total
}

/**
 * Whether an otherwise-clean outcome still holds something worth a question.
 *
 * Two warnings are not findings: the note that `--fill` left no title for this
 * check to read, and the note that the description names no issue. Both are
 * advisory — the first states what could not be judged, the second asks for
 * something the check has no way to know exists. They belong in the record, so a
 * status report shows them, but a question containing only those has nothing to
 * ask: under a `never` approval policy it would be refused outright and turn an
 * advisory note into a blocked pull request.
 * @param outcome - what the check found.
 * @param t - translator, to recognise the notes in the language in effect.
 * @returns whether the prompt has anything to carry.
 */
function worthAsking(outcome: CheckResult, t: Translate): boolean {
  const notes = new Set([t('trigger.pre_pr.warn.filled'), t('trigger.pre_pr.warn.issue')])
  return outcome.errors.length > 0 || outcome.warnings.some((line) => !notes.has(line))
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
    // The title is judged with the commit-message rules — and with that check's
    // own configuration, because under squash merge this title *is* a commit
    // message. A repository that turned the check off or downgraded it to a
    // warning meant it for this text too.
    const title = evaluateMessage(input.title, undefined, config, t)
    errors.push(...title.errors)
    warnings.push(...title.warnings)
    if (!(input.titleLiteral ?? true)) {
      warnings.push(t('trigger.pre_pr.warn.title_literal'))
    }
  }

  if (input.body !== undefined) {
    // A description assembled by the shell is not text this check can read;
    // judging the literal pieces of `-b "$(cat pr.md)"` would report every
    // section as missing and repeat the report on every attempt.
    if (!(input.bodyLiteral ?? true)) {
      warnings.push(t('trigger.pre_pr.warn.body_literal'))
    } else {
      const missing = missingSections(input.body)
      if (missing.length > 0) {
        errors.push(t('trigger.pre_pr.error.description', { sections: missing.join(', ') }))
      }
      const unchecked = uncheckedBoxes(input.body)
      if (unchecked > 0) {
        errors.push(t('trigger.pre_pr.error.checklist', { count: unchecked }))
      }
    }
  }

  // `gh pr create --fill` takes the title and description from the commits, so
  // the command line states neither and nothing here can judge them. Saying that
  // is the point: silently reporting "clean" would make the check look like it
  // passed. Under squash merge the filled title is what lands on `main`.
  if (input.title === undefined && input.body === undefined) {
    warnings.push(t('trigger.pre_pr.warn.filled'))
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
    // The gates behind this one decide first; a cancelled or refused call is not
    // this check's to settle. What that answer does not do is skip the check:
    // `gh pr create` is exactly the command the outward guard asks about, so
    // settling the question from behind it would mean the pull request rules
    // never ran.
    const downstream = await next()
    if (downstream.kind === 'cancel' || downstream.kind === 'deny') return downstream

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

    // A description read from a file is text this check holds, so it is literal
    // whatever the command line said about where it came from.
    const stated = pullRequest.body !== undefined
    const literal = stated ? (pullRequest.bodyLiteral ?? true) : true
    const input: PullRequestInput = {
      ...(pullRequest.title === undefined
        ? {}
        : { title: pullRequest.title, titleLiteral: pullRequest.titleLiteral ?? true }),
      ...(body === undefined ? {} : { body, bodyLiteral: literal }),
    }
    const outcome = evaluatePullRequest(input, options.config(), t)
    options.state.record({
      kind: 'pr',
      ok: outcome.ok,
      summary: summarize(outcome, t),
    })

    // `--fill` is not a finding: it is this check stating that the command line
    // carries no title to judge. Asking the user to approve that statement would
    // be a prompt with nothing in it, so the statement is recorded and the call
    // proceeds. Every other warning is a finding and goes to the prompt.
    if (outcome.ok && !worthAsking(outcome, t)) return downstream

    const target = fingerprint(pullRequest.title ?? body ?? command)
    // Asked once and not answered? `settleAbout` records the check only once the
    // question really reaches the user, so a rejection is not turned into a
    // one-time reminder.
    if (options.state.seen(sessionId, 'pr', target)) return downstream

    return settleAbout(
      downstream,
      {
        reasonKey: 'trigger.pre_pr.reason',
        askKey: 'trigger.pre_pr.ask',
        detailKey: 'trigger.pre_pr.detail',
        settledBy: 'trigger.pre_pr.settled_by',
        outcome,
        t,
        assess: (translator) => evaluatePullRequest(input, options.config(), translator),
        approval: options.approval,
        session: agent.session,
      },
      () => options.state.remember(sessionId, 'pr', target),
    )
  }
}

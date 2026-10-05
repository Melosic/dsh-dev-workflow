import { join } from 'node:path'
import type { PreToolDecision, ToolExecution } from '@deepseek-ai/dsh-tools'
import type { Translate } from '../i18n.js'
import type { CheckResult } from '../tools/result.js'
import { fingerprint } from '../checks.js'
import { commandOf, gitInvocations, programInvocations } from '../shell.js'
import { askAbout, readText } from './shared.js'
import type { TriggerOptions } from './shared.js'

// The third automatic check: before the agent tags or publishes a release, judge
// the release itself. Publishing is the one operation in this workflow that
// cannot be taken back — npm allows unpublishing for only 72 hours, and a version
// number that reached the registry is spent forever.
//
// As with the other two triggers, there is no release event in the DSH catalogue,
// so the action is recognised by the shell command that performs it (`git tag`,
// `npm publish`).

/** Package managers whose `publish` subcommand reaches the registry. */
const PACKAGE_MANAGERS = new Set(['npm', 'npm.exe', 'pnpm', 'pnpm.exe'])

/** `git tag` options that take a separate value, so it is not the tag name. */
const TAG_VALUE_OPTIONS = new Set(['-m', '--message', '-F', '--file', '-u', '--local-user'])

/** `git tag` invocations that only read tags rather than create one. */
const TAG_READ_ONLY = new Set(['-d', '--delete', '-l', '--list', '-v', '--verify'])

/** Semantic version, pre-release and build metadata included. */
const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/

/** A version carrying a pre-release suffix, e.g. `0.2.0-rc.1`. */
const PRERELEASE = /^\d+\.\d+\.\d+-/

/** The categories Keep a Changelog defines, lowercased. */
const CATEGORIES = new Set(['added', 'changed', 'deprecated', 'removed', 'fixed', 'security'])

/** What one release command line does. Omit a field when the line does not. */
export interface ReleaseCommand {
  /** The tag name, when the line creates one. */
  readonly tag?: string
  /**
   * The dist-tag, when the line publishes. A publish that states none is
   * recorded as the `latest` npm would default to.
   */
  readonly publishTag?: string
}

/** What one release inspection covers. Omit a field to skip its rules. */
export interface ReleaseInput {
  /** The version being released, taken from the tag when there is one. */
  readonly version?: string
  /** The tag name as written, `v` prefix included. */
  readonly tag?: string
  /** The version recorded in `package.json`, when it could be read. */
  readonly packageVersion?: string
  /** The changelog, when it could be read. */
  readonly changelog?: string
  /** The dist-tag the publish would use. */
  readonly publishTag?: string
}

/**
 * Read the tag name a `git tag` invocation creates.
 * @param args - the words after `tag`.
 * @returns the name, or `undefined` when the invocation only reads tags.
 */
function tagName(args: readonly string[]): string | undefined {
  for (let index = 0; index < args.length; index += 1) {
    const token = args[index] ?? ''
    if (TAG_READ_ONLY.has(token)) return undefined
    if (TAG_VALUE_OPTIONS.has(token)) {
      index += 1
      continue
    }
    if (token.startsWith('-')) continue
    return token
  }
  return undefined
}

/**
 * Read the dist-tag a `publish` invocation states.
 * @param args - the words after `publish`.
 * @returns the dist-tag, or `undefined` when the invocation states none.
 */
function publishTagOf(args: readonly string[]): string | undefined {
  for (let index = 0; index < args.length; index += 1) {
    const token = args[index] ?? ''
    if (token === '--tag') return args[index + 1]
    if (token.startsWith('--tag=')) return token.slice('--tag='.length)
  }
  return undefined
}

/**
 * Recognise the release actions in one shell command.
 *
 * A single line may do both (`git tag v1.0.0 && npm publish`), so the two are
 * collected together rather than the first one winning: the checks that follow
 * need to see the tag *and* the dist-tag to judge the release as a whole.
 * @param command - a shell command line, as a tool would receive it.
 * @returns what the line does, or `undefined` when it releases nothing.
 */
export function detectRelease(command: string): ReleaseCommand | undefined {
  let tag: string | undefined
  let publishTag: string | undefined

  for (const { subcommand, args } of gitInvocations(command)) {
    if (subcommand !== 'tag') continue
    const name = tagName(args)
    if (name !== undefined) {
      tag = name
      break
    }
  }

  for (const { program, args } of programInvocations(command)) {
    if (!PACKAGE_MANAGERS.has(program)) continue
    if (args[0] !== 'publish') continue
    // npm defaults the dist-tag to `latest`, and does not except pre-releases
    // from that default. Recording the default is what makes the pre-release
    // rule below able to fire on a publish that stated nothing.
    publishTag = publishTagOf(args.slice(1)) ?? 'latest'
    break
  }

  if (tag === undefined && publishTag === undefined) return undefined
  return {
    ...(tag === undefined ? {} : { tag }),
    ...(publishTag === undefined ? {} : { publishTag }),
  }
}

/**
 * Split a changelog into its `##` sections.
 * @param changelog - the changelog text.
 * @returns section body per lowercased section name, e.g. `unreleased`, `0.2.0`.
 */
function sections(changelog: string): Map<string, string> {
  const found = new Map<string, string>()
  let name: string | undefined
  let lines: string[] = []

  const flush = (): void => {
    if (name === undefined) return
    found.set(name, lines.join('\n'))
  }

  for (const line of changelog.split('\n')) {
    // `## [Unreleased]` and `## [0.2.0] - 2026-01-01` both name a section; `###`
    // does not, because the character after `##` is not whitespace.
    const heading = /^##\s+\[?([^\]\s]+)\]?/.exec(line)
    if (heading !== null) {
      flush()
      name = (heading[1] ?? '').toLowerCase()
      lines = []
      continue
    }
    if (name === undefined) continue
    lines.push(line)
  }
  flush()
  return found
}

/**
 * Name the category headings a section body uses.
 * @param body - one `##` section's body.
 * @returns the `###` heading texts, in order.
 */
function categoryHeadings(body: string): string[] {
  return body
    .split('\n')
    .map((line) => /^###\s+(\S.*?)\s*$/.exec(line)?.[1])
    .filter((name): name is string => name !== undefined)
}

/**
 * Read the `version` field of a `package.json`.
 * @param path - absolute path to the manifest.
 * @returns the version, or `undefined` when it cannot be read.
 */
async function readPackageVersion(path: string): Promise<string | undefined> {
  const text = await readText(path)
  if (text === undefined) return undefined
  try {
    const parsed: unknown = JSON.parse(text)
    if (typeof parsed !== 'object' || parsed === null) return undefined
    const value: unknown = (parsed as { version?: unknown }).version
    return typeof value === 'string' ? value : undefined
  } catch {
    return undefined
  }
}

/**
 * Judge one release against the workflow rules.
 *
 * The changelog rule accepts either place for the entries. Keep a Changelog
 * keeps them under `[Unreleased]` until the moment of release, and the release
 * procedure then moves them into a `[<version>]` section — so at the instant a
 * tag is created, "nothing here" means both are empty, not just the first.
 * @param input - what is known about the release.
 * @param t - translator for every returned line.
 * @returns blocking problems and advisory observations.
 */
export function evaluateRelease(input: ReleaseInput, t: Translate): CheckResult {
  const errors: string[] = []

  const version = input.version?.replace(/^v/, '')
  if (version !== undefined && !SEMVER.test(version)) {
    errors.push(t('trigger.pre_release.error.version', { version }))
  }

  // The tag and the manifest disagreeing means the published artefact and the
  // tag name different versions — whichever one is wrong, the release is.
  const tagged = input.tag?.replace(/^v/, '')
  if (
    tagged !== undefined &&
    input.packageVersion !== undefined &&
    tagged !== input.packageVersion
  ) {
    errors.push(
      t('trigger.pre_release.error.version_mismatch', {
        tag: tagged,
        version: input.packageVersion,
      }),
    )
  }

  if (version !== undefined && PRERELEASE.test(version) && input.publishTag === 'latest') {
    errors.push(t('trigger.pre_release.error.prerelease_tag', { version }))
  }

  if (input.changelog !== undefined) {
    const released = sections(input.changelog)
    const unreleased = released.get('unreleased')
    if (unreleased === undefined) {
      errors.push(t('trigger.pre_release.error.changelog'))
    } else {
      for (const category of categoryHeadings(unreleased)) {
        if (!CATEGORIES.has(category.toLowerCase())) {
          errors.push(t('trigger.pre_release.error.changelog_category', { section: category }))
        }
      }
      const recorded = version === undefined ? undefined : released.get(version.toLowerCase())
      const empty = unreleased.trim().length === 0 && (recorded ?? '').trim().length === 0
      if (empty) {
        errors.push(
          t('trigger.pre_release.error.changelog_empty', { version: version ?? 'Unreleased' }),
        )
      }
    }
  }

  return { ok: errors.length === 0, errors, warnings: [] }
}

/**
 * Build the `tools/pre-execute` listener for tags and publishes.
 * @param options - configuration, translator, state, and logging.
 * @returns the listener to register on `tools/pre-execute`.
 */
export function createPreReleaseTrigger(
  options: TriggerOptions,
): (exec: ToolExecution, next: () => Promise<PreToolDecision>) => Promise<PreToolDecision> {
  return async (exec, next) => {
    const downstream = await next()
    if (downstream.kind !== 'allow') return downstream

    const agent = exec.agent
    if (agent === undefined) return downstream
    const command = commandOf(exec.arguments)
    if (command === undefined) return downstream
    const release = detectRelease(command)
    if (release === undefined) return downstream
    if (exec.signal.aborted) return { kind: 'cancel' }

    const t = options.t()
    const config = options.config()
    const cwd = agent.session.header.cwd ?? process.cwd()
    const sessionId = String(agent.session.id)
    options.log(t('trigger.pre_release.detected'))

    const packageVersion = await readPackageVersion(join(cwd, 'package.json'))
    const changelog = await readText(join(cwd, config.docs.changelog))
    const version = release.tag?.replace(/^v/, '') ?? packageVersion

    const input: ReleaseInput = {
      ...(version === undefined ? {} : { version }),
      ...(release.tag === undefined ? {} : { tag: release.tag }),
      ...(packageVersion === undefined ? {} : { packageVersion }),
      ...(changelog === undefined ? {} : { changelog }),
      ...(release.publishTag === undefined ? {} : { publishTag: release.publishTag }),
    }
    const outcome = evaluateRelease(input, t)
    options.state.record({
      kind: 'release',
      ok: outcome.ok,
      summary: outcome.errors[0] ?? t('command.toggle.check.clean'),
    })

    if (outcome.ok) return downstream

    // The version identifies the release, which is what the state model asks
    // for: a second attempt at releasing the same version is the same problem.
    const target = fingerprint(version ?? command)
    if (options.state.seen(sessionId, 'release', target)) return downstream
    options.state.remember(sessionId, 'release', target)

    return askAbout({
      reasonKey: 'trigger.pre_release.reason',
      askKey: 'trigger.pre_release.ask',
      outcome,
      t,
      assess: (translator) => evaluateRelease(input, translator),
    })
  }
}

import { defineTool } from '@deepseek-ai/dsh-tools'
import { COMMIT_TYPES, SUBJECT_MAX_LENGTH } from '../config.js'
import type { Translate } from '../i18n.js'
import type { CheckResult } from './result.js'
import { renderCheck } from './result.js'

// Local mirror of the specification's Commit Messages section. Everything that
// can be decided from the message text alone lives here; anything needing the
// repository is the caller's job to supply as `files`.

/** Body lines the specification asks to wrap at. */
const BODY_MAX_LENGTH = 72

/** Files that must change together, as configured. */
export type Mirrors = readonly (readonly string[])[]

/** Inputs the check needs beyond the message itself. */
export interface CommitCheckInput {
  /** Full commit message: subject, optional body, optional footer. */
  readonly message: string
  /** Paths this commit touches, when known. Used for the split warning only. */
  readonly files?: readonly string[]
}

/**
 * Split a commit message into its subject, body, and footer block.
 * @param message - the full message.
 * @returns the three parts, with blank-line padding removed.
 */
function sections(message: string): { subject: string; body: string } {
  const lines = message.replace(/\r\n/g, '\n').trimEnd().split('\n')
  const subject = lines[0]?.trim() ?? ''
  const body = lines.slice(1).join('\n').trim()
  return { subject, body }
}

/**
 * Check one commit message against Conventional Commits.
 * @param input - the message and, when known, the paths it touches.
 * @param t - translator for every returned line.
 * @returns blocking problems and advisory observations.
 */
export function checkCommitMessage(input: CommitCheckInput, t: Translate): CheckResult {
  const errors: string[] = []
  const warnings: string[] = []
  const { subject, body } = sections(input.message)

  if (subject.length === 0) {
    return { ok: false, errors: [t('tool.check_commit_message.error.empty')], warnings }
  }

  const header = /^([a-z]+)(\([^)]*\))?(!)?:\s*(\S.*)$/.exec(subject)
  if (header === null) {
    errors.push(t('tool.check_commit_message.error.missing_type'))
    errors.push(t('tool.check_commit_message.hint.format'))
    return { ok: false, errors, warnings }
  }

  // Group 1 is guaranteed by the pattern; groups 2 and 3 are optional and are
  // `undefined` when the author omitted the scope or the breaking marker.
  const type = header[1] ?? ''
  const scope = header[2]
  const bang = header[3]
  const rest = header[4] ?? ''
  if (!(COMMIT_TYPES as readonly string[]).includes(type)) {
    errors.push(
      t('tool.check_commit_message.error.unknown_type', {
        type,
        allowed: COMMIT_TYPES.join(', '),
      }),
    )
  }

  // Soft rules. Each names the problem, the expected form, and the fix, so the
  // reader can act without opening the specification.
  if (rest.length > SUBJECT_MAX_LENGTH) {
    warnings.push(
      t('tool.check_commit_message.warn.subject_length', {
        length: rest.length,
        max: SUBJECT_MAX_LENGTH,
      }),
    )
  }
  if (subject.endsWith('.')) {
    warnings.push(t('tool.check_commit_message.warn.trailing_period'))
  }
  if (bang === '!' && !/^BREAKING CHANGE:/m.test(body)) {
    errors.push(t('tool.check_commit_message.error.breaking_without_footer'))
  }

  for (const line of body.split('\n')) {
    if (line.length > BODY_MAX_LENGTH && !/^\s*(https?:\/\/|\S+\s*\|)/.test(line)) {
      warnings.push(
        t('tool.check_commit_message.warn.body_width', {
          length: line.length,
          max: BODY_MAX_LENGTH,
        }),
      )
      break
    }
  }

  const modules = modulesOf(input.files ?? [])
  if (modules.length > 1) {
    warnings.push(
      t('tool.check_commit_message.warn.multiple_modules', { modules: modules.join(', ') }),
    )
  }
  if (scope === undefined && modules.length === 1) {
    warnings.push(t('tool.check_commit_message.warn.missing_scope', { module: modules[0]! }))
  }

  return { ok: errors.length === 0, errors, warnings }
}

/**
 * Reduce paths to the modules they change, for the split-warning only.
 * @param files - repository-relative paths.
 * @returns distinct top-level module names, sorted.
 */
function modulesOf(files: readonly string[]): string[] {
  const modules = new Set<string>()
  for (const file of files) {
    const [first] = file.split('/')
    if (first !== undefined && first.length > 0) modules.add(first)
  }
  return [...modules].sort()
}

/**
 * Build the `check_commit_message` tool.
 * @param options - the active translator and the conflict-group configuration.
 * @param options.t - translator for parameters, descriptions, and output.
 * @param options.mirrors - reserved for the trigger; unused by the text check.
 * @returns the registry-ready tool definition.
 */
export function createCheckCommitMessageTool(options: { t: () => Translate; mirrors?: Mirrors }) {
  return defineTool({
    name: 'check_commit_message',
    description: options.t()('tool.check_commit_message.description'),
    parameters: {
      message: {
        type: 'string' as const,
        required: true as const,
        description: options.t()('tool.check_commit_message.param.message'),
      },
      files: {
        type: 'array' as const,
        items: { type: 'string' as const },
        description: options.t()('tool.check_commit_message.param.files'),
      },
    },
    output: {
      schema: {
        type: 'object' as const,
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean' as const, required: true as const },
          errors: {
            type: 'array' as const,
            required: true as const,
            items: { type: 'string' as const },
          },
          warnings: {
            type: 'array' as const,
            required: true as const,
            items: { type: 'string' as const },
          },
          error: { type: 'string' as const },
        },
      },
      render: (args, value) => {
        void args
        return renderCheck(
          {
            ok: value.ok,
            errors: value.errors,
            warnings: value.warnings,
            ...(value.error === undefined ? {} : { error: value.error }),
          },
          options.t(),
          'tool.check_commit_message.ok',
        )
      },
    },
    execute: async (args) => {
      const input: CommitCheckInput = {
        message: args.message,
        ...(args.files === undefined ? {} : { files: args.files }),
      }
      return checkCommitMessage(input, options.t())
    },
  })
}

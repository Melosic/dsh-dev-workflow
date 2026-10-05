import type { Config } from '../config.js'
import type { Locale, Translate } from '../i18n.js'
import type { GitRunner } from '../git.js'
import type { WorkflowState } from '../state.js'
import { renderCheck } from '../tools/result.js'
import { listChangedFiles } from '../tools/check-doc-sync.js'
import { evaluate, summarize } from '../checks.js'

// `/dev-workflow` — the manual half of the plugin. A human command runs without
// becoming a model message, so it is the right place for "turn this off" and
// "check the tree now"; neither belongs in the conversation transcript.
//
// The registry is reached through `ctx.get('commands')` by the caller, exactly
// like `subprocess`: a profile without it still loads this plugin, and this file
// never has to name a package it does not depend on.

/** The handler result a UI settles a command with. */
export type CommandResult = { kind: 'success'; text?: string } | { kind: 'error'; text: string }

/** The slice of a command invocation this handler reads. */
export interface CommandInvocation {
  /** The agent the command targets; carries the session and its working directory. */
  readonly agent?: {
    readonly session: {
      readonly id: { toString(): string }
      readonly header: { readonly cwd: string }
    }
  }
  /** Everything after the command name, whitespace included. */
  readonly rawInput: string
  /** Cancellation owned by the UI request. */
  readonly signal: AbortSignal
}

/** The one method this plugin needs from the command registry. */
export interface CommandRegistry {
  /**
   * Register one command.
   * @param definition - metadata plus the direct handler.
   * @returns the disposer that unregisters it.
   */
  register(definition: {
    readonly name: string
    readonly description: string
    readonly input?: { readonly hint: string }
    readonly handler: (invocation: CommandInvocation) => CommandResult | Promise<CommandResult>
  }): () => void
}

/** Live access the command needs; all of it belongs to the runtime. */
export interface DevWorkflowCommandOptions {
  /** Resolved plugin configuration. */
  readonly config: Config
  /** Translator for the locale in effect. */
  readonly t: Translate
  /** The locale actually in effect, after `auto` was resolved. */
  readonly locale: Locale
  /** Whether the plugin's registrations are currently active. */
  readonly active: () => boolean
  /** Turn the plugin on or off. */
  readonly setActive: (on: boolean) => void
  /** Session-scoped memory behind the status line. */
  readonly state: WorkflowState
  /** A git runner bound to one working directory. */
  readonly git: (cwd: string) => GitRunner
}

/** The subcommands this command accepts. */
const SUBCOMMANDS = ['on', 'off', 'status', 'check'] as const

/**
 * Render the status report: what the plugin is doing, in which language, what it
 * last found, and how often a guard has fired.
 * @param options - the live plugin state.
 * @returns one line per fact, in reading order.
 */
function statusLines(options: DevWorkflowCommandOptions): string[] {
  const t = options.t
  const lines = [options.active() ? t('command.toggle.status.on') : t('command.toggle.status.off')]
  lines.push(
    t('command.toggle.status.locale', {
      locale: options.locale,
      setting: options.config.locale,
    }),
  )

  const last = options.state.lastOutcome()
  lines.push(
    last === undefined
      ? t('command.toggle.status.never')
      : t('command.toggle.status.last', {
          kind: t(`command.toggle.kind.${last.kind}`),
          summary: last.summary,
        }),
  )

  // Reasons are dictionary keys, so the tally reads as prose rather than as an
  // internal identifier.
  const tally = Object.entries(options.state.guardHits())
  lines.push(
    tally.length === 0
      ? t('command.toggle.status.guards.none')
      : t('command.toggle.status.guards', {
          tally: tally.map(([reason, count]) => `${t(reason)}×${count}`).join(', '),
        }),
  )

  // The audit trail is the one part of a guard's work a user cannot see from the
  // outside, so the status report says whether it is being kept.
  lines.push(
    options.config.audit.enabled
      ? t('audit.enabled', { path: options.config.audit.path })
      : t('audit.disabled'),
  )
  return lines
}

/**
 * Check the working tree on demand, with the same rules the trigger applies.
 * @param options - the live plugin state.
 * @param invocation - the command invocation, for its agent and cancellation.
 * @returns the settlement for the UI.
 */
async function runCheck(
  options: DevWorkflowCommandOptions,
  invocation: CommandInvocation,
): Promise<CommandResult> {
  const t = options.t
  const cwd = invocation.agent?.session.header.cwd ?? process.cwd()
  const listed = await listChangedFiles(options.git(cwd), invocation.signal)
  if (!listed.ok) {
    return {
      kind: 'error',
      text: t(`error.${listed.failure.replace(/-/g, '_')}`, { detail: listed.stderr.trim() }),
    }
  }

  const outcome = evaluate({ files: listed.files }, options.config, t)
  options.state.record({ kind: 'doc', ok: outcome.ok, summary: summarize(outcome, t) })
  const [body] = renderCheck(outcome, t, 'command.toggle.check.clean')
  return {
    kind: 'success',
    text: `${t('command.toggle.check.header')}\n${body?.text ?? ''}`,
  }
}

/** The definition shape the registry accepts, as this command fills it in. */
export interface DevWorkflowCommandDefinition {
  /** Command name without the leading slash. */
  readonly name: string
  /** One line the UI lists the command with. */
  readonly description: string
  /** Placeholder shown while the user types the input. */
  readonly input: { readonly hint: string }
  /**
   * Handle one invocation.
   * @param invocation - the raw input and the agent it targets.
   * @returns the settlement for the UI.
   */
  readonly handler: (invocation: CommandInvocation) => Promise<CommandResult>
}

/**
 * Build the `/dev-workflow` command definition.
 * @param options - configuration, translator, runtime state, and git access.
 * @returns the registry-ready definition; the caller owns registration.
 */
export function createDevWorkflowCommand(
  options: DevWorkflowCommandOptions,
): DevWorkflowCommandDefinition {
  return {
    name: 'dev-workflow',
    description: options.t('command.toggle.description'),
    input: { hint: options.t('command.toggle.hint') },
    handler: async (invocation) => {
      const t = options.t
      const input = invocation.rawInput.trim()
      const requested = input.split(/\s+/)[0] ?? ''
      if (requested.length === 0) {
        return { kind: 'success', text: statusLines(options).join('\n') }
      }
      if (!(SUBCOMMANDS as readonly string[]).includes(requested)) {
        return { kind: 'error', text: t('command.toggle.unknown', { input: requested }) }
      }

      if (requested === 'status') {
        return { kind: 'success', text: statusLines(options).join('\n') }
      }
      if (requested === 'on' || requested === 'off') {
        options.setActive(requested === 'on')
        return {
          kind: 'success',
          text: [statusLines(options)[0] ?? '', statusLines(options)[1] ?? ''].join('\n'),
        }
      }
      return runCheck(options, invocation)
    },
  }
}

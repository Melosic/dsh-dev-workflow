import type { Context } from '@deepseek-ai/cordis'
import type { PreToolDecision, ToolExecution } from '@deepseek-ai/dsh-tools'
import type { GitFailure, GitResult, GitRunner } from '../src/git.js'

// Shared scaffolding for the specs. Nothing here exercises the plugin: it only
// stands in for the DSH services `apply` reaches for, so a spec can assert what
// the plugin registers instead of what a real host does with it.

/** A tool definition as it reaches `ctx.tools.register`. */
export interface RegisteredTool {
  readonly name: string
  readonly description: string
  readonly parameters: {
    readonly type: string
    readonly properties: Record<string, unknown>
    readonly required?: readonly string[]
  }
  readonly output: {
    readonly schema: {
      readonly type: string
      readonly properties: Record<string, unknown>
      readonly required?: readonly string[]
    }
    readonly render: (
      args: unknown,
      value: { ok: boolean; errors: string[]; warnings: string[]; error?: string },
    ) => { type: string; text: string }[]
  }
  readonly execute: (
    args: Record<string, unknown>,
    exec: ToolExecution,
  ) => Promise<{ ok: boolean; errors: string[]; warnings: string[]; error?: string }>
}

/** One `tools/pre-execute` listener as it reaches `ctx.on`. */
export interface RegisteredListener {
  readonly name: string
  readonly listener: (
    exec: ToolExecution,
    next: () => Promise<PreToolDecision>,
  ) => Promise<PreToolDecision>
  readonly options: unknown
}

/** A command definition as it reaches the command registry. */
export interface RegisteredCommand {
  readonly name: string
  readonly description: string
  readonly input?: { readonly hint: string }
  readonly handler: (invocation: {
    agent?: { session: { id: { toString(): string }; header: { cwd: string } } }
    rawInput: string
    signal: AbortSignal
  }) => unknown
}

/** Everything the plugin registered on the stub context. */
export interface Harness {
  readonly ctx: Context
  readonly tools: RegisteredTool[]
  readonly providers: (() => unknown)[]
  readonly listeners: RegisteredListener[]
  readonly commands: RegisteredCommand[]
  readonly effects: (() => void)[]
  readonly logs: string[]
}

/**
 * Build a context that records registrations instead of serving them.
 * @param options - `commands: false` models a profile with no command service.
 * @returns the recording context and the arrays it fills.
 */
export function createHarness(options: { commands?: boolean } = {}): Harness {
  const tools: RegisteredTool[] = []
  const providers: (() => unknown)[] = []
  const listeners: RegisteredListener[] = []
  const commands: RegisteredCommand[] = []
  const effects: (() => void)[] = []
  const logs: string[] = []

  const remove =
    <T>(list: T[], item: T) =>
    () => {
      const index = list.indexOf(item)
      if (index !== -1) list.splice(index, 1)
    }

  const registry = {
    register: (definition: RegisteredCommand) => {
      commands.push(definition)
      return remove(commands, definition)
    },
  }

  const ctx = {
    tools: {
      register: (definition: RegisteredTool) => {
        tools.push(definition)
        return remove(tools, definition)
      },
    },
    skills: {
      registerProvider: (factory: () => unknown) => {
        providers.push(factory)
        return remove(providers, factory)
      },
    },
    // `commands` and `subprocess` are optional capabilities: `undefined` here is
    // a profile that simply offers less, which is the case worth covering.
    get: (name: string) =>
      name === 'commands' && options.commands === true ? registry : undefined,
    on: (name: string, listener: RegisteredListener['listener'], listenerOptions: unknown) => {
      const entry = { name, listener, options: listenerOptions }
      listeners.push(entry)
      return remove(listeners, entry)
    },
    effect: (fn: () => () => void) => {
      const dispose = fn()
      effects.push(dispose)
      return () => dispose()
    },
    logger: { debug: (message: string) => logs.push(message) },
  }

  return {
    ctx: ctx as unknown as Context,
    tools,
    providers,
    listeners,
    commands,
    effects,
    logs,
  }
}

/** One agent session, as the trigger reads it. */
export function makeExec(
  command: string,
  options: {
    cwd?: string
    sessionId?: string
    signal?: AbortSignal
    withoutAgent?: boolean
  } = {},
): ToolExecution {
  const agent =
    options.withoutAgent === true
      ? undefined
      : {
          session: {
            id: { toString: () => options.sessionId ?? 'session-1' },
            header: { cwd: options.cwd ?? process.cwd() },
          },
        }
  return {
    callId: 'call-1',
    name: 'bash',
    arguments: { command },
    ...(agent === undefined ? {} : { agent }),
    signal: options.signal ?? new AbortController().signal,
  } as unknown as ToolExecution
}

/** The decision every gate delegates to when it has nothing to say. */
export const allow = async (): Promise<PreToolDecision> => ({ kind: 'allow' })

/**
 * A git runner whose `status --porcelain` output is whatever the spec says.
 * @param files - read on every call, so a spec can change the working tree.
 * @returns the runner.
 */
export function makeGit(files: () => readonly string[] = () => []): GitRunner {
  return {
    cwd: process.cwd(),
    run: async (): Promise<GitResult> => ({
      ok: true,
      stdout: files()
        .map((file) => ` M ${file}\n`)
        .join(''),
    }),
    locate: async () => ({ ok: true, path: 'git' }),
  }
}

/**
 * A git runner that cannot answer, for the failure path.
 * @param failure - the classified failure to report.
 * @returns the runner.
 */
export function makeFailingGit(failure: GitFailure = 'not-a-git-repository'): GitRunner {
  return {
    cwd: process.cwd(),
    run: async (): Promise<GitResult> => ({ ok: false, failure, stderr: 'fatal: nope' }),
    locate: async () => ({ ok: false, failure }),
  }
}

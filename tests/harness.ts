import type { Context } from '@deepseek-ai/cordis'
import type { PreToolDecision, ToolExecution } from '@deepseek-ai/dsh-tools'
import { Config } from '../src/config.js'
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

/** One `settings.configure` call, as it reached the settings service. */
export interface RecordedPresentation {
  readonly page: { readonly auto?: boolean }
  readonly owner: unknown
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
  /** Every `loader/volatile-update` listener the plugin registered. */
  readonly volatile: (() => void)[]
  /** Every page presentation the plugin declared on the settings service. */
  readonly presentations: RecordedPresentation[]
}

/**
 * Build a context that records registrations instead of serving them.
 * @param options - `commands: false` and `settings: false` model a profile
 * without that optional service.
 * @returns the recording context and the arrays it fills.
 */
export function createHarness(options: { commands?: boolean; settings?: boolean } = {}): Harness {
  const tools: RegisteredTool[] = []
  const providers: (() => unknown)[] = []
  const listeners: RegisteredListener[] = []
  const commands: RegisteredCommand[] = []
  const effects: (() => void)[] = []
  const logs: string[] = []
  const volatile: (() => void)[] = []
  const presentations: RecordedPresentation[] = []

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

  const settings = {
    configure: (page: { auto?: boolean }, owner: unknown) => {
      const entry: RecordedPresentation = { page, owner }
      presentations.push(entry)
      return remove(presentations, entry)
    },
  }

  const collectEffect = (fn: () => () => void) => {
    const dispose = fn()
    effects.push(dispose)
    return () => dispose()
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
    effect: collectEffect,
    // Two optional services, read the way the plugin reads them: through
    // `ctx.get` for `commands`, and through an `inject` whose callback never
    // runs when the service is absent.
    inject: (deps: readonly string[], callback: (child: unknown) => void) => {
      if (options.settings === true && deps.includes('settings')) {
        callback({ get: () => settings, effect: collectEffect })
      }
    },
    logger: { debug: (message: string) => logs.push(message) },
    events: {
      on: (_name: string, listener: () => void) => {
        volatile.push(listener)
        return remove(volatile, listener)
      },
    },
    fiber: {},
  }

  return {
    ctx: ctx as unknown as Context,
    tools,
    providers,
    listeners,
    commands,
    effects,
    logs,
    volatile,
    presentations,
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
    /** Tool name to report; `bash` by default, since most guards read a command. */
    tool?: string
    /** Full arguments to report instead of `{ command }`. */
    arguments?: unknown
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
    name: options.tool ?? 'bash',
    arguments: options.arguments ?? { command },
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

/**
 * Read a resolved configuration as plain values.
 *
 * `Config` hands every leaf back as a volatile reference — that is what lets the
 * loader commit a panel edit into a running plugin — so a spec that is about the
 * resolved defaults unwraps them instead of calling `get()` on each one.
 * @param value - a resolved configuration, or anything inside it.
 * @returns the same shape with every reference replaced by its value.
 */
export function plain(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(plain)
  if (value === null || typeof value !== 'object') return value
  const reference = value as { get?: () => unknown }
  if (typeof reference.get === 'function') return plain(reference.get())
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, plain(item)]))
}

/**
 * Every leaf of a resolved schema that the loader is willing to commit, using
 * the host's own rule: a leaf counts when it is declared volatile, and a branch
 * counts when anything below it does.
 * @param schema - the resolved schema, e.g. `Config`.
 * @returns each volatile leaf as a path.
 */
export function volatilePaths(schema: unknown): string[][] {
  const paths: string[][] = []
  const walk = (node: unknown, prefix: string[]): void => {
    if (node === null || (typeof node !== 'object' && typeof node !== 'function')) return
    const branch = node as { meta?: { volatile?: boolean }; dict?: Record<string, unknown> }
    // Schemastery schemas are callable, so `dict` is the branch test, not a
    // prototype check. A volatile leaf is also a stopping point.
    if (branch.meta?.volatile === true) paths.push(prefix)
    else if (branch.dict !== undefined) {
      for (const key of Object.keys(branch.dict)) walk(branch.dict[key], [...prefix, key])
    }
  }
  const root = schema as { dict?: Record<string, unknown> }
  for (const key of Object.keys(root.dict ?? {})) walk(root.dict?.[key], [key])
  return paths
}

/** One `mutate` operation, in the shape the settings controller accepts. */
export interface FormOp {
  readonly op: 'set' | 'unset'
  readonly path: readonly string[]
  readonly value?: unknown
}

/** The snapshot a `ConfigFormController` hands the panel. */
export interface FormScopeSnapshot {
  readonly status: 'ready' | 'unavailable'
  readonly value: unknown
  readonly base: unknown
  readonly user: unknown
  readonly revision: number
  readonly writable: boolean
}

/** A stand-in for the client `configForms` controller a panel stages edits on. */
export interface FormScope {
  getSnapshot(): FormScopeSnapshot
  subscribe(listener: () => void): () => void
  mutate(ops: readonly FormOp[], expectedRevision?: number): Promise<boolean>
  openSettingsDocument(): Promise<unknown>
  /** Every batch the panel asked the host to write, in order. */
  readonly writes: FormOp[][]
  /** The revision fence each batch carried. */
  readonly revisions: (number | undefined)[]
  /** Reject the next `count` writes instead of applying them. */
  failWrites(count: number): void
  /** What the next `openSettingsDocument` answers. */
  answerOpen(result: unknown): void
}

/**
 * Build a form controller over a real resolved configuration, applying writes
 * the way the host does: `set` commits the value into the running reference,
 * `unset` puts the inherited default back, and both bump the revision.
 * @param config - the resolved configuration the panel is supposed to drive.
 * @param options - `user` is the override layer; `base` the inherited one.
 * @returns the controller and the batches it received.
 */
export function createFormScope(
  config: unknown,
  options: { user?: unknown; base?: unknown } = {},
): FormScope {
  // `base` is the inherited layer — the values the package ships — while
  // `config` already carries whatever the profile file overrides. Unsetting a
  // field puts the base back, which is what makes the reset button work.
  const base = options.base ?? plain(Config({}))
  let user = options.user ?? {}
  let revision = 0
  let failures = 0
  let openResult: unknown = { ok: true }
  const listeners = new Set<() => void>()
  const writes: FormOp[][] = []
  const revisions: (number | undefined)[] = []

  const reference = config as Record<string, unknown>
  const parentOf = (path: readonly string[]): Record<string, unknown> =>
    path
      .slice(0, -1)
      .reduce<Record<string, unknown>>(
        (node, key) => node[key] as Record<string, unknown>,
        reference,
      )
  const baseLeaf = (path: readonly string[]): unknown =>
    path.reduce<unknown>((node, key) => (node as Record<string, unknown>)[key], base)

  return {
    getSnapshot: () => ({
      status: 'ready',
      value: plain(config),
      base,
      user,
      revision,
      writable: true,
    }),
    subscribe: (listener) => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    mutate: async (ops, expectedRevision) => {
      writes.push(ops.map((op) => ({ ...op })))
      revisions.push(expectedRevision)
      if (expectedRevision !== undefined && expectedRevision !== revision) return false
      if (failures > 0) {
        failures -= 1
        return false
      }
      for (const op of ops) {
        const parent = parentOf(op.path)
        const key = op.path[op.path.length - 1] as string
        const volatile = parent[key] as { get(): unknown } & Record<symbol, (next: unknown) => void>
        if (op.op === 'set') {
          volatile[Symbol.for('cosmokit.volatile.write')]!(op.value)
          user = { ...(user as Record<string, unknown>) }
          const container = op.path.slice(0, -1).reduce<Record<string, unknown>>(
            (node, part) => {
              node[part] ??= {}
              return node[part] as Record<string, unknown>
            },
            user as Record<string, unknown>,
          )
          container[key] = op.value
        } else {
          volatile[Symbol.for('cosmokit.volatile.write')]!(plain(baseLeaf(op.path)))
          const container = op.path
            .slice(0, -1)
            .reduce<Record<string, unknown> | undefined>(
              (node, part) => node?.[part] as Record<string, unknown> | undefined,
              user as Record<string, unknown>,
            )
          if (container !== undefined) delete container[key]
        }
      }
      revision += 1
      for (const listener of listeners) listener()
      return true
    },
    openSettingsDocument: async () => {
      const result = openResult
      openResult = { ok: true }
      return result
    },
    writes,
    revisions,
    failWrites: (count) => {
      failures = count
    },
    answerOpen: (result) => {
      openResult = result
    },
  }
}

/** The description the browser half exports, shared with the panel renderer. */
export interface PanelDescription {
  readonly namespace: string
  readonly locale: string
  readonly slot: string
  readonly order: number
  readonly groups: readonly { readonly key: string; readonly open: boolean }[]
  readonly fields: readonly {
    readonly group: string
    readonly path: readonly string[]
    readonly control: string
    readonly options?: readonly (string | { readonly value: string })[]
  }[]
  readonly advanced: readonly { readonly path: readonly string[]; readonly label: string }[]
  readonly commitTypes: readonly string[]
  readonly gitPolicies: readonly string[]
  readonly dictionaries: {
    readonly en: Record<string, string>
    readonly zh: Record<string, string>
  }
}

/** The browser half's section registration, as the slot service received it. */
export interface PanelSection {
  readonly options: {
    readonly name: string
    readonly id: string
    readonly order: number
    readonly locale: string
    readonly label: () => string
    readonly inject: () => unknown
  }
  readonly component: unknown
}

/** Everything one loaded panel hands back to a spec. */
export interface LoadedPanel {
  readonly description: PanelDescription
  readonly section: PanelSection
  readonly injected: {
    readonly hooks: { readonly form: unknown; readonly document: unknown }
    readonly openDocument: () => void
    readonly documentAvailable: boolean
  }
  /** The namespaces the panel asked the settings service for. */
  readonly namespaces: string[]
  /** The dictionaries the panel registered, by namespace. */
  readonly dictionaries: { readonly ns: string; readonly dict: unknown }[]
}

let registration:
  | {
      readonly factory: (require: (spec: string) => unknown) => {
        readonly apply: (ctx: unknown) => void
        readonly inject: readonly string[]
        readonly panel: PanelDescription
      }
    }
  | undefined

/**
 * Load the hand-written browser half the way the deployment does: through
 * `window.__ModuleLoader__`, with a `require` that answers the baseline
 * externals, then run its `apply` against a stub client context.
 * @param scope - the controller the panel should stage its edits on.
 * @returns the section the panel registered and its injected props.
 */
export async function loadPanel(scope: FormScope): Promise<LoadedPanel> {
  if (registration === undefined) {
    const loaded: (typeof registration)[] = []
    const globals = globalThis as { window?: unknown }
    const previous = globals.window
    globals.window = {
      __ModuleLoader__: {
        load: (entry: (typeof loaded)[number]) => {
          loaded.push(entry)
        },
      },
    }
    try {
      await import('../client.js')
    } finally {
      globals.window = previous
    }
    registration = loaded[0]
    if (registration === undefined) throw new Error('client.js registered no module')
  }
  const module = registration.factory((spec) =>
    spec === 'react'
      ? {
          createElement: () => undefined,
          Fragment: 'Fragment',
          useRef: () => ({ current: undefined }),
          useState: (initial: unknown) => [initial, () => undefined],
          useEffect: () => undefined,
        }
      : undefined,
  )

  const sections: PanelSection[] = []
  const namespaces: string[] = []
  const dictionaries: { ns: string; dict: unknown }[] = []
  const ctx = {
    locale: {
      bind: (ns: string) => (key: string) => `${ns}.${key}`,
      register: (ns: string, dict: unknown) => {
        dictionaries.push({ ns, dict })
        return () => undefined
      },
    },
    configForms: {
      get: (ns: string) => {
        namespaces.push(ns)
        return scope
      },
      whileServed: (_namespaces: readonly string[], register: () => () => void) =>
        register() ?? (() => undefined),
    },
    remote: { $host: { isLoopback: true }, settings: scope },
    slots: {
      inject: (_owner: string, register: () => () => void) => register() ?? (() => undefined),
      register: (options: PanelSection['options'], component: unknown) => {
        sections.push({ options, component })
        return () => undefined
      },
    },
    effect: (fn: () => () => void) => fn(),
  }
  module.apply(ctx)
  const section = sections[0]
  if (section === undefined) throw new Error('the panel registered no settings section')
  const injected = section.options.inject() as LoadedPanel['injected']
  return { description: module.panel, section, injected, namespaces, dictionaries }
}

import type { Context } from '@deepseek-ai/cordis'
import { Config } from './config.js'
import type { Translate } from './i18n.js'
import { createTranslator, resolveLocale } from './i18n.js'
import type { Locale } from './i18n.js'
import { createGitRunner } from './git.js'
import type { GitRunner } from './git.js'
import { createWorkflowState } from './state.js'
import type { WorkflowState } from './state.js'
import { createSkillProvider } from './skills/provider.js'
import { createCheckCommitMessageTool } from './tools/check-commit-message.js'
import { createCheckDocSyncTool } from './tools/check-doc-sync.js'
import type { CommandRegistry } from './commands/dev-workflow.js'
import { createDevWorkflowCommand } from './commands/dev-workflow.js'
import { createPreCommitTrigger } from './triggers/pre-commit.js'
import { createGitGuard } from './guard/git-guard.js'
import { createCommandGuard } from './guard/command-guard.js'
import { createFileGuard } from './guard/file-guard.js'

/** Cordis plugin name. */
export const name = 'dev-workflow'

// `tools` and `skills` are read as services, so they are declared: the plugin
// cannot load before them and cannot outlive them. `subprocess` (used by the git
// runner) and `commands` (used by `/dev-workflow`) are deliberately absent — they
// are optional capabilities read through `ctx.get`, so a profile without either
// still mounts this plugin and simply offers less.
export const inject = ['tools', 'skills']

/**
 * Live plugin state, shared by everything registered during `apply`.
 *
 * The mode is mutable: turning the plugin off has to unregister the tool, skill,
 * command, and trigger registrations, not merely stop answering, because the
 * resident cost of this plugin is exactly those registrations. Keeping the state
 * in one object lets the command surface reach the same registrations the
 * trigger does, without reimplementing them.
 */
export interface Runtime {
  /** Whether the registrations are currently active. */
  readonly active: boolean
  /** The locale in effect, resolved from configuration. */
  locale(): Locale
  /** Translator for the locale in effect. */
  t(): Translate
  /** A git runner bound to one working directory. */
  git(cwd: string): GitRunner
  /** What this plugin remembers while it is loaded. */
  readonly state: WorkflowState
  /**
   * Turn the plugin on or off.
   * @param on - `true` to register, `false` to unregister.
   */
  setActive(on: boolean): void
}

/**
 * Create the runtime for one plugin instance.
 * @param ctx - the context the plugin is applied to.
 * @param config - resolved configuration.
 * @returns the runtime, with nothing registered yet.
 */
export function createRuntime(ctx: Context, config: Config): Runtime {
  // `locale: 'auto'` is resolved once, at load: the runtime locale cannot change
  // while a session is running, and a stable value keeps the catalog entry and
  // the skill body in the same language.
  const locale = resolveLocale(config.locale)
  const translate = createTranslator(locale)

  // Only one locale is ever translated per process, but the accessor keeps the
  // call sites identical to the ones an explicit locale switch would need.
  const t: Translate = (key, params) =>
    params === undefined ? translate(key) : translate(key, params)

  const state = createWorkflowState()
  const gitCache = new Map<string, GitRunner>()

  // Effects that undo the current registration, newest first. Holding them here
  // is what makes `off` more than a flag: the resident cost of this plugin is
  // exactly the registrations, so they have to go away.
  const releases: (() => void)[] = []

  const bind = (dispose: () => void): void => {
    let released = false
    const once = (): void => {
      if (released) return
      released = true
      dispose()
    }
    // The tool and command registries tie what they return to their own context,
    // not to this fiber, so an unload alone would leave the registration behind.
    // Binding it as an effect is what makes an unload (or a hot reload) clean up;
    // the explicit call in `setActive(false)` unregisters at runtime, and the
    // `released` flag keeps the second call harmless.
    releases.push(ctx.effect(() => once))
  }

  const activate = (): void => {
    const registrations: (() => void)[] = [
      ctx.tools.register(createCheckCommitMessageTool({ t: () => t })),
      ctx.tools.register(
        createCheckDocSyncTool({ t: () => t, config: () => config, git: runtime.git }),
      ),
      // A provider instance per registration would be wrong here: the registry
      // reads the locale on every `list()`/`get()`, so one provider serves
      // whichever locale is in effect without being re-registered.
      ctx.skills.registerProvider(() =>
        createSkillProvider({ currentLocale: () => runtime.locale(), t }),
      ),
    ]

    const commands: unknown = ctx.get('commands')
    if (commands !== undefined && commands !== null) {
      registrations.push(
        (commands as CommandRegistry).register(
          createDevWorkflowCommand({
            config,
            t,
            locale,
            active: () => runtime.active,
            setActive: (on) => runtime.setActive(on),
            state,
            git: runtime.git,
          }),
        ),
      )
    }

    // The repository may already enforce these rules with husky and commitlint;
    // `enableOwnTrigger: false` is how an author says so.
    if (config.enableOwnTrigger) {
      registrations.push(
        ctx.on(
          'tools/pre-execute',
          createPreCommitTrigger({
            config: () => config,
            t: () => t,
            state,
            git: runtime.git,
            log: (message) => ctx.logger.debug(message),
          }),
        ),
      )
    }

    // The guard is a separate listener on the same gate rather than part of the
    // trigger: one protects conventions and the other protects work, and they
    // are switched on independently.
    if (config.gitGuard.enabled) {
      registrations.push(
        ctx.on(
          'tools/pre-execute',
          createGitGuard({
            config: () => config,
            t: () => t,
            state,
            log: (message) => ctx.logger.debug(message),
          }),
        ),
      )
    }

    // The command guard is a third listener on the same gate: the git one
    // protects the repository, this one protects the machine. It is its own
    // switch, so a profile can keep one without the other.
    if (config.commandGuard.enabled) {
      registrations.push(
        ctx.on(
          'tools/pre-execute',
          createCommandGuard({
            config: () => config,
            t: () => t,
            state,
            log: (message) => ctx.logger.debug(message),
          }),
        ),
      )
    }

    // The file guard reads paths out of the tool arguments. DSH has no
    // before-read event, so matching a path is the only point at which a
    // sensitive file can be stopped before its contents are in context.
    if (config.fileGuard.enabled) {
      registrations.push(
        ctx.on(
          'tools/pre-execute',
          createFileGuard({
            config: () => config,
            t: () => t,
            state,
            log: (message) => ctx.logger.debug(message),
          }),
        ),
      )
    }

    for (const dispose of registrations) bind(dispose)
  }

  const runtime: Runtime = {
    get active() {
      return releases.length > 0
    },
    locale: () => locale,
    t: () => t,
    git: (cwd) => {
      const existing = gitCache.get(cwd)
      if (existing !== undefined) return existing
      const runner = createGitRunner(ctx, cwd)
      gitCache.set(cwd, runner)
      return runner
    },
    state,
    setActive: (on) => {
      if (on === runtime.active) return
      if (on) activate()
      else for (const release of releases.splice(0).reverse()) release()
    },
  }

  if (config.mode === 'on') activate()
  ctx.logger.debug(
    `[dsh-dev-workflow] mounted (mode=${config.mode}, locale=${locale}, ownTrigger=${config.enableOwnTrigger})`,
  )

  return runtime
}

/**
 * Cordis entry point.
 * @param ctx - the context the plugin is applied to.
 * @param config - validated configuration; every field has a default.
 */
export function apply(ctx: Context, config: Config): void {
  createRuntime(ctx, config)
}

export { Config }

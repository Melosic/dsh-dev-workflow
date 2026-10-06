import type { Context, Fiber } from '@deepseek-ai/cordis'
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
import { createPrePrTrigger } from './triggers/pre-pr.js'
import { createPreReleaseTrigger } from './triggers/pre-release.js'
import { createGitGuard } from './guard/git-guard.js'
import { createOutwardGuard } from './guard/outward-guard.js'
import type { ApprovalPolicyReporter } from './approval-policy.js'
import type { ApprovalService } from './guard/approval.js'
import { createCommandGuard } from './guard/command-guard.js'
import { createFileGuard } from './guard/file-guard.js'
import { createSecretGuard } from './guard/secret-guard.js'
import { createAudit } from './audit.js'

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
 * The part of the `settings` service this plugin uses.
 *
 * The service is read through `ctx.get`, so its shape is described here rather
 * than imported: the package ships no types at all.
 */
interface SettingsPresentation {
  /**
   * Declare who renders this plugin's page.
   * @param page - `auto: false` turns off the page generated from the schema.
   * @param owner - the plugin fiber the choice belongs to.
   * @returns the disposer that withdraws the choice.
   */
  configure(page: { auto?: boolean }, owner: Fiber): () => void
}

/**
 * Create the runtime for one plugin instance.
 * @param ctx - the context the plugin is applied to.
 * @param config - resolved configuration.
 * @returns the runtime, with nothing registered yet.
 */
export function createRuntime(ctx: Context, config: Config): Runtime {
  // `locale: 'auto'` is resolved to one concrete language, but not once for the
  // life of the process: the settings panel can change it, so it is re-resolved
  // whenever it is read and the dictionary is rebuilt only when it actually
  // moved. The catalog entry and the skill body then stay in the same language.
  let locale = resolveLocale(config.locale.get())
  let translate = createTranslator(locale)
  const refreshLocale = (): void => {
    const next = resolveLocale(config.locale.get())
    if (next === locale) return
    locale = next
    translate = createTranslator(next)
  }

  // Only one locale is ever translated per process, but the accessor keeps the
  // call sites identical to the ones an explicit locale switch would need.
  const t: Translate = (key, params) => {
    refreshLocale()
    return params === undefined ? translate(key) : translate(key, params)
  }

  const state = createWorkflowState()
  const gitCache = new Map<string, GitRunner>()

  // Effects that undo the current registration, newest first. Holding them here
  // is what makes `off` more than a flag: the resident cost of this plugin is
  // exactly the registrations, so they have to go away.
  const releases: (() => void)[] = []

  // What the live registrations were built from. Everything else a setting
  // controls is read at the moment a check or a guard runs, so it needs no
  // rebuilding; these switches decide whether something is registered at all.
  const registrationSignature = (): string =>
    [
      config.mode.get(),
      config.enableOwnTrigger.get(),
      config.gitGuard.enabled.get(),
      config.outwardGuard.enabled.get(),
      config.commandGuard.enabled.get(),
      config.fileGuard.enabled.get(),
      config.secretGuard.enabled.get(),
    ].join(':')
  let registered = ''

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
    registered = registrationSignature()
    const registrations: (() => void)[] = [
      ctx.tools.register(createCheckCommitMessageTool({ t: () => t, config: () => config })),
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
            locale: () => runtime.locale(),
            active: () => runtime.active,
            setActive: (on) => runtime.setActive(on),
            state,
            git: runtime.git,
          }),
        ),
      )
    }

    // The repository may already enforce these rules with husky and commitlint;
    // `enableOwnTrigger: false` is how an author says so. It governs all three
    // convention triggers: they are one family, and an author who has the rules
    // somewhere else does not want any of them.
    //
    // They ride on `tools/pre-execute` because the event catalogue has no commit,
    // pull-request, or release event. Each recognises its action by the shell
    // command that performs it, and the commit gate stays first so a change that
    // is already being fixed at commit time is not judged twice.
    if (config.enableOwnTrigger.get()) {
      registrations.push(
        ctx.on(
          'tools/pre-execute',
          createPreCommitTrigger({
            config: () => config,
            t: () => t,
            state,
            git: runtime.git,
            log: (message) => ctx.logger.debug(message),
            approval: () => ctx.get('approval') as ApprovalPolicyReporter | undefined,
          }),
        ),
        ctx.on(
          'tools/pre-execute',
          createPrePrTrigger({
            config: () => config,
            t: () => t,
            state,
            log: (message) => ctx.logger.debug(message),
            approval: () => ctx.get('approval') as ApprovalPolicyReporter | undefined,
          }),
        ),
        ctx.on(
          'tools/pre-execute',
          createPreReleaseTrigger({
            config: () => config,
            t: () => t,
            state,
            log: (message) => ctx.logger.debug(message),
            approval: () => ctx.get('approval') as ApprovalPolicyReporter | undefined,
          }),
        ),
      )
    }

    // Every guard shares one audit sink: the record should read the same whether
    // a force push or a leaked token is what tripped it.
    const audit = createAudit({ config: () => config, log: (message) => ctx.logger.debug(message) })

    // The guard is a separate listener on the same gate rather than part of the
    // trigger: one protects conventions and the other protects work, and they
    // are switched on independently.
    if (config.gitGuard.enabled.get()) {
      registrations.push(
        ctx.on(
          'tools/pre-execute',
          createGitGuard({
            config: () => config,
            t: () => t,
            state,
            log: (message) => ctx.logger.debug(message),
            audit,
            // Read at call time and never injected: a profile without an
            // approval service still mounts the plugin, and every question then
            // falls back to the dispatcher's own prompt.
            approval: () => ctx.get('approval') as ApprovalService | undefined,
          }),
        ),
      )
    }

    // The guards that leave this machine run next: nothing they cover is
    // unrecoverable here, but each one is visible to other people the moment it
    // lands, and consent is the thing being protected.
    if (config.outwardGuard.enabled.get()) {
      registrations.push(
        ctx.on(
          'tools/pre-execute',
          createOutwardGuard({
            config: () => config,
            t: () => t,
            state,
            log: (message) => ctx.logger.debug(message),
            audit,
            approval: () => ctx.get('approval') as ApprovalPolicyReporter | undefined,
          }),
        ),
      )
    }

    // The remaining guards run after those, from the widest blast radius to the
    // narrowest: a machine, then a filesystem, then a single secret. Each is its
    // own switch, so a profile can keep one without the others.
    if (config.commandGuard.enabled.get()) {
      registrations.push(
        ctx.on(
          'tools/pre-execute',
          createCommandGuard({
            config: () => config,
            t: () => t,
            state,
            log: (message) => ctx.logger.debug(message),
            audit,
            approval: () => ctx.get('approval') as ApprovalPolicyReporter | undefined,
          }),
        ),
      )
    }

    if (config.fileGuard.enabled.get()) {
      registrations.push(
        ctx.on(
          'tools/pre-execute',
          createFileGuard({
            config: () => config,
            t: () => t,
            state,
            log: (message) => ctx.logger.debug(message),
            audit,
            approval: () => ctx.get('approval') as ApprovalPolicyReporter | undefined,
          }),
        ),
      )
    }

    if (config.secretGuard.enabled.get()) {
      registrations.push(
        ctx.on(
          'tools/pre-execute',
          createSecretGuard({
            config: () => config,
            t: () => t,
            state,
            log: (message) => ctx.logger.debug(message),
            audit,
            approval: () => ctx.get('approval') as ApprovalPolicyReporter | undefined,
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
    locale: () => {
      refreshLocale()
      return locale
    },
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
      else {
        for (const release of releases.splice(0).reverse()) release()
        registered = ''
      }
    },
  }

  // The panel writes configuration, which the loader commits into the live
  // reference without reloading this plugin. Every read then sees the new value
  // by itself; only the registrations have to be rebuilt, and only when one of
  // the switches they were built from actually moved. A manual
  // `/dev-workflow off` is not undone unless the edit itself asks for a switch:
  // the signature is unchanged by any other setting.
  const resync = (): void => {
    refreshLocale()
    if (registered === registrationSignature()) return
    runtime.setActive(false)
    if (config.mode.get() === 'on') runtime.setActive(true)
  }
  // Declared on this context, not inside the `inject` below: the loader delivers
  // the event to listeners owned by this plugin's own fiber.
  void ctx.events.on('loader/volatile-update', () => {
    resync()
  })

  // The plugin renders its own page, so the schema-driven one is turned off.
  // The service is optional — a profile without it simply has no panel.
  void ctx.inject(['settings'], (child) => {
    child.effect(() =>
      (child.get('settings') as SettingsPresentation).configure({ auto: false }, ctx.fiber),
    )
  })

  if (config.mode.get() === 'on') activate()
  ctx.logger.debug(
    `[dsh-dev-workflow] mounted (mode=${config.mode.get()}, locale=${locale}, ownTrigger=${config.enableOwnTrigger.get()})`,
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

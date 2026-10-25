import type { Context, Fiber } from '@deepseek-ai/cordis'
import type { PreToolDecision, ToolExecution } from '@deepseek-ai/dsh-tools'
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
import { applies } from './scope.js'
import type { Scope } from './scope.js'

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
  // The command's own registration, kept apart so `off` can withdraw everything
  // else and still leave a way back. It is released on unload like the rest.
  const commandReleases: (() => void)[] = []

  // What the live registrations were built from. Everything else a setting
  // controls is read at the moment a check or a guard runs, so it needs no
  // rebuilding; these switches decide whether something is registered at all.
  //
  // `locale` is here because a tool's `description` and a command's
  // `description`/`hint` are strings evaluated once, when the registration is
  // built — unlike a tool's parameters and render, which call `t()` per use. A
  // panel locale change would otherwise leave every tool description in the
  // language it was registered in, while the skill catalog line moved.
  const registrationSignature = (): string =>
    [
      config.mode.get(),
      config.locale.get(),
      config.enableOwnTrigger.get(),
      config.gitGuard.enabled.get(),
      config.outwardGuard.enabled.get(),
      config.commandGuard.enabled.get(),
      config.fileGuard.enabled.get(),
      config.secretGuard.enabled.get(),
    ].join(':')
  let registered = ''
  // The `mode` value in effect when `/dev-workflow off` withdrew the plugin, or
  // `undefined` while it is running. Storing the value rather than a boolean is
  // what makes "the configuration edited `mode`" distinguishable from "the
  // configuration edited something else": a withdrawal is undone by the answer to
  // its own question, not by every write the panel makes.
  let manualOff: string | undefined

  const bind = (dispose: () => void, into: (() => void)[] = releases): void => {
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
    into.push(ctx.effect(() => once))
  }

  // A profile is per machine, but the rules are a property of the repository.
  // `scope: 'marked'` is how one profile serves repositories that want the rules
  // and repositories that do not, and the gate below is the only place that
  // decides it — every listener asks the same question, so the answer cannot
  // disagree between the trigger that speaks first and the guard that speaks
  // last.
  //
  // The gate wraps the registration rather than living inside each listener:
  // a listener that is skipped has to behave exactly like one that found
  // nothing, and calling `next()` is precisely that.
  const cwdOf = (exec: ToolExecution): string => exec.agent?.session.header.cwd ?? process.cwd()

  const scoped =
    (
      listener: (
        exec: ToolExecution,
        next: () => Promise<PreToolDecision>,
      ) => Promise<PreToolDecision>,
    ) =>
    async (exec: ToolExecution, next: () => Promise<PreToolDecision>): Promise<PreToolDecision> => {
      // Read live: the panel can change the scope without re-registering
      // anything, so a rebuild would only add a way for the two to disagree.
      if (!applies(config.scope.get() as Scope, cwdOf(exec))) return next()
      return listener(exec, next)
    }

  // Registering a gate is `scoped(listener)`, and doing that inline at each of
  // the eight sites buries the listener in wrapper syntax. Naming the two things
  // a gate needs — its body and the event it rides — keeps each registration
  // readable, and keeps the wrapper from being forgotten at one site out of eight.
  const gate = (
    listener: (
      exec: ToolExecution,
      next: () => Promise<PreToolDecision>,
    ) => Promise<PreToolDecision>,
  ): (() => void) => ctx.on('tools/pre-execute', scoped(listener))

  const activate = (): void => {
    registered = registrationSignature()
    const registrations: (() => void)[] = [
      ctx.tools.register(createCheckCommitMessageTool({ t: () => t, config: () => config })),
      ctx.tools.register(
        createCheckDocSyncTool({
          t: () => t,
          config: () => config,
          git: (cwd) => runtime.git(cwd),
        }),
      ),
      // A provider instance per registration would be wrong here: the registry
      // reads the locale on every `list()`/`get()`, so one provider serves
      // whichever locale is in effect without being re-registered.
      ctx.skills.registerProvider(() =>
        createSkillProvider({
          currentLocale: () => runtime.locale(),
          t,
          applies: (cwd) => applies(config.scope.get() as Scope, cwd),
        }),
      ),
    ]

    // `/dev-workflow` itself survives `off`, because it is the only way back: a
    // command that removes its own registration leaves the user with no command
    // to type. That is why it is bound apart from `releases` — `active` asks
    // whether the working registrations are here, and a command that outlives
    // `off` would otherwise answer yes to a question about the plugin being off.
    //
    // It is released here, though, before being registered again: a registration
    // carries its `description` and `hint` as strings, so a rebuild after a locale
    // change has to replace it or the tool list keeps the old language.
    for (const release of commandReleases.splice(0).reverse()) release()
    const commands: unknown = ctx.get('commands')
    if (commands !== undefined && commands !== null) {
      bind(
        (commands as CommandRegistry).register(
          createDevWorkflowCommand({
            config,
            t,
            locale: () => runtime.locale(),
            active: () => runtime.active,
            setActive: (on) => runtime.setActive(on),
            runtimeOff: () => manualOff !== undefined,
            state,
            git: (cwd) => runtime.git(cwd),
          }),
        ),
        commandReleases,
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
        gate(
          createPreCommitTrigger({
            config: () => config,
            t: () => t,
            state,
            git: (cwd) => runtime.git(cwd),
            log: (message) => ctx.logger.debug(message),
            approval: () => ctx.get('approval') as ApprovalPolicyReporter | undefined,
          }),
        ),
        gate(
          createPrePrTrigger({
            config: () => config,
            t: () => t,
            state,
            git: (cwd) => runtime.git(cwd),
            log: (message) => ctx.logger.debug(message),
            approval: () => ctx.get('approval') as ApprovalPolicyReporter | undefined,
          }),
        ),
        gate(
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
        gate(
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
        gate(
          createOutwardGuard({
            config: () => config,
            t: () => t,
            state,
            log: (message) => ctx.logger.debug(message),
            audit,
            // Same seam the git guard reads, and for the same reason: it is what
            // lets `rememberApproved` apply to a push as well as to a commit.
            approval: () => ctx.get('approval') as ApprovalService | undefined,
          }),
        ),
      )
    }

    // The remaining guards run after those, from the widest blast radius to the
    // narrowest: a machine, then a filesystem, then a single secret. Each is its
    // own switch, so a profile can keep one without the others.
    if (config.commandGuard.enabled.get()) {
      registrations.push(
        gate(
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
        gate(
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
        gate(
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

  // Register or withdraw, without recording *why*. `setActive` is the decision
  // the command makes; a rebuild after a settings write is not a decision, and
  // routing it through the command's entry point is what made a configured off
  // look like a manual one.
  const apply = (on: boolean): void => {
    if (on === runtime.active) return
    if (on) activate()
    else {
      for (const release of releases.splice(0).reverse()) release()
      registered = ''
    }
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
      // The value `mode` held when the user withdrew the plugin. Storing the
      // value rather than a boolean is what makes "the configuration edited
      // `mode`" distinguishable from "the configuration edited something else".
      manualOff = on ? undefined : config.mode.get()
      apply(on)
    },
  }

  // The panel writes configuration, which the loader commits into the live
  // reference without reloading this plugin. Every read then sees the new value
  // by itself; only the registrations have to be rebuilt, and only when one of
  // the switches they were built from actually moved — or when `mode` itself
  // moved, which is the one edit that does ask for a switch. A manual
  // `/dev-workflow off` is not undone by anything else the panel writes; the
  // comparison against `registered` is skipped while that flag is set, because
  // `off` clears the signature and would otherwise match nothing.
  const resync = (): void => {
    refreshLocale()
    const signature = registrationSignature()
    const mode = config.mode.get()
    if (manualOff !== undefined) {
      // A manual `off` is the user's own decision, and it survives every settings
      // write that does not answer the same question. Only a `mode` that *moved*
      // counts as an answer — checking `mode === 'on'` instead is the bug this
      // replaces: every unrelated edit (a locale, a guard switch) restored the
      // plugin the user had just turned off.
      if (mode === manualOff) return
      manualOff = undefined
      if (mode === 'on') apply(true)
      return
    }
    if (registered === signature) return
    apply(false)
    if (mode === 'on') apply(true)
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

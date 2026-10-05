import type { Context } from '@deepseek-ai/cordis'
import { Config } from './config.js'
import type { Translate } from './i18n.js'
import { createTranslator, resolveLocale } from './i18n.js'
import type { Locale } from './i18n.js'
import { createGitRunner } from './git.js'
import type { GitRunner } from './git.js'
import { createSkillProvider } from './skills/provider.js'
import { createCheckCommitMessageTool } from './tools/check-commit-message.js'
import { createCheckDocSyncTool } from './tools/check-doc-sync.js'

/** Cordis plugin name. */
export const name = 'dev-workflow'

// `tools` and `skills` are read as services, so they are declared: the plugin
// cannot load before them and cannot outlive them. `subprocess` is deliberately
// absent — it is an optional capability read through `ctx.get` inside the check,
// so a profile without a subprocess provider still mounts this plugin and
// reports "git was not found" instead of failing to load.
export const inject = ['tools', 'skills']

/**
 * Live plugin state, shared by everything registered during `apply`.
 *
 * The mode is mutable: turning the plugin off has to unregister the tool and
 * skill registrations, not merely stop answering, because the resident cost of
 * this plugin is exactly those registrations. Keeping the state in one object
 * lets the command surface (and the pre-commit trigger) reach the same
 * registration without reimplementing it.
 */
export interface Runtime {
  /** Whether the tool and skill registrations are currently active. */
  readonly active: boolean
  /** The locale in effect, resolved from configuration. */
  locale(): Locale
  /** Translator for the locale in effect. */
  t(): Translate
  /** A git runner bound to one working directory. */
  git(cwd: string): GitRunner
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

  const gitCache = new Map<string, GitRunner>()
  const runtime: Runtime = {
    get active() {
      return disposers.length > 0
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
    setActive: (on) => {
      if (on === runtime.active) return
      if (on) activate()
      else for (const dispose of disposers.splice(0).reverse()) dispose()
    },
  }

  // Disposers of the current registration. Both registries tie what they return
  // to this plugin's fiber, so an unload cleans up even if `setActive(false)`
  // never runs; the array only exists to support turning off at runtime.
  let disposers: (() => void)[] = []

  const activate = (): void => {
    disposers = [
      ctx.tools.register(createCheckCommitMessageTool({ t: () => t })),
      ctx.tools.register(
        createCheckDocSyncTool({ t: () => t, config: () => config, git: runtime.git }),
      ),
      // Returning the same provider instance each call would be wrong here: the
      // registry reads the locale on every `list()`/`get()`, so one provider
      // serves whichever locale is in effect without being re-registered.
      ctx.skills.registerProvider(() =>
        createSkillProvider({ currentLocale: () => runtime.locale(), t: t }),
      ),
    ]
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

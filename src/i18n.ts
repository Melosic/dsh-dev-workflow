import { createRequire } from 'node:module'

// Translation for everything the user or the model can read. Dictionaries ship
// as JSON next to the compiled output (`lib/` -> `../locale/`), are required
// through `createRequire` because they are data rather than a module graph
// edge, and are cached per locale.

/** Locales this plugin ships dictionaries for. */
export type Locale = 'en-US' | 'zh-CN'

/** Values interpolated into `{name}` placeholders. */
export type TranslationParams = Readonly<Record<string, string | number>>

/** Translate one dictionary key, interpolating `{name}` placeholders. */
export type Translate = (key: string, params?: TranslationParams) => string

/** Configured locale setting, before `auto` is resolved. */
export type LocaleSetting = 'auto' | Locale

const DICTIONARY_FILES: Readonly<Record<Locale, string>> = {
  'en-US': '../locale/en.json',
  'zh-CN': '../locale/zh.json',
}

const cache = new Map<Locale, Record<string, string>>()

/**
 * Load one dictionary, once per process.
 * @param locale - the shipped locale to read.
 * @returns the flat `dot.path` -> text map.
 */
function dictionary(locale: Locale): Record<string, string> {
  const cached = cache.get(locale)
  if (cached !== undefined) return cached
  const require = createRequire(import.meta.url)
  const loaded = require(DICTIONARY_FILES[locale]) as Record<string, string>
  cache.set(locale, loaded)
  return loaded
}

/**
 * Resolve the configured setting to a shipped locale. `auto` reads the runtime
 * locale through `Intl`, so no environment variable has to be parsed by hand.
 * @param setting - the configured value.
 * @returns the locale to translate with.
 */
export function resolveLocale(setting: LocaleSetting): Locale {
  if (setting !== 'auto') return setting
  const runtime = Intl.DateTimeFormat().resolvedOptions().locale.toLowerCase()
  return runtime.startsWith('zh') ? 'zh-CN' : 'en-US'
}

/**
 * Build the translator for one locale.
 * @param locale - the locale to read.
 * @returns a translator; an unknown key resolves to the key itself, which keeps
 *   a missing translation visible instead of silently printing `undefined`.
 */
export function createTranslator(locale: Locale): Translate {
  const messages = dictionary(locale)
  return (key, params) => {
    const template = messages[key] ?? key
    if (params === undefined) return template
    return template.replace(/\{(\w+)\}/g, (match, name: string) => {
      const value = params[name]
      return value === undefined ? match : String(value)
    })
  }
}

import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { BUNDLED_SKILL_RANK } from '@deepseek-ai/dsh-skill'
import type { SkillCandidate, SkillDefinition, SkillProvider } from '@deepseek-ai/dsh-skill'
import type { Locale, Translate } from '../i18n.js'

// The plugin's whole resident footprint is this one catalog entry: the model
// sees `skill.summary` and the skill name, nothing else. The specification
// itself stays in `skills/dsh-dev-workflow/` and is read only when the model
// asks for it.

/** Skill name. Matches the plugin name so one name addresses both. */
export const SKILL_NAME = 'dsh-dev-workflow'

/** Provider name registered on `ctx.skills`. */
export const PROVIDER_NAME = 'dsh-dev-workflow'

/** Bodies are loaded relative to the compiled file in `lib/skills/`. */
const BODIES: Readonly<Record<Locale, URL>> = {
  'en-US': new URL('../../skills/dsh-dev-workflow/SKILL.md', import.meta.url),
  'zh-CN': new URL('../../skills/dsh-dev-workflow/SKILL.zh.md', import.meta.url),
}

/** Body cache: two files, read at most once per process. */
const bodies = new Map<Locale, string>()

/**
 * Read a skill body with its YAML frontmatter removed. The registry wraps the
 * returned `content` in `<skill_content>` markup and carries name/description
 * separately, so leaving the frontmatter in would duplicate the header.
 * @param url - the skill file to read.
 * @returns the specification text without its frontmatter.
 */
async function readBody(url: URL): Promise<string> {
  const text = await readFile(url, 'utf8')
  const lines = text.split(/\r?\n/)
  if (lines[0]?.trim() !== '---') return text.trim()
  const close = lines.findIndex((line, index) => index > 0 && line.trim() === '---')
  if (close === -1) return text.trim()
  return lines
    .slice(close + 1)
    .join('\n')
    .trim()
}

/**
 * Build the skill provider.
 * @param options - the locale to serve and the translator for the catalog line.
 * @param options.currentLocale - read on every call, so a locale change applies
 *   to the next load without re-registering the provider.
 * @param options.t - translator for the catalog description.
 * @returns a provider serving exactly one skill in one language at a time.
 */
export function createSkillProvider(options: {
  currentLocale: () => Locale
  t: Translate
}): SkillProvider {
  const resourceBase = {
    kind: 'directory' as const,
    path: fileURLToPath(new URL('../../skills/dsh-dev-workflow/', import.meta.url)),
  }

  /**
   * The catalog entry. Its `description` is the resident line, so it is
   * recomputed per call to follow the active locale.
   * @returns the single candidate, or none while the plugin is off.
   */
  const candidate = (): SkillCandidate => ({
    name: SKILL_NAME,
    description: options.t('skill.summary'),
    invocation: { modelInvocable: true, userInvocable: true },
    source: 'bundled',
    provider: PROVIDER_NAME,
    resourceBase,
    rank: BUNDLED_SKILL_RANK,
    locator: BODIES,
  })

  return {
    name: PROVIDER_NAME,
    list: async () => [candidate()],
    get: async (): Promise<SkillDefinition | undefined> => {
      const locale = options.currentLocale()
      const entry = candidate()
      let content = bodies.get(locale)
      if (content === undefined) {
        content = await readBody(BODIES[locale])
        bodies.set(locale, content)
      }
      return {
        name: entry.name,
        description: entry.description,
        invocation: entry.invocation,
        source: entry.source,
        provider: entry.provider,
        resourceBase: entry.resourceBase,
        content,
      }
    },
  }
}

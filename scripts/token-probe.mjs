#!/usr/bin/env node
// The numbers in docs/TOKEN-BUDGET.md, measured rather than remembered.
//
// This used to be a probe that lived in `.dev-docs/`, which is gitignored: every
// reader of the document was told to run a file they do not have. The
// measurement is not secret, so the script belongs in the repository.
//
// Run `pnpm build` first: the resident footprint is what the built tool
// definitions carry, not what the TypeScript sources look like.

import { readFileSync } from 'node:fs'
import { createTranslator } from '../lib/i18n.js'
import { Config } from '../lib/config.js'
import { createCheckCommitMessageTool } from '../lib/tools/check-commit-message.js'
import { createCheckDocSyncTool } from '../lib/tools/check-doc-sync.js'

const root = new URL('../', import.meta.url)
const LOCALES = ['en-US', 'zh-CN']
const CJK = /[\u3000-\u303f\u3400-\u9fff\uff00-\uffef]/

/**
 * Rough token count for one string: CJK at one token per character, everything
 * else at four characters per token. A deliberately conservative upper bound —
 * the two locales land in the same band, which is the point of the comparison.
 * @param text - the string to estimate.
 * @returns the estimated token count.
 */
function estimate(text) {
  let cjk = 0
  let other = 0
  for (const char of text) {
    if (CJK.test(char)) cjk += 1
    else other += 1
  }
  return Math.ceil(other / 4) + cjk
}

/**
 * The resident footprint of one locale: what the two tool definitions and the
 * catalog line put into the context of every request.
 * @param locale - the locale to measure.
 * @returns the character counts, the combined text, and its estimate.
 */
function resident(locale) {
  const t = createTranslator(locale)
  const config = () => Config({})
  const tools = [
    createCheckCommitMessageTool({ t: () => t, config }),
    createCheckDocSyncTool({ t: () => t, config, git: () => undefined }),
  ]
  // Name, description and parameter schema: the parts a model can act on.
  const toolsText = tools
    .map((tool) => tool.name + tool.description + JSON.stringify(tool.parameters))
    .join('')
  const catalogText = `name: dsh-dev-workflow\ndescription: ${t('skill.summary')}`
  return {
    toolsChars: toolsText.length,
    catalogChars: catalogText.length,
    tokens: estimate(toolsText + catalogText),
  }
}

/**
 * Body size of a skill file with its frontmatter stripped, the way
 * `SkillProvider.get()` delivers it.
 * @param path - repository-relative path to the skill file.
 * @returns character and line counts of the body.
 */
function body(path) {
  const text = readFileSync(new URL(path, root), 'utf8')
  const lines = text.split(/\r?\n/)
  const close =
    lines[0]?.trim() === '---'
      ? lines.findIndex((line, index) => index > 0 && line.trim() === '---')
      : -1
  const kept = close === -1 ? lines : lines.slice(close + 1)
  const joined = kept.join('\n').trim()
  return { chars: joined.length, lines: joined.split('\n').length }
}

console.log('resident, every request')
for (const locale of LOCALES) {
  const measured = resident(locale)
  console.log(
    `  ${locale}: tools ${measured.toolsChars} + catalog ${measured.catalogChars} = ` +
      `${measured.toolsChars + measured.catalogChars} chars, ~${measured.tokens} tokens`,
  )
}

console.log('on demand, once per session')
for (const path of ['skills/dsh-dev-workflow/SKILL.md', 'skills/dsh-dev-workflow/SKILL.zh.md']) {
  const measured = body(path)
  console.log(`  ${path}: ${measured.chars} chars, ${measured.lines} lines`)
}

#!/usr/bin/env node
// Run a command only when src/ exists.
//
// During the staged rollout this repository intentionally ships no TypeScript
// source yet (see .dev-docs/PROGRESS.md). `tsc` exits with TS18003 when its
// include globs match nothing, which would make `pnpm build` / `pnpm typecheck`
// fail on a healthy checkout. This wrapper makes both a no-op in that state and
// a real run once src/ appears, identically on Windows and POSIX shells.
import { existsSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))

if (!existsSync(new URL('../src', import.meta.url))) {
  console.log('src/ does not exist yet - nothing to compile, skipping.')
  process.exit(0)
}

const [command, ...args] = process.argv.slice(2)
if (!command) {
  console.error('usage: node scripts/with-src.mjs <command> [args...]')
  process.exit(2)
}

const result = spawnSync(command, args, { cwd: root, stdio: 'inherit', shell: true })
process.exit(result.status ?? 1)

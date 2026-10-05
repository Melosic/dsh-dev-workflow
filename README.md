# dsh-dev-workflow

**English | [简体中文](README.zh.md)**

A development-workflow gatekeeper and orchestrator plugin for [DSH](https://github.com/deepseek-ai).

It is a plugin, not a mode. It does not try to become a fifth built-in DSH mode; it provides
workflow capabilities on top of the modes you already use.

## Features

- **Conventions as a skill, not as a lecture.** The full workflow spec lives in a skill that the
  model reads only when it needs details. What is always resident is a short summary — a few
  hundred tokens, not a few thousand.
- **Two tools for the checks that matter.**
  - `check_commit_message` — validates a commit message against Conventional Commits.
  - `check_doc_sync` — checks that documentation moved together with the code it describes.
- **A pre-commit trigger that stays quiet.** The plugin does nothing until you are about to
  commit. That is the one moment a workflow gatekeeper earns its keep.
- **git-guard.** Destructive git commands (force push, hard reset, `clean -f`, `branch -D`,
  rebase, `commit --amend`, `checkout -- .`) are intercepted before they run. Each operation
  defaults to `ask`, never to `allow`. A bare `--force` is reported with a suggestion to use
  `--force-with-lease` instead.
- **One switch.** `/dev-workflow` toggles between `on` (default) and `off`; `status` reports the
  mode, the locale, the last check, and how often the guards have spoken; `check` runs the
  workflow rules over the working tree on demand. Turning it `off` unregisters everything, so it
  costs nothing rather than merely staying quiet.

## Quick Start

```bash
# Clone and install
git clone https://github.com/Melosic/dsh-dev-workflow.git
cd dsh-dev-workflow
pnpm install

# Build and verify
pnpm build
pnpm typecheck
pnpm lint
pnpm test
```

Then install the plugin into your DSH profile. In a DSH session, use the plugin manager with the
absolute path to this package directory as the bundle target.

## Documentation

- [CHANGELOG.md](CHANGELOG.md) — release history, Keep a Changelog format.
- [CONTRIBUTING.md](CONTRIBUTING.md) — how to set up, branch, commit, and submit changes.
- [docs/TOKEN-BUDGET.md](docs/TOKEN-BUDGET.md) — what this plugin costs per request, and how to
  measure it again.
- [docs/TRIGGERS.md](docs/TRIGGERS.md) — when the plugin intervenes on its own, what it detects,
  and the limits of that detection.

Deeper reference documents (`docs/ARCHITECTURE.md`, `docs/CONFIGURATION.md`, `docs/TOOLS.md`,
`docs/SECURITY.md`, `docs/I18N.md`) are written as the corresponding
implementation phases land, so that they describe real behavior rather than guesses.

## Contributing

Contributions are welcome. Read [CONTRIBUTING.md](CONTRIBUTING.md) first — it covers branch
naming, commit conventions, the PR flow, and the internationalization rules that this repository
enforces in CI.

## License

[MIT](LICENSE) © 2026 Melosic

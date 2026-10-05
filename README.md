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

Then install the plugin into a DSH profile:

```bash
dsh plugin --profile <profile> add @melosic/dsh-dev-workflow
```

To install from a local checkout instead, point the plugin manager at this package directory.

## Documentation

- [docs/README.md](docs/README.md) — the documentation index: start here and pick a reading path.
- [CHANGELOG.md](CHANGELOG.md) — release history, Keep a Changelog format.
- [CONTRIBUTING.md](CONTRIBUTING.md) — how to set up, branch, commit, and submit changes.
- [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md) — the local loop, how the tests are organised, and
  what to touch when adding a rule.
- [docs/TOKEN-BUDGET.md](docs/TOKEN-BUDGET.md) — what this plugin costs per request, and how to
  measure it again.
- [docs/TRIGGERS.md](docs/TRIGGERS.md) — when the plugin intervenes on its own, what it detects,
  and the limits of that detection.
- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) — how the pieces fit together: exports, inject,
  registration ownership, and the data flow of one check.
- [docs/CONFIGURATION.md](docs/CONFIGURATION.md) — every configuration field, its default, and
  why that default.
- [docs/TOOLS.md](docs/TOOLS.md) — the tool and command contracts: names, arguments, returns,
  and every rule they enforce.
- [docs/I18N.md](docs/I18N.md) — how text is translated, how the locale is chosen, and why the
  approval prompt carries two languages.
- [docs/SECURITY.md](docs/SECURITY.md) — what the guard protects, what it deliberately does not
  do, and the division of labour with husky and branch protection.
- [docs/ADR/](docs/ADR/) — the decisions behind the design, and the alternatives that lost.
- [docs/PUBLISHING.md](docs/PUBLISHING.md) — the release checklist, the commands, and the
  `peerDependencies` rule that decides whether DSH will load the plugin at all.
- [ACKNOWLEDGEMENTS.md](ACKNOWLEDGEMENTS.md) — the upstream projects, official packages, and
  specifications this plugin is built on.

## Contributing

Contributions are welcome. Read [CONTRIBUTING.md](CONTRIBUTING.md) first — it covers branch
naming, commit conventions, the PR flow, and the internationalization rules that this repository
enforces in CI.

## License

[MIT](LICENSE) © 2026 Melosic

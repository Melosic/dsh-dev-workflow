# dsh-dev-workflow

**English | [简体中文](README.zh.md)**

A development-workflow gatekeeper and orchestrator plugin for [DSH](https://github.com/deepseek-ai/deepseek-harness).

It is a plugin, not a mode. It does not try to become a fifth built-in DSH mode; it provides
workflow capabilities on top of the modes you already use.

## Features

- **Conventions as a skill, not as a lecture.** The full workflow spec lives in a skill that the
  model reads only when it needs details. What is always resident is a short summary — a few
  hundred tokens, not a few thousand.
- **Two tools for the checks that matter.**
  - `check_commit_message` — validates a commit message against Conventional Commits.
  - `check_doc_sync` — checks that documentation moved together with the code it describes.
- **Three triggers that stay quiet until the moment matters.** The plugin does nothing while you
  write code. It speaks at the three points where a workflow gatekeeper earns its keep: before a
  commit (message, CHANGELOG, docs), before `gh pr create` (the title becomes the squash commit,
  plus a description with What / Why / How to verify), and before `git tag` or `npm publish`
  (SemVer, tag-versus-manifest, pre-releases off `latest`, a non-empty `[Unreleased]`). Each
  problem is raised once per session; ignoring it lets the action through.
- **git-guard.** Destructive git commands (force push, hard reset, `clean -f`, `branch -D`,
  rebase, `commit --amend`, `checkout -- .`) are intercepted before they run. Each operation
  defaults to `ask`, never to `allow`. A bare `--force` is reported with a suggestion to use
  `--force-with-lease` instead.
- **Four guards, one shape.** Beyond git, the plugin refuses what cannot be undone: irrecoverable
  shell commands (`rm -rf /`, `mkfs`, `dd of=/dev/sda`, fork bombs) at `ask` by default; reads of
  sensitive paths (`.env`, `*.pem`, `.ssh/id_rsa`, `secrets/`) at `deny`; and tool arguments
  carrying live credentials (AWS keys, GitHub and Slack tokens, private keys) at `deny`, reported
  by pattern name and never echoed back. What the guards decide is also written to a redacted
  audit log — credentials become `[REDACTED]`, sensitive paths keep only their file name.
- **One switch.** `/dev-workflow` toggles between `on` (default) and `off`; `status` reports the
  mode, the locale, the last check, how often the guards have spoken, and where the audit log
  goes; `check` runs the workflow rules over the working tree on demand. Turning it `off`
  unregisters everything, so it costs nothing rather than merely staying quiet.
- **A settings panel in DSH Settings.** Every switch and enum the plugin has — mode and locale, the
  commit rules, the documentation rules, the eight git policies, the command, file and secret
  guards, the audit log — is editable from one card, with a short note where the right choice is
  not obvious. Saving writes to the same source the file configuration is read from, and the plugin
  picks the change up without a restart. Paths, patterns and mappings stay read-only under
  **Advanced**, next to a button that opens the profile's `cordis.patch.yml`.

## Requirements

| Component | Version | Notes |
| --- | --- | --- |
| DSH runtime | `>=0.2.0-rc.1 <0.3.0` | Declared in `peerDependencies` and checked by DSH at load time. Check yours with `dsh --version`. |
| Node.js | `>=20` | The floor declared in `engines.node`, and the version CI runs on. |
| pnpm | `10.x` | Needed to build from source. `pnpm-lock.yaml` is committed; npm or yarn would resolve a different tree. |

**An unsupported DSH version does not fail the install — it disables the plugin.** DSH checks the
declared range while loading the profile, drops the plugin when it does not match, and prints
`disabling profile plugin <label>: <reason>` to stderr. The symptom is a plugin that is installed
but never appears, which is why the range is worth checking before you file a bug.
[docs/PUBLISHING.md](docs/PUBLISHING.md) explains how the range is chosen, and the per-profile
escape hatch if you are on a different DSH line.

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

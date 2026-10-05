# 更新日志

本文件记录 dsh-dev-workflow 的所有重要变更。

格式遵循 [Keep a Changelog 1.1.0](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循 [语义化版本 SemVer](https://semver.org/lang/zh-CN/)。

> **关于 0.x 阶段**：本项目尚处于 0.x 阶段，不保证向后兼容性。
> 按 SemVer 规范，MAJOR 位为 0 时，MINOR 位变更即可包含破坏性变更。
> 每个破坏性变更都会在本文件中显式标注 `BREAKING`。

## [Unreleased]

### Added

- 项目骨架：`package.json`、`tsconfig.json`、`cordis.patch.yml`、`.gitignore`、
  `.editorconfig`、`.gitattributes`。
- 工具链配置：ESLint 9 flat config、Prettier、Vitest。
- `scripts/with-src.mjs`：在 `src/` 尚不存在时跳过 `tsc`，使 `build` / `typecheck` 保持可跑通。
- `AGENTS.md`：面向 AI 编码工具的稳定规则（核心原则、关键约束、常用命令、详细规范入口）。
- 双语 README：`README.md`（英文）与 `README.zh.md`（中文）。
- `CONTRIBUTING.md`：环境搭建、分支命名、提交规范、PR 流程、国际化同步规则、安全操作规范。
- `LICENSE`：MIT。
- `locale/en.json` 与 `locale/zh.json`：面向用户的展示元数据与文本骨架，key 集合完全对齐。
- `scripts/ci-checks.mjs`：CI 守护，校验两个 locale 字典 key 一致，`cordis.patch.yml` 既被
  `dsh.bundle.patch` 声明又列入 `files`，以及两份 SKILL 文件的 frontmatter 合法且章节数量与层级顺序一致。
- `.github/workflows/ci.yml`：push 到 main 与 PR 时执行 install / typecheck / lint / format / test /
  build / locale 与 manifest 校验。
- commitlint（`commitlint.config.mjs`）与 husky 钩子：`commit-msg` 校验提交信息，
  `pre-commit` 对暂存文件跑 ESLint 与 Prettier。
- `skills/dsh-dev-workflow/SKILL.md` 与 `skills/dsh-dev-workflow/SKILL.zh.md`：完整开发工作流规范
  的双语单一事实源，共 9 个章节（核心原则、分支模型、提交信息规范、原子提交、PR 流程与质量门禁、
  文档同步工作流、版本发布、安全操作规范、自动触发时机）。两份文件的章节数量与层级顺序由 CI 校验。

### Changed

- 包名采用 `@melosic/dsh-dev-workflow`：`dsh-dev-workflow` 在 npm 上已被他人占用。
- 工具名不得使用 `:` 命名空间分隔符，只能包含 `[A-Za-z0-9_-]` 且不超过 64 字符
  （DeepSeek function-name 合同）。
- 国际化字典目录由 `locales/` 修正为 DSH 实际约定的单数 `locale/`，文件名为短语言 id
  （`locale/en.json`、`locale/zh.json`）。
- 技能正文目录由预留的 `assets/` 改为 `skills/dsh-dev-workflow/`：`@deepseek-ai/dsh-agent-preset`
  等官方包即采用 `skills/<name>/SKILL.md` 布局，且该路径由 `package.json` 的 `files` 发布。
- `ci.yml` 中关于 Node 版本矩阵的注释已修正：单版本是为控制审查节奏，而非私有仓库的 Actions
  分钟配额（仓库已转为 public，标准 runner 免费）。

### Security

- `peerDependencies` 对 DSH 域内包使用显式版本范围 `>=0.2.0-rc.1 <0.3.0`，不使用 `^` / `~`。

[Unreleased]: https://github.com/Melosic/dsh-dev-workflow/commits/main

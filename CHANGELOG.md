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
  的双语单一事实源，共 13 个章节（核心原则、分支模型、提交信息规范、原子提交、PR 流程与质量门禁、
  文档同步工作流、版本发布、CHANGELOG 维护、安全操作规范、自动触发时机等）。两份文件的章节数量
  与层级顺序由 CI 校验。
- 规范补充 14 处此前只能靠自觉的规则：分支保护与大小写约定、用 `git merge main` 保持最新的理由、
  Issue 引用写法、subject 语言、`BREAKING CHANGE:` 页脚精确格式、PR 粒度上限（200–400 行）、
  文档同步的五类豁免、`docs/` 只描述 main、发布后验证、预发布版本与 dist-tag、废弃与移除、
  回滚、72 小时撤回窗口，以及全新的「CHANGELOG 维护」整章（该写什么、不该写什么、怎么写、
  正反示例、何时写、依赖升级例外、破坏性变更）。
- 插件核心代码（`src/`，8 个文件）：`src/config.ts` 用 Schemastery 声明配置面（每个字段都带默认值），
  `src/i18n.ts` 用 `createRequire` 读取 locale 字典并以 `Intl.DateTimeFormat()` 解析 `auto`，
  `src/git.ts` 通过 `ctx.get('subprocess')` 的可选服务运行 git，`src/skills/provider.ts` 注册单一
  技能 `dsh-dev-workflow`（目录描述与正文都随当前 locale 动态返回），`src/index.ts` 是插件入口。
- 两个工具：`check_commit_message`（按 Conventional Commits 校验提交信息，并对过长标题、句尾句号、
  过宽正文、跨模块提交、缺少 scope 给出可忽略的软警告）与 `check_doc_sync`（成对文件只改一半时报错，
  代码变更未带文档或 CHANGELOG 条目时给警告）。
- `docs/TOKEN-BUDGET.md`：常驻 token 的实测数字与复算方法。实测常驻增量约 900 字符
  （工具定义 + 一行技能目录条目，约 200–250 token），规范全文只在模型主动读取技能时支付。
- `locale/en.json` 与 `locale/zh.json` 补齐两个工具的参数字典、错误码与软警告文案，共 40 个 key。
- 工作流规范补充 6 处：本地验证与 CI 的分工（本地是建议、CI 是硬门禁、本地通过不等于 CI 通过）、
  squash merge 的提交信息来源（squash 提交取 PR 标题，故 PR 标题必须符合 Conventional Commits）、
  hotfix 流程（从 `main` 切出、直接合回、条目写入 `[Unreleased]`）、冲突解决后必须重新跑
  typecheck / lint / test、CI 失败的处理（修根因而非改配置）、提交前扫描密钥模式且泄露后必须轮换密钥。
  SKILL 双语章节数由 26 增至 28。

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
- 双语 README 顶部的语言切换行改为普通文本行（不再使用引用块）：去掉指向当前语言自身的链接，
  当前语言的标签保留为纯文本，另一种语言仍为链接。`README.md` 显示
  `**English | [简体中文](README.zh.md)**`，`README.zh.md` 显示
  `**[English](README.md) | 简体中文**`。
- 双语 README 的文档链接列表去掉 `.dev-docs/` 一条：该目录仅存在于开发者本机、未纳入版本控制，
  对仓库读者没有意义。

### Security

- `peerDependencies` 对 DSH 域内包使用显式版本范围 `>=0.2.0-rc.1 <0.3.0`，不使用 `^` / `~`。

[Unreleased]: https://github.com/Melosic/dsh-dev-workflow/commits/main

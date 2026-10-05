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
- 贡献者规范 `CONTRIBUTING.md` 补充 4 节：依赖管理（固定 pnpm、锁文件入库、不混用包管理器）、
  版本号单一源（只在 `package.json` 维护，徽章与文档引用均派生）、忽略规则清单、测试规范
  （测试放 `tests/` 目录、命名与覆盖率要求）。
- `/dev-workflow` 命令：`on` / `off` 切换插件，`status` 报告当前模式、locale、
  最近一次检查结果与守卫命中次数，`check` 按工作流规则即时检查整个工作区。
  命令在 DSH 命令服务存在时注册，不存在时静默跳过。
- pre-commit 触发器（`src/triggers/pre-commit.ts`）：挂在 `tools/pre-execute` waterfall 上，
  当 agent 通过 `bash` / `pwsh` 工具执行 `git commit` 时，把提交信息检查、变更文件检查与
  `rules.requireChangelogOnFeat` 合起来跑一遍（`src/checks.ts`），命中问题时给出
  `ask` 提示。提示文案按客户端 locale 双语渲染，每一份都用对应语言的翻译器重新判定。
  先调用链上后面的门禁，只在它返回 `allow` 之后才自查，绝不改判上游的决定。
- 会话内去重状态（`src/state.ts`）：按 `${sessionId}:${checkType}:${targetId}` 记住已报告过的
  问题，同一会话同一问题只提示一次，跨会话允许重新提示；只存在内存中，不落盘。
- `docs/TRIGGERS.md`：触发器挂载的事件、判定一次「提交」的保守规则、检查内容、双语提示的
  渲染方式、去重状态模型，以及主路径的真实能力边界（含与 husky 的分工）。
- `locale/en.json` 与 `locale/zh.json` 补齐命令、触发器与 `feat` 提交强制 CHANGELOG 的文案，
  共 56 个 key。
- git-guard（`src/guard/git-guard.ts`）：第二个 `tools/pre-execute` 监听器，扫描危险 git 命令。
  识别 force push（含 `-f` 与 `+refspec`）、`reset --hard`、`rebase`、`commit --amend`、
  `branch -D`、`clean -f`、`checkout -- <path>` 与 `--no-verify`，按 `config.gitGuard` 决定
  `deny` / `ask` / `allow`。带 `--force-with-lease` 的推送放行，裸 `--force` 的提示里附带
  改用 `--force-with-lease` 的建议。多条规则同时命中时取最严的一条，绝不削弱上游更严的决定。
- 共用命令行解析层（`src/shell.ts`）：不跑 shell 的词法切分，处理引号与转义、按
  `&&` / `||` / `;` / `|` / 换行切段、跳过 `env` 与前导赋值、跳过 `-C` / `-c` / `--git-dir`
  等带值的全局选项，取出 `git` 子命令与参数。提交前检查与 git-guard 共用它。
- `config.gitGuard` 由 6 个字段扩为 9 个：新增 `cleanForce`、`checkoutDiscard` 与 `noVerify`。
  `cleanForce` 不复用 `hardReset`（`clean -f` 删未跟踪文件，与丢弃已跟踪文件的改动不是一回事）；
  `noVerify` 默认 `ask` 而非 `deny`，因为它是钩子出错时的逃生通道。
- `docs/ARCHITECTURE.md`：模块地图、具名导出与 `inject` 的选择、注册所有权的归属、
  一次检查的数据流与错误处理约定。
- `docs/CONFIGURATION.md`：全部配置字段与默认值，以及 `gitGuard` 三个不显然默认值的理由。
- `docs/TOOLS.md`：两个工具与 `/dev-workflow` 命令的合同、参数、返回结构，以及它们执行的每条规则。
- `docs/I18N.md`：字典读取与插值、`locale` 三取值与 `auto` 的解析时机、`displayReason`
  双语与中文键必须是字面 `zh`、`ci:checks` 的 key 对齐守护。
- `docs/SECURITY.md`：git-guard 保护什么、刻意不做什么（不读敏感文件、不联网、不落盘、
  不写日志文件），以及它与 husky、GitHub 分支保护的分工。
- `docs/ADR/template.md` 与两份架构决策记录：`001-skill-first-approach.md`（规范为什么放技能
  而不是系统提示）与 `002-plugin-not-preset.md`（为什么是插件而不是模式或预设），
  含被否决方案及其理由。
- 测试套件（`tests/`，7 个 spec + 1 个共享脚手架，共 107 个用例）：`register.spec.ts` 覆盖
  cordis 契约（具名导出、无 `default`、`inject`、注册与注销清单、工具定义形状）、
  `config.spec.ts` 覆盖每个默认值与校验报错、`i18n.spec.ts` 覆盖两份字典的 key 与占位符对齐
  及 `t()` 的分语言与回退、`impl.spec.ts` 覆盖两个判定函数与 `evaluate` 的阻塞/建议边界、
  `guard.spec.ts` 覆盖每条 git-guard 规则与三档策略、`trigger.spec.ts` 覆盖触发时机与去重、
  `skill-parity.spec.ts` 覆盖 SKILL 两份语言的标题数量与顺序。测试直接 import `../src/*.js`，
  由 Vitest 转译源码，不依赖 `lib/` 构建产物。
- `docs/DEVELOPMENT.md`：本地循环、目录职责、测试的组织方式与写测试时的约定、
  加一条新规则所需的完整改动清单、CI 的守卫范围，以及若干已知的坑。

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
- `src/checks.ts` 中的命令行词法解析（`tokenize` / `segments` / `git` 调用识别）与
  `commandOf` 提取到 `src/shell.ts`，供提交前检查与 git-guard 共用，避免两处各写一份
  会漂移的解析。`detectCommit` 相应简化为遍历 `gitInvocations()` 的结果。
- 双语 README 的文档链接列表改为指向已落地的参考文档（`docs/ARCHITECTURE.md`、
  `docs/CONFIGURATION.md`、`docs/TOOLS.md`、`docs/I18N.md`、`docs/SECURITY.md`、`docs/ADR/`），
  不再写「随阶段落地后再写」。

### Security

- `peerDependencies` 对 DSH 域内包使用显式版本范围 `>=0.2.0-rc.1 <0.3.0`，不使用 `^` / `~`。
- `config.gitGuard` 的全部策略项默认 `'ask'`，**没有任何一项默认 `'allow'`**；插件自身也不
  默认拒绝任何操作，`'deny'` 只由用户显式配置产生。守卫命中的诊断日志只记规则标识
  （字典 key），不记命令行全文与提交信息内容。

[Unreleased]: https://github.com/Melosic/dsh-dev-workflow/commits/main

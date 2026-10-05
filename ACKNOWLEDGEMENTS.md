# 致谢

dsh-dev-workflow 是一份薄薄的编排层。它的大部分价值来自别人的工作——宿主平台、微内核框架、
规范的作者，以及把 DSH 生态的形态测出来、让人不必重新猜一遍的先行者。

本文件按「真的用到了什么」分类，不含客套话。列在这里的每一项都能在仓库里找到对应的引用。

## 运行期依赖的上游

本插件的 `dependencies` 为空，运行期不依赖任何第三方包。下面这些是**宿主提供**的能力，
本包只通过 `peerDependencies` 声明兼容范围。

三个包都来自同一个 monorepo：[deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness)。
Cordis 与 Schemastery 是上游项目、被该 monorepo vendor 进来的（各自保留原作者署名）。

| 包 | 源目录 | 作者 | 许可证 | 本插件如何使用 |
| --- | --- | --- | --- | --- |
| `@deepseek-ai/dsh` | `apps/cli` | DeepSeek | MIT | 宿主平台本体：`tools` / `skills` / `commands` / `subprocess` 服务与 `tools/pre-execute` 门禁事件 |
| `@deepseek-ai/dsh-tools` | `packages/core/tools` | DeepSeek | MIT | `defineTool()` 与工具执行、门禁合同（`ToolExecution` / `PreToolDecision`）的类型来源 |
| `@deepseek-ai/dsh-skill` | `packages/skill/skill` | DeepSeek | MIT | 技能 provider 的注册合同（`list()` / `get()`、`locator`、`rank`） |
| `@deepseek-ai/cordis` | `vendor/cordis` | Shigma \<shigma10826@gmail.com\> | MIT | 微内核框架：`apply(ctx, config)` 插件模型、`ctx.inject`、`ctx.effect`、事件系统 |
| `@deepseek-ai/schemastery` | `vendor/schemastery` | Shigma \<shigma10826@gmail.com\> | MIT | `src/config.ts` 的配置面声明与默认值校验 |

三者都以 `peerDependencies` 声明（`@deepseek-ai/cordis` 用 `^4.0.4`，DSH 域内三个包用显式范围
`>=0.2.0-rc.1 <0.3.0`）。理由见 [docs/PUBLISHING.md](docs/PUBLISHING.md)。

## 作为实现范式被研读的官方包

`.dev-docs/DSH-API-NOTES.md` 是第 0 阶段的 API 核对结论。它不是猜出来的——结论来自逐字阅读
asar 内随宿主出货的官方包。这些包没有被引入依赖，但**本插件的每个关键写法都能在它们中间找到出处**：

| 官方包 | 借走的东西 |
| --- | --- |
| `@deepseek-ai/dsh-tool-bash` | 注册 disposer 的归属处理——服务持有的 disposer 用 `ctx.effect(() => once)` 重新绑定 |
| `@deepseek-ai/dsh-skill-badge` | `defineTool()` 的最小可抄范式；`src/skills/provider.ts` 的技能 provider 形状 |
| `@deepseek-ai/dsh-plan-mode` | 用 `ctx.get('subprocess')` + 本地结构接口读取无法静态解析的 peer 服务 |
| `@deepseek-ai/dsh-agent-preset` | `skills/<name>/SKILL.md` 的随包布局，以及 `files` 里声明 `skills/` 的官方先例 |
| `@deepseek-ai/dsh-commands` | 命令名约束 `^[a-z][a-z0-9_-]*$` 与 `register()` 的合同 |
| `@deepseek-ai/dsh-app-boot` | locale 字典的读取路径 `${specifier}/locale/en.json`；`peerDependencies` 兼容性校验的实际判定逻辑 |
| `@deepseek-ai/dsh-skill-filesystem`、`@deepseek-ai/dsh-skill-office` | 技能正文随包的两种官方布局（`skills/` 与 `assets/`），以及 `exports` 的官方写法 |

## 作为社区形态参照的项目

`package.json` 的形态（`type: module`、`main` / `types` / `exports`、`dsh.bundle.patch`、`files` 白名单）
在第 0 阶段通过比对社区已发布的插件确认过。**没有复制其中任何一行代码**，但它们证明了官方范式之外
确实有第三方走过一遍。

| 包 | 维护者 | 许可证 |
| --- | --- | --- |
| `dsh-qoder-connect` | masknull \<masknull@outlook.com\> | MIT |
| `dsh-approval-gate` | moon0930 \<1025504368@qq.com\> | MIT |

## 规范的作者

本插件的技能正文（[skills/dsh-dev-workflow/SKILL.md](skills/dsh-dev-workflow/SKILL.md)）在若干处
直接引用并转述下面的规范。它们定义了「什么是正确的提交信息」「什么是正确的版本号」「怎么记录变更」，
本插件只是把这些规则变成可执行的检查：

| 规范 | 作者 / 维护者 | 被引用之处 |
| --- | --- | --- |
| [Conventional Commits 1.0.0](https://www.conventionalcommits.org/) | Conventional Commits 社区 | `src/config.ts` 的 `rules.commitPattern` 与 `src/tools/check-commit-message.ts` 的全部规则 |
| [Semantic Versioning 2.0.0](https://semver.org/) | Tom Preston-Werner | SKILL.md 的「Releases」章、`package.json` 的 `0.1.0` |
| [Keep a Changelog 1.1.0](https://keepachangelog.com/) | Olivier Lacan | 本仓库的 [CHANGELOG.md](CHANGELOG.md) 与 SKILL.md 的「CHANGELOG Maintenance」整章 |

## 开发工具链

以下均为 `devDependencies`，不进入发布产物。

| 工具 | 许可证 | 用途 |
| --- | --- | --- |
| [TypeScript](https://www.typescriptlang.org/) | Apache-2.0 | 源码语言与类型检查 |
| [ESLint](https://eslint.org/) / [typescript-eslint](https://typescript-eslint.io/) | MIT | 静态检查 |
| [Prettier](https://prettier.io/) | MIT | 格式化 |
| [Vitest](https://vitest.dev/) | MIT | 测试运行器（`tests/` 的 107 个用例） |
| [Husky](https://typicode.github.io/husky/) | MIT | 本地 git 钩子 |
| [lint-staged](https://github.com/lint-staged/lint-staged) | MIT | 只对暂存文件跑 lint 与 format |
| [commitlint](https://commitlint.js.org/) | MIT | 提交信息校验（`@commitlint/config-conventional`） |
| [@types/node](https://github.com/DefinitelyTyped/DefinitelyTyped) | MIT | Node 内建模块的类型 |

## 说明

- 本文件**不包含**任何未实际使用的项目。若上表某项在后续版本里被移除，本文件应同步删除该行——
  一份声称感谢了某物、实际早已不用的致谢列表，比没有列表更糟。
- 任何遗漏都是本文件的缺陷而非上游的问题，欢迎提 issue 或 PR 补上。

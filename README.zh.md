# dsh-dev-workflow

**[English](README.md) | 简体中文**

DSH 的开发工作流守门员与编排器插件。

它是插件，不是模式。它不试图成为 DSH 内置的第五种模式，而是在你已经在用的模式之上提供工作流能力。

## 功能特性

- **规范以技能形式注入，而不是每轮说教。** 完整工作流规范放在技能里，模型只在需要细节时才去读。
  常驻的只有一段简短摘要——几百 token，而不是几千。
- **两个真正有用的检查工具。**
  - `check_commit_message` —— 按 Conventional Commits 校验提交信息。
  - `check_doc_sync` —— 检查文档是否与它描述的代码一起更新。
- **一个不打扰人的 pre-commit 触发器。** 在你要提交之前，插件什么都不做。
  提交前正是工作流守门员唯一值得开口的时刻。
- **git-guard 安全守卫。** 危险 git 命令（force push、hard reset、`clean -f`、`branch -D`、
  rebase、`commit --amend`、`checkout -- .`）会在执行前被拦截。
  每个操作的默认值都是 `ask`，绝不默认 `allow`。识别到裸 `--force` 时会提示改用 `--force-with-lease`。
- **一个开关。** `/dev-workflow` 在 `on`（默认）与 `off` 之间切换；`status` 报告当前模式、语言、
  最近一次检查结果与守卫开口的次数；`check` 按工作流规则即时检查整个工作区。
  关闭时会注销全部注册，因此它是「零成本」，而不只是「安静地不回答」。

## 快速开始

```bash
# 克隆并安装
git clone https://github.com/Melosic/dsh-dev-workflow.git
cd dsh-dev-workflow
pnpm install

# 构建与校验
pnpm build
pnpm typecheck
pnpm lint
pnpm test
```

然后把插件安装到你的 DSH profile：在 DSH 会话中用插件管理器，以本包目录的绝对路径作为 bundle 目标。

## 文档链接

- [CHANGELOG.md](CHANGELOG.md) —— 版本历史，Keep a Changelog 格式。
- [CONTRIBUTING.md](CONTRIBUTING.md) —— 环境搭建、分支、提交与提交流程。
- [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md) —— 本地循环、测试如何组织，以及加一条规则要动哪些文件。
- [docs/TOKEN-BUDGET.md](docs/TOKEN-BUDGET.md) —— 本插件每条请求的成本，以及如何复算它。
- [docs/TRIGGERS.md](docs/TRIGGERS.md) —— 插件什么时候自动介入、识别什么，以及识别的边界。
- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) —— 各模块如何拼在一起：具名导出、`inject`、
  注册的所有权归属，以及一次检查的数据流。
- [docs/CONFIGURATION.md](docs/CONFIGURATION.md) —— 每一个配置字段、它的默认值，以及为什么是这个默认值。
- [docs/TOOLS.md](docs/TOOLS.md) —— 工具与命令的合同：名字、参数、返回，以及它们执行的每一条规则。
- [docs/I18N.md](docs/I18N.md) —— 文本如何翻译、语言如何选择，以及审批提示为什么带两种语言。
- [docs/SECURITY.md](docs/SECURITY.md) —— 守卫保护什么、刻意不做什么，以及它与 husky
  和分支保护的分工。
- [docs/ADR/](docs/ADR/) —— 设计背后的决策，以及被否决的方案。

## 贡献指引

欢迎贡献。请先读 [CONTRIBUTING.md](CONTRIBUTING.md)——其中说明了分支命名、提交规范、PR 流程，
以及本仓库会在 CI 中强制执行的国际化规则。

## 许可证

[MIT](LICENSE) © 2026 Melosic

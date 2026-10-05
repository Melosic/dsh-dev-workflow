# dsh-dev-workflow

> **[English](README.md) | [简体中文](README.zh.md)**

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
- **一个开关。** `/dev-workflow` 在 `on`（默认）与 `off` 之间切换。
  没有第三档：如果需要靠自己去记得改设置，这个设计本身就已经失败了。

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
- `.dev-docs/` —— 仅本机的开发笔记（未纳入版本控制）。

更深入的参考文档（`docs/ARCHITECTURE.md`、`docs/CONFIGURATION.md`、`docs/TOOLS.md`、
`docs/TRIGGERS.md`、`docs/SECURITY.md`、`docs/I18N.md`、`docs/TOKEN-BUDGET.md`）会随对应阶段落地后再写，
这样它们描述的是真实行为，而不是猜测。

## 贡献指引

欢迎贡献。请先读 [CONTRIBUTING.md](CONTRIBUTING.md)——其中说明了分支命名、提交规范、PR 流程，
以及本仓库会在 CI 中强制执行的国际化规则。

## 许可证

[MIT](LICENSE) © 2026 Melosic

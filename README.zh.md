# dsh-dev-workflow

**[English](README.md) | 简体中文**

[DSH](https://github.com/deepseek-ai/deepseek-harness) 的开发工作流守门员与编排器插件。

它是插件，不是模式。它不试图成为 DSH 内置的第五种模式，而是在你已经在用的模式之上提供工作流能力。

## 功能特性

- **规范以技能形式注入，而不是每轮说教。** 完整工作流规范放在技能里，模型只在需要细节时才去读。
  常驻的只有一段简短摘要——几百 token，而不是几千。
- **两个真正有用的检查工具。**
  - `check_commit_message` —— 按 Conventional Commits 校验提交信息。
  - `check_doc_sync` —— 检查文档是否与它描述的代码一起更新。
- **三个只在关键时刻开口的触发器。** 写代码时插件什么都不做，只在三处拦一下：
  提交前（提交信息、CHANGELOG、文档同步）、`gh pr create` 前（标题在 squash merge 后会成为
  提交信息，描述需有 What / Why / How to verify 三段）、`git tag` 或 `npm publish` 前
  （SemVer、tag 与 manifest 是否一致、预发布不能推 `latest`、`[Unreleased]` 不能为空）。
  每个问题在一个会话里只提示一次；忽略之后动作照常执行。
- **git-guard 安全守卫。** 危险 git 命令（force push、hard reset、`clean -f`、`branch -D`、
  rebase、`commit --amend`、`checkout -- .`）会在执行前被拦截。
  每个操作的默认值都是 `ask`，绝不默认 `allow`。识别到裸 `--force` 时会提示改用 `--force-with-lease`。
- **四道守卫，一个形状。** 除了 git，插件还挡住收不回来的事：不可逆的 shell 命令
  （`rm -rf /`、`mkfs`、`dd of=/dev/sda`、fork 炸弹）默认 `ask`；读取敏感路径
  （`.env`、`*.pem`、`.ssh/id_rsa`、`secrets/`）直接 `deny`；调用参数里带着真实凭据
  （AWS key、GitHub 与 Slack token、私钥）同样 `deny`，且只报模式名、绝不回显。
  守卫的判定还会写进脱敏后的审计日志——凭据变成 `[REDACTED]`，敏感路径只留文件名。
- **一个开关。** `/dev-workflow` 在 `on`（默认）与 `off` 之间切换；`status` 报告当前模式、语言、
  最近一次检查结果、守卫开口的次数，以及审计日志的落点；`check` 按工作流规则即时检查整个工作区。
  关闭时会注销全部注册，因此它是「零成本」，而不只是「安静地不回答」。
- **DSH 设置里的可视化面板。** 插件所有的开关与枚举——模式与语言、提交规范、文档同步规则、八个
  git 策略、命令/文件/密钥三道守卫、审计日志——都在同一张卡片里修改，不易抉择的项旁边附一句说明。
  保存会写进文件配置所读的同一份来源，插件无需重启即可生效。路径、正则与映射只读展示在
  **高级**区，旁边有按钮直接打开当前 profile 的 `cordis.patch.yml`。

## 环境要求

| 组件 | 版本 | 说明 |
| --- | --- | --- |
| DSH 运行时 | `>=0.2.0-rc.1 <0.3.0` | 声明在 `peerDependencies` 里，由 DSH 在加载时校验。用 `dsh --version` 查看本机版本。 |
| Node.js | `>=20` | `engines.node` 声明的下限，也是 CI 实际跑的版本。 |
| pnpm | `10.x` | 从源码构建时需要。`pnpm-lock.yaml` 已入库，换成 npm 或 yarn 会解析出不同的依赖树。 |

**DSH 版本不在支持范围内，不会让安装失败——它会把这个插件禁用掉。** DSH 在加载 profile 时
校验上面声明的范围，不匹配就把插件丢掉，并在 stderr 打印
`disabling profile plugin <label>: <reason>`。症状是「装上了但从来不出现」，
所以报 bug 之前值得先对一下版本。[docs/PUBLISHING.md](docs/PUBLISHING.md) 说明了范围的选取依据，
以及你确实在另一条 DSH 版本线上时，按 profile 开的那个应急口子。

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

然后把插件安装到你的 DSH profile：

```bash
dsh plugin --profile <profile> add @melosic/dsh-dev-workflow
```

若想从本地检出安装，把插件管理器指向本包目录即可。

## 文档链接

- [docs/README.md](docs/README.md) —— 文档索引：从这里挑一条阅读路径。
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
- [docs/PUBLISHING.md](docs/PUBLISHING.md) —— 发布前的检查清单、实际命令，以及决定 DSH
  会不会加载本插件的 peerDependencies 规则。
- [ACKNOWLEDGEMENTS.md](ACKNOWLEDGEMENTS.md) —— 本插件所依赖的上游项目、官方包与规范。

## 贡献指引

欢迎贡献。请先读 [CONTRIBUTING.md](CONTRIBUTING.md)——其中说明了分支命名、提交规范、PR 流程，
以及本仓库会在 CI 中强制执行的国际化规则。

## 许可证

[MIT](LICENSE) © 2026 Melosic

# dsh-dev-workflow

**[English](README.md) | 简体中文**

面向编码 Agent 的一套开发工作流，以 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)
（`dsh`）插件的形式分发：一份按需读取的规范，负责执行其中可机械检查部分的两件工具与三个
触发器，以及守住不可撤销动作、或不该在你点头之前就对外宣称的动作的几道守卫。它是插件，
不是模式——在你已经在用的模式之上工作。

## 为什么需要它

每个项目都有一套开发工作流：分支怎么起名、提交信息怎么写、文档什么时候跟着代码改、发版前必须
满足什么。写下来，这些约定就躺在贡献者指南里，在该用的那一刻没人会去翻——Agent 尤其不会；
不写下来，就得每个会话重说一遍，而且会漂移。

这个插件把这套规范变成 Agent 随身带着、工具负责执行的东西。整套流程——分支模型、提交信息
格式、原子提交、PR 质量门禁、文档同步、发版与 CHANGELOG 规则——以技能形式随包分发、按需读取，
该用的时刻就在手边，又不必每轮常驻。能机械检查的替你检查；不能撤销的先拦下，
其他人会看见、而你还没点头的也先问过。它只在这些时刻说话，其余时候不吭声。

## 功能特性

- **规范以技能形式按需读取，而不是每轮说教。** 常驻的只有一段几百 token 的摘要。
- **两个检查工具。** `check_commit_message` 校验提交信息，`check_doc_sync` 检查文档是否跟着代码一起改。
- **三个触发器，平时不吭声：** 提交前、`gh pr create` 前、`git tag` 或发布前。
- **五道守卫，一个形状。** 不可逆的 shell 命令、危险的 git 操作、其他人看得见的对外动作、敏感文件读取、参数里的真实凭据。
- **一个开关，而且是安装开关。** `/dev-workflow status` 报告模式、语言、最近一次检查与守卫命中；`off` 会把注册全部注销。
- **DeepSeek Harness 设置里的可视化面板**，所有开关与枚举都能改，保存后无需重启。

## 环境要求

| 组件 | 版本 |
| --- | --- |
| DeepSeek Harness 运行时 | `>=0.2.0-rc.2` |
| Node.js | `>=20` |
| pnpm | `10.x` |

**DeepSeek Harness 版本不在支持范围内，不会让安装失败——它会把这个插件静默禁用**，症状是
「装上了但从来不出现」。报 bug 之前先用 `dsh --version` 对一下上面的版本范围；
[docs/PUBLISHING.md](docs/PUBLISHING.md) 说明了范围怎么定，以及按 profile 开的那个应急口子。

## 快速开始

```bash
dsh plugin --profile <profile> add @melosic/dsh-dev-workflow
```

请用 DSH 的安装器，而不是 `npm install`：profile 只会加载自己 `dsh.profile.bundles` 列表里
点名的组合包，而安装器负责同时写依赖和这个条目。

在 DeepSeek Harness 里执行 `/dev-workflow status` 确认它真的在工作——它会打印模式、语言、
最近一次检查、守卫命中次数与审计日志状态。像 `git clean -f` 这类该被拦下的动作不会不问就跑：
它会先问你，在关掉审批的会话里则直接拒绝。

想开发插件本身，见 [CONTRIBUTING.md](CONTRIBUTING.md)。

## 文档链接

- [docs/README.md](docs/README.md) —— 全部文档的索引：从这里挑一条阅读路径。
- [CHANGELOG.md](CHANGELOG.md) —— 版本历史，Keep a Changelog 格式。
- [CONTRIBUTING.md](CONTRIBUTING.md) —— 环境搭建、分支、提交与提交流程。

## 贡献指引

欢迎贡献——请先读 [CONTRIBUTING.md](CONTRIBUTING.md)。

## 许可证

[MIT](LICENSE) © 2026 Melosic

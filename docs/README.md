# 文档索引

本目录是 dsh-dev-workflow 的深度文档。本文件是它们的入口——**新增文档时必须在这里登记**，
否则文档就等于不存在。下面是本目录的全部内容，一份都不少。

读者分四类，按「你现在想干什么」挑：

## 我想用这个插件

| 文档 | 内容 |
| --- | --- |
| [../README.md](../README.md) | 项目简介、功能特性、**环境要求**、安装与快速开始（英文） |
| [../README.zh.md](../README.zh.md) | 同上（中文） |
| [CONFIGURATION.md](CONFIGURATION.md) | 每一个配置字段、默认值，以及**为什么是这个默认值** |
| [TOOLS.md](TOOLS.md) | 两个工具与 `/dev-workflow` 命令的合同：名字、参数、返回、执行的每条规则 |
| [TRIGGERS.md](TRIGGERS.md) | 插件什么时候自动介入、识别什么，以及识别的真实边界 |
| [I18N.md](I18N.md) | 文本如何翻译、语言如何选择，以及审批提示为什么带两种语言 |
| [TOKEN-BUDGET.md](TOKEN-BUDGET.md) | 常驻 token 的实测数字与复算方法 |

## 我想贡献代码

| 文档 | 内容 |
| --- | --- |
| [../AGENTS.md](../AGENTS.md) | 稳定规则清单（AI 编码工具与协作者共用）。**先读这个** |
| [../CONTRIBUTING.md](../CONTRIBUTING.md) | 环境搭建、分支、提交、PR 流程、国际化同步规则的展开版 |
| [DEVELOPMENT.md](DEVELOPMENT.md) | 本地循环、目录职责、测试怎么组织、加一条新规则要动哪些文件、CI 会拦住什么 |
| [ARCHITECTURE.md](ARCHITECTURE.md) | 具名导出与 `inject` 的选择、注册所有权的归属、一次检查的数据流 |
| [../ACKNOWLEDGEMENTS.md](../ACKNOWLEDGEMENTS.md) | 运行期与开发期实际用到的上游工作，按「真的用到了什么」分类 |

## 我想发一个版本

| 文档 | 内容 |
| --- | --- |
| [PUBLISHING.md](PUBLISHING.md) | 发布前检查清单（含 bundle manifest 完整性）、DSH peerDependencies 分段枚举规则、发布命令与验证、撤回与废弃（含 0.x 阶段的撤回策略） |
| [../CHANGELOG.md](../CHANGELOG.md) | 版本历史，Keep a Changelog 格式 |

## 我想知道为什么这样设计

| 文档 | 内容 |
| --- | --- |
| [SECURITY.md](SECURITY.md) | 守卫保护什么、刻意不做什么、与 husky 和分支保护的分工 |
| [ADR/](ADR/) | 架构决策记录。已接受五份：规范为什么放技能、为什么是插件而不是模式、为什么常驻摘要 + 按需全文、为什么不靠手动切档、为什么需要 `AGENTS.md` |
| [ADR/001-skill-first-approach.md](ADR/001-skill-first-approach.md) | 规范全文放技能，不放系统提示——省的是每轮的常驻成本 |
| [ADR/002-plugin-not-preset.md](ADR/002-plugin-not-preset.md) | 做成插件，而不是模式或预设——安装面、正交性、可卸载性 |
| [ADR/003-summary-plus-on-demand.md](ADR/003-summary-plus-on-demand.md) | 常驻的只有一行目录条目与两个工具定义，规范全文按需读——token 成本的算法 |
| [ADR/004-action-triggered-not-manual-mode.md](ADR/004-action-triggered-not-manual-mode.md) | 按动作自动触发，不让用户手动切档——**手动切档失败过：用户会忘记切** |
| [ADR/005-agents-md-as-context-anchor.md](ADR/005-agents-md-as-context-anchor.md) | `AGENTS.md` 与 `SKILL.md` 的分工——每轮都要成立的规则 vs 做事时才读的规范 |
| [ADR/template.md](ADR/template.md) | 写新 ADR 时的模板（含「什么才值得写一份 ADR」的门槛） |

## 完整工作流规范

[../skills/dsh-dev-workflow/SKILL.md](../skills/dsh-dev-workflow/SKILL.md)（英文）/
[../skills/dsh-dev-workflow/SKILL.zh.md](../skills/dsh-dev-workflow/SKILL.zh.md)（中文）
是本插件分发的规范全文——分支模型、提交信息、原子提交、PR 与质量门禁、文档同步、
版本发布、CHANGELOG 维护、安全操作、自动触发时机。它与本目录的关系是：

- **SKILL 是规范本身**，面向任何安装本插件的 DSH 用户，随包发布。
- **`docs/` 是这个仓库自己的工程文档**，面向本仓库的贡献者，不随包发布
  （`package.json` 的 `files` 白名单里没有 `docs/`）。

两份 SKILL 的章节数量与顺序由 `pnpm ci:checks` 强制一致。

## 文档的写作约定

- `docs/` 深度文档**单语中文**。原因见 [../CONTRIBUTING.md](../CONTRIBUTING.md)：
  面向用户的短文本双语，面向贡献者的长文档单语——把每一份长文档都翻译一遍，
  成本会落在最不该花的读者身上。
- 面向用户的运行时文本走 `t()`，双语放在 `locale/en.json` 与 `locale/zh.json`。
- 描述**当前 `main` 的状态**，不写「计划中」的功能。未实现的东西不是文档，是愿望。
- 改了行为就同 PR 改文档。`check_doc_sync` 会在代码变更没带上文档或 CHANGELOG 条目时给出警告，
  成对文件（README 双语、locale 双语、SKILL 双语）只改一半时则是**阻塞性错误**；
  翻译正确性与「文档是否说清楚了」是人工审查项，CI 不替你判断。

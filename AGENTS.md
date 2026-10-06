# AGENTS.md

本文件是本仓库的稳定规则，供 AI 编码工具与协作者共同遵守。
本文件不记录进度状态；进度见 `.dev-docs/PROGRESS.md`（仅本机，未纳入版本控制）。

## 项目一句话

dsh-dev-workflow 是 DSH 的开发工作流守门员与编排器插件。
它是插件，不是模式。

## 核心原则

- 按规范开发，从这个插件能跑起来起就用它检查自己。
- 插件而非模式：不试图成为 DSH 内置的第五种模式，而是在现有模式中提供工作流能力。
- 安全默认，显式确认，最小权限。
- 按动作自动触发，不靠用户手动切档。
- 常驻摘要 + 按需全文，token 成本可控：常驻增量控制在几百 token 量级。
- 技能注入为主，工具调用为辅，事件监听极简。
- 平时安静，只在关键节点自动介入。
- 面向用户的短文本双语，面向贡献者的长文档单语。
- 原子提交是推荐实践，不是强制拦截。

## 关键约束

- 分支命名：`feature/*`、`fix/*`、`docs/*`、`hotfix/*`（GitHub Flow）。
- 提交信息：Conventional Commits，由 commitlint 在提交时校验。
- 文档与代码同 PR 更新。
- CHANGELOG 的 `[Unreleased]` 段常驻顶部。
- 改 `README.md` 必须同步改 `README.zh.md`。
- 改 `locale/en.json` 必须同步改 `locale/zh.json`（DSH 约定目录为单数 `locale/`，短语言 id）。
- 改 `skills/dsh-dev-workflow/SKILL.md` 必须同步改 `skills/dsh-dev-workflow/SKILL.zh.md`，章节数量与层级顺序一致。
- 代码注释用英文；用户可见文本一律走 `t()`，不得硬编码。
- 敏感文件不得读取，密钥不得硬编码。
- 包为 ESM-only：`"type": "module"`，源码必须使用 ESM 语法。
- 工具名只能包含 `[A-Za-z0-9_-]` 且不超过 64 字符（DeepSeek function-name 合同），
  不得使用 `:` 等命名空间分隔符。
- DSH 插件 API 以本机实际版本为准；核对结论见 `.dev-docs/DSH-API-NOTES.md`。

## 常用命令

```bash
pnpm install        # 安装依赖
pnpm build          # 编译 TypeScript 到 lib/
pnpm typecheck      # 仅类型检查，不产出
pnpm lint           # ESLint
pnpm format         # Prettier 写入
pnpm test           # Vitest 单次运行
pnpm test:watch     # Vitest 监听模式
```

## 详细规范入口

- 完整开发提示词：`.dev-docs/prompt.md`
- 当前进度：`.dev-docs/PROGRESS.md`
- API 核对结论：`.dev-docs/DSH-API-NOTES.md`
- 文档索引：`docs/README.md`
- 完整工作流规范：`skills/dsh-dev-workflow/SKILL.md`（英文）/ `skills/dsh-dev-workflow/SKILL.zh.md`（中文）
- 架构说明：`docs/ARCHITECTURE.md`
- 开发指引：`docs/DEVELOPMENT.md`
- 配置参考：`docs/CONFIGURATION.md`
- 工具参考：`docs/TOOLS.md`
- 国际化策略：`docs/I18N.md`
- 触发策略：`docs/TRIGGERS.md`
- Token 预算：`docs/TOKEN-BUDGET.md`
- 安全策略：`docs/SECURITY.md`
- 发布指引：`docs/PUBLISHING.md`
- 贡献指引：`CONTRIBUTING.md`

`.dev-docs/` 为本机私有目录，已被 `.gitignore` 忽略，克隆仓库后不一定存在。

## 多 AI 工具协同

`AGENTS.md` 是唯一主文件。若需供其他工具（如 Claude Code）使用，
用软链接或构建脚本同步 `CLAUDE.md` 等副本，不要手动维护多份。

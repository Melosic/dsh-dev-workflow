# 贡献指引

感谢你愿意为 dsh-dev-workflow 花时间。本文说明本仓库的协作规则——不只是「怎么做」，
还有「为什么这样做」，因为规则背后的理由决定了它什么时候该被修改。

在动手之前，请先读 [`AGENTS.md`](AGENTS.md)：那是本仓库的稳定规则清单。
本文是它的展开版本。

## 环境搭建

**要求**

- Node.js >= 20（`engines.node` 声明的下限；CI 目前只跑 Node 20）
- pnpm 10.x

**步骤**

```bash
git clone https://github.com/Melosic/dsh-dev-workflow.git
cd dsh-dev-workflow
pnpm install
```

**常用命令**

| 命令 | 作用 |
|---|---|
| `pnpm build` | 把 `src/` 编译到 `lib/`（`src/` 不存在时会自动跳过） |
| `pnpm typecheck` | 只做类型检查，不产出 |
| `pnpm lint` | ESLint |
| `pnpm lint:fix` | ESLint 自动修复 |
| `pnpm format` | Prettier 写入 |
| `pnpm format:check` | Prettier 校验（CI 用） |
| `pnpm test` | Vitest 单次运行 |
| `pnpm test:watch` | Vitest 监听模式 |

**⚠️ 关于 `target` 与 `engines.node`**

`tsconfig.json` 的 `target` / `lib` 锁定 `ES2022`，与 `engines.node: ">=20"` 一致。
**声明支持 Node 20 就不能使用 Node 22 才有的 API。** 要升级 `target`，
必须同时提升 `engines.node`，并把 CI 矩阵改为对应版本。

**⚠️ 关于依赖版本锁定**

`lint-staged` 锁 `^15.5.2`、`@commitlint/*` 锁 `^19.8.1`，**不能升到 latest**：
`lint-staged@17` 要求 Node >= 22.22.1，`@commitlint/*@21` 要求 Node >= 22.12.0，
两者都会破坏 Node 20 支持。升级这些依赖时必须同步提升 `engines.node`。

## 依赖管理

- 包管理器固定为 **pnpm**，不使用 npm，也不使用 yarn。
- `pnpm-lock.yaml` 提交到仓库；`node_modules/` 不提交。
- **不要混用包管理器。** `npm install` 或 `yarn add` 会写出与本仓库无关的锁文件，
  让下一个人装出不同的依赖树。
- 安装运行时依赖用 `pnpm add <pkg>`，安装开发依赖用 `pnpm add -D <pkg>`，
  升级依赖用 `pnpm update`。

## 版本号

- 版本号**只在 `package.json` 的 `version` 字段维护**，这是唯一来源。
- 需要展示版本号的地方（README 徽章、文档里的版本引用）都从它派生，不硬编码字面量。
- 理由：版本号散落在多处时，总有一处会先过期，而「哪一处是权威」也会随之变得模糊。

## 忽略规则（`.gitignore`）

必须包含以下条目：

- `node_modules/`
- `lib/`
- `dist/`
- `.dev-docs/`
- `*.log`
- `.DS_Store`

构建产物、编辑器临时文件、本机开发文档都不进版本控制。

## 分支命名

采用 GitHub Flow，只使用以下前缀：

| 前缀 | 用途 | 示例 |
|---|---|---|
| `feature/` | 新功能 | `feature/commit-message-tool` |
| `fix/` | 缺陷修复 | `fix/guard-false-positive` |
| `docs/` | 仅文档 | `docs/contributing-guide` |
| `hotfix/` | 紧急修复 | `hotfix/release-blocker` |

`main` 分支受保护：禁止直接 push，必须通过 PR 合并，且必须 CI 通过。

## 提交规范

提交信息遵循 [Conventional Commits](https://www.conventionalcommits.org/zh-hans/)，
由 commitlint 在提交时校验。

```
<type>(<scope>): <subject>

[optional body]

[optional footer]
```

**允许的 type**：`feat`、`fix`、`docs`、`style`、`refactor`、`perf`、`test`、
`build`、`ci`、`chore`、`revert`。

**示例**

```
feat(tools): add check_doc_sync tool
fix(guard): stop treating --force-with-lease as dangerous
docs(readme): document the /dev-workflow command
```

### 原子提交是推荐，不是强制

本项目鼓励一个提交做一件事、能独立通过测试、能独立回滚。但这是**推荐实践而非拦截规则**——
当一次拆分会让历史更难理解时，宁可要一个完整的提交，也不要三个互相依赖的半成品。
工具不会因为你提交得不够原子而拒绝你，只会因为提交信息不合规范而拒绝你。

## PR 流程

1. 从最新的 `main` 切出符合命名规范的分支。
2. 提交前本地跑通：`pnpm lint && pnpm typecheck && pnpm test && pnpm format:check`。
3. 推送分支并开 PR，说明动机（为什么）与做法（是什么），而不只是列出改了哪些文件。
4. 等待 CI 通过。CI 会校验：typecheck、lint、test、构建、locale key 对齐、
   `cordis.patch.yml` 存在于 `files` 字段。
5. 合并策略：**squash merge**，保持 `main` 历史线性、每个合并对应一个完整意图。

### 文档与代码同 PR

代码改了，描述它的文档要在同一个 PR 里改。理由：拆成两个 PR 时，
第二个 PR 几乎总会因为「代码已经能跑了」而被搁置，文档就此腐烂。

具体对应关系：

| 改动 | 必须同步 |
|---|---|
| `README.md` | `README.zh.md` |
| `locale/en.json` | `locale/zh.json` |
| `skills/dsh-dev-workflow/SKILL.md` | `skills/dsh-dev-workflow/SKILL.zh.md`（章节数量与层级顺序一致） |
| 行为/配置变化 | `CHANGELOG.md` 的 `[Unreleased]` 段 |

## 代码风格

- 格式由 Prettier 决定（`semi: false`、`singleQuote: true`、`printWidth: 100`），不要手工争辩。
- 规则由 ESLint 9 flat config 决定。
- **代码注释用英文。**
- **用户可见文本一律走 `t()`，不得硬编码**（见下节）。
- 路径处理用 `node:path` / `node:url`，不要拼接正斜杠字符串——本项目的开发环境包含 Windows。
- 包为 ESM-only，源码必须使用 ESM 语法（`import` / `export`，无 `require`）。

## 测试

- 测试文件放在 **`tests/` 目录下**（`tsconfig.json` 已把 `**/*.test.ts` 排除在构建之外）。
- 命名：`describe` 用被测模块名，`it` 用行为描述。
- 覆盖率建议 ≥ 80%，新代码优先。
- 新功能、修 bug、重构都需要补测试；纯文档、纯配置变更不需要。

测试名用英文、描述行为而非实现：

```ts
// ✅ 好：描述可观察的行为
it('rejects a commit message without a type prefix', () => {})

// ❌ 差：描述内部实现
it('returns false from checkCommitMessage', () => {})
```

每个非平凡逻辑至少留一个最小可运行检查——一个能捕获破坏的断言就够，
不引入框架或夹具，除非确实需要。

## 国际化同步规则

本插件有两套彼此独立的 i18n 机制，不要混淆：

### 1. 插件展示元数据 —— `locale/*.json`

用于 Plugin Manager / Settings 里显示的插件标题与描述。
DSH 约定目录是**单数 `locale/`**，文件名是**短语言 id**：

```
locale/en.json
locale/zh.json
```

内容形态：

```json
{
  "meta": {
    "title": "Dev Workflow",
    "description": "..."
  }
}
```

**硬性约束**（由 DSH 加载实现决定）：

- 所有语言文件**必须与 `en.json` 同目录**，否则加载器报
  `... must share the English locale directory ...`。
- 语言 id 不得重复。
- `locale/*.json` **必须写进 `package.json` 的 `exports`**，否则会被静默忽略，
  表现为插件在设置面板里没有标题和描述——这类问题没有任何报错，只能靠知道这条规则来避免。

### 2. 运行时 UI 文本 —— client 侧字典

面向用户的短文本走客户端 `dsh-client-locale` 的 `ctx.locale.register(ns, { zh, en })`。
**两个 shipped locale 都必须提供每个 key**；插件提供的全部 key 必须与 namespace 的
typed key union 对应。

### CI 校验的边界

CI **只校验 key 对齐**（两个字典的 key 集合完全一致），不校验翻译正确性。
**翻译正确性是人工审查项**——一条 key 对齐但语义翻错的字符串，CI 不会有任何意见。
PR 审查时请把翻译质量当作真实审查内容，而不是走过场。

## 按规范开发（第一到第三阶段）

本项目在开发自己的过程中遵守自己将要强加的规范。这不是仪式感，
而是唯一能在发布前发现规范是否可用的办法。

- **第一阶段（项目初始化）**：建立仓库、文档、CI、Git Hooks。
- **第二阶段（SKILL.md）**：写出插件的完整工作流规范正文。
- **第三阶段（插件核心代码）**：实现工具、触发器与 git-guard。
- **第三阶段完成后**：补齐 `docs/ARCHITECTURE.md`、`docs/TOOLS.md`、`docs/CONFIGURATION.md`、
  `docs/I18N.md`、`docs/SECURITY.md`。

分期到此为止：后续工作（测试、发布准备、设置面板等）不再编号，也不要用编号去引用
某一份文档或某一条决定——那些分期只在本机、不随仓库发布。需要标注一份 ADR 的时间，
写日期，不写「第几阶段」（见 `docs/ADR/template.md`）。

## 吃自己的狗粮（第四、第五阶段）

- **第四阶段（测试）**：开始用本插件检查本插件自己的提交。
- **第五阶段（发布准备）**：用本插件的规范检查发布流程所需的文档与提交信息。

一旦进入第四阶段，提交前如果本插件的 git-guard 或 commit 检查报了问题，
**先修问题，而不是先绕过检查**。绕过检查的手段（`--no-verify`）只在本插件自身有缺陷时使用，
且必须在 PR 里说明是哪个缺陷。

## 安全操作规范

- **安全默认，显式确认，最小权限。** 危险操作默认 `ask`，绝不默认 `allow`。
- **git-guard 的每条规则都必须默认 `ask`。** 把某条规则改成 `allow` 需要独立审查，
  且必须在 PR 里说明为什么该操作在这个项目里是无条件安全的。
- **`--no-verify` 的默认值也是 `ask`**，不是 `deny`。理由：它是紧急场景的逃生通道，
  直接 deny 会切断这条路。逃生通道的存在不降低门槛，只是保证门可以开。
- **rebase 默认 `ask`**，不默认 `allow`。理由：rebase 会重写历史，
  与「危险操作默认 ask」的原则一致。
- 敏感文件不得读取，密钥不得硬编码。

## AGENTS.md 维护规则

- `AGENTS.md` **只放稳定规则，不放进度状态**。进度状态写 `.dev-docs/PROGRESS.md`。
- 理由：AI 编码工具会在每次会话注入 `AGENTS.md` 全文。里面每一条过期状态
  都会变成常驻成本，而它提供的信息（「昨天做到哪了」）对一个刚打开仓库的人毫无价值。
- 新增规则前先问：这条规则在一年后还成立吗？不成立的内容属于 PROGRESS，不属于 AGENTS。
- `AGENTS.md` 是唯一主文件。若需供其他工具使用，用软链接或构建脚本同步副本，
  不要手动维护多份内容。

## husky 与插件触发器的分工

两者都会在提交前后介入，但职责不重叠：

| | husky（本仓库开发用） | 插件触发器（用插件的项目用） |
|---|---|---|
| 运行位置 | 本仓库的本地 git hooks | DSH 会话内的工具执行前门禁 |
| 校验内容 | 提交信息格式（commitlint）、暂存文件 lint/format | 工作流规范、文档同步、危险 git 命令 |
| 是否可绕过 | 是（`--no-verify`） | 是（同一条逃生通道） |
| 面向谁 | 本仓库的贡献者 | 任何安装了本插件的 DSH 用户 |

**本仓库自己用 husky 做提交信息校验，插件自身的触发器用于它服务的项目。**
两者互不替代：husky 管的是这个仓库的 git 行为，插件管的是 DSH 会话里的模型行为。

## 许可证

贡献即表示你同意以 [MIT](LICENSE) 许可证授权你的贡献。

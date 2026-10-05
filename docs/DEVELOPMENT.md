# 开发指引

本文说明**怎么在本仓库里改代码**：本地循环、测试怎么组织、加一条规则要动哪些文件、
以及 CI 会拦住什么。[`CONTRIBUTING.md`](../CONTRIBUTING.md) 讲的是协作规则（分支、提交信息、
PR 流程），本文讲的是工程实践，两者互补。

## 本地循环

```bash
pnpm install
pnpm test:watch     # 边改边跑
```

提交前跑与 CI 完全相同的六个检查：

```bash
pnpm typecheck && pnpm lint && pnpm format:check && pnpm test && pnpm build && pnpm ci:checks
```

`pnpm build` 产出 `lib/`，但**测试不读 `lib/`**：spec 直接 import `../src/*.js`，由 Vitest
自己转译 TypeScript。因此改完 `src/` 不需要先构建就能看到测试结果，也不存在
「测试跑的是旧构建产物」这种假绿。

**不要用裸 `tsc`。** `package.json` 的脚本都经过 `scripts/with-src.mjs`，它保证 `src/`
不存在时安静跳过，并且用项目内固定的 TypeScript 而非全局那份。直接敲 `tsc` 会用到
PATH 上任意版本的编译器，报出与 CI 无关的错误。

## 目录职责

| 路径 | 职责 | 改这里时要注意 |
| --- | --- | --- |
| `src/index.ts` | 插件入口：构造 Runtime，注册/注销全部资源 | 只能具名导出，**不得 `export default`** |
| `src/config.ts` | Schemastery 配置面，唯一声明处 | 每个字段都要有默认值；新字段同步 `docs/CONFIGURATION.md` |
| `src/i18n.ts` | locale 解析与 `t()` | 新 key 必须同时进 `locale/en.json` 与 `locale/zh.json` |
| `src/state.ts` | 会话内去重与守卫计数（纯内存） | 不落盘：重启即忘是设计目标 |
| `src/shell.ts` | 不跑 shell 的命令行解析 | 三个特性共用（提交、PR、发版），改动会同时影响触发器与守卫 |
| `src/checks.ts` | 一次变更的判定逻辑 | 触发器与 `/dev-workflow check` 共用，别只改一侧 |
| `src/git.ts` | 通过可选服务 `subprocess` 跑 git | 每次使用前重新取服务，不要在插件存活期间缓存 |
| `src/tools/` | 两个工具的 `defineTool` 定义 | 工具名只能含 `[A-Za-z0-9_-]`，且 ≤ 64 字符 |
| `src/guard/` | 四道守卫的识别与判定 | 新规则默认必须是 `ask`；`file-guard` / `secret-guard` 固定 `deny` |
| `src/triggers/` | `tools/pre-execute` 监听器 | waterfall：必须先 `await next()` 再决定 |
| `src/commands/` | `/dev-workflow` 子命令 | 用户可见文本一律走 `t()` |
| `locale/` | 插件展示元数据（标题/描述） | 目录名必须是单数 `locale/`，文件名是短 id |
| `skills/` | 工作流规范正文（两份语言） | 两份的**标题数量与层级顺序必须一致** |
| `docs/` | 面向使用者与贡献者的文档 | 与代码同 PR 更新 |
| `tests/` | 测试 | 见下节 |

`src/` 之外的一切都不进构建产物。`tsconfig.json` 的 `include` 只有 `src/**/*.ts`，
`rootDir` 是 `src`，所以往 `src/` 之外放 `.ts` 不会污染 `lib/`。

## 测试怎么组织

测试文件放在 `tests/`，命名建议 `describe` 用被测模块路径（如 `src/tools/check-doc-sync.ts`）、
`it` 用可观察的行为描述，见 [`CONTRIBUTING.md`](../CONTRIBUTING.md) 的测试一节。

| 文件 | 覆盖什么 |
| --- | --- |
| `tests/register.spec.ts` | cordis 契约：具名导出、`inject`、注册与注销的完整清单，工具定义形状 |
| `tests/config.spec.ts` | 每个默认值，以及校验失败的报错文本 |
| `tests/i18n.spec.ts` | 两份字典的 key 集合与占位符一致、`t()` 的分语言与回退行为 |
| `tests/impl.spec.ts` | 两个判定函数与 `evaluate` 的边界：阻塞 vs 建议 |
| `tests/guard.spec.ts` | 每条 git-guard 规则、三档策略、与上下游门禁的交互 |
| `tests/command-guard.spec.ts` | 危险 shell 命令的识别与误报边界 |
| `tests/file-guard.spec.ts` | 敏感路径匹配（目录语义、任意深度）、各工具读哪个字段 |
| `tests/secret-guard.spec.ts` | 四种凭据模式、可选的高熵检测、脱敏不泄漏 |
| `tests/audit.spec.ts` | 审计记录的字段、脱敏、路径与写失败 |
| `tests/trigger.spec.ts` | 什么时候开口、什么时候沉默、去重与跨会话重报 |
| `tests/trigger-pr.spec.ts` | `gh pr create` 的识别、标题/描述/清单规则 |
| `tests/trigger-release.spec.ts` | `git tag` / `npm publish` 的识别与发版规则 |
| `tests/skill-parity.spec.ts` | SKILL 两份语言的标题数量与顺序一致 |
| `tests/harness.ts` | 公共脚手架：记录注册的假 ctx、假 git、`makeExec` |

**`tests/harness.ts` 不是测试文件**，它不匹配 Vitest 的用例收集规则，只被上面几个 spec
导入。加新 spec 时优先复用它，而不是再写一份假的 context——假 ctx 一旦出现两份，
它们迟早会对不上真实注册契约。

几个写测试时必须知道的约定：

- **假 ctx 只记录、不服务。** `tests/harness.ts` 的 `createHarness()` 把 `tools.register`、
  `skills.registerProvider`、`ctx.on`、`ctx.effect` 的调用记下来，让 spec 断言
  「注册了什么」，而不是「真实宿主会怎么用它」。`commands` 与 `subprocess` 默认为
  `undefined`（模拟没有这两项能力的 profile），需要时用 `{ commands: true }` 打开。
- **阻塞与建议要分开断言。** `evaluate()` 的 `ok` 只看 `errors`，`warnings` 不影响它。
  「改了代码没动文档」是 `warn.no_document`，不会让触发器开口；只有「配对的镜像文件只改了
  一半」和「`feat` 没补 CHANGELOG」这类 `errors` 才会。断言这类行为时写清楚断言在哪一层。
- **断言报错文本用 `t()` 而不是字面量。** 字典改动时测试会跟着动，而不是留下一条
  读不出意图的字符串比较。
- **`locale/en.json` 的 `meta` 是唯一嵌套对象**，所以顶层 80 个 key、扁平化后 81 个路径。
  数 key 时想清楚数的是哪一层。

## 加一条新规则要动什么

以「git-guard 新增一条危险命令」为例，完整改动是：

1. `src/config.ts` —— 在 `gitGuard` 下加字段，默认值用 `guardAction()`（工厂，不是共享实例：
   共享的 schema 实例会把第一个字段解析出的值串到其它字段上）。
2. `src/guard/git-guard.ts` —— 在 `detectGuard` 的判定链里加分支。判定顺序有意义：
   取最严的规则，同级保留先入列者；`--no-verify` 在所有子命令判定**之后**才追加。
3. `locale/en.json` + `locale/zh.json` —— 加 `security.guard.<name>`。
4. `tests/guard.spec.ts` —— 至少一条命中、一条最近的「不该命中」的反例。
5. `docs/CONFIGURATION.md` + `docs/SECURITY.md` —— 新字段与新规则。
6. `CHANGELOG.md` 的 `[Unreleased]`。

**加一整道新守卫同理，但不用碰 `src/index.ts` 以外的事件代码**：写一个
`src/guard/<name>-guard.ts`，导出纯函数 `detect<Name>(exec, config)` 与一个薄壳
`create<Name>Guard(options)`——后者把 `detect` 交给 `src/guard/shared.ts` 的
`createGuard()`，接线、计数、审计与档位决策都由它统一提供。然后：

1. `src/config.ts` 加一组 `<name>Guard`，`.default({})`，`enabled` 默认 `true`。
2. `src/index.ts` 的 `activate()` 里 `if (config.<name>Guard.enabled) registrations.push(...)`，
   放在提交前检查之后。**不要新增任何 export**——`tests/register.spec.ts` 断言导出恰好是
   `Config` / `apply` / `createRuntime` / `inject` / `name` 五个。
3. `locale/*.json` 加理由 key；若有档位，`ask` 的两份 `displayReason` 由 `createGuard()` 拼好。
4. `tests/<name>-guard.spec.ts`，另加同步 `tests/register.spec.ts` 里的监听器与 effect 计数。
5. `docs/SECURITY.md`（这道守卫保护什么、默认值为什么这样定）、`docs/CONFIGURATION.md`、
   `docs/TRIGGERS.md`（哪一道监听器看什么）。
6. `CHANGELOG.md` 的 `[Unreleased]`。

新增**检查工具**或**触发器**同理，另外还要确认 `docs/TOOLS.md` / `docs/TRIGGERS.md`。
新 key 加进字典后，`pnpm ci:checks` 会校验两份字典 key 对齐。

## CI 会拦住什么

`.github/workflows/ci.yml` 在 Node 20 上依次跑：`pnpm install --frozen-lockfile`、
`typecheck`、`lint`、`format:check`、`test`、`build`、`ci:checks`。
`main` 分支的保护规则要求 `verify` 这个检查通过、要求 PR、且禁止强制推送。

`pnpm ci:checks`（`scripts/ci-checks.mjs`）跑三个不需要额外依赖的守卫：

1. **两份 locale 字典的 key 集合完全一致**（递归扁平化后比较，嵌套对象藏不住）。
2. **`dsh.bundle.patch` 指向的文件存在，且写进了 `package.json` 的 `files`** —— 后者漏了
   的话补丁不会随包发布，而且没有任何报错，只表现为插件装上去不生效。
3. **SKILL 两份语言的标题数量与层级顺序一致**（跳过围栏代码块：正文里的示例 PR 模板
   含 `##` 行，那是示例文本不是章节）。

CI 只校验 key 对齐，**不校验翻译正确性**——那条 key 在两种语言里语义是否一致，是人工审查项。

## 已知的坑

- **`tsconfig.json` 不覆盖 `tests/`。** `include` 只有 `src/**/*.ts`，所以 `pnpm typecheck`
  检查的是发布出去的那部分源码；测试的类型问题由 ESLint 的 `**/*.ts` 规则和 Vitest 的转译
  暴露。这是刻意的：测试不随包发布，不该被 `rootDir: src` 拉进构建。
- **`AGENTS.md` 只放稳定规则，不放进度。** 进度写 `.dev-docs/PROGRESS.md`（本机私有，
  已被 gitignore）。`AGENTS.md` 每次会话都会被注入，里面每条过期状态都是常驻成本。
- **`docs/SECURITY.md` 里 git-guard 与 husky 的分工不要混。** 前者管 DSH 会话里的模型行为，
  后者管这个仓库自己的 git 行为，两者互不替代。
- **`t()` 的占位符缺失时不会报错。** `createTranslator` 找不到参数时留下字面的 `{name}`，
  所以漏传参数在测试里表现为断言失败，而不是运行时崩溃——出现 `{...}` 优先怀疑漏参数。
- **`ask` 在没有 `approval` 服务的 profile 里会退化成拒绝。** 这是宿主行为，不是插件缺陷；
  排查「为什么问了却没弹窗」时先确认 profile 是否装了审批能力。

# 架构

本文件说明 dsh-dev-workflow 由哪些模块组成、它们怎么连起来，以及几个看起来古怪但必须如此的设计。
它描述的是**已经落地并实测过的行为**，不是设计意图。

## 插件在 DSH 里的位置

DSH 是 Cordis 微内核：内核只提供上下文、服务注册与事件总线，其余能力（工具、技能、命令、子进程）
都是插件。本插件也是其中之一，入口是 `src/index.ts` 的三个具名导出：

| 导出 | 作用 |
| --- | --- |
| `name` | 插件名 `dev-workflow`，必须与 `cordis.patch.yml` 里的 `id` 一致 |
| `inject` | 声明依赖的**宿主服务名**：`['tools', 'skills']` |
| `apply` | `(ctx, config) => void`，唯一的副作用入口 |
| `Config` | Schemastery schema，DSH 在 `apply` 之前完成校验与填默认值 |

**不使用 `export default`。** DSH 的 loader 在 ESM/CJS 互操作时会解包默认导出，一旦用默认导出，
同文件里的 `inject` / `Config` / `name` 都会跟着丢掉，插件会以错误的形式挂载（没有依赖声明、
没有配置面）。这是个安静的坑，不是风格偏好。

`inject` 里写的是**服务名**，不是 npm 包名。本插件只声明两个真正无法工作的依赖：

- `tools`：两个检查工具注册在这里，没有它插件无事可做。
- `skills`：工作流规范以技能形式注入，同上。

`subprocess`（跑 git）与 `commands`（`/dev-workflow`）**故意不写在 `inject` 里**，而是用
`ctx.get('subprocess')` / `ctx.get('commands')` 取。这样做的收益是：一个没有装 git 集成、
或者版本里没有命令服务的 profile 依然能挂载本插件，只是少一项能力，而不是整个加载失败。
代价是这两个服务可以在插件存活期间消失，所以每次使用前都要取一次——见 `src/git.ts` 的
`service()` 与 `src/index.ts` 的 `activate()`。

## 模块地图

```
src/
├── index.ts                  插件入口：构造 Runtime，注册/注销全部资源
├── config.ts                 Schemastery 配置面（唯一声明处，每个字段带默认值）
├── i18n.ts                   locale 解析 + 字典读写 + t()
├── state.ts                  会话内去重状态与守卫命中计数（纯内存）
├── shell.ts                  不跑 shell 的命令行解析（两个特性共用）
├── checks.ts                 一次变更的判定逻辑（触发器与 /dev-workflow check 共用）
├── git.ts                    通过可选服务 subprocess 运行 git
├── skills/provider.ts        技能 provider：目录条目 + 按需全文
├── tools/
│   ├── result.ts             CheckResult 与统一的渲染格式
│   ├── check-commit-message.ts
│   └── check-doc-sync.ts
├── triggers/pre-commit.ts    tools/pre-execute 上的提交前检查
├── guard/
│   ├── shared.ts             四道守卫共用的事件接线与档位决策
│   ├── git-guard.ts          危险 git 命令
│   ├── command-guard.ts      危险 shell 命令
│   ├── file-guard.ts         敏感路径
│   └── secret-guard.ts       凭据泄漏
├── audit.ts                  脱敏后的审计记录（.dev-docs/audit-log.jsonl）
└── commands/dev-workflow.ts  /dev-workflow 的子命令分派
```

依赖方向是单向的：`index.ts` 依赖所有模块，各模块之间只向下依赖（`commands` 与
`triggers` 都依赖 `checks`，`checks` 依赖 `tools` 与 `shell`）。没有循环，也没有全局单例——
每个模块导出的都是 `createX(options)` 工厂，要什么能力由调用方注入。

## Runtime：一份可开关的注册集合

`src/index.ts` 的 `createRuntime(ctx, config)` 返回一个 `Runtime`，它把「插件当前在做什么」
收敛成四个访问器加一个开关：

```ts
interface Runtime {
  readonly active: boolean          // 当前是否有注册
  locale(): Locale
  t(): Translate
  git(cwd: string): GitRunner       // 带缓存，同一目录复用一个 runner
  readonly state: WorkflowState
  setActive(on: boolean): void
}
```

关键点是 `active` 与 `setActive` 的语义：**`off` 不是「安静地不回答」，而是把注册本身撤掉。**
常驻 token 成本恰恰等于这些注册，所以关掉之后必须真的归零。`releases` 数组按注册顺序存
disposer，`setActive(false)` 逆序逐个调用。

### 为什么注册要额外绑一次 effect

`ctx.tools.register()` 与 `ctx.commands.register()` 返回的 disposer **绑定的是服务自己的
上下文，不是调用方 fiber**：它们的实现内部走 `this.layers.effect(this.ctx, ...)`，
`this.ctx` 是 `ToolRuntime` / `CommandRuntime` 所在的那层。只把 disposer 存进数组的话，
插件 fiber 卸载（热重载、禁用插件）时**注册不会跟着消失**，会留下悬挂的工具定义。

所以 `bind()` 做了两件事：把 disposer 包一层幂等（`released` 标志，重复调用无害），
再用 `ctx.effect(() => once)` 把它挂到本插件 fiber 上。这样运行时显式 `off` 与 fiber 卸载两条路
都能清干净。官方 `dsh-tool-bash` 的 `ctx.inject(['jobs'], jobCtx => jobCtx.effect(...))`
是同一个手法。

事件监听器（`ctx.on`）没有这个问题：`on` 返回的 disposer 本来就归当前 fiber。

## 数据流：一次提交检查

```
agent 调 bash/pwsh 工具
        │
        ▼
tools/pre-execute   ← Cordis waterfall，本插件最多挂五个监听器
        │              ① src/triggers/pre-commit.ts  （提交前检查）
        │              ② src/guard/git-guard.ts      （危险 git 命令）
        │              ③ src/guard/command-guard.ts  （危险 shell 命令）
        │              ④ src/guard/file-guard.ts     （敏感路径）
        │              ⑤ src/guard/secret-guard.ts   （凭据泄漏）
        │
        ├─ 监听器先 await next()：链上后面的门禁与内置行为先决定
        │
        └─ 上游 allow 时才自查，命中后返回 ask（guard 也返回 deny）
```

监听器挂在同一个事件上、互相独立，是刻意的：**一个守规范（提交信息与文档同步），
四个守工作成果（可能丢数据的 git 命令、不可逆的 shell 命令、不该读的路径、发出即泄漏的
凭据）**，`enableOwnTrigger` 与各守卫的 `enabled` 分别是它们的开关。它们不共享判定，
但共享三样东西：

- `src/shell.ts`：把命令行归约成 `git <subcommand> <args>` 与命令词序列，涉及命令行的守卫
  必须对「什么算 git」「什么算程序名」有同一个答案。
- `src/guard/shared.ts`：`createGuard()` 提供接线、计数与档位决策，四道守卫都只是给它一个
  `detect(exec)`。策略差异（谁是 `ask`、谁固定 `deny`）留在各自文件里。
- `src/state.ts`：命中计数与「同一会话同一问题只提示一次」的记忆。

`next()` 返回 `{kind:'allow'}` 之外的值时，本插件一律原样透传，绝不改判上游的决定；
guard 是唯一的例外，且只在**自己的策略更严**（`deny` 对上上游的 `ask`）时才覆盖，
理由写在 `src/guard/shared.ts:164-172`。

## 共用的判定层

`src/checks.ts` 的 `evaluate(input, config, t)` 是「给一份工作区变更 + 一条提交信息，
返回问题清单」的纯函数。它被三处调用：

| 调用方 | 输入 | 用途 |
| --- | --- | --- |
| `triggers/pre-commit.ts` | 命令里解析出的信息 + `git status` 的文件集 | 提交前拦截 |
| `triggers/pre-commit.ts` | 同上，但用另一语言的 `t` | 渲染双语提示 |
| `commands/dev-workflow.ts` | 工作区文件集（无提交信息） | `/dev-workflow check` |

「纯函数」这条不是洁癖：触发器要为审批提示同时给出中英两份，而**每一份都必须用对应语言的
翻译器重新跑一遍 `evaluate`**。如果清单是一次算好再翻译外层的，就会出现「英文提示里嵌着
中文问题」。详见 [docs/TRIGGERS.md](TRIGGERS.md#提示的语言)。

工作区只读一次（`git status --porcelain=v1 --untracked-files=all`，由调用方执行），
之后所有判断都是对文件列表与字符串的操作——这也是 `evaluate` 能重跑的前提。

## 不跑 shell 的命令行解析

插件需要识别「agent 正要用 `git commit`」和「agent 正要用 `git push --force`」，
但它**不通过执行 shell 来识别**——那会带来两个问题：需要真的跑一遍命令（有副作用），
以及依赖 shell 的可用性。

`src/shell.ts` 因此只做有限词法：

1. `tokenize()` 处理单双引号、反斜杠转义，把 `&&` / `||` / `;` / `|` / 换行保留为独立 token。
2. `segments()` 按这些运算符切段，每段独立判断（`pnpm test && git commit -m "..."` 照样命中）。
3. `gitInvocations()` 跳过前导 `VAR=value` 与 `env`，取程序名 basename，匹配 `git` / `git.exe`，
   跳过 `-C`、`-c`、`--git-dir` 等带值的全局选项，取出子命令。

它的**刻意的能力边界**：引号里的 `git commit` 不算命令；提交信息含 `$(...)` 或反引号时放弃判定
（插件看不到 git 最终收到的字面量）；`git commit -F -` 放弃判定。这些不是待修的缺陷，
而是「宁可不开口，也不误报」的取舍，清单见 [docs/TRIGGERS.md](TRIGGERS.md#降级路径)。

## 错误处理约定

- **工具执行失败返回 `{ error: ... }`，不抛异常。** `CheckResult` 里 `error` 字段存在时
  `renderCheck()` 只渲染这一行；`/dev-workflow check` 遇到 git 不可用时返回
  `{kind:'error', text}`。
- **事件监听器必须总是 settle。** 门禁里抛出的异常会变成工具调用失败，而不是一条提示。
- **没有可用服务时静默降级**，不报错、不阻塞：没有 `subprocess` 时判定退化为只检查提交信息；
  没有 `commands` 时命令不注册；没有 `approval` 时 DSH 自己会把 `ask` 变成拒绝
  （这是宿主的行为，不是本插件的选择）。

## 相关文档

- 配置面：[docs/CONFIGURATION.md](CONFIGURATION.md)
- 两个工具：[docs/TOOLS.md](TOOLS.md)
- 触发时机与边界：[docs/TRIGGERS.md](TRIGGERS.md)
- 语言处理：[docs/I18N.md](I18N.md)
- 安全默认值：[docs/SECURITY.md](SECURITY.md)
- 常驻成本：[docs/TOKEN-BUDGET.md](TOKEN-BUDGET.md)
- 决策记录：[docs/ADR/](ADR/)

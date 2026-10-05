# 触发器

本文件说明 dsh-dev-workflow 的自动介入路径：**它什么时候开口，靠什么开口，以及什么时候它其实开不了口。**

对应的代码是 `src/triggers/pre-commit.ts`（自动路径）与 `src/commands/dev-workflow.ts`
（手动路径）。两者共用 `src/checks.ts` 的判定逻辑，所以「自动检查」和 `/dev-workflow check`
给出的结论必然一致。

## 拦在哪个事件上

```
agent 调用 bash / pwsh 工具
        │
        ▼
tools/pre-execute  ← waterfall 门禁，本插件在此挂一个监听器
        │
        ├─ 先 await next()：上游门禁的 allow / deny / ask / cancel 原样返回，不抢话
        │
        └─ 上游 allow 且命令是 git commit → 自己判定
                 ├─ 通过 → 返回上游结果，命令照常执行
                 └─ 命中 → { kind: 'ask', displayReason: { en, zh } }
```

`tools/pre-execute` 是 DSH 官方在派发任何工具调用之前走的 waterfall 钩子
（`@deepseek-ai/dsh-tools` 的 `prepareExecution`）。它的 `next()` 会继续调用链上后面的监听器，
默认返回 `{ kind: 'allow' }`。本插件**先调 `next()` 再自查**，因此：

- 上游（例如 auto-review、权限门禁）已经拒绝或取消了这次调用时，本插件绝不改判，
  而是把上游的决定原样透传。
- 本插件只在「调用已经合法、正要去执行」这个位置补充工作流检查。

判定结果用 `ask` 而不是 `deny`：提交信息不规范是作者可以明知的取舍，
插件给的是「要不要照常提交」的选择，而不是否决权。

## 什么算「一次提交」

触发器不解析 shell，只在**有限的词法层面**判断，因为过度猜测会在错误的时刻开口：

1. `src/checks.ts` 的 `tokenize()` 按 shell 语法切成 token（处理引号、`\` 转义、
   `&&` / `||` / `;` / `|` / 换行作为分隔）。
2. `segments()` 按这些运算符切段，每段独立判断——所以
   `pnpm test && git commit -m "..."` 里的提交部分照样被识别。
3. `detectCommit()` 在每段里跳过前导的 `VAR=value` 赋值和 `env`，取程序名的 basename，
   匹配 `git` / `git.exe`；再跳过 `-C`、`-c`、`--git-dir` 等带值的全局选项，
   命中子命令 `commit`。
4. `commitArguments()` 解析提交信息：`-m` / `--message` / `--message=` / `-mXXX`
   （多个 `-m` 按 git 的语义用空行拼接），以及 `-F` / `--file` / `--file=` / `-FXXX`。

两条刻意的保守规则：

- **引号里的 `git commit` 不算提交。** 词法处理已经把它归到同一 token 里，
  不会被当成命令名。
- **提交信息里含 `$(...)` 或反引号时不判定。** 这种值要在 shell 里展开，
  插件看不到 git 最终收到的字面量，与其对一段 git 永远不会收到的文本报错，不如不开口。

`git commit -F -`（从标准输入读）同样放弃判定：信息还没产生。

## 检查什么

`evaluate()` 把两个已有工具合在一起跑，输入是「提交信息 + 工作区变更文件集」：

| 来源 | 判定 |
| --- | --- |
| `checkCommitMessage` | Conventional Commits：类型、格式、标题长度、句尾句号、`!` 与 `BREAKING CHANGE:` 页脚是否配套 |
| 变更文件集 | 跨模块提交、缺少 scope 的软警告 |
| `checkDocSync` | 成对文件（README、locale、SKILL）只改一半 → 报错；改了代码没动文档 / CHANGELOG → 警告 |
| `rules.requireChangelogOnFeat` | `feat` 提交且变更集里没有 `config.docs.changelog` → 阻塞 |

最后一条把 `config.rules.requireChangelogOnFeat` 与 `checkDocSync` 的同类警告区分开：
`feat` 要求 CHANGELOG 是硬规则（阻塞），其它类型的 CHANGELOG 缺失只是建议（警告）。
同一次判定里两者只出现一条，不重复提示同一件事。

工作区变更集来自 `git status --porcelain=v1 --untracked-files=all`，
通过 `ctx.get('subprocess')` 运行——**每次判定只跑一次 git**。

## 提示的语言

审批提示按**客户端的 locale** 选择文案，而客户端 locale 未必等于插件自己的
`config.locale`。因此 `displayReason` 同时给出 `en` 和 `zh` 两份，并且每一份都是
**用它自己的翻译器重新跑一遍 `evaluate()`** 得到的——只要外面那层包装是英文、
里面的问题清单还是中文，就等于没翻。

中文键必须是字面 `zh`：客户端会把 locale 小写化再回退到 `en`，写 `zh-CN` 永远匹配不上。

## 状态模型：同一会话同一问题只提示一次

状态在插件 fiber 的内存里（`src/state.ts`），**不落盘**：

- key 为 `${sessionId}:${checkType}:${targetId}`，`checkType` 为 `commit` 或 `doc`。
- `targetId`：提交检查用提交信息（或命令文本）的 FNV-1a 指纹；
  文档检查用变更文件集合的指纹。
- 单个会话最多记 512 个 target，超出后淘汰最旧的，避免长会话无界增长。
- 插件重启后状态清空。
- 跨会话允许重新提示：同一个问题在另一个会话里会再问一次。

**先记后问**：命中问题时先把 target 记入状态，再返回 `ask`。这样作者被问过一次、
选择照常提交之后，同样的提交不会再被拦第二遍——审批回调没有提供「作者选了哪一个」
的通道，所以只能在问之前记下。

`/dev-workflow status` 会显示最近一次检查结果和守卫命中次数，这两项同样来自这个状态。

## 降级路径

规范给了两条路：主路径（在会话内自动拦截）与降级路径（插件只提供手动工具，
强制拦截完全交给 husky）。

**实际结论：走主路径。** `tools/pre-execute` 确实存在、确实是 waterfall、
确实能拦下 agent 通过 `bash` / `pwsh` 执行的 `git commit`，因此不需要降级。
核对的依据是 `@deepseek-ai/dsh-tools` 的类型声明（`Events` 里声明了
`'tools/pre-execute'`，模式为 waterfall）与派发实现（`prepareExecution` 里
`await this.ctx.waterfall(carrier, 'tools/pre-execute', exec, ...)`），
以及本机探针实测：构造一次 `bash` + `git commit -m "..."` 的调用，
监听器被调用并返回了 `ask`。

但主路径有**真实的能力边界**，这些不是缺陷而是设计前提，应当写清楚：

| 场景 | 行为 |
| --- | --- |
| agent 通过 `bash` / `pwsh` 工具执行 `git commit` | 检查并提示 |
| 提交信息含 `$(...)`、反引号，或 `-F -` 从 stdin 读 | 放弃判定，不提示 |
| agent 用其它非 shell 路径提交 | 不提示 |
| 用户在**自己的终端**里提交 | 不提示——插件只在 DSH 会话内运行 |
| 运行时没有 `approval` 服务 | DSH 会把 `ask` 降级为拒绝；提交被拦下，而不是静默放行 |
| `mode: 'off'` 或 `enableOwnTrigger: false` | 监听器根本不注册，零常驻成本、零介入 |
| 运行时没有 `subprocess` 服务 | `git` 读不到工作区，判定退化为只检查提交信息本身 |

第四行是这套机制与 husky 的分工：**插件管会话内，husky 管会话外。**
作者在自己的终端里 `git commit` 时，唯一能拦住的仍然是 `.husky/` 里的钩子；
插件的价值在于让 agent 在提交之前就知道规范，而不是代替 git 钩子。

第六行的行为来自 DSH 本身（`serviceAsk` 在缺少 approval 时把 `ask` 变成 deny），
**不是本插件主动选择的**：如果宿主没有审批能力，我们宁可挡住，也不假装问过。

## 手动路径

`/dev-workflow check` 走同一套判定，只是不需要等待提交：

- 取当前工作区的变更文件集，跑 `evaluate()`，把结果渲染成 `⚠` / `✖` 清单。
- 同时把结果记入状态，所以随后的自动检查能看到「最近一次检查结果」。

`/dev-workflow on | off` 切换的是**注册本身**：`off` 会把两个工具、技能 provider、
命令和事件监听器全部注销（`mode: 'off'` 时则一开始就不注册），
所以关掉之后常驻增量为零，而不只是「安静地不回答」。详见
[docs/TOKEN-BUDGET.md](TOKEN-BUDGET.md)。

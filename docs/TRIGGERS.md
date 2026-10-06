# 触发器

本文件说明 dsh-dev-workflow 的自动介入路径：**它什么时候开口，靠什么开口，以及什么时候它其实开不了口。**

对应的代码是 `src/triggers/`（三个约定触发器：提交前、PR 前、发版前）、`src/guard/`（四道守卫）与
`src/commands/dev-workflow.ts`（手动路径）。它们共用 `src/checks.ts` 与
`src/tools/check-commit-message.ts` 的判定逻辑、`src/shell.ts` 的命令行解析，所以
「自动检查」和 `/dev-workflow check` 给出的结论必然一致。

## 拦在哪个事件上

```
agent 调用 bash / pwsh 工具
        │
        ▼
tools/pre-execute  ← waterfall 门禁，本插件在此最多挂七个监听器
        │
        ├─ 先 await next()：上游门禁的 allow / deny / ask / cancel 原样返回，不抢话
        │
        ├─ 监听器 A（pre-commit）：命令是 git commit → 校验提交信息与文档同步
        ├─ 监听器 B（pre-pr）：命令是 gh pr create → 校验标题与描述
        ├─ 监听器 C（pre-release）：命令是 git tag / npm publish → 校验发版
        ├─ 监听器 D（git-guard）：危险 git 操作 → 按策略 deny / ask
        ├─ 监听器 E（command-guard）：危险 shell 命令 → 按策略 deny / ask
        ├─ 监听器 F（file-guard）：参数里有敏感路径 → deny
        └─ 监听器 G（secret-guard）：参数里有凭据形状 → deny

前三个命中时返回 { kind: 'ask', displayReason: { en, zh } }；后四个按各自策略返回。
```

三者都**先 `await next()` 再自查**：上游（例如 auto-review、权限门禁）已经拒绝或取消了这次调用时，
本插件绝不改判，而是把上游的决定原样透传；本插件只在「调用已经合法、正要去执行」这个位置补充检查。
`tools/pre-execute` 是 DSH 官方在派发任何工具调用之前走的 waterfall 钩子
（`@deepseek-ai/dsh-tools` 的 `prepareExecution`），其 `next()` 会继续调用链上后面的监听器，
默认返回 `{ kind: 'allow' }`。

### 为什么三个触发器都挂在 shell 工具上

规范期望的是「PR 创建前」「发版前」两个断点。**DSH 的事件目录里没有这两类事件**：
`tools/pre-execute` 之外不存在「PR 即将创建」或「即将发版」的钩子（核对方式见
`.dev-docs/DSH-API-NOTES.md`，该笔记不入库）。因此这两个断点与提交前一样，
落在**执行动作的那条 shell 命令行**上：`gh pr create`、`git tag`、`npm publish`。

这不是无法拦截后的降级——命令行**在动作发生之前**就已经可见，拦下它就能拦下动作本身。
降级的判据是「动作完全不经过 DSH」，而这三条路径都经过。

由此产生的能力边界，与提交前检查一致：插件只看**被调用的命令文本**，看不懂脚本内部
（agent 执行一个内部会发版的脚本时看不到），也不看用户自己终端里的操作。

三个约定触发器之外的决策规则也用 `ask` 而不是 `deny`：提交信息或 PR 描述不规范是作者可以明知的
取舍，插件给的是「要不要照常执行」的选择，而不是否决权。**只有配置里显式写了 `'deny'`
的守卫策略才会真正拒绝**（见 [docs/SECURITY.md](SECURITY.md)）。

七道门是独立的：`enableOwnTrigger` 管三个约定触发器，四道守卫各由自己的 `enabled` 管，
其中一个出问题不影响其余。注册顺序是「约定（提交 → PR → 发版）→ 破坏性 git → 危险命令 →
敏感文件 → 密钥」：更靠前的守卫先写审计记录，而各级决策仍按「更严者胜」汇总，
顺序不影响最终结果。

## 什么算「一次提交」

触发器不跑 shell，只在**有限的词法层面**判断，因为过度猜测会在错误的时刻开口。这一层
（`src/shell.ts`）由提交前检查与 git-guard 共用：

1. `tokenize()` 按 shell 语法切成 token（处理引号、`\` 转义、
   `&&` / `||` / `;` / `|` / 换行作为分隔）。
2. `segments()` 按这些运算符切段，每段独立判断——所以
   `pnpm test && git commit -m "..."` 里的提交部分照样被识别。
3. `gitInvocations()` 在每段里跳过前导的 `VAR=value` 赋值和 `env`，取程序名的 basename，
   匹配 `git` / `git.exe`；再跳过 `-C`、`-c`、`--git-dir` 等带值的全局选项，
   取出子命令与它的参数。
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

## 什么算「一次 PR 创建」

`detectPullRequest()` 在每段里找 basename 为 `gh` / `gh.exe` 的程序，要求前两个参数是
`pr` `create`。命令行里通过 `--title` / `-t`、`--body` / `-b`、`--body-file` / `-F`
（含 `--opt=value` 写法）给出的内容会被解析出来；这几项之外的带值选项在
`GH_VALUE_OPTIONS` 里列明，以免把它们的值误当标题。

`--body-file` 指向的文件在**判定时刻**读取（相对路径按会话 cwd 解析）；
`-F -`（从标准输入读）不读——和 `git commit -F -` 同理，内容还没产生。

## PR 检查什么

| 规则 | 判定 |
| --- | --- |
| 标题 | 直接复用 `checkCommitMessage({ message: title })` 的结论。**squash merge 后 PR 标题就是 main 上的提交信息**，因此它必须满足与提交信息完全相同的规范——用同一份实现，结论不会漂移 |
| 描述三段 | PR 模板要求的 `## What` / `## Why` / `## How to verify`，**缺段或段内为空都算缺失**——一个只有标题的空盒子并不比没有好 |
| 检查清单 | 描述里遗留的 `- [ ]` 未勾选行逐项计数 |
| 关联 Issue | 标题与描述里没有 `#<数字>` 时**只警告**：本地无法判断是否真的存在对应 Issue，不该因此阻塞 |

`.github/` 下没有 PR 模板文件，所以「模板里有没有复选框」无法作为触发条件；
实现选择的是「描述里**实际存在**的未勾选行」——模板缺席时这条规则自然不触发，
模板存在而作者漏勾时正好命中。

## 什么算「一次发版」

`detectRelease()` 同时收集两类动作，**同一条命令行可以两件都做**
（`git tag v0.2.0 && npm publish`）：只有拿到 tag 和 dist-tag 两样，才谈得上「发版整体是否合规」。

- `git tag <name>`：跳过 `-a` / `-s` 等无值选项与 `-m` / `-F` / `-u` 等带值选项，
  取第一个非选项词为 tag 名；`-l` / `--list` / `-d` / `--delete` / `-v` / `--verify`
  是**读**操作，直接不算发版。
- `npm publish` / `pnpm publish`：读 `--tag` / `--tag=`。**没有写 dist-tag 时记为 `latest`**，
  因为 npm 确实会把预发布版本也发布到 `latest`——把默认值当成事实，预发布规则才拦得住它。

## 发版检查什么

| 规则 | 判定 |
| --- | --- |
| SemVer | 版本号须匹配 `MAJOR.MINOR.PATCH`，可带 `-rc.1` 之类的预发布后缀 |
| tag 与 manifest 一致 | 去掉 `v` 前缀后，tag 名与 `package.json` 的 `version` 必须相同：两者不一致意味着「发布出来的版本」和「tag 名」不是同一个 |
| 预发布不推 latest | 版本带预发布后缀而 dist-tag 是 `latest` → 阻塞，提示改用 `--tag next` |
| CHANGELOG 有 `[Unreleased]` | 没有 `## [Unreleased]` 段 → 阻塞（Keep a Changelog 要求它常驻顶部） |
| CHANGELOG 分类合法 | `[Unreleased]` 段里的 `###` 标题须是 Added / Changed / Deprecated / Removed / Fixed / Security 之一 |
| `[Unreleased]` 不为空 | **`[Unreleased]` 与 `[<version>]` 两段都为空**才算空：发布流程的第二步就是把条目从前者移入后者，所以 tag 创建的那一刻，合法状态可能落在任何一段里 |

版本号取自 tag（无 tag 时才退回 `package.json`）。`package.json` 与 CHANGELOG 在
**判定时刻**从会话 cwd 读取；读不到就不跑对应规则，只跑能跑的——门禁不会因此变成空操作。

## 守卫危险 git 命令

第一道守卫（`src/guard/git-guard.ts`）与提交前检查共用同一段命令行解析，
但看的是另一件事：**这条命令会不会让工作成果不可恢复地消失。**

| 命令形态 | 策略键 | 默认 |
| --- | --- | --- |
| `push --force` / `-f` / `+refspec` | `forcePush` | `ask` |
| `reset --hard` | `hardReset` | `ask` |
| `rebase` | `rebase` | `ask` |
| `commit --amend` | `amend` | `ask` |
| `branch -D` / `--delete --force` | `branchDelete` | `ask` |
| `clean -f` / `-fd` | `cleanForce` | `ask` |
| `checkout -- <path>` | `checkoutDiscard` | `ask` |
| `--no-verify`（任何子命令） | `noVerify` | `ask` |

识别规则里几处刻意的地方：

- **`--force-with-lease` 直接放过。** 带这个选项（含 `--force-with-lease=main`）时不算
  force push——它会在覆盖一个你尚未看到的提交时失败，正是我们想避免的事故。反过来，
  裸 `--force` 的理由里会附带一行「建议改用 `--force-with-lease`」。
- **短选项按字母匹配。** `-fd` 含 `f`，`-D` 含 `D`；`--force` 这类长选项不参与短选项匹配。
- **`reset --soft` / `clean -n` / `branch -d` / `checkout main` 都不拦。** 它们不丢工作。
- **`--no-verify` 与操作同时出现时，操作胜出。** `git push --no-verify --force` 报的是
  force push：`--no-verify` 只是修饰符，真正会丢东西的是那个操作。同等级的策略下先入列者
  胜出，所以判定循环把 `--no-verify` 放在子命令判定之后。

一条命令行同时命中多项时，按 `deny > ask > allow` 取最严的一条——**绝不削弱上游更严的决定**。
唯一的覆盖方向是「自己 `deny` 对上上游 `ask`」，因为拒绝一个已经在被质疑的调用不会让情况变坏。
细节与默认值的理由见 [docs/SECURITY.md](SECURITY.md)。

## 另外三道守卫

后三道守卫看的是同一件事的三面：**这次调用会不会让东西永久地出去或消失。**

| 监听器 | 看什么 | 命中后 | 默认 |
| --- | --- | --- | --- |
| `command-guard` | `command` 里不可逆的 shell 命令 | 按 `commandGuard.dangerousShell` 走 `deny` / `ask` / `allow` | `ask` |
| `file-guard` | 参数里的路径是否命中 `fileGuard.noRead` | `deny` | `deny` |
| `secret-guard` | 参数里是否有凭据形状 | `deny` | `deny` |

三处与 git-guard 不同的地方，都是刻意的：

- **`file-guard` 与 `secret-guard` 没有档位字段。** git 与命令守卫拦的是可以重做的工作，
  所以给一个「我知道我在做什么」的覆盖档是合理的；**读出去的路径与发出去的凭据收不回来**，
  因此这两道只有拒绝。`fileGuard.noRead: []` 或 `secretGuard.enabled: false` 才是它们的开关。
- **`file-guard` 与 `secret-guard` 不只看 shell 命令。** 它们扫描**每一次**工具调用的参数：
  凭据写进源码文件与敲进命令行一样是泄漏，`read` 一个 `.env` 与 `cat` 它一样是读取。
  `command-guard` 则只认 `command` 字段，因为只有它看的是一行命令。
- **路径从每个工具真实的参数字段里取**（`file_path` / `path` / `pattern` / `include`），
  而不是靠工具名猜。判定只看字符串，**从不打开文件**——这一道自己读文件去判断该不该读，
  就正好是它要防的事。

`command-guard` 的识别细节（什么算危险目标、为什么 `rm -rf node_modules` 放行）见
[docs/SECURITY.md](SECURITY.md#command-guard-保护什么)。

**四道守卫共用 `src/guard/shared.ts` 的 `createGuard()`。** 它负责接线、命中计数、审计回调
与档位决策；每道守卫只提供一个 `detect(exec)`。因此「先 `await next()`、透传上游决定、
`signal.aborted` 时返回 `cancel`、同级先入列者胜」这些规则只有一份实现。

## 提示的语言

审批提示按**客户端的 locale** 选择文案，而客户端 locale 未必等于插件自己的
`config.locale`。因此 `displayReason` 同时给出 `en` 和 `zh` 两份，并且每一份都是
**用它自己的翻译器重新跑一遍 `evaluate()`** 得到的——只要外面那层包装是英文、
里面的问题清单还是中文，就等于没翻。

中文键必须是字面 `zh`：客户端会把 locale 小写化再回退到 `en`，写 `zh-CN` 永远匹配不上。

## 状态模型：同一会话同一问题只提示一次

状态在插件 fiber 的内存里（`src/state.ts`），**不落盘**：

- key 为 `${sessionId}:${checkType}:${targetId}`，`checkType` 为 `commit`、`doc`、`pr` 或 `release`。
- `targetId`：提交检查用提交信息（或命令文本）的 FNV-1a 指纹；
  文档检查用变更文件集合的指纹；PR 检查用标题（无标题时退回描述，再退回命令文本）的指纹；
  发版检查用版本号（无版本号时退回命令文本）。
- 单个会话最多记 512 个 target，超出后淘汰最旧的，避免长会话无界增长。
- 插件重启后状态清空。
- 跨会话允许重新提示：同一个问题在另一个会话里会再问一次。

**先记后问**：命中问题时先把 target 记入状态，再返回 `ask`。这样作者被问过一次、
选择照常执行之后，同样的对象不会再被拦第二遍——审批回调没有提供「作者选了哪一个」
的通道，所以只能在问之前记下。

`/dev-workflow status` 会显示最近一次检查结果和守卫命中次数，这两项同样来自这个状态。

## 降级路径

规范给了两条路：主路径（在会话内自动拦截）与降级路径（插件只提供手动工具，
强制拦截完全交给 husky）。

**实际结论：走主路径，三个断点都不降级。** `tools/pre-execute` 确实存在、确实是 waterfall、
确实能拦下 agent 通过 `bash` / `pwsh` 执行的 `git commit`，因此不需要降级。
核对的依据是 `@deepseek-ai/dsh-tools` 的类型声明（`Events` 里声明了
`'tools/pre-execute'`，模式为 waterfall）与派发实现（`prepareExecution` 里
`await this.ctx.waterfall(carrier, 'tools/pre-execute', exec, ...)`），
以及本机探针实测：构造一次 `bash` + `git commit -m "..."` 的调用，
监听器被调用并返回了 `ask`。

PR 与发版两个断点的核对结论见上文「为什么三个触发器都挂在 shell 工具上」：
事件目录里没有对应事件，但动作本身经过 `bash` / `pwsh`，所以在动作发生前就能拦下，
**不构成降级条件**。

第三条「DSH 不支持设置面板的某些能力」有一条**真实降级**。面板需要知道 `auto`
解析成了哪种语言，但 `ctx.remote.$host` 只暴露 `{ home, isLoopback }`，没有 locale；
包私有的 `host.call` RPC 需要 `harness.handle(method, fn)`，那只有动态包（vm-sandbox）
路径才有，普通 npm bundle 拿不到。降级方案是浏览器侧用同一条 `zh` 前缀规则自己重算一遍：
面板显示的是「解析结果」而不是宿主内部值，两者在同一条 `Intl` 规则下等价。
`documentAvailable` 同理——它由 `$host.isLoopback === true` 决定，非回环环境不提供打开
文件。面板整体是可选的：`ctx.inject(['settings'], …)`，没有 `settings` 服务的档位只是
没有这个页面，不影响守卫与触发器。

| 场景 | 行为 |
| --- | --- |
| agent 通过 `bash` / `pwsh` 工具执行 `git commit` | 检查并提示 |
| 提交信息含 `$(...)`、反引号，或 `-F -` 从 stdin 读 | 放弃判定，不提示 |
| agent 通过 `bash` / `pwsh` 执行 `gh pr create` | 检查标题与描述并提示 |
| PR 描述由 `--body-file -` 从 stdin 读 | 跳过描述规则，标题照常检查 |
| agent 通过 `bash` / `pwsh` 执行 `git tag` / `npm publish` | 检查发版并提示 |
| 读不到 `package.json` 或 CHANGELOG | 只跑能跑的规则，不提示缺文件本身 |
| agent 通过 `bash` / `pwsh` 执行危险 git 命令 | 按 `gitGuard` 策略 deny / ask |
| agent 用其它非 shell 路径提交、建 PR 或发版（如某个工具内部代办） | 不提示 |
| 命令写在脚本里、由 agent 执行该脚本 | 看不到——插件只看被调用的命令文本本身 |
| 用户在**自己的终端**里提交、建 PR 或发版 | 不提示——插件只在 DSH 会话内运行 |
| 运行时没有 `approval` 服务 | DSH 会把 `ask` 降级为拒绝；操作被拦下，而不是静默放行 |
| 本会话审批策略为 `never`（如 `danger-full-access` 预设） | 不再返回没人会回答的 `ask`：插件自己 `deny`，理由追加 `approval.disabled` 说明没有人被问到、两条放行路径，以及「设为『允许』会一直生效直到改回『询问』」的代价 |
| `mode: 'off'` | 监听器根本不注册，零常驻成本、零介入 |
| `enableOwnTrigger: false` / 某个守卫 `enabled: false` | 对应的监听器不注册（前者管三个约定触发器），其余照常工作 |
| 运行时没有 `subprocess` 服务 | `git` 读不到工作区，提交判定退化为只检查提交信息本身；守卫不受影响（它不需要读仓库） |

第五行与第六行是这套机制与 husky 的分工：**插件管会话内，husky 管会话外。**
作者在自己的终端里 `git commit` 时，唯一能拦住的仍然是 `.husky/` 里的钩子；
插件的价值在于让 agent 在提交之前就知道规范，而不是代替 git 钩子。

第七行的行为来自 DSH 本身（`serviceAsk` 在缺少 approval 时把 `ask` 变成 deny），
**不是本插件主动选择的**：如果宿主没有审批能力，我们宁可挡住，也不假装问过。

第八行是本插件**主动**补的那一半。`never` 下 `decide()` 会在提问前返回 `rejected`，
dispatcher 再把它说成「用户拒绝了工具」——用户什么都没看到。结果无法更好（操作都是被拒），
但理由可以更诚实，至少让用户知道没有人被问到、以及在哪里放行。实现是
`src/approval-policy.ts` 的 `unaskable()`，七个监听器共用；读不到策略或没有会话时一律
维持 `ask`，因为「不知道」不该被猜成「不会有人回答」。

## 手动路径

`/dev-workflow check` 走同一套判定，只是不需要等待提交：

- 取当前工作区的变更文件集，跑 `evaluate()`，把结果渲染成 `⚠` / `✖` 清单。
- 同时把结果记入状态，所以随后的自动检查能看到「最近一次检查结果」。

`/dev-workflow on | off` 切换的是**注册本身**：`off` 会把两个工具、技能 provider、
命令和全部事件监听器注销（`mode: 'off'` 时则一开始就不注册），
所以关掉之后常驻增量为零，而不只是「安静地不回答」。详见
[docs/TOKEN-BUDGET.md](TOKEN-BUDGET.md)。

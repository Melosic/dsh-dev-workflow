# 配置参考

本文件是 `src/config.ts` 的对照说明。配置面由 Schemastery 声明，**每个字段都带默认值**，
因此空配置解析出的就是文档里描述的基线：插件开着、危险 git 操作与危险 shell 命令一律 `ask`、
没有任何操作被默认放行、四道守卫与审计记录全部启用。

配置写在 DSH profile 里，`apply` 之前由宿主完成校验与填默认值——插件内部永远看不到「未填」的状态。
它也可以在 DSH 设置里的**可视化面板**中修改，两条路写的是同一份配置源：面板保存后落进当前
profile 的 `cordis.patch.yml`，插件无需重启就会读到新值（详见 [可视化面板](#可视化面板)）。

## 顶层

| 字段 | 类型 | 默认值 | 作用 |
| --- | --- | --- | --- |
| `codePaths` | `string[]` | `['src/']` | 算作「代码」的路径前缀，用于判断文档是否滞后 |
| `docs` | 对象 | 见下 | 文档相关路径 |
| `rules` | 对象 | 见下 | 机械约定 |
| `commitCheck` | 对象 | 见下 | 提交信息检查的开关、档位与类型清单 |
| `docsCheck` | 对象 | 见下 | 文档同步检查的开关 |
| `mode` | `'on' \| 'off'` | `'on'` | 总开关。`off` 不注册任何东西，常驻成本为零 |
| `locale` | `'auto' \| 'en-US' \| 'zh-CN'` | `'auto'` | 本插件自身文案的语言（**不是**设置页的语言，也**不**决定模型怎么写提交信息） |
| `enableOwnTrigger` | `boolean` | `true` | 是否运行自带的提交前检查 |
| `gitGuard` | 对象 | 见下 | 危险 git 操作的策略 |
| `commandGuard` | 对象 | 见下 | 危险 shell 命令的策略 |
| `fileGuard` | 对象 | 见下 | 不许读取的敏感路径 |
| `secretGuard` | 对象 | 见下 | 凭据泄漏预防 |
| `audit` | 对象 | 见下 | 审计记录的开关与路径 |

### `locale: 'auto'` 的解析时机

`auto` 在**插件加载时解析一次**（`src/i18n.ts` 的 `resolveLocale()`），判断依据是
`Intl.DateTimeFormat().resolvedOptions().locale` 是否以 `zh` 开头。

解析一次而不是每次读取时解析，是为了让技能目录条目与技能正文始终是同一种语言。
但它不是「只能重启才能换」：面板改 `locale` 后，宿主把新值提交进运行中的配置，
插件收到 `loader/volatile-update` 就重新解析一次，技能与提示语随之切换。
要写死在文件里就显式写 `en-US` 或 `zh-CN`。

面板在选中 `auto` 时会直接写出它当前解析成哪个语言（例如「当前为：中文（zh-Hans-HK）」）：
宿主在 node 进程里解析，面板只能在浏览器里问同一台机器的 `Intl`，两边用的是同一条
`zh` 前缀规则。这是面板自己的复刻，不是宿主回传的真值 —— 两者理论上可能不一致
（同一台机器上实际不会）。

这一项管的是**插件自身产出的文案**：检查结果、技能正文、审批提示。它管不到、也不该被理解成
「让模型用哪种语言写提交信息」——提交信息的语言规则写在技能里（subject 一律英文，正文与页脚
项目内自选一种），两种语言下的规则逐字相同。设置页本身的文案跟随 DSH 界面的语言（面板走客户端
`locale` 服务，`client.js` 里注册了 `settings.devWorkflow` 这个命名空间），改这一项不会切换设置页的语言。

## `docs`

| 字段 | 类型 | 默认值 | 作用 |
| --- | --- | --- | --- |
| `readme` | `string[]` | `['README.md', 'README.zh.md']` | 哪些文件算「README 类文档」 |
| `changelog` | `string` | `'CHANGELOG.md'` | CHANGELOG 的路径 |
| `docsDir` | `string` | `'docs/'` | 文档目录；其下的文件都算文档 |
| `adrDir` | `string` | `'docs/ADR/'` | ADR 目录。**当前已声明、尚未被任何检查读取** |
| `exclude` | `string[]` | `[]` | 算作文档的路径前缀；命中的文件不再被当成代码改动，因此不会触发文档滞后检查 |
| `mirrors` | `string[][]` | 三组 | 必须一起改动的文件组，每组一行 |

`mirrors` 的默认值是本仓库真实存在的三对文件：

```js
[
  ['README.md', 'README.zh.md'],
  ['locale/en.json', 'locale/zh.json'],
  ['skills/dsh-dev-workflow/SKILL.md', 'skills/dsh-dev-workflow/SKILL.zh.md'],
]
```

判定规则（`src/tools/check-doc-sync.ts`）：某一组里有文件被改动、但组内还有文件没被改动 → **报错**。
所以「改了 README.md 却没改 README.zh.md」是阻塞项，而不只是提醒。

`exclude` 在判定「这是不是一个代码改动」之前生效：命中前缀的路径既不算代码，也不算文档，
于是它可以用来把生成物、快照或脚本放进 `docs/` 这类目录里而不误报。

## `rules`

| 字段 | 类型 | 默认值 | 作用 |
| --- | --- | --- | --- |
| `branchPattern` | `string` | `^(feature\|fix\|docs\|hotfix\|chore)/[a-z0-9][a-z0-9._-]*$` | 分支命名规则。**当前已声明、尚未被任何检查读取** |
| `commitPattern` | `string` | 见下 | 提交头部的正则。**当前已声明、尚未被任何检查读取** |
| `requireChangelogOnFeat` | `boolean` | `true` | `feat` 提交必须带上 CHANGELOG 改动，否则阻塞 |

`commitPattern` 的默认值由 `COMMIT_TYPES` 派生，避免类型清单与正则漂移：

```js
`^(${COMMIT_TYPES.join('|')})(\\([^)]+\\))?!?: \\S`
```

`COMMIT_TYPES` 为 `feat` / `fix` / `docs` / `style` / `refactor` / `perf` / `test` / `build` /
`ci` / `chore` / `revert`。实际提交检查（`src/tools/check-commit-message.ts`）走的是这段类型
清单本身，而不是 `commitPattern`；后者留作把同一份规则交给其它工具时的可复用形式。

### `requireChangelogOnFeat` 与文档检查的分工

`check_doc_sync` 已经会软提示「改了代码但没动 CHANGELOG」。仓库规则把其中一种情况升级为硬规则：

| 提交类型 | 缺 CHANGELOG | 结果 |
| --- | --- | --- |
| `feat` | 是 | **阻塞**（`rules.requireChangelogOnFeat`） |
| 其它类型 | 是 | 软警告 |

同一次判定里只会出现一条：升级为阻塞时，那条软警告会被移除，不重复提示同一件事
（`src/checks.ts:146-166`）。

## `commitCheck`

| 字段 | 类型 | 默认值 | 作用 |
| --- | --- | --- | --- |
| `enabled` | `boolean` | `true` | 提交信息检查的开关。`false` 时提交前不再跑 `check_commit_message`，工具本身仍可手动调用 |
| `onFailure` | `'warn' \| 'block'` | `'block'` | 检查出的**硬性错误**是阻塞（默认）还是降级为警告 |
| `types` | `string[]` | 11 项 `COMMIT_TYPES` | 允许的提交类型 |
| `requireScope` | `boolean` | `false` | `true` 时「缺 scope」从软警告升为硬错误 |
| `subjectMaxLength` | `number` | `50` | 标题最长字符数，`min(1)` 且必须是整数 |

### 硬性错误与建议性警告

检查信息本身的轻重是固定的，`onFailure` 只决定「硬性错误要不要挡住提交」：

| 问题 | 轻重 |
| --- | --- |
| 头部不匹配 / 类型不在 `types` 里 | 硬性错误 |
| `!` 标了破坏性变更却没有 `BREAKING CHANGE:` footer | 硬性错误 |
| 标题超过 `subjectMaxLength` | 建议性警告 |
| 标题以句点结尾 | 建议性警告 |
| 缺 scope | 建议性警告；`requireScope: true` 时升为硬性错误 |

`onFailure: 'warn'` 只降级提交信息自身的硬性错误，**不影响文档同步检查**：那是另一类问题，
不该因为「这次只想提醒提交话术」而被一起放过。

`types` 在面板上是 11 个复选框；直接从文件改可以加入自定义类型，面板会把已选中的自定义值
原样保留并一并提交。

## `docsCheck`

| 字段 | 类型 | 默认值 | 作用 |
| --- | --- | --- | --- |
| `enabled` | `boolean` | `true` | 文档同步检查的开关 |
| `requireReadmeOnConfig` | `boolean` | `false` | 改动 `package.json` 或 `cordis.patch.yml` 却没动 `docs.readme` 里的任何文件时给一条警告 |

`docsCheck.enabled` 只作用于**提交前**那一次 `evaluate()`（连同其中的镜像配对与
`rules.requireChangelogOnFeat`）。`check_doc_sync` 工具不受它影响，始终是个可手动调用的检查——
否则面板上关掉它就会让「文档是否同步」这个问题彻底无法提问。

## `gitGuard`

| 字段 | 类型 | 默认值 | 拦截什么 |
| --- | --- | --- | --- |
| `enabled` | `boolean` | `true` | 守卫总开关 |
| `forcePush` | 动作 | `'ask'` | `git push --force` / `-f` / `+refspec` |
| `hardReset` | 动作 | `'ask'` | `git reset --hard` |
| `rebase` | 动作 | `'ask'` | `git rebase`（会重写历史） |
| `amend` | 动作 | `'ask'` | `git commit --amend` |
| `branchDelete` | 动作 | `'ask'` | `git branch -D`、`--delete --force` |
| `cleanForce` | 动作 | `'ask'` | `git clean -f`（删未跟踪文件） |
| `checkoutDiscard` | 动作 | `'ask'` | `git checkout -- <path>`（丢弃未暂存改动） |
| `noVerify` | 动作 | `'ask'` | `--no-verify`（跳过 git 钩子） |
| `rememberApproved` | `boolean` | `false` | 同会话内已批准过的同一条命令不再重复询问（需要档里挂了审批通道） |

「动作」是 `'deny' | 'ask' | 'allow'` 之一：

- `deny`：直接拒绝，工具调用带 `Error: <理由>` 返回给 agent。
- `ask`：走审批提示。**宿主没有审批能力时，DSH 会把 `ask` 变成拒绝**——宁可挡住，也不假装问过。
- `allow`：放行。**没有任何一项的默认值是 `allow`。**

### 三个不显然的默认值

**`noVerify` 默认 `ask`，绝不 `deny`。** `--no-verify` 是钩子本身出错时的逃生通道
（紧急修复、钩子误报）。把它默认改成 `deny` 会在最需要它的时候切断它。给它 `ask` 的意义是
「让人知道自己在跳过什么」，而不是「禁止跳过」。

**`rebase` 默认 `ask`，不是 `allow`。** rebase 会重写历史；已经推送过的分支上做这件事，
别人拉到的是被改写的提交。

**`cleanForce` 不复用 `hardReset` 的策略。** 两者丢弃的是不同的东西：`reset --hard` 丢的是
已跟踪文件的改动，`clean -f` 删的是未跟踪文件——后者更可能是「还没进版本控制的新工作」。

### 更严者胜

一条命令行里可能同时命中多项，例如 `git push --no-verify --force origin main`。
判定按 `deny > ask > allow` 取最严的一条；**同级时先入列者胜**，而操作本身排在修饰符
（`--no-verify`）之前，所以上面这条报的是 force push，而不是 no-verify——理由栏要说明
真正会丢工作的那个操作。

### `rememberApproved` 的记忆范围

DSH 的审批层是**一次性**的：`ApprovalOutcome` 里只有 `allowed-once`，没有 `allow-always`，
也没有授权存储（`dsh-user-approval` 的 README 明说这一点）。而守卫把 `ask` 交给 dispatcher 后
**拿不到那次提问的答案**。所以「记住我的选择」只能由插件自己发起提问：

`rememberApproved: true` 时，命中的操作若策略为 `ask`，git 守卫会自己经 `ctx.get('approval')`
发起审批，然后按答案处理：

| 答案 | 处理 |
| --- | --- |
| `allowed-once` | 放行，并把这次操作记进本会话 |
| `rejected` | 拒绝（`security.guard.approval_rejected`） |
| `cancelled` | 拒绝（`security.guard.approval_cancelled`） |
| `unavailable` | 拒绝（`security.guard.approval_unavailable`） |

被记住的是**一次具体调用**：工具名加上序列化后的参数。所以 `git clean -f` 与
`git clean -f -d` 是两次操作，换工作目录也是。记忆按会话隔离，插件重新加载即清空，绝不落盘。

边界（这几条是刻意的）：

- **只作用于 `ask`。** `deny` 永不经过这条路——把某项设成 `deny` 之后不存在「批准过一次就放行」。
- **拒绝不会被记成批准。** 只有 `allowed-once` 才写入记忆，其余三种都会在下一次重新提问。
- **`rejected` 不等于「用户点了拒绝」。** 审批策略为 `never`（例如 `danger-full-access` 预设）
  时，`dsh-user-approval` 的 `decide()` 会**在提问之前**直接返回 `rejected`
  （`dsh-user-approval/lib/index.js:175 if (this.effectivePolicy(session) === "never") return "rejected"`），
  根本没有人被问过。所以 `security.guard.approval_rejected` 只陈述结果（未获批准），
  不写「你拒绝了」——那会把平台的自动拒绝说成用户的决定。
- **没有审批通道时不自行提问。** 档里没挂审批服务、或这次调用没有 agent，守卫就把问题交回
  dispatcher（与开关关闭时逐字相同的行为），绝不把「问不出来」当成「同意了」。
- **不吞并别的 gate。** 若另一个 listener 已经拒绝，或者已经要提问，git 守卫不会自己再问一次：
  别的 gate 的答案不是它该记的。
- **默认关闭。** `false` 时行为与没有这个开关时完全一致。

### 权限策略为 `never` 时会发生什么

`danger-full-access` 预设把审批策略设为 `never`。它**不是「全部批准」**：`dsh-user-approval`
的 `decide()` 在询问任何审批方之前就返回 `rejected`（`dsh-user-approval/lib/index.js:175`），
于是 `dsh-tools` 把这次拒绝渲染成 `the user rejected tool "..."`（该包 `lib/index.js:3468`）。
用户什么都没看到，模型却被告知用户做了决定。

所以本插件的每一道 gate（四道守卫 + 三个触发器）在返回 `ask` 之前先读本会话的有效策略
（`effectivePolicy(session)`）。策略是 `never` 时，gate **自己**返回 `deny`：

- 结果与之前完全相同——该操作都是被拒绝；
- 理由保留 gate 自己的判定（是哪次 force push、哪个提交信息不合规），并追加
  `approval.disabled`（双字典同步），说明**没有人被问到**，以及两条放行路径：
  切换到会提问的权限预设，或把对应项设为「允许」而非「询问」。

刻意**不**改成静默放行：守卫静默放行就不是守卫（`src/guard/git-guard.ts:16-17`）。
读不到策略（档里没挂审批服务、审批服务没实现这个方法）或这次调用没有会话时，行为
与之前逐字相同——维持 `ask`，交给 dispatcher。**不知道就不猜**，否则会把一个能正常
提问、能被批准的操作变成拒绝。实现见 `src/approval-policy.ts` 的 `unaskable()`。

## `commandGuard`

检测危险 shell 命令。命令文本从工具调用的 `command` 字段读取，**不绑定具体工具名**
（本机是 `pwsh`，别处可能是 `bash`），判定复用 `src/shell.ts` 的词法切分。

| 字段 | 类型 | 默认值 | 拦截什么 |
| --- | --- | --- | --- |
| `enabled` | `boolean` | `true` | 守卫总开关 |
| `dangerousShell` | 动作 | `'ask'` | `rm -rf /`、`mkfs`、`dd ... of=/dev/sda`、fork 炸弹、`chmod -R 777 /` |

普通删除（`rm -rf node_modules`、`rm -rf ./dist`、`rm -rf /tmp/build`）不命中：判定看的是
**目标**，不是 `-rf` 本身。完整清单见 [docs/SECURITY.md](SECURITY.md#command-guard-保护什么)。

## `fileGuard`

从工具调用的参数里取路径并在**不打开文件**的前提下比对，命中即 `deny`。

| 字段 | 类型 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `enabled` | `boolean` | `true` | 守卫总开关 |
| `noRead` | `string[]` | 见下 | 不许读取的路径模式 |

```json
{ "fileGuard": { "noRead": [".env", ".ssh/id_rsa", "*.pem", "*.key", "credentials", "*.p12", ".npmrc", "secrets/"] } }
```

模式语法有三条规则：尾随 `/` 匹配该目录及其中一切；含 `/` 的模式在任意深度匹配
（`.ssh/id_rsa` 命中 `C:/Users/x/.ssh/id_rsa`）；否则匹配文件名，且首字符是 `.` 时同时覆盖
其变体（`.env` 覆盖 `.env.local`）。**列表是替换而不是追加**——给了一组自定义值，内置清单
就不再生效，设空数组等于关掉这一道。

这一道**没有档位字段**：它固定 `deny`，因为审批提示必须展示那条路径本身，而那正是规则要
挡住的东西。理由见 [docs/SECURITY.md](SECURITY.md#file-guard-保护什么)。

## `secretGuard`

扫描**每一次**工具调用的全部参数，命中即 `deny`。

| 字段 | 类型 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `enabled` | `boolean` | `true` | 守卫总开关 |
| `genericHighEntropy` | `boolean` | `false` | 额外标记无前缀的高熵字符串 |

**`genericHighEntropy` 默认关闭**，因为它是唯一会拦下普通文本的规则：长 base64、哈希、
压缩数据都可能越过熵阈值。需要时再打开，并预期要处理误报。

这一道同样**没有档位字段**：git 与命令守卫拦的是能重做的工作，覆盖档是合理的；凭据发出
即收不回，所以固定 `deny`。

## `audit`

| 字段 | 类型 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `enabled` | `boolean` | `true` | 是否写审计记录 |
| `path` | `string` | `'.dev-docs/audit-log.jsonl'` | 每行一个 JSON 对象；相对路径按调用的工作目录解析 |

审计记录写的是决策的形状：时间、会话、工具名、命中的规则 key、应用的档位、工作目录与
**脱敏后**的参数——凭据替换为 `[REDACTED]`，敏感路径只留文件名。写入同步落盘，失败只记
调试日志，绝不让一次工具调用因为写不出日志而失败。完整说明见
[docs/SECURITY.md](SECURITY.md#审计日志记什么)。

## 关闭与降级

| 想要的行为 | 配置 |
| --- | --- |
| 完全关掉插件（零常驻、零介入） | `mode: 'off'` |
| 只关掉提交前检查（交给 husky / commitlint） | `enableOwnTrigger: false` |
| 只关掉提交信息检查 | `commitCheck.enabled: false` |
| 只关掉文档同步检查 | `docsCheck.enabled: false` |
| 只关掉危险 git 命令守卫 | `gitGuard.enabled: false` |
| 只关掉危险 shell 命令守卫 | `commandGuard.enabled: false` |
| 只关掉敏感文件守卫 | `fileGuard.enabled: false` 或 `noRead: []` |
| 只关掉密钥守卫 | `secretGuard.enabled: false` |
| 只关掉审计记录 | `audit.enabled: false` |
| 让某个操作放行 | 把该项设为 `'allow'`（仅限有档位的守卫） |
| 让某个操作直接拒绝 | 把该项设为 `'deny'` |

`/dev-workflow on` / `off` 是 `mode` 的**运行期等价物**：它同样撤掉全部注册。区别是它不落盘，
插件重新加载后仍按 `mode` 决定。

## 可视化面板

面板与文件配置**同源**：面板不读也不写任何自己的存储，它走的是 DSH 的设置控制器
（`configForms`），保存后宿主把新值写进当前 profile 的 `cordis.patch.yml`，并通过
`loader/volatile-update` 提交给运行中的插件——**不需要重启**。面板里看到的就是文件里的值，
反过来说，手改文件后重新加载同样会反映到面板。

保存成功时底部会出现一行提示；它只说明「这一批值已经落到 profile 里了」，下一次编辑、取消或
关闭设置面板时就会消失。官方 `SettingsForm` 只报告失败，但本表单有 27 个字段，只靠按钮从
「可点」变回「不可点」来暗示成功，滚在顶部的人无从判断——所以这里补了一行明确的成功提示。
提示绑定在「这一次打开面板」上：设置面板关闭时会卸载这个 section，而草稿实例与插件同生命周期，
所以提示在这两者之间要显式清掉，否则下次打开面板会重放上次的保存提示。底部的两个按钮靠右对齐，
与官方表单一致。

### 面板可以改的（27 项）

| 分组 | 项目 |
| --- | --- |
| 工作流模式 | `mode`、`locale`、`enableOwnTrigger` |
| 提交规范 | `commitCheck.enabled`、`onFailure`、`types`、`requireScope`、`subjectMaxLength` |
| 文档同步 | `docsCheck.enabled`、`rules.requireChangelogOnFeat`、`docsCheck.requireReadmeOnConfig` |
| Git 安全 | `gitGuard.enabled`、八个操作档位、`gitGuard.rememberApproved` |
| 命令安全 | `commandGuard.enabled`、`commandGuard.dangerousShell` |
| 文件与密钥 | `fileGuard.enabled`、`secretGuard.enabled`、`secretGuard.genericHighEntropy` |
| 审计日志 | `audit.enabled` |

主区只有开关与枚举（加上 `subjectMaxLength` 这一个数字输入），不提供自由文本——路径与正则
是「写错就静默失效」的那一类值，不该交给一个没有校验的输入框。

### 只能在文件里改的（11 项）

面板的**高级**区（默认折叠、**只读**）展示其中 9 项，并提供一个打开当前 profile
`cordis.patch.yml` 的按钮：`codePaths`、`docs.docsDir`、`docs.adrDir`、`docs.changelog`、
`docs.exclude`、`rules.branchPattern`、`rules.commitPattern`、`docs.mirrors`、`audit.path`。

另外 2 项连展示都没有，因为它们只能由文件表达：`docs.readme`（哪些文件算 README 类文档）
与 `fileGuard.noRead`（不许读取的敏感路径清单）。一个路径清单不是开关或枚举，面板给不了
比编辑文件更好的体验。

### 面板不做什么

- **不重复 DSH 自带的插件总开关。** 插件的启用与停用是插件管理器的事，面板只负责插件内部的
  配置；`mode: 'off'` 是插件自己的「零常驻」语义，两者互不替代。
- **不改由 DSH 拥有的东西**（审批策略、沙箱模式、插件名册）。
- **不写入配置文件以外的地方。** 面板没有自己的持久化，也没有「仅本次会话生效」的开关。

## 相关文档

- 配置字段在代码里的唯一声明：`src/config.ts`
- 面板的浏览器半：`client.js`；Host 半（关闭 schema 页、`loader/volatile-update` 后重建注册）在 `src/index.ts:320-344`
- 每个工具的参数：`docs/TOOLS.md`
- 默认值为什么这样定：`docs/SECURITY.md`
- 守卫的判定细节与实测：`docs/TRIGGERS.md`

# 配置参考

本文件是 `src/config.ts` 的对照说明。配置面由 Schemastery 声明，**每个字段都带默认值**，
因此空配置解析出的就是文档里描述的基线：插件开着、危险 git 操作与危险 shell 命令一律 `ask`、
没有任何操作被默认放行、四道守卫与审计记录全部启用。

配置写在 DSH profile 里，`apply` 之前由宿主完成校验与填默认值——插件内部永远看不到「未填」的状态。

## 顶层

| 字段 | 类型 | 默认值 | 作用 |
| --- | --- | --- | --- |
| `codePaths` | `string[]` | `['src/']` | 算作「代码」的路径前缀，用于判断文档是否滞后 |
| `docs` | 对象 | 见下 | 文档相关路径 |
| `rules` | 对象 | 见下 | 机械约定 |
| `mode` | `'on' \| 'off'` | `'on'` | 总开关。`off` 不注册任何东西，常驻成本为零 |
| `locale` | `'auto' \| 'en-US' \| 'zh-CN'` | `'auto'` | 用户可见文案的语言 |
| `enableOwnTrigger` | `boolean` | `true` | 是否运行自带的提交前检查 |
| `gitGuard` | 对象 | 见下 | 危险 git 操作的策略 |
| `commandGuard` | 对象 | 见下 | 危险 shell 命令的策略 |
| `fileGuard` | 对象 | 见下 | 不许读取的敏感路径 |
| `secretGuard` | 对象 | 见下 | 凭据泄漏预防 |
| `audit` | 对象 | 见下 | 审计记录的开关与路径 |

### `locale: 'auto'` 的解析时机

`auto` 在**插件加载时解析一次**（`src/i18n.ts` 的 `resolveLocale()`），之后不再变化。
判断依据是 `Intl.DateTimeFormat().resolvedOptions().locale` 是否以 `zh` 开头。

解析一次而不是每次读取时解析，是为了让技能目录条目与技能正文始终是同一种语言；
运行中的会话语言本来也不会变。要换语言就显式写 `en-US` 或 `zh-CN` 并重新加载插件。

## `docs`

| 字段 | 类型 | 默认值 | 作用 |
| --- | --- | --- | --- |
| `readme` | `string[]` | `['README.md', 'README.zh.md']` | 哪些文件算「README 类文档」 |
| `changelog` | `string` | `'CHANGELOG.md'` | CHANGELOG 的路径 |
| `docsDir` | `string` | `'docs/'` | 文档目录；其下的文件都算文档 |
| `adrDir` | `string` | `'docs/ADR/'` | ADR 目录。**当前已声明、尚未被任何检查读取** |
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
| 只关掉危险 git 命令守卫 | `gitGuard.enabled: false` |
| 只关掉危险 shell 命令守卫 | `commandGuard.enabled: false` |
| 只关掉敏感文件守卫 | `fileGuard.enabled: false` 或 `noRead: []` |
| 只关掉密钥守卫 | `secretGuard.enabled: false` |
| 只关掉审计记录 | `audit.enabled: false` |
| 让某个操作放行 | 把该项设为 `'allow'`（仅限有档位的守卫） |
| 让某个操作直接拒绝 | 把该项设为 `'deny'` |

`/dev-workflow on` / `off` 是 `mode` 的**运行期等价物**：它同样撤掉全部注册。区别是它不落盘，
插件重新加载后仍按 `mode` 决定。

## 相关文档

- 配置字段在代码里的唯一声明：`src/config.ts`
- 每个工具的参数：`docs/TOOLS.md`
- 默认值为什么这样定：`docs/SECURITY.md`
- 守卫的判定细节与实测：`docs/TRIGGERS.md`

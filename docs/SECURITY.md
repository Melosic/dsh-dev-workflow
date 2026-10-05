# 安全策略

本文件说明本插件在安全上做了什么、没做什么，以及为什么默认值是现在这些值。

一句话原则：**安全默认，显式确认，最小权限。**

## 三句话的范围

| 说法 | 实际含义 |
| --- | --- |
| 默认安全 | 所有危险操作的默认动作是 `ask`，**没有任何一项默认 `allow`**；插件关掉时零常驻、零介入 |
| 显式确认 | 命中危险操作时走审批提示，由人决定；宿主没有审批能力时 DSH 把 `ask` 变成拒绝 |
| 最小权限 | 插件不读敏感文件、不执行 git 以外的程序、不联网、不落盘任何状态 |

**v0.1.0 只做 git-guard。** command-guard、file-guard、secret-guard、审计日志完整脱敏
推迟到 v0.2.0——写在没有实现之前属于承诺，而承诺不是防护。

## git-guard 保护什么

| 操作 | 策略键 | 默认 | 为什么危险 |
| --- | --- | --- | --- |
| `git push --force`（含 `-f`、`+refspec`） | `forcePush` | `ask` | 重写远端历史，可能丢掉他人提交 |
| `git reset --hard` | `hardReset` | `ask` | 永久丢弃未提交改动 |
| `git rebase` | `rebase` | `ask` | 重写历史（已推送的分支上尤其） |
| `git commit --amend` | `amend` | `ask` | 改写已发布的提交 |
| `git branch -D` / `--delete --force` | `branchDelete` | `ask` | 丢掉只存在于该分支的提交 |
| `git clean -f` | `cleanForce` | `ask` | 永久删除未跟踪文件 |
| `git checkout -- <path>` | `checkoutDiscard` | `ask` | 丢弃未暂存的改动 |
| `--no-verify` | `noVerify` | `ask` | 跳过保护仓库的钩子 |

判定细节与实测用例见 [docs/TRIGGERS.md](TRIGGERS.md)。

### 更严者胜

一条命令行可能同时命中多项。判定按 `deny > ask > allow` 取最严的一条——**别人的策略比自己的严
时绝不削弱它**。唯一的覆盖方向是「自己 `deny` 对上上游 `ask`」时返回自己的 `deny`，
因为拒绝一个已经在被质疑的调用不会让情况变坏；反方向（把上游的 `deny` 变成 `ask`）永远不会发生。

上游返回 `cancel`（调用已中止）时原样透传，不做任何判断。

## 三个默认值的理由

**`noVerify` 默认 `ask`，不默认 `deny`。** `--no-verify` 是钩子本身出错时的逃生通道
（紧急修复、钩子误报、CI 阻塞下的止损）。默认 `deny` 会在最需要它的时候切断它，
而人一旦发现逃生通道被锁，下一步往往是绕过整个插件。给它 `ask` 的意义是
「让人知道自己在跳过什么」。

**`rebase` 默认 `ask`，不默认 `allow`。** rebase 会重写历史。在本地未推送的分支上它完全
正常，在已推送的分支上则会让别人的 clone 失效——而这正是插件无法判断的事，所以交给确认。

**`cleanForce` 不复用 `hardReset`。** 两者丢弃的东西不同：`reset --hard` 丢的是已跟踪文件的
改动，`clean -f` 删的是未跟踪文件——后者更可能是「还没进版本控制的新工作」，
需要独立决策。

**裸 `--force` 会附带改用 `--force-with-lease` 的建议。** `--force-with-lease` 在覆盖一个
你尚未看到的提交时会失败，正是我们想避免的事故。建议出现在理由的第二行，
让「有没有更安全的写法」和「要不要继续」在同一个提示里被回答。

## 不做什么

| 不做的事 | 原因 |
| --- | --- |
| 不读敏感文件 | 插件不需要仓库内容，只需要路径列表。`.env`、密钥文件不在任何检查的输入里 |
| 不执行 git 以外的程序 | 唯一的子进程是 `git`，经 `subprocess` 服务的 `resolveExecutable('git')` |
| 不联网 | 插件没有任何网络调用 |
| 不落盘状态 | 去重状态与命中计数只在内存（`src/state.ts`）；重启即清空 |
| 不写日志到文件 | 只经 `ctx.logger.debug` 输出，且日志里是字典 key，不是提交信息全文 |
| 不硬编码密钥 | 插件不持有任何凭据，也不需要 |

### 日志里有什么

守卫命中时记一行：`[dsh-dev-workflow] git guard: security.guard.force_push`——
**记的是规则标识，不是命令行全文**。提交信息同样不进日志。

原因是不落盘的日志常常会被重定向到文件或随 issue 提交；把命令行与提交信息全文写进去，
等于把「作者正在做什么、改动里有哪个客户名」这类信息搬到了另一个地方。
规则标识足够定位问题，且不携带内容。

## 与宿主的分工

| 层 | 负责什么 |
| --- | --- |
| DSH 宿主 | 工具派发、审批服务、`ask` 在没有审批能力时降级为拒绝 |
| 本插件 | 在门禁上判断命令是否危险，给出 `deny` / `ask` / `allow` |
| `.husky/` + commitlint | 用户在自己终端里提交时的强制校验 |
| GitHub 分支保护 | 合并前必须 PR、必须 CI 通过、禁止直接 push、禁止强推与删除 |

**插件管会话内，husky 管会话外。** 用户在**自己的终端**里 `git commit` 或 `git push --force`
时，插件看不到——它只在 DSH 会话的工具调用路径上运行。这不是可以靠更多代码弥补的缺口，
而是分工：会话外的最后一道门是 git 钩子与 GitHub 分支保护。

相应地，**本插件不是安全边界**。它降低事故概率，不能阻止一个决意绕过的操作者
（关掉插件、换终端、直接调 git 都能绕过）。把它当护栏，不要当门锁。

## 依赖与供应链

- **运行期零依赖**：`dependencies` 为空。全部能力来自宿主提供的服务与 Node 内建模块。
- DSH 域内包用**显式版本范围** `>=0.2.0-rc.1 <0.3.0`，不用 `^` / `~`：
  0.x 版本的次版本号可以包含破坏性变更，`^0.2.0` 的语义在这里会误导人。
- 插件通过 `cordis.patch.yml` 声明为 bundle patch，`scripts/ci-checks.mjs` 校验它
  既被 `package.json` 的 `dsh.bundle.patch` 声明，又列入 `files`——避免「发布出去的包缺了
  挂载点」这类只在用户机器上暴露的问题。

## 相关文档

- 判定细节与边界：[docs/TRIGGERS.md](TRIGGERS.md)
- 策略字段与取值：[docs/CONFIGURATION.md](CONFIGURATION.md)
- 规范中的安全操作规范：[skills/dsh-dev-workflow/SKILL.md](../skills/dsh-dev-workflow/SKILL.md)
- 为什么是插件而不是模式：[docs/ADR/002-plugin-not-preset.md](ADR/002-plugin-not-preset.md)

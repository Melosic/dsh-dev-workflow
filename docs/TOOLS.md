# 工具参考

本插件向模型暴露两个工具，加上一个不需要模型参与的命令。本文件列出它们的合同：
名字、参数、返回结构，以及被截断或降级时的行为。

工具定义在 `src/tools/`，由 `src/index.ts` 的 `activate()` 通过 `ctx.tools.register()` 注册。

## 命名约束

工具名只能包含 `[A-Za-z0-9_-]`，不超过 64 字符，**不得使用 `:` 等命名空间分隔符**——
这是 DeepSeek function-name 合同，不是本仓库的偏好。因此没有 `check:commit` 这类名字，
而是 `check_commit_message` / `check_doc_sync`。

两个工具都是幂等的纯查询：读参数、返回结论，不改动仓库、不写文件。

## `check_commit_message`

按 Conventional Commits 校验一条提交信息。

### 参数

| 名称 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `message` | `string` | 是 | 完整提交信息：标题、可选正文、可选页脚 |
| `files` | `string[]` | 否 | 这次提交涉及的文件路径。只用于「跨模块提交」与「缺少 scope」两条软提示 |

`files` 省略时不报错，只是少两条判断；提交信息的机械检查不依赖它。

### 返回

```ts
{
  ok: boolean          // 是否没有阻塞问题
  errors: string[]     // 阻塞问题
  warnings: string[]   // 可忽略的建议
}
```

工具 schema 里另有一个可选的 `error` 字段，用于「检查本身无法进行」的情况；
本工具是纯字符串判定，不会产生它（`check_doc_sync` 会）。

渲染成文本时：有 `error` 只输出该行；否则两个数组都为空输出一行通过语；
否则 `✖ ` 逐条列出阻塞项、`⚠ ` 逐条列出建议（`src/tools/result.ts`）。

### 判定规则

**阻塞项**

| 规则 | 触发条件 |
| --- | --- |
| `error.empty` | 标题为空 |
| `error.missing_type` + `hint.format` | 标题不匹配 `^([a-z]+)(\([^)]*\))?(!)?:\s*(\S.*)$` |
| `error.unknown_type` | 类型不在 `COMMIT_TYPES` 清单里 |
| `error.breaking_without_footer` | 标题带 `!` 但正文里没有 `BREAKING CHANGE:` |

**建议（`warnings`）**

| 规则 | 触发条件 |
| --- | --- |
| `warn.subject_length` | 标题描述部分超过 50 字符（`SUBJECT_MAX_LENGTH`） |
| `warn.trailing_period` | 标题以 `.` 结尾 |
| `warn.body_width` | 正文某行超过 72 字符（`BODY_MAX_LENGTH`）。只报第一条；URL 行与表格行豁免 |
| `warn.multiple_modules` | `files` 跨了多个顶层目录 |
| `warn.missing_scope` | 没写 scope，且 `files` 只涉及一个模块 |

标题长度按**描述部分**算：`feat(auth): add login` 里参与长度检查的是 `add login`。

### 为什么软规则只给建议

标题过长、句尾句号、正文过宽都是风格问题。工作流规范里它们是「应当」，不是「必须」。
把它们定为阻塞会让工具在无关紧要的地方拦住提交，而插件在提交前的位置只有一次开口机会——
用在不值得的地方，下次就会被整体关掉。

## `check_doc_sync`

检查文档是否跟着代码一起动。

### 参数

| 名称 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `files` | `string[]` | 否 | 本次变更的文件路径。省略时自己跑 `git status` 取 |

省略 `files` 时，工具通过 `ctx.get('subprocess')` 执行：

```
git status --porcelain=v1 --untracked-files=all
```

**一次调用只跑一次 git。** 解析逐行进行：跳过非变更行，取状态码之后的路径，
rename 形态（`old -> new`）取右侧，并还原 git 的 C 风格转义（`\"`、`\\`、`\t`、`\n`）。

### 返回

与 `check_commit_message` 同构，另外可能带 `error`：

```ts
{
  ok: boolean
  errors: string[]
  warnings: string[]
  error?: string       // 例如 error.not_a_git_repository / error.git_not_available
}
```

`error` 的取值来自 git 失败的分类（`src/git.ts` 的 `GitFailure`）：
`git-not-available` / `not-a-git-repository` / `cancelled` / `command-failed`，
下划线化后作为字典 key，并把 git 的 stderr 作为 `{detail}` 填进文案。

### 判定规则

| 严重性 | 规则 | 触发条件 |
| --- | --- | --- |
| 阻塞 | `error.mirror` | `config.docs.mirrors` 某一组里，有文件被改动而组内还有文件没被改动 |
| 建议 | `warn.no_document` | 命中 `config.codePaths` 的代码被改动，但 `docsDir`、`docs.readme`、`changelog` 全都没动 |
| 建议 | `warn.changelog` | 有代码改动，但 CHANGELOG 没动 |

「算代码」的定义：路径以 `config.codePaths` 里任一前缀开头，且**不在** `config.docsDir` 之下。
后者避免把文档自己的改动当成代码。

第三条（`warn.changelog`）在 `feat` 提交里会被升级为阻塞项，见
[docs/CONFIGURATION.md](CONFIGURATION.md#requirechangelogonfeat-与文档检查的分工)。

## `/dev-workflow` 命令

命令由 `ctx.get('commands')` 注册，**没有命令服务时静默跳过**。命令输入不会变成模型消息
（`dsh-commands` 的设计如此），所以它是「关掉插件」「现在检查一下」这类操作的合适位置：
它们不属于对话记录。

| 子命令 | 行为 |
| --- | --- |
| 无参数 / `status` | 输出四行：开关状态、locale（含配置里的原始值）、最近一次检查结果、守卫命中计数 |
| `on` | 注册全部资源，并回显状态行 |
| `off` | 注销全部资源（工具、技能 provider、命令、两个监听器），并回显状态行 |
| `check` | 对当前工作区跑一次 `evaluate()`，结果记入状态，输出 `✖` / `⚠` 清单 |
| 其它 | `{kind: 'error'}`，提示可用取值 |

`status` 的守卫命中计数把字典 key 渲染成可读文本并带上次数，例如
`Guard hits: A force push rewrites remote history…×2, git clean -f deletes untracked files permanently.×1`；
一次都没命中时输出一条明确的「无」。

`check` 在 git 不可用或不在仓库里时返回 `{kind: 'error', text}`，而不是抛异常。

### 注销是真的注销

`off` 会调用每个注册返回的 disposer，之后常驻增量为零。它不只是「安静地不回答」——
理由与实现见 [docs/ARCHITECTURE.md](ARCHITECTURE.md#为什么注册要额外绑一次-effect)。

## 相关文档

- 配置字段（`codePaths`、`docs`、`mirrors`）：[docs/CONFIGURATION.md](CONFIGURATION.md)
- 同样两个判定如何被触发器复用：[docs/TRIGGERS.md](TRIGGERS.md)
- 语言与文案：[docs/I18N.md](I18N.md)

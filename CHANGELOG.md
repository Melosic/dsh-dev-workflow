# 更新日志

本文件记录 dsh-dev-workflow 的所有重要变更。

格式遵循 [Keep a Changelog 1.1.0](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循 [语义化版本 SemVer](https://semver.org/lang/zh-CN/)。

> **关于 0.x 阶段**：本项目尚处于 0.x 阶段，不保证向后兼容性。
> 按 SemVer 规范，MAJOR 位为 0 时，MINOR 位变更即可包含破坏性变更。
> 每个破坏性变更都会在本文件中显式标注 `BREAKING`。

## [Unreleased]

### Added

- **可视化设置面板。** 插件现在在 DSH 设置里有一张自己的卡片，由两半组成：浏览器半
  `client.js`（手写的模块表格式，注册进 `settings.section` 槽位）与 Host 半
  （`src/index.ts` 里关闭 schema 自动页、并监听 `loader/volatile-update`）。
  - **与文件配置同源。** 面板没有自己的存储：保存经宿主的设置控制器写入当前 profile 的
    `cordis.patch.yml`，再提交进运行中的配置引用，**不需要重启**；`locale` 也会随之
    重新解析。
  - 27 项可在面板修改（开关与枚举，外加 `commitCheck.subjectMaxLength` 一个数字输入）；
    8 个危险 git 操作的档位、四道守卫与审计的开关、提交与文档两组检查的规则都在其中。
  - 9 项（`codePaths`、`docs.docsDir`、`docs.adrDir`、`docs.changelog`、`docs.exclude`、
    `rules.branchPattern`、`rules.commitPattern`、`docs.mirrors`、`audit.path`）只读展示在
    默认折叠的**高级**区，旁边有按钮直接打开 profile 的 `cordis.patch.yml`；另有 2 项
    （`docs.readme`、`fileGuard.noRead`）只能改文件。路径与正则不下沉到主区：写错就静默失效
    的值不该交给没有校验的输入框。
  - **不重复 DSH 的插件总开关**，也不改由 DSH 拥有的设置（审批策略、沙箱模式）。
  - 样式只用主题发布的 `--dsw-alias-*` token，类名统一 `dsw-dev-workflow-` 前缀，
    `<style>` 带 `data-plugin` / `data-plugin-css`，HMR 能按归属清理。
- **配置面补齐并全部标记为可变。** `src/config.ts` 的每个叶子都加了 `.volatile()`——这是
  面板能读到并写入的前提；新增九个字段：
  - `commitCheck`：`enabled`（默认 `true`）、`onFailure`（`'warn' | 'block'`，默认 `block`）、
    `types`（默认 11 个 `COMMIT_TYPES`）、`requireScope`（默认 `false`，开启后「缺 scope」
    从软警告升为硬错误）、`subjectMaxLength`（默认 `50`，`min(1)` 且必须是整数）。
  - `docsCheck`：`enabled`（默认 `true`，只作用于提交前那次判定，`check_doc_sync` 工具不受
    影响）、`requireReadmeOnConfig`（默认 `false`：改 `package.json` / `cordis.patch.yml`
    却没动 README 类文档时给一条警告）。
  - `docs.exclude`（默认 `[]`）：命中的路径既不算代码也不算文档，用来排除生成物。
  - `gitGuard.rememberApproved`（默认 `false`）：见下一条。
- **`gitGuard.rememberApproved`：记住一次批准，同一操作本会话不再询问。** DSH 的审批是
  一次性的（`allowed-once`，没有 `allow-always`，也没有授权存储），而守卫把 `ask` 交给
  dispatcher 后**看不到答案**。所以开启后 git 守卫经 `ctx.get('approval')` 自己发起审批、
  自己读结果：`allowed-once` 放行并记进会话，`rejected` / `cancelled` / `unavailable` 一律拒绝。
  记忆键是「工具名 + 序列化参数」，`git clean -f` 与 `git clean -f -d` 是两次操作，换工作
  目录也是；按会话隔离，插件重新加载即清空，不落盘。`deny` 永不经过这条路；档里没有审批服务
  时把问题交回 dispatcher（与开关关闭时逐字相同），绝不把「问不出来」当成「同意了」；
  别的 gate 已经拒绝或已经要提问时也不自行再问。
- **补全四类安全守卫。** v0.1.0 只有 git-guard，其余三类是写在文档里的承诺；现在它们
  都是代码，并且共用 `src/guard/shared.ts` 的 `createGuard()`（接线、命中计数、审计回调、
  档位决策各一份实现）。
  - `src/guard/command-guard.ts`：拦截不可逆的 shell 命令——`rm -rf /`（含 `/*`、`~`、`.`、
    `*` 等危险目标）、`mkfs` 系列、`dd` 的 `if=`/`of=` 指向块设备、`> /dev/sda`、
    fork 炸弹、`chmod -R 777 /`。默认 `ask`（`commandGuard.dangerousShell`），
    普通删除（`rm -rf node_modules`、`rm -rf ./dist`）放行。
  - `src/guard/file-guard.ts`：从每次工具调用的参数里取路径（`file_path` / `path` /
    `pattern` / `include`，以及 shell 里已知读取程序的操作数），比对 `fileGuard.noRead`
    （默认 `.env`、`.ssh/id_rsa`、`*.pem`、`*.key`、`credentials`、`*.p12`、`.npmrc`、
    `secrets/`），命中即 `deny`。理由里给出文件名与命中的规则，**从不打开文件**。
  - `src/guard/secret-guard.ts`：扫描每次调用的全部参数，识别 AWS access key、GitHub
    token（`ghp_`/`gho_`/`ghs_`/`ghr_`）、Slack token（`xox[baprs]-`）与私钥头，
    命中即 `deny`；可选的 `secretGuard.genericHighEntropy`（默认关）额外标记无前缀的
    高熵字符串。**只报模式名，绝不回显匹配到的值**，同一条值也不进入审计记录。
  - `src/audit.ts`：审计记录写入 `audit.path`（默认 `.dev-docs/audit-log.jsonl`，每行一个
    JSON 对象）。记录守卫决策的形状与**脱敏后**的参数——凭据替换为 `[REDACTED]`，
    敏感路径只保留文件名；同步追加，写失败只记调试日志，绝不让工具调用失败。
  - `src/config.ts`：新增 `commandGuard` / `fileGuard` / `secretGuard` / `audit` 四组配置，
    全部安全默认（`enabled: true`、危险命令 `ask`、没有任何一项默认 `allow`）。
  - `locale/en.json` + `locale/zh.json`：8 个新 key，两本字典 key 与占位符保持对齐。
- `/dev-workflow status` 增加第五行：审计记录的开关与路径。
- **补全 PR 触发器与发版触发器。** v0.1.0 只有提交前触发器；现在三个约定触发器齐备，
  共用 `src/triggers/shared.ts` 的 `detailsOf()` / `askAbout()`（截断、双语 `displayReason`、
   `MAX_DETAILS = 5` 各一份实现），由 `enableOwnTrigger` 统一开关。
  - `src/triggers/pre-pr.ts`：识别 `gh pr create`，校验 PR 标题（**直接复用
    `checkCommitMessage`**——squash merge 后标题就是 main 上的提交信息）、描述的
    `## What` / `## Why` / `## How to verify` 三段（缺段或段内为空都算缺失）、
    未勾选的 `- [ ]` 清单项；无 `#<数字>` 的 Issue 引用只给警告。支持
    `--title` / `--body` / `--body-file`（含 `--opt=value` 写法），
    `-F` 指向的文件在判定时刻读取，`-F -` 跳过描述规则。
  - `src/triggers/pre-release.ts`：识别 `git tag <name>` 与 `npm`/`pnpm publish`（同一条命令
    行两件都做时一起收集）。校验 SemVer、tag 与 `package.json` 的 `version` 是否一致、
    预发布版本是否被推到 `latest`（未写 `--tag` 时按 npm 的默认值记为 `latest`）、
    CHANGELOG 是否有 `## [Unreleased]` 段、段内 `###` 分类是否为 Keep a Changelog 的六类之一、
    `[Unreleased]` 与 `[<version>]` 是否两段皆空。
  - `src/state.ts` 的 `CheckKind` 由 `'commit' | 'doc'` 扩为四种，新增 `'pr' | 'release'`；
    targetId 分别为标题指纹与版本号。
  - `locale/en.json` + `locale/zh.json`：新增 `command.toggle.kind.pr` /
    `command.toggle.kind.release` 与两个触发器的文案，共 17 个新 key；
    `trigger.pre_commit.omitted` 提升为共用的 `trigger.omitted`。

- **补全架构决策记录。** `docs/ADR/` 从两份扩到五份，三份新 ADR 补齐了此前只在
  `docs/TOKEN-BUDGET.md`、`.dev-docs/prompt.md` 与代码注释里零散存在的推理过程：
  - `docs/ADR/003-summary-plus-on-demand.md`：为什么常驻的只有一行目录条目与两个工具定义、
    规范全文按需读取；含 token 成本算法（全文常驻 ≈ 2600 token/轮，是验收线的十倍）。
  - `docs/ADR/004-action-triggered-not-manual-mode.md`：为什么按动作自动触发而不让用户手动切档；
    **记录了手动切档的失败教训——用户会忘记切，而忘记切比不装更糟**。
  - `docs/ADR/005-agents-md-as-context-anchor.md`：`AGENTS.md` 与 `SKILL.md` 的分工
    （每轮都要成立的稳定规则 vs 做事时才读的规范全文），含
    `@deepseek-ai/dsh-agent-instructions` 的加载链、候选名、65536 字节预算与「不 watch」约束。

### Changed

- **DSH `peerDependencies` 改为只写下界 `>=0.2.0-rc.2`，去掉上界 `<0.3.0`。**
  三个 DSH 域内包（`@deepseek-ai/dsh` / `dsh-skill` / `dsh-tools`）都改成这一条。
  下界从 `rc.1` 抬到 `rc.2` 是因为实测基线就是 `0.2.0-rc.2`（本机 `dsh --version` 与
  三个包的实际版本），凭记忆写更低的下界等于宣称一段没人验过的兼容性。
  去掉上界是**明确的取舍**：`0.3.0` 尚不存在，`<0.3.0` 只是猜测，而代价是 DSH 一旦升到
  `0.3`，即使 API 变了插件也会被加载、问题推迟到运行时才暴露，不再由加载时的 `preflight()`
  干净地禁用。规则与代价已写进 `docs/PUBLISHING.md` 第 4 条，`docs/SECURITY.md` 的
  供应链一节同步；`README.md` / `README.zh.md` 的环境要求表随之更新。
- `README.md` / `README.zh.md` 新增「环境要求」一节：DSH 运行时 `>=0.2.0-rc.2`、
  Node.js `>=20`、pnpm `10.x`，以及各自的查看方式。此前这三条只写在 `CONTRIBUTING.md` 里
  （贡献者视角），**使用者视角的要求一条都没有**；其中最容易踩的是 DSH 版本——不在范围内
  的后果是被静默禁用而不是安装失败，所以连症状和排查入口一并写在了 README 里；
  `docs/README.md` 的 README 那行也补上了这一节。
- `README.md` / `README.zh.md` 里 DSH 的链接从 GitHub 组织页 `github.com/deepseek-ai`
  换成了真正的仓库 `github.com/deepseek-ai/deepseek-harness`（后者才是这三个
  peerDependencies 的来源 monorepo，`ACKNOWLEDGEMENTS.md` 一直链的是它）。
- `docs/README.md` 的「我想知道为什么这样设计」一节从一行 ADR 目录扩为逐份登记
  （001–005 各一行说明 + 模板），并补上 ADR 现在有五份。
- `docs/PUBLISHING.md` 补三节：**bundle manifest 完整性检查**（四处链路逐条核对，
  其中两条无自动守卫，必须靠 `pnpm pack --dry-run` 与一次真实安装确认）、
  **0.x 阶段的撤回策略**（按「是否对已装用户造成实际伤害」分三类处置，
  因为 0.x 允许 MINOR 位带破坏性变更，不兼容本身不是撤回理由）、
  以及 `unpublish` 的三个技术前提（72 小时窗口、只接受单个版本或整个项目、
  撤掉最后一个版本会被拦且 24 小时内发不回来）；并把 `ci:checks` 输出示例里的
  过期数字 `locale keys aligned (56 keys)` 更正为 81。
- `docs/SECURITY.md` 从「v0.1.0 只做 git-guard」改写为四道守卫的完整说明，含各自的
  默认值与理由；`docs/CONFIGURATION.md` 补四组新配置；`docs/TRIGGERS.md` 与
  `docs/ARCHITECTURE.md` 的监听器数量与次序更正为「约定 → git → 命令 → 文件 → 密钥」；
  `docs/DEVELOPMENT.md` 补一节「加一整道新守卫要动什么」。
- `docs/TRIGGERS.md` 补 PR 与发版两个断点的完整说明：为什么三者都挂在 `tools/pre-execute`
  （事件目录里没有 PR 创建或发版事件，但动作本身经过 `bash` / `pwsh`，能在动作发生前拦下，
  不构成降级条件）、各自的识别规则与检查项、状态模型扩为四种 `checkType`，
  并更新能力边界表。
- `docs/PUBLISHING.md` 的 v0.1.0 发布记录补上真实结果：提交 `219dbdb`、PR #11、
  annotated tag、发布产物 66 文件 / `shasum 8e35f3866fe53bd1973577ddf1ccbb73e5e0ff4b`、
  发布认证需要 bypass-2FA 的 granular token、以及 GitHub Release 地址；
  并记下「发布成功后 packument 短时 404 是 CDN 负缓存，判断发布是否成功应看 PUT 状态码
  与 tarball shasum」。

## [0.1.0] - 2026-10-05

### Added

- 项目骨架：`package.json`、`tsconfig.json`、`cordis.patch.yml`、`.gitignore`、
  `.editorconfig`、`.gitattributes`。
- 工具链配置：ESLint 9 flat config、Prettier、Vitest。
- `scripts/with-src.mjs`：在 `src/` 尚不存在时跳过 `tsc`，使 `build` / `typecheck` 保持可跑通。
- `AGENTS.md`：面向 AI 编码工具的稳定规则（核心原则、关键约束、常用命令、详细规范入口）。
- 双语 README：`README.md`（英文）与 `README.zh.md`（中文）。
- `CONTRIBUTING.md`：环境搭建、分支命名、提交规范、PR 流程、国际化同步规则、安全操作规范。
- `LICENSE`：MIT。
- `locale/en.json` 与 `locale/zh.json`：面向用户的展示元数据与文本骨架，key 集合完全对齐。
- `scripts/ci-checks.mjs`：CI 守护，校验两个 locale 字典 key 一致，`cordis.patch.yml` 既被
  `dsh.bundle.patch` 声明又列入 `files`，以及两份 SKILL 文件的 frontmatter 合法且章节数量与层级顺序一致。
- `.github/workflows/ci.yml`：push 到 main 与 PR 时执行 install / typecheck / lint / format / test /
  build / locale 与 manifest 校验。
- commitlint（`commitlint.config.mjs`）与 husky 钩子：`commit-msg` 校验提交信息，
  `pre-commit` 对暂存文件跑 ESLint 与 Prettier。
- `skills/dsh-dev-workflow/SKILL.md` 与 `skills/dsh-dev-workflow/SKILL.zh.md`：完整开发工作流规范
  的双语单一事实源，共 13 个章节（核心原则、分支模型、提交信息规范、原子提交、PR 流程与质量门禁、
  文档同步工作流、版本发布、CHANGELOG 维护、安全操作规范、自动触发时机等）。两份文件的章节数量
  与层级顺序由 CI 校验。
- 规范补充 14 处此前只能靠自觉的规则：分支保护与大小写约定、用 `git merge main` 保持最新的理由、
  Issue 引用写法、subject 语言、`BREAKING CHANGE:` 页脚精确格式、PR 粒度上限（200–400 行）、
  文档同步的五类豁免、`docs/` 只描述 main、发布后验证、预发布版本与 dist-tag、废弃与移除、
  回滚、72 小时撤回窗口，以及全新的「CHANGELOG 维护」整章（该写什么、不该写什么、怎么写、
  正反示例、何时写、依赖升级例外、破坏性变更）。
- 插件核心代码（`src/`，8 个文件）：`src/config.ts` 用 Schemastery 声明配置面（每个字段都带默认值），
  `src/i18n.ts` 用 `createRequire` 读取 locale 字典并以 `Intl.DateTimeFormat()` 解析 `auto`，
  `src/git.ts` 通过 `ctx.get('subprocess')` 的可选服务运行 git，`src/skills/provider.ts` 注册单一
  技能 `dsh-dev-workflow`（目录描述与正文都随当前 locale 动态返回），`src/index.ts` 是插件入口。
- 两个工具：`check_commit_message`（按 Conventional Commits 校验提交信息，并对过长标题、句尾句号、
  过宽正文、跨模块提交、缺少 scope 给出可忽略的软警告）与 `check_doc_sync`（成对文件只改一半时报错，
  代码变更未带文档或 CHANGELOG 条目时给警告）。
- `docs/TOKEN-BUDGET.md`：常驻 token 的实测数字与复算方法。实测常驻增量约 900 字符
  （工具定义 + 一行技能目录条目，约 200–250 token），规范全文只在模型主动读取技能时支付。
- `locale/en.json` 与 `locale/zh.json` 补齐两个工具的参数字典、错误码与软警告文案，共 40 个 key。
- 工作流规范补充 6 处：本地验证与 CI 的分工（本地是建议、CI 是硬门禁、本地通过不等于 CI 通过）、
  squash merge 的提交信息来源（squash 提交取 PR 标题，故 PR 标题必须符合 Conventional Commits）、
  hotfix 流程（从 `main` 切出、直接合回、条目写入 `[Unreleased]`）、冲突解决后必须重新跑
  typecheck / lint / test、CI 失败的处理（修根因而非改配置）、提交前扫描密钥模式且泄露后必须轮换密钥。
  SKILL 双语章节数由 26 增至 28。
- 贡献者规范 `CONTRIBUTING.md` 补充 4 节：依赖管理（固定 pnpm、锁文件入库、不混用包管理器）、
  版本号单一源（只在 `package.json` 维护，徽章与文档引用均派生）、忽略规则清单、测试规范
  （测试放 `tests/` 目录、命名与覆盖率要求）。
- `/dev-workflow` 命令：`on` / `off` 切换插件，`status` 报告当前模式、locale、
  最近一次检查结果与守卫命中次数，`check` 按工作流规则即时检查整个工作区。
  命令在 DSH 命令服务存在时注册，不存在时静默跳过。
- pre-commit 触发器（`src/triggers/pre-commit.ts`）：挂在 `tools/pre-execute` waterfall 上，
  当 agent 通过 `bash` / `pwsh` 工具执行 `git commit` 时，把提交信息检查、变更文件检查与
  `rules.requireChangelogOnFeat` 合起来跑一遍（`src/checks.ts`），命中问题时给出
  `ask` 提示。提示文案按客户端 locale 双语渲染，每一份都用对应语言的翻译器重新判定。
  先调用链上后面的门禁，只在它返回 `allow` 之后才自查，绝不改判上游的决定。
- 会话内去重状态（`src/state.ts`）：按 `${sessionId}:${checkType}:${targetId}` 记住已报告过的
  问题，同一会话同一问题只提示一次，跨会话允许重新提示；只存在内存中，不落盘。
- `docs/TRIGGERS.md`：触发器挂载的事件、判定一次「提交」的保守规则、检查内容、双语提示的
  渲染方式、去重状态模型，以及主路径的真实能力边界（含与 husky 的分工）。
- `locale/en.json` 与 `locale/zh.json` 补齐命令、触发器与 `feat` 提交强制 CHANGELOG 的文案，
  共 56 个 key。
- git-guard（`src/guard/git-guard.ts`）：第二个 `tools/pre-execute` 监听器，扫描危险 git 命令。
  识别 force push（含 `-f` 与 `+refspec`）、`reset --hard`、`rebase`、`commit --amend`、
  `branch -D`、`clean -f`、`checkout -- <path>` 与 `--no-verify`，按 `config.gitGuard` 决定
  `deny` / `ask` / `allow`。带 `--force-with-lease` 的推送放行，裸 `--force` 的提示里附带
  改用 `--force-with-lease` 的建议。多条规则同时命中时取最严的一条，绝不削弱上游更严的决定。
- 共用命令行解析层（`src/shell.ts`）：不跑 shell 的词法切分，处理引号与转义、按
  `&&` / `||` / `;` / `|` / 换行切段、跳过 `env` 与前导赋值、跳过 `-C` / `-c` / `--git-dir`
  等带值的全局选项，取出 `git` 子命令与参数。提交前检查与 git-guard 共用它。
- `config.gitGuard` 由 6 个字段扩为 9 个：新增 `cleanForce`、`checkoutDiscard` 与 `noVerify`。
  `cleanForce` 不复用 `hardReset`（`clean -f` 删未跟踪文件，与丢弃已跟踪文件的改动不是一回事）；
  `noVerify` 默认 `ask` 而非 `deny`，因为它是钩子出错时的逃生通道。
- `docs/ARCHITECTURE.md`：模块地图、具名导出与 `inject` 的选择、注册所有权的归属、
  一次检查的数据流与错误处理约定。
- `docs/CONFIGURATION.md`：全部配置字段与默认值，以及 `gitGuard` 三个不显然默认值的理由。
- `docs/TOOLS.md`：两个工具与 `/dev-workflow` 命令的合同、参数、返回结构，以及它们执行的每条规则。
- `docs/I18N.md`：字典读取与插值、`locale` 三取值与 `auto` 的解析时机、`displayReason`
  双语与中文键必须是字面 `zh`、`ci:checks` 的 key 对齐守护。
- `docs/SECURITY.md`：git-guard 保护什么、刻意不做什么（不读敏感文件、不联网、不落盘、
  不写日志文件），以及它与 husky、GitHub 分支保护的分工。
- `docs/ADR/template.md` 与两份架构决策记录：`001-skill-first-approach.md`（规范为什么放技能
  而不是系统提示）与 `002-plugin-not-preset.md`（为什么是插件而不是模式或预设），
  含被否决方案及其理由。
- 测试套件（`tests/`，7 个 spec + 1 个共享脚手架，共 107 个用例）：`register.spec.ts` 覆盖
  cordis 契约（具名导出、无 `default`、`inject`、注册与注销清单、工具定义形状）、
  `config.spec.ts` 覆盖每个默认值与校验报错、`i18n.spec.ts` 覆盖两份字典的 key 与占位符对齐
  及 `t()` 的分语言与回退、`impl.spec.ts` 覆盖两个判定函数与 `evaluate` 的阻塞/建议边界、
  `guard.spec.ts` 覆盖每条 git-guard 规则与三档策略、`trigger.spec.ts` 覆盖触发时机与去重、
  `skill-parity.spec.ts` 覆盖 SKILL 两份语言的标题数量与顺序。测试直接 import `../src/*.js`，
  由 Vitest 转译源码，不依赖 `lib/` 构建产物。
- `docs/DEVELOPMENT.md`：本地循环、目录职责、测试的组织方式与写测试时的约定、
  加一条新规则所需的完整改动清单、CI 的守卫范围，以及若干已知的坑。
- `ACKNOWLEDGEMENTS.md`：上游依赖、作为实现范式被研读的官方包、作为形态参照的社区项目、
  被引用的规范，以及开发工具链，逐项列出作者与许可证。
- `docs/PUBLISHING.md`：发布前检查清单、每一步的实际命令、DSH peerDependencies 的
  分段枚举规则（写错这一节的后果是插件被静默禁用而非安装失败）、撤回与废弃的处置，
  以及本机踩过的坑（镜像源不能发布、`npm audit` 必须显式指定官方 registry）。
- `docs/README.md`：文档索引，按「想用插件 / 想贡献 / 想发版 / 想知道为什么这样设计」
  四条读者路径组织。
- `docs/SECURITY.md` 补发布相关章节：发布产物的白名单能推导出什么、审计结果该怎么读
  （运行期零依赖意味着所有命中都在开发期路径上），以及发布者的凭据放在哪里。

### Changed

- 包名采用 `@melosic/dsh-dev-workflow`：`dsh-dev-workflow` 在 npm 上已被他人占用。
- 工具名不得使用 `:` 命名空间分隔符，只能包含 `[A-Za-z0-9_-]` 且不超过 64 字符
  （DeepSeek function-name 合同）。
- 国际化字典目录由 `locales/` 修正为 DSH 实际约定的单数 `locale/`，文件名为短语言 id
  （`locale/en.json`、`locale/zh.json`）。
- 技能正文目录由预留的 `assets/` 改为 `skills/dsh-dev-workflow/`：`@deepseek-ai/dsh-agent-preset`
  等官方包即采用 `skills/<name>/SKILL.md` 布局，且该路径由 `package.json` 的 `files` 发布。
- `ci.yml` 中关于 Node 版本矩阵的注释已修正：单版本是为控制审查节奏，而非私有仓库的 Actions
  分钟配额（仓库已转为 public，标准 runner 免费）。
- 双语 README 顶部的语言切换行改为普通文本行（不再使用引用块）：去掉指向当前语言自身的链接，
  当前语言的标签保留为纯文本，另一种语言仍为链接。`README.md` 显示
  `**English | [简体中文](README.zh.md)**`，`README.zh.md` 显示
  `**[English](README.md) | 简体中文**`。
- 双语 README 的文档链接列表去掉 `.dev-docs/` 一条：该目录仅存在于开发者本机、未纳入版本控制，
  对仓库读者没有意义。
- `src/checks.ts` 中的命令行词法解析（`tokenize` / `segments` / `git` 调用识别）与
  `commandOf` 提取到 `src/shell.ts`，供提交前检查与 git-guard 共用，避免两处各写一份
  会漂移的解析。`detectCommit` 相应简化为遍历 `gitInvocations()` 的结果。
- 双语 README 的文档链接列表改为指向已落地的参考文档（`docs/ARCHITECTURE.md`、
  `docs/CONFIGURATION.md`、`docs/TOOLS.md`、`docs/I18N.md`、`docs/SECURITY.md`、`docs/ADR/`），
  不再写「随阶段落地后再写」。

### Security

- `peerDependencies` 对 DSH 域内包使用显式版本范围 `>=0.2.0-rc.1 <0.3.0`，不使用 `^` / `~`。
- `config.gitGuard` 的全部策略项默认 `'ask'`，**没有任何一项默认 `'allow'`**；插件自身也不
  默认拒绝任何操作，`'deny'` 只由用户显式配置产生。守卫命中的诊断日志只记规则标识
  （字典 key），不记命令行全文与提交信息内容。

[Unreleased]: https://github.com/Melosic/dsh-dev-workflow/compare/v0.1.0...main
[0.1.0]: https://github.com/Melosic/dsh-dev-workflow/releases/tag/v0.1.0

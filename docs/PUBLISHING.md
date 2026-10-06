# 发布指引

本文件说明如何把一个版本发布出去：发布前要核什么、命令怎么写、发布后怎么确认它真的落地了。
流程本身定义在 [skills/dsh-dev-workflow/SKILL.md](../skills/dsh-dev-workflow/SKILL.md) 的
「Releases (SemVer + Keep a Changelog)」与「Withdrawing a Published Release」两节；
本文件是它在这个仓库里的可执行版本，包含本机的实测结果与踩过的坑。

## 一次性准备

| 前置条件 | 检查方式 |
| --- | --- |
| 已登录 npm，且账号对 `@melosic` scope 有发布权 | `npm whoami --registry=https://registry.npmjs.org` |
| `gh` 已登录（用于创建 GitHub Release） | `gh auth status` |
| 工作区干净、`main` 已同步 | `git status --short`、`git log --oneline -1` |

**`npm whoami` 报 `ENEEDAUTH` 时不要用 `--no-verify` 绕过去**——没有登录就是没有登录，
发布命令会以 `E404` 或 `403` 失败。先 `npm login`。

**镜像源不能发布。** 本机 `~/.npmrc` 的 `registry` 指向 `registry.npmmirror.com`（只读镜像），
它是同步源、不是发布端点。所有发布相关命令都必须显式带上
`--registry=https://registry.npmjs.org`，否则会拿到与真实 npm 不一致的结果：

```bash
npm whoami   --registry=https://registry.npmjs.org
npm view     @melosic/dsh-dev-workflow --registry=https://registry.npmjs.org
npm audit    --registry=https://registry.npmjs.org
npm publish  --registry=https://registry.npmjs.org
```

`npm audit` 在本仓库还有一层特别：仓库用 pnpm，没有 `package-lock.json`，
所以裸 `npm audit` 报 `ENOLOCK`，而 `pnpm audit` 走默认 registry 报
`ERR_PNPM_AUDIT_ENDPOINT_NOT_EXISTS`。两者都要显式指定官方 registry：

```bash
pnpm audit --registry=https://registry.npmjs.org
```

## 发布前检查清单

以下每一条都在本仓库实测过。顺序即执行顺序。

### 1. 元数据

- `name` 为 `@melosic/dsh-dev-workflow`（scoped；`dsh-dev-workflow` 在 npm 上已被他人占用）。
- `version` 与即将发布的版本号一致。
- `type` 为 `module`（ESM-only 是 DSH 插件的硬要求）。
- `main` / `types` / `exports` 指向 `lib/`；`exports` 含 `.`、`./cordis.patch.yml`、
  `./locale/*.json`、`./package.json`。
- `dsh.bundle.patch` 为 `./cordis.patch.yml`。
- `cordis.patch.yml` **同时**被 `dsh.bundle.patch` 声明并列入 `files`——
  由 `pnpm ci:checks` 的第二项守卫强制。

#### bundle manifest 完整性检查

DSH 装的不是一个 npm 包，是一个 bundle：`package.json` 的 `dsh.bundle.patch` 指向一份 patch，
宿主把它插进 profile 的 Cordis 入口列表。**这四处任何一处断了，症状都发生在用户机器上，
而不在本仓库的 CI 里。** 发布前逐条核：

| 要核的东西 | 怎么核 | 断了的症状 |
| --- | --- | --- |
| `dsh.bundle.patch` 声明了 | `node -e "console.log(require('./package.json').dsh.bundle.patch)"` | 装上了也不会被挂载；用户看到「装成功但没反应」 |
| 声明的文件真实存在 | 上一条的输出能在仓库根找到 | 同上，且 `pnpm pack` 不会报错 |
| 该文件在 `files` 白名单里 | `pnpm ci:checks` 第二项守卫 | 本地一切正常，tarball 里没有它——只在用户机器上炸 |
| patch 内容与入口 id | patch 里 `id: dsh-dev-workflow`、`name: '@melosic/dsh-dev-workflow'`；id 不能与 DSH 已有 loader 条目冲突 | 与别人的条目打架，或加载到错的包 |

`pnpm ci:checks` 只强制其中两条（声明 + 随包发布）。**剩下两条没有自动守卫**，
所以要靠 `pnpm pack --dry-run`（看 `cordis.patch.yml` 在不在列表里）与一次真实安装来确认：

```bash
pnpm pack --dry-run                                  # 产物里有 cordis.patch.yml
dsh plugin --profile <scratch> add @melosic/dsh-dev-workflow   # 装完能挂载、命令能出现
```

最可靠的验收是**装到一个空 profile 里**跑一次：`/dev-workflow status` 能出五行、
两个工具出现在工具列表里，就说明 manifest 的整条链路是通的。这一步不能靠「CI 绿了」代替。

### 2. 打包产物

```bash
pnpm pack --dry-run
```

本仓库的实测输出（v0.1.0）为 tarball `melosic-dsh-dev-workflow-0.1.0.tgz`，其中至少有：

```
CHANGELOG.md  cordis.patch.yml  client.js  LICENSE  README.md  README.zh.md  package.json
lib/**（.js + .d.ts + .js.map）
locale/en.json  locale/zh.json
skills/dsh-dev-workflow/SKILL.md  skills/dsh-dev-workflow/SKILL.zh.md
```

完整清单以 `pnpm pack --dry-run` 的实际输出为准——上面这份会随 `files` 变化。

四点值得盯：

- **`cordis.patch.yml` 必须在里面**。它不在，包装上了也不会被挂载——而这只会发生在用户机器上。
- **`client.js` 必须在里面**。它是设置面板的浏览器侧代码，由 `dsh.client` 声明而非 `files` 白名单兜底；漏掉它面板会空白，同样只在用户机器上暴露。
- **`docs/` 不在里面**，这是刻意的：`files` 是白名单，深度文档随仓库发布，不随包发布。
- **`tests/` 不在里面**，同理。
- 目录名是单数 **`locale/`**，不是 `locales/`。DSH 宿主按
  `` `${specifier}/locale/en.json` `` 读字典，复数目录会静默读不到。

### 3. 门禁

```bash
pnpm typecheck && pnpm lint && pnpm format:check && pnpm test && pnpm build && pnpm ci:checks
```

`ci:checks` 输出 `locale keys aligned (90 keys); bundle patch declared and shipped;
skill headings aligned (28 sections); published entry points present (4 checked);
no numbered development phases cited.`——这就是全部五项结构守卫。（括号里的数字都是当前值，
脚本按实际内容算出，不硬编码；换句话说这些数字会随内容变，不要拿这里出现的具体数字去断言
CI 是否通过。）

这五项不靠人记得跑：`pnpm publish` / `npm publish` 会先触发 `prepack`
（`pnpm build && pnpm ci:checks`），所以**打包这一步必然在编译之后、且必然过一遍结构守卫**——
`lib/` 是 gitignore 的构建产物，`files` 里第一项就是它，少了它发出去的包装上去直接不能用。

### 4. 审计

```bash
pnpm audit --registry=https://registry.npmjs.org
```

本项目 `dependencies` 为空，**运行期零依赖**，所以审计命中的必然是开发期路径。
必须区分两类命中：

| 级别 | 包 | 路径 | 处置 |
| --- | --- | --- | --- |
| moderate | `fflate` | `@deepseek-ai/dsh > @deepseek-ai/dsh-skill-office > @deepseek-ai/libreoffice-kit > fflate` | 经 peerDependency 传递的开发期路径，**不在本包发布产物中**；由宿主侧升级，本包不干预 |
| high | `braces` | `lint-staged > micromatch > braces` | devDependency；**上游暂无修复版本**（`patched <0.0.0`），无法通过升级消除。记录在案，不阻塞发布 |

**不为了让审计变绿而删掉 lint-staged。** 用一个真实的开发体验损失，换一条不可能被利用的
告警消失，方向是反的。要判断的是「这条路径能不能到达用户」，答案是不能。

### 5. 规范一致性

以下各项由 `pnpm ci:checks` 与 CI **机械保证**，本文不复述其判定细节：

- `scripts/ci-checks.mjs` 的五项守卫：两个 locale 字典 key 一致；`cordis.patch.yml` 已声明
  且在 `files` 里；SKILL 双语标题数量与顺序一致；发布入口文件存在于 `files` 白名单内
  （配合 `prepack`）；任何随仓库发布的 `.md` 都不按编号引用开发分期。
- 代码中无硬编码用户可见文本：`git grep -P '[\x{4e00}-\x{9fff}]' -- 'src/**/*.ts'` 应无输出；
  英文文案也一律走 `t()`，只在 `locale/*.json` 里出现。
- `git log` 的**新提交**标题行全部符合 Conventional Commits：`.husky/commit-msg` 管提交那一刻，
  CI 再对**本次 PR 新增的范围**跑一次 `commitlint`（`--from <base> --to <head>`），所以绕过
  本地钩子或从网页合并进来的提交同样过不去。存量违规是 `c247d5d` 与 `fd8004f` 两条历史提交的
  **正文**行（`body-max-line-length`，上游默认 error）；改写已发布的历史不可接受，所以范围是
  豁免的，规则不是——新提交仍受同一门禁约束。
- `mode` 默认 `'on'`；四类守卫的每项默认值都不是 `allow`——由 `tests/settings-schema.spec.ts`
  对 schema 逐叶子断言，不靠人眼核对。
- `CHANGELOG.md` 的 `[Unreleased]` 段包含本次发布的全部变更（人工核对，无守卫）。

`inject` 声明完整（`export const inject = ['tools', 'skills']`；`commands` 与 `subprocess`
通过 `ctx.get(...)` 可选读取，故不进 `inject`，理由见 [docs/ARCHITECTURE.md](ARCHITECTURE.md)）
由 `tests/register.spec.ts` 断言，不在 `ci:checks` 里。

### 6. 名称可用性

```bash
npm view dsh-dev-workflow            version --registry=https://registry.npmjs.org  # 他人占用
npm view @melosic/dsh-dev-workflow   version --registry=https://registry.npmjs.org  # E404 = 可用
```

首次发布前的 `E404` 是**好**消息。已发布之后这里会返回版本号，那就不再是可用性检查，
而是「上一个版本是什么」的查询。

## DSH peerDependencies 的分段枚举规则

这一节是 `.dev-docs/PROGRESS.md` 「待决策 / 遗留问题」第 4 条要求的落地。
**写错这里，后果不是安装失败，而是插件被静默禁用。**

DSH 从 `0.1.7-rc.1` 起在加载前做兼容性校验（`dsh-app-boot` 的 `preflight()`）。规则如下：

1. **只读 `peerDependencies`。** `dependencies` 完全不参与兼容判断
   （`if (!Object.hasOwn(fields, "peerDependencies")) return void 0;`）。
   把 DSH 域内的包写进 `dependencies` 而不是 `peerDependencies`，等于没声明兼容范围。
2. **只校验 `@deepseek-ai/dsh` 与 `@deepseek-ai/dsh-*` 前缀的 peer。**
   `@deepseek-ai/cordis`、`react` 之类的 peer 会被跳过——它们仍是正常的 npm peer，
   只是不参与 DSH 的兼容判断。
3. **`0.x` 下不要用 `^` 或 `~`。** 判定是
   `semver.satisfies(runtimeVersion, requirement, { includePrerelease: true })`，
   而 `0.x` 的次版本位可以携带破坏性变更，`^0.2.0` 的语义在这里会误导人。
   官方包对 DSH 域内 peer 一律写精确版本（`0.2.0-rc.2`）。
4. **按实测基线写下界，暂不写上界（本项目的当前选择）。** 本项目采用的写法是：

   ```json
   "@deepseek-ai/dsh":       ">=0.2.0-rc.2",
   "@deepseek-ai/dsh-skill": ">=0.2.0-rc.2",
   "@deepseek-ai/dsh-tools": ">=0.2.0-rc.2"
   ```

   下界是「本插件实测可用过的最低版本」——三个包都在 `0.2.0-rc.2` 上实测过，所以下界写
   `rc.2` 而不是 `rc.1`（凭记忆写更低的下界，等于宣称一段没人验过的兼容性）。
   **不写上界的代价要说清楚**：DSH 出到 `0.3` 时，即使 API 变了插件也会被加载，问题会推迟到
   运行时才暴露，而不是在加载时被 `preflight()` 干净地禁用。这个选择是在「`0.3.0` 尚不存在、
   上限纯属猜测」与「未来不兼容会静默加载」之间取的偏向前者；等 `0.3` 真正发布并重新实测之后，
   应当把上界补回来。
5. **`peerDependenciesMeta.optional` 不救场。** 兼容性校验只遍历 `peerDependencies` 本身，
   不读 `peerDependenciesMeta`。把某个 DSH 包标成 optional 不会让它跳过校验。
6. **不兼容的后果是「被禁用」而非「安装失败」。** `preflight()` 把该行 `row.disabled = true`
   后**照常加载其余行**，stderr 打印
   `disabling profile plugin <label>: <reason>`。用户看到的是功能不见了，不是一条报错。
7. **豁免机制存在，但不要依赖它。** 每个 profile 目录下有一份 `compatibility.json`
   （`exact package@version → [exact dsh versions]`，规范 SemVer 精确匹配，范围/前缀一律拒绝），
   对应 CLI 是 `dsh plugin version-exemptions` 与
   `dsh plugin allow-version <package@version> --dsh-version <runtime> --accept-risk`。
   这是给用户应急用的，不是包作者的正规出路。
8. **声明前先看真实版本列表**，不要凭记忆写范围：

   ```bash
   npm view @deepseek-ai/dsh versions --registry=https://registry.npmjs.org
   ```

`@deepseek-ai/cordis` 与 `@deepseek-ai/schemastery` 不参与上述校验，本项目分别写
`^4.0.4` 与 `^3.18.4`（与官方范式一致，官方对 cordis 用 `~4.0.4`，本项目用 `^` 并已是当前版本）。

## 发布一个版本

SKILL.md 的六步，落到具体命令：

### 第一步：确认 `main` 是绿的

```bash
git switch main && git pull
git log --oneline -3
```

分支保护要求 `verify` 检查通过（`strict: true`）。CI 红了就不要往下走。

### 第二步：把 `[Unreleased]` 移到版本标题下

在 `CHANGELOG.md` 里：

- 把 `## [Unreleased]` 下**全部**条目移到新的 `## [0.1.0] - 2026-10-05` 标题下；
- `## [Unreleased]` **保留在原位且清空**（不是删除）——它是下一次改动的入口；
- 更新文件底部的链接定义：`[Unreleased]` 指向新版本与 `main` 的比较，
  新增 `[0.1.0]` 指向该 tag 与上一版本（首个版本则指向该 tag）；
- **不要编辑已发布的段落。** 之后的更正写成新条目。

日期用 `YYYY-MM-DD`。

### 第三步：版本号与之对齐

`package.json` 的 `version` 改成与标题一致的 `0.1.0`。**版本号只有这一个来源**，
README、徽章、文档里的版本引用都从它派生，不手动维护第二份。

### 第四步：提交并打 tag

```bash
git commit -m "chore(release): prepare v0.1.0"
git tag v0.1.0
```

tag 打在**发布准备这个提交**上，因为「发布什么」由它定义。

### 第五步：发布

```bash
npm publish --registry=https://registry.npmjs.org
```

本项目是 scoped 包，命令是 `npm publish`（必要时显式加 `--access public`）。
`package.json` 里已有 `publishConfig.access: "public"`，所以裸 `npm publish` 也是公开的——
**scoped 包漏掉 public 会导致默认私有、装不到**，这个字段是防呆。

**关于 `--tag`：**

- 不加 `--tag` → 推到 `latest`，用户 `npm install @melosic/dsh-dev-workflow` 直接装到。
  这是 v0.1.0 的选择：0.x 阶段确实不保证兼容，但**首个版本装不到才是问题**。
- 加 `--tag next` → 不推 `latest`，用户必须写 `@next` 才装得到。
  SKILL.md 规定**预发布版本**（`-rc.1`、`-beta.1`、`-alpha.1`）必须这样发，
  以免有人误装 release candidate。0.1.0 不是预发布版本，故不加。

### 第六步：验证它真的落地了

```bash
npm view @melosic/dsh-dev-workflow versions --registry=https://registry.npmjs.org
npm view @melosic/dsh-dev-workflow dist-tags --registry=https://registry.npmjs.org
```

`latest` 指向新版本，`versions` 里出现新版本号，才算发布成功。
**验证失败时先查 dist-tag 与 registry 状态，不要假设发布成功了。**

### 第七步：GitHub Release

```bash
gh release create v0.1.0 --title "v0.1.0" --notes-file .dev-docs/_release-notes.md
```

`--notes-file` 指向从 `CHANGELOG.md` 抄出来的 `[0.1.0]` 段。
（SKILL.md 里写的 `<(awk ...)` 是 bash 进程替换，在 PowerShell 里不可用，
本机做法是先写文件再传入。）注意 tag 必须已经推送：

```bash
git push origin main --follow-tags
```

## 发布后 24 小时内：安装可能停在上一版

应用内的插件管理器走的是 DSH 自带的 **pnpm 11.7.0**，而 pnpm 11 把
`minimumReleaseAge` 的默认值从 0 改成了 **1440 分钟（24 小时）**
（[pnpm 文档](https://pnpm.io/settings/dependency-resolution#minimumreleaseage)）。
新版本发布不到 24 小时时，**不带版本号**的安装会静默回退到上一版：
不报错、不提示、也不写 `minimumReleaseAgeExclude`。

实测（v0.2.0 发布约 2 小时后，在应用里装裸名）：

```text
dependencies:
+ @melosic/dsh-dev-workflow ^0.1.0
Done in 16.9s using pnpm v11.7.0
```

**这条只发生在应用内的插件管理器这条路上。** `dsh plugin --profile <profile> add …`
转发给 PATH 上的 pnpm 10.30.3，其 `minimumReleaseAge` 默认仍是 0，实测三次都装到最新版。
README 里的安装命令不需要因此改动。

### 可以怎么办

| 做法 | 怎么写 | 代价 |
| --- | --- | --- |
| 安装时指名版本 | `add @melosic/dsh-dev-workflow@0.2.0` | 每次要记住版本号 |
| 给这一个包开永久口子 | profile 的 `pnpm-workspace.yaml` 里写 `minimumReleaseAgeExclude: ['@melosic/dsh-dev-workflow']` | 只影响这一个包 |
| 关掉整个 profile 的年龄门槛 | `minimumReleaseAge: 0` | 对该 profile 里**所有**包生效 |
| 等满 24 小时再装 | — | 发布当天装不到 |

指名版本或带范围（`@^0.2.0`、`@~0.2.0`）时，pnpm 会把该版本写进
`minimumReleaseAgeExclude`；写进去之后，裸名安装也能解析到新版。

前三种方式都实测过：装到 `0.2.0`，且随后的 `install --frozen-lockfile`
（即应用里那道「Lockfile passes supply-chain policies」检查）照样通过。

### 三个会踩的坑

- **`@*` 与 `@>=0.2.0` 会被直接拒绝**：`ERR_PNPM_INVALID_MINIMUM_RELEASE_AGE_EXCLUDE …
  Use exact versions only.` 这个名单只接受精确版本，或者不带版本的裸包名。
- **`minimumReleaseAgeStrict: true` 单独写没有用**，仍然回退到上一版。它只是把「静默回退」
  换成「报错并询问」，不会放行。
- **不要手工去删那行 `minimumReleaseAgeExclude`。** 如果 profile 的 lockfile 里已经记了
  新版本，删掉那行会让**连卸载都失败**：

  ```text
  ✗ Lockfile failed supply-chain policy check (1 entry in 249ms)
    @melosic/dsh-dev-workflow@0.2.0 was published at … within the minimumReleaseAge cutoff
  ```

  要么保留那行，要么同时写 `minimumReleaseAge: 0`。

### 时间怎么算

截止线是「**当前时间 − 1440 分钟**」，与**发布时刻**比较，不是你安装的时刻。
0.2.0 发布于 `2026-10-06T12:04:10.860Z`，门槛在 `2026-10-07T12:04:10Z` 解除。
发布时间可查：

```bash
npm view @melosic/dsh-dev-workflow time --registry https://registry.npmjs.org
```

这条只对「当前最新版」成立：下一次发 `0.3.0`，门槛立刻对 `0.3.0` 生效。

## 撤回、废弃与回滚

| 情况 | 做法 |
| --- | --- |
| 发布 < 72 小时，版本有致命问题 | `npm unpublish @melosic/dsh-dev-workflow@<version> --registry=https://registry.npmjs.org` |
| 发布 > 72 小时 | `npm unpublish` 已不可用，改用 `npm deprecate` 标注问题版本，再发修复版 |
| 只是功能要回退 | 用 `revert` 提交回退，在 `[Unreleased]` 对应分类下写明回退了什么、为什么 |

### 0.x 阶段的撤回策略

0.x 有一条与 1.0 之后不同的现实：**破坏性变更本来就在允许范围内**
（`CHANGELOG.md` 顶部的说明写着 MINOR 位可以携带 `BREAKING`），
所以「这个版本引入了不兼容」本身不是撤回的理由。判断标准只有一个：
**这个版本对已经装了它的人是否造成了实际伤害。**

按这个标准分三类处置：

| 情况 | 0.x 下的处置 | 为什么 |
| --- | --- | --- |
| 版本装不上、装上就崩、静默禁用（例如 manifest 或 peer 范围写错） | 立刻处理：< 72 小时 `npm unpublish`；> 72 小时 `npm deprecate` + 尽快发补丁版 | 这是**没人能正常使用**的版本，留着只会让每个新用户踩一次 |
| 行为与文档不符，但功能可用（例如触发器少拦了一种命令） | **不撤回。** 在 `[Unreleased]` 的 `Fixed` 下写明，随下一个版本发出 | 撤回会让已经按文档适配过的人白做。0.x 的兼容性承诺本来就不包括这种细节 |
| 设计方向错了（例如某个配置项的语义应该反过来） | **不撤回旧版本。** 改在新版本里，`[Unreleased]` 用 `Changed` + `BREAKING` 标注，附迁移说明 | 这正是 0.x 允许的：MINOR 位带破坏性变更。撤回会让「哪些版本还能装」变成一件需要查 history 的事 |

四条不随版本阶段变化的底线：

- **废弃信息必须说清三件事**：问题是什么、影响哪些版本、应该用什么替代。
  它的读者是已经装了坏版本的人，那是他唯一会看的地方。
- **绝不用删除版本来掩盖一次坏发布。** 发一个新版本。
- **不要删除原来的 CHANGELOG 条目。** CHANGELOG 记录的是发生过的事，
  一个发布过的版本确实发生过。
- 密钥一旦进了提交并被推送，就已经泄露；删除提交不够，必须**轮换密钥**。

**`unpublish` 的三个技术前提**，不了解它们会把「命令自己拒绝了」当成「发布失败」：

- **必须在 72 小时内**（npm 的撤回政策），且只能指定**单个版本或整个项目**，
  不接受 tag 与范围——`npm unpublish @melosic/dsh-dev-workflow@0.1.x` 会得到
  `Can only unpublish a single version, or the entire project. Tags and ranges are not supported.`
- **必须显式带 `--registry=https://registry.npmjs.org`**——镜像源不接受 unpublish
  （见开头「镜像源不能发布」）。执行后确认的是 packument：
  `npm view @melosic/dsh-dev-workflow versions --registry=https://registry.npmjs.org`
  里不再有那个版本号。
- 撤掉**最后一个版本**时 npm 会先拦住你：
  `Refusing to delete the last version of the package. It will block from republishing a new version for 24 hours.`
  带 `--force` 可以继续，但接下来 24 小时内同名同版本发不回来——
  0.x 阶段出现这种情况时，正确做法通常不是 `--force`，而是直接发一个更高的补丁版。

## 本项目的 v0.2.0 发布记录

留档，供下一次发布比对。

| 步骤 | 结果 |
| --- | --- |
| 分支 | `release/0.2.0`（`main` 受保护，不能直接推） |
| 提交 | `chore(release): 0.2.0`（`98152e0`） |
| 合并 | PR [#22](https://github.com/Melosic/dsh-dev-workflow/pull/22) squash 合并，`main` = `8f93ce1` |
| tag | `v0.2.0`（annotated，指向 `8f93ce1`） |
| 版本号 | `0.1.0` → `0.2.0` |
| 发布命令 | `npm publish --registry https://registry.npmjs.org`（`publishConfig.access: "public"` 已声明，无需 `--access`；正式版不加 `--tag`） |
| 发布产物 | 111 个文件 / 139.7 kB tarball / 514.5 kB 解包；`shasum 96df6c1604b2ba4ea29579c34c7bfc088dee90c0`；`fileCount` 111 |
| 验证 | `npm view @melosic/dsh-dev-workflow@0.2.0 version dist.shasum` = `0.2.0` / `96df6c16…`；`dist-tags.latest = 0.2.0` |
| GitHub Release | <https://github.com/Melosic/dsh-dev-workflow/releases/tag/v0.2.0> |
| 审计 | moderate 1（`fflate`，宿主 `dsh-skill-office` 链路）、high 1（`braces`，`lint-staged` devDependency）；两条均无可用修复版，运行期零依赖 |
| 后续处置 | **`0.1.0` 已 `npm deprecate`**，信息指向 `0.2.0` |

发布后 packument 立刻返回 404、`/0.2.0` 与 tarball 也已 404，而 `PUT` 是 202 —— 与 v0.1.0 一样是 CDN 的负缓存。
判据同前：**看 PUT 的状态码**（本次 `PUT 202`），不要用发布后立刻执行的 `npm view` 下结论；带
cache-buster 再查即可看到 `versions = 0.1.0, 0.2.0`。

**为什么给 `0.1.0` 打 deprecated**：0.2.0 把 v0.2.0 预发布评审的 23 条发现全部修掉（含四道守卫的绕过），
0.1.0 带着这些缺口，继续装它会在守卫「开着」的情况下被静默绕过。版本没有致命到需要 `unpublish`
（能装、能跑），所以按本文档的规则标注而不是删版本——**绝不用删除版本来掩盖一次坏发布**。

## 本项目的 v0.1.0 发布记录

留档，供下一次发布比对。

| 步骤 | 结果 |
| --- | --- |
| 分支 | `release/0.1.0`（`main` 受保护，不能直接推） |
| 提交 | `chore(release): prepare v0.1.0`（`219dbdb`） |
| 合并 | PR [#11](https://github.com/Melosic/dsh-dev-workflow/pull/11) squash 合并，`main` = `389b4c6` |
| tag | `v0.1.0`（annotated，指向 `389b4c6`） |
| 版本号 | `0.1.0`（发前已是，无需修改） |
| 安装命令 | `dsh plugin --profile <name> add @melosic/dsh-dev-workflow`，或从源码目录安装 |
| npm 包名 | `@melosic/dsh-dev-workflow`（`dsh-dev-workflow` 已被他人占用） |
| 发布认证 | 需要 **bypass-2FA 的 granular access token**；会话 token 会被 `E403 Two-factor authentication ... is required` 拒绝 |
| 发布产物 | 66 个文件 / 69.3 kB tarball / 232.0 kB 解包；`shasum 8e35f3866fe53bd1973577ddf1ccbb73e5e0ff4b` |
| 发布结果 | `PUT .../@melosic%2fdsh-dev-workflow → 200`，`dist-tags.latest = 0.1.0` |
| GitHub Release | <https://github.com/Melosic/dsh-dev-workflow/releases/tag/v0.1.0> |
| 审计 | moderate 1（`fflate`，开发期路径）、high 1（`braces`，上游无修复版），运行期零依赖 |

发布后有一段时间 packument（`GET /@melosic%2fdsh-dev-workflow`）仍返回 404，
而 `/…/0.1.0`、`/-/package/…/dist-tags` 与 tarball 都已 200 —— 这是 CDN 的负缓存，
不是发布失败。判断发布是否成功的可靠信号是 **PUT 的状态码**与 **tarball 的 shasum**，
不要用发布后立刻执行的那条 `npm view` 下结论。

## 相关文档

- 版本与变更记录的规范：[skills/dsh-dev-workflow/SKILL.md](../skills/dsh-dev-workflow/SKILL.md)
- 依赖与供应链安全：[docs/SECURITY.md](SECURITY.md)
- 本地循环与门禁：[docs/DEVELOPMENT.md](DEVELOPMENT.md)
- 协作规则与提交规范：[CONTRIBUTING.md](../CONTRIBUTING.md)

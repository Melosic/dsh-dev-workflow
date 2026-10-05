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

### 2. 打包产物

```bash
pnpm pack --dry-run
```

本仓库的实测输出（v0.1.0）为 tarball `melosic-dsh-dev-workflow-0.1.0.tgz`，内容恰好是：

```
CHANGELOG.md  cordis.patch.yml  LICENSE  README.md  README.zh.md  package.json
lib/**（.js + .d.ts + .js.map）
locale/en.json  locale/zh.json
skills/dsh-dev-workflow/SKILL.md  skills/dsh-dev-workflow/SKILL.zh.md
```

三点值得盯：

- **`cordis.patch.yml` 必须在里面**。它不在，包装上了也不会被挂载——而这只会发生在用户机器上。
- **`docs/` 不在里面**，这是刻意的：`files` 是白名单，深度文档随仓库发布，不随包发布。
- **`tests/` 不在里面**，同理。
- 目录名是单数 **`locale/`**，不是 `locales/`。DSH 宿主按
  `` `${specifier}/locale/en.json` `` 读字典，复数目录会静默读不到。

### 3. 门禁

```bash
pnpm typecheck && pnpm lint && pnpm format:check && pnpm test && pnpm build && pnpm ci:checks
```

`ci:checks` 输出 `locale keys aligned (56 keys); bundle patch declared and shipped;
skill headings aligned (28 sections).`——这三行就是全部三个结构守卫。

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

- 两个 locale 字典 key 一致：`pnpm ci:checks` 的第一项守卫。
- SKILL 双语标题数量与顺序一致：第三项守卫。
- 代码中无硬编码用户可见文本：`git grep -P '[\x{4e00}-\x{9fff}]' -- 'src/**/*.ts'` 应无输出；
  英文文案也一律走 `t()`，只在 `locale/*.json` 里出现。
- `mode` 默认 `'on'`；`gitGuard` 每项默认 `'ask'`（**没有任何一项默认 `'allow'`**）。
- `inject` 声明完整：`export const inject = ['tools', 'skills']`；`commands` 与 `subprocess`
  通过 `ctx.get(...)` 可选读取，故不进 `inject`（理由见 [docs/ARCHITECTURE.md](ARCHITECTURE.md)）。
- `AGENTS.md` 只含稳定规则，不含进度状态。
- `git log` 全部提交符合 Conventional Commits。
- `CHANGELOG.md` 的 `[Unreleased]` 段包含本次发布的全部变更。

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
4. **按实测基线分段枚举。** 本项目采用的写法是：

   ```json
   "@deepseek-ai/dsh":       ">=0.2.0-rc.1 <0.3.0",
   "@deepseek-ai/dsh-skill": ">=0.2.0-rc.1 <0.3.0",
   "@deepseek-ai/dsh-tools": ">=0.2.0-rc.1 <0.3.0"
   ```

   下界是「本插件实测可用过的最低版本」，上界是「下一个可能破坏兼容的次版本」。
   显式写上界，是为了让不兼容在加载时被发现，而不是在运行到某个分支时才炸。
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

## 撤回、废弃与回滚

| 情况 | 做法 |
| --- | --- |
| 发布 < 72 小时，版本有致命问题 | `npm unpublish @melosic/dsh-dev-workflow@0.1.0` |
| 发布 > 72 小时 | `npm unpublish` 已不可用，改用 `npm deprecate` 标注问题版本，再发修复版 |
| 只是功能要回退 | 用 `revert` 提交回退，在 `[Unreleased]` 对应分类下写明回退了什么、为什么 |

- **废弃信息必须说清三件事**：问题是什么、影响哪些版本、应该用什么替代。
  它的读者是已经装了坏版本的人，那是他唯一会看的地方。
- **绝不用删除版本来掩盖一次坏发布。** 发一个新版本。
- **不要删除原来的 CHANGELOG 条目。** CHANGELOG 记录的是发生过的事，
  一个发布过的版本确实发生过。
- 密钥一旦进了提交并被推送，就已经泄露；删除提交不够，必须**轮换密钥**。

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

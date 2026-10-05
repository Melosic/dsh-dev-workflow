// Browser half of `@melosic/dsh-dev-workflow`.
//
// Hand-written, in the deployment's module-table format, because this package
// has no bundler: the loader hands the factory a `require` that resolves the
// baseline externals (`react` here), and the factory's return value becomes the
// module exports. The id must equal the package name, and the configuration
// namespace below must equal the Loader entry id that Host half registers, or
// the two halves never pair up.
//
// Nothing here talks to the profile file directly. Reads, writes, the revision
// fence, conflict detection and the reload after a failed write all go through
// the client `configForms` service; this file only renders the form and stages
// a draft the way the official `SettingsForm` does.
window.__ModuleLoader__.load({
  id: '@melosic/dsh-dev-workflow',
  factory: (require) => {
    const React = require('react')
    const h = React.createElement
    const { useEffect, useState } = React

    /** Loader entry id of the Host half; the settings namespace key. */
    const NAMESPACE = 'dsh-dev-workflow'
    /** Client locale namespace for this panel's own text. */
    const LOCALE = 'settings.devWorkflow'
    /** Slot the Settings navigation entry lives in. */
    const SLOT = 'settings.section'

    // Only the 14 `--dsw-alias-*` tokens the theme publishes are referenced;
    // the primitive package's other tokens stay undefined for a plugin, so
    // every value the primitives read from one falls back to a literal here.
    // Markup and behaviour are copied from `dsh-client-ui-primitives` and the
    // official settings pages, renamed under this plugin's prefix.
    const CSS = `
.dsw-dev-workflow-section{display:flex;flex-direction:column;gap:12px;max-width:760px;color:var(--dsw-alias-label-primary)}
.dsw-dev-workflow-title{margin:0;font-size:18px;font-weight:600}
.dsw-dev-workflow-intro{margin:0;font-size:13px;line-height:1.6;color:var(--dsw-alias-label-secondary)}
.dsw-dev-workflow-status{margin:0;font-size:12px;line-height:1.5;color:var(--dsw-alias-label-secondary)}
.dsw-dev-workflow-group{display:flex;flex-direction:column;width:100%;min-width:0}
.dsw-dev-workflow-group+.dsw-dev-workflow-group{border-top:0.5px solid var(--dsw-alias-border-l1)}
.dsw-dev-workflow-groupRow{display:flex;align-items:center;gap:6px;height:32px;min-width:0;padding:0;border:0;background:none;color:var(--dsw-alias-label-secondary);cursor:pointer;text-align:left;font:inherit}
.dsw-dev-workflow-groupRow:hover{color:var(--dsw-alias-label-primary)}
.dsw-dev-workflow-groupChevron{flex:none;width:14px;height:14px;transition:transform 120ms ease}
.dsw-dev-workflow-groupRow[aria-expanded='true'] .dsw-dev-workflow-groupChevron{transform:rotate(90deg)}
.dsw-dev-workflow-groupTitle{font-size:13px;font-weight:500;line-height:1.5}
.dsw-dev-workflow-groupBody{display:flex;flex-direction:column;padding:0 0 8px}
.dsw-dev-workflow-field{display:flex;flex-direction:column;gap:6px;padding:10px 0}
.dsw-dev-workflow-field+.dsw-dev-workflow-field{border-top:0.5px solid var(--dsw-alias-border-l1)}
.dsw-dev-workflow-fieldHead{display:flex;align-items:center;gap:8px}
.dsw-dev-workflow-fieldLabel{flex:1;min-width:0;font-size:13px;font-weight:500;line-height:1.5}
.dsw-dev-workflow-fieldBody{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.dsw-dev-workflow-hint{margin:0;font-size:12px;line-height:1.6;color:var(--dsw-alias-label-secondary)}
.dsw-dev-workflow-invalid{margin:0;font-size:12px;line-height:1.5;color:var(--dsw-alias-state-error-primary)}
.dsw-dev-workflow-reset{padding:0;border:0;background:none;font:inherit;font-size:12px;line-height:1.5;color:var(--dsw-alias-label-secondary);cursor:pointer}
.dsw-dev-workflow-badge{flex:none;padding:1px 6px;border:0.5px solid var(--dsw-alias-border-l1);border-radius:4px;font-size:11px;line-height:16px;color:var(--dsw-alias-label-secondary)}
.dsw-dev-workflow-switch{box-sizing:border-box;position:relative;flex:none;width:36px;height:20px;padding:2px;border:0;border-radius:999px;background:var(--dsw-alias-border-l1);cursor:pointer}
.dsw-dev-workflow-switch[aria-checked='true']{background:var(--dsw-alias-brand-primary)}
.dsw-dev-workflow-switch:disabled{opacity:0.4;cursor:default}
.dsw-dev-workflow-switchThumb{display:block;width:16px;height:16px;border-radius:50%;background:var(--dsw-alias-bg-layer-1);transition:transform 120ms ease}
.dsw-dev-workflow-switch[aria-checked='true'] .dsw-dev-workflow-switchThumb{transform:translateX(16px)}
.dsw-dev-workflow-segments{position:relative;display:inline-grid;grid-auto-flow:column;grid-auto-columns:1fr;gap:2px;padding:4px;border-radius:8px;background:var(--dsw-alias-bg-layer-2)}
.dsw-dev-workflow-segmentIndicator{position:absolute;top:4px;left:4px;width:calc((100% - 8px - 2px * (var(--dsw-dev-workflow-segment-count) - 1)) / var(--dsw-dev-workflow-segment-count));height:calc(100% - 8px);border-radius:6px;background:var(--dsw-alias-bg-layer-1);transform:translateX(calc(var(--dsw-dev-workflow-segment-index) * (100% + 2px)));transition:transform 160ms ease;pointer-events:none}
.dsw-dev-workflow-segment{height:28px;padding:0 16px;border:0;border-radius:6px;background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:13px;line-height:20px;font-weight:500;white-space:nowrap;cursor:pointer}
.dsw-dev-workflow-segment:hover,.dsw-dev-workflow-segment[aria-selected='true']{color:var(--dsw-alias-label-primary)}
.dsw-dev-workflow-segment:disabled{opacity:0.4;cursor:default}
.dsw-dev-workflow-checks{display:flex;flex-wrap:wrap;gap:4px 16px}
.dsw-dev-workflow-check{display:inline-flex;align-items:center;gap:6px;font-size:13px;line-height:20px;cursor:pointer}
.dsw-dev-workflow-check input{flex:none;width:16px;height:16px;margin:0;accent-color:var(--dsw-alias-brand-primary)}
.dsw-dev-workflow-number{box-sizing:border-box;width:96px;height:32px;padding:0 10px;border:0.5px solid var(--dsw-alias-border-l1);border-radius:8px;background:var(--dsw-alias-bg-layer-1);font:inherit;font-size:13px;line-height:1.5;color:var(--dsw-alias-label-primary)}
.dsw-dev-workflow-number:focus-visible{outline:none;border-color:var(--dsw-alias-brand-primary)}
.dsw-dev-workflow-number[aria-invalid='true']{border-color:var(--dsw-alias-state-error-primary)}
.dsw-dev-workflow-advanced{display:flex;flex-direction:column;gap:6px;padding:8px 0 4px}
.dsw-dev-workflow-advancedRow{display:flex;gap:12px;font-size:12px;line-height:1.6}
.dsw-dev-workflow-advancedKey{flex:none;width:180px;color:var(--dsw-alias-label-secondary)}
.dsw-dev-workflow-advancedValue{flex:1;min-width:0;margin:0;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;word-break:break-all;color:var(--dsw-alias-label-primary)}
.dsw-dev-workflow-actions{display:flex;align-items:center;gap:8px;padding-top:12px}
.dsw-dev-workflow-note{flex:1;min-width:0;margin:0;font-size:12px;line-height:1.5;color:var(--dsw-alias-label-secondary)}
.dsw-dev-workflow-note[data-tone='error']{color:var(--dsw-alias-state-error-primary)}
.dsw-dev-workflow-button{box-sizing:border-box;display:inline-flex;align-items:center;justify-content:center;height:28px;padding:0 12px;border:0.5px solid var(--dsw-alias-border-l1);border-radius:8px;background:transparent;font:inherit;font-size:12px;line-height:18px;color:var(--dsw-alias-label-primary);cursor:pointer}
.dsw-dev-workflow-button:disabled{opacity:0.4;cursor:default}
.dsw-dev-workflow-button[data-variant='primary']{border-color:transparent;background:var(--dsw-alias-brand-primary);color:var(--dsw-alias-bg-layer-1)}
@media (prefers-reduced-motion: reduce){.dsw-dev-workflow-switchThumb,.dsw-dev-workflow-groupChevron,.dsw-dev-workflow-segmentIndicator{transition:none}}
`
    const cssTag = '@melosic/dsh-dev-workflow/client.module.css'
    if (
      typeof document !== 'undefined' &&
      document.querySelector('style[data-plugin-css=' + JSON.stringify(cssTag) + ']') === null
    ) {
      const tag = document.createElement('style')
      tag.dataset.plugin = '@melosic/dsh-dev-workflow'
      tag.dataset.pluginCss = cssTag
      tag.textContent = CSS
      document.head.appendChild(tag)
    }

    const EN = {
      nav: 'Dev workflow',
      title: 'Dev workflow',
      intro:
        'The conventions this plugin enforces while you work. Saving writes them to the configuration file of this profile; they take effect without a restart.',
      'group.workflow': 'Workflow mode',
      'group.commit': 'Commit convention',
      'group.docs': 'Documentation sync',
      'group.git': 'Git safety',
      'group.command': 'Command safety',
      'group.files': 'Files and secrets',
      'group.audit': 'Audit log',
      'group.advanced': 'Advanced (read-only)',
      'field.mode': 'Plugin mode',
      'field.locale': 'Panel language',
      'field.ownTrigger': 'Run the pre-commit check',
      'field.commitEnabled': 'Check commit messages',
      'field.onFailure': 'On a hard problem',
      'field.types': 'Allowed types',
      'field.requireScope': 'Require a scope',
      'field.subjectMaxLength': 'Maximum subject length',
      'field.docsEnabled': 'Check documentation sync',
      'field.requireChangelog': 'A feat must update the changelog',
      'field.requireReadmeOnConfig': 'A configuration change must update the README',
      'field.gitEnabled': 'Git guard',
      'field.rememberApproved': 'Remember approved operations',
      'field.commandEnabled': 'Command guard',
      'field.dangerousShell': 'Destructive shell commands',
      'field.fileEnabled': 'Sensitive file guard',
      'field.secretEnabled': 'Secret leak guard',
      'field.genericHighEntropy': 'Generic high-entropy strings',
      'field.auditEnabled': 'Audit log',
      'policy.forcePush': 'Force push',
      'policy.hardReset': 'Hard reset',
      'policy.rebase': 'Rebase',
      'policy.amend': 'Amend a commit',
      'policy.branchDelete': 'Delete a branch',
      'policy.cleanForce': 'Clean untracked files',
      'policy.checkoutDiscard': 'Discard unstaged edits',
      'policy.noVerify': 'Skip hooks (--no-verify)',
      'hint.mode':
        'Off withdraws every tool, skill, command and trigger this plugin registers, so it costs no tokens. The plugin itself stays loaded — enabling or disabling it is the plugin manager\u2019s job.',
      'hint.onFailure':
        'A header that does not parse, a type outside the allowed set, and a `!` without a BREAKING CHANGE footer are hard problems. Length, a trailing period and a missing scope are always warnings.',
      'hint.requireScope':
        'Off leaves a missing scope as a hint, shown only when the change touches one module.',
      'hint.genericHighEntropy':
        'Also stops long random strings with no known prefix. This is the rule most likely to interrupt an ordinary call, so it is off by default.',
      'hint.rememberApproved':
        'Applies to git operations whose policy is Ask: one approval covers the same operation for the rest of the session. Deny is never affected.',
      'value.on': 'On',
      'value.off': 'Off',
      'value.auto': 'Auto',
      'value.en-US': 'English',
      'value.zh-CN': 'Chinese',
      'value.warn': 'Warn',
      'value.block': 'Block',
      'value.deny': 'Deny',
      'value.ask': 'Ask',
      'value.allow': 'Allow',
      'invalid.number': 'Enter a whole number of 1 or more.',
      'action.save': 'Save',
      'action.saving': 'Saving\u2026',
      'action.discard': 'Discard',
      'action.reset': 'Reset',
      'action.overridden': 'Overridden',
      'action.failed': 'Could not save. The draft is kept.',
      'action.unavailable': 'These settings are not available right now.',
      'advanced.note':
        'Declared in the configuration file only. The panel shows them for reference and never edits them.',
      'advanced.open': 'Open configuration file',
      'advanced.empty': 'not set',
      'advanced.codePaths': 'Code paths',
      'advanced.docsDir': 'Docs directory',
      'advanced.adrDir': 'ADR directory',
      'advanced.changelog': 'Changelog path',
      'advanced.exclude': 'Excluded paths',
      'advanced.branchPattern': 'Branch name pattern',
      'advanced.commitPattern': 'Commit header pattern',
      'advanced.mirrors': 'Code \u2194 document mirrors',
      'advanced.auditPath': 'Audit log path',
    }
    const ZH = {
      nav: '开发工作流',
      title: '开发工作流',
      intro:
        '本插件在工作过程中执行的规范。保存即写入当前 profile 的配置文件，不需要重启即可生效。',
      'group.workflow': '工作流模式',
      'group.commit': '提交规范',
      'group.docs': '文档同步',
      'group.git': 'Git 安全',
      'group.command': '命令安全',
      'group.files': '文件与密钥保护',
      'group.audit': '审计日志',
      'group.advanced': '高级（只读）',
      'field.mode': '插件模式',
      'field.locale': '面板语言',
      'field.ownTrigger': '运行 pre-commit 检查',
      'field.commitEnabled': '检查提交信息',
      'field.onFailure': '出现硬性问题时',
      'field.types': '允许的 type',
      'field.requireScope': 'scope 必填',
      'field.subjectMaxLength': 'subject 最大长度',
      'field.docsEnabled': '检查文档同步',
      'field.requireChangelog': 'feat 必须更新 CHANGELOG',
      'field.requireReadmeOnConfig': '配置变更必须更新 README',
      'field.gitEnabled': 'Git 守卫',
      'field.rememberApproved': '记住已批准的同类操作',
      'field.commandEnabled': '命令守卫',
      'field.dangerousShell': '危险 shell 命令',
      'field.fileEnabled': '敏感文件守卫',
      'field.secretEnabled': '密钥泄漏守卫',
      'field.genericHighEntropy': '通用高熵字符串检测',
      'field.auditEnabled': '审计日志',
      'policy.forcePush': '强制推送',
      'policy.hardReset': '硬重置',
      'policy.rebase': '变基',
      'policy.amend': '修改已有提交',
      'policy.branchDelete': '删除分支',
      'policy.cleanForce': '清理未跟踪文件',
      'policy.checkoutDiscard': '丢弃未暂存改动',
      'policy.noVerify': '跳过钩子（--no-verify）',
      'hint.mode':
        '关闭后，本插件注册的工具、技能、命令和触发器全部撤销，不占常驻 token。插件本身仍然加载 —— 启用或停用是插件管理器的事。',
      'hint.onFailure':
        'header 无法解析、type 不在允许集合、`!` 缺少 BREAKING CHANGE footer 属于硬性问题。长度、句末句点和缺少 scope 始终只是警告。',
      'hint.requireScope': '关闭时，只有改动落在单个模块里才提示补 scope。',
      'hint.genericHighEntropy':
        '没有已知前缀的长随机串也会被拦。这一项最容易打断普通调用，所以默认关闭。',
      'hint.rememberApproved':
        '仅对策略为「询问」的 git 操作生效：一次同意覆盖本会话内同一操作。策略为「拒绝」的操作永不受影响。',
      'value.on': '开启',
      'value.off': '关闭',
      'value.auto': '自动',
      'value.en-US': 'English',
      'value.zh-CN': '中文',
      'value.warn': '警告',
      'value.block': '阻断',
      'value.deny': '拒绝',
      'value.ask': '询问',
      'value.allow': '允许',
      'invalid.number': '请输入大于等于 1 的整数。',
      'action.save': '保存',
      'action.saving': '保存中…',
      'action.discard': '放弃',
      'action.reset': '恢复默认',
      'action.overridden': '已覆盖',
      'action.failed': '保存失败。草稿已保留。',
      'action.unavailable': '当前无法读取这些设置。',
      'advanced.note': '这些项只能在配置文件里声明。面板只作展示，从不修改它们。',
      'advanced.open': '打开配置文件',
      'advanced.empty': '未设置',
      'advanced.codePaths': '代码目录',
      'advanced.docsDir': '文档目录',
      'advanced.adrDir': 'ADR 目录',
      'advanced.changelog': 'CHANGELOG 路径',
      'advanced.exclude': '排除路径',
      'advanced.branchPattern': '分支命名正则',
      'advanced.commitPattern': '提交标题正则',
      'advanced.mirrors': '代码 ↔ 文档映射',
      'advanced.auditPath': '审计日志路径',
    }

    // One entry per control the page renders. `path` is the same path the Host
    // schema nests the field under, so a test can walk `Config` with it.
    const COMMIT_TYPES = [
      'feat',
      'fix',
      'docs',
      'style',
      'refactor',
      'perf',
      'test',
      'build',
      'ci',
      'chore',
      'revert',
    ]
    const GIT_POLICIES = [
      'forcePush',
      'hardReset',
      'rebase',
      'amend',
      'branchDelete',
      'cleanForce',
      'checkoutDiscard',
      'noVerify',
    ]
    const POLICY_OPTIONS = [
      { value: 'deny', label: 'value.deny' },
      { value: 'ask', label: 'value.ask' },
      { value: 'allow', label: 'value.allow' },
    ]
    const GROUPS = [
      { key: 'workflow', open: true },
      { key: 'commit', open: true },
      { key: 'docs', open: true },
      { key: 'git', open: true },
      { key: 'command', open: true },
      { key: 'files', open: true },
      { key: 'audit', open: true },
      { key: 'advanced', open: false },
    ]
    const FIELDS = [
      {
        group: 'workflow',
        path: ['mode'],
        control: 'switch',
        on: 'on',
        off: 'off',
        hint: 'hint.mode',
      },
      {
        group: 'workflow',
        path: ['locale'],
        control: 'segments',
        options: ['auto', 'en-US', 'zh-CN'],
      },
      {
        group: 'workflow',
        path: ['enableOwnTrigger'],
        control: 'switch',
        label: 'field.ownTrigger',
      },
      { group: 'commit', path: ['commitCheck', 'enabled'], control: 'switch' },
      {
        group: 'commit',
        path: ['commitCheck', 'onFailure'],
        control: 'segments',
        options: ['warn', 'block'],
        hint: 'hint.onFailure',
      },
      { group: 'commit', path: ['commitCheck', 'types'], control: 'checks' },
      {
        group: 'commit',
        path: ['commitCheck', 'requireScope'],
        control: 'switch',
        hint: 'hint.requireScope',
      },
      { group: 'commit', path: ['commitCheck', 'subjectMaxLength'], control: 'number' },
      { group: 'docs', path: ['docsCheck', 'enabled'], control: 'switch' },
      { group: 'docs', path: ['rules', 'requireChangelogOnFeat'], control: 'switch' },
      { group: 'docs', path: ['docsCheck', 'requireReadmeOnConfig'], control: 'switch' },
      { group: 'git', path: ['gitGuard', 'enabled'], control: 'switch' },
      ...GIT_POLICIES.map((policy) => ({
        group: 'git',
        path: ['gitGuard', policy],
        control: 'segments',
        options: POLICY_OPTIONS,
        label: `policy.${policy}`,
      })),
      {
        group: 'git',
        path: ['gitGuard', 'rememberApproved'],
        control: 'switch',
        hint: 'hint.rememberApproved',
      },
      { group: 'command', path: ['commandGuard', 'enabled'], control: 'switch' },
      {
        group: 'command',
        path: ['commandGuard', 'dangerousShell'],
        control: 'segments',
        options: POLICY_OPTIONS,
      },
      { group: 'files', path: ['fileGuard', 'enabled'], control: 'switch' },
      { group: 'files', path: ['secretGuard', 'enabled'], control: 'switch' },
      {
        group: 'files',
        path: ['secretGuard', 'genericHighEntropy'],
        control: 'switch',
        hint: 'hint.genericHighEntropy',
      },
      { group: 'audit', path: ['audit', 'enabled'], control: 'switch' },
    ]
    // Read-only projection of the fields the profile file owns.
    const ADVANCED = [
      { path: ['codePaths'], label: 'advanced.codePaths' },
      { path: ['docs', 'docsDir'], label: 'advanced.docsDir' },
      { path: ['docs', 'adrDir'], label: 'advanced.adrDir' },
      { path: ['docs', 'changelog'], label: 'advanced.changelog' },
      { path: ['docs', 'exclude'], label: 'advanced.exclude' },
      { path: ['rules', 'branchPattern'], label: 'advanced.branchPattern' },
      { path: ['rules', 'commitPattern'], label: 'advanced.commitPattern' },
      { path: ['docs', 'mirrors'], label: 'advanced.mirrors' },
      { path: ['audit', 'path'], label: 'advanced.auditPath' },
    ]
    // Fields whose value the Host would reject as written. A staged value that
    // fails here never becomes an operation, which is what disables Save.
    const VALIDATORS = {
      'commitCheck.subjectMaxLength': (value) => Number.isInteger(value) && value >= 1,
    }

    const keyOf = (path) => path.join('.')
    const readPath = (value, path) => {
      let current = value
      for (const key of path) {
        if (current === null || typeof current !== 'object') return undefined
        current = current[key]
      }
      return current
    }
    const hasPath = (value, path) => {
      let current = value
      for (const key of path) {
        if (current === null || typeof current !== 'object') return false
        if (!Object.prototype.hasOwnProperty.call(current, key)) return false
        current = current[key]
      }
      return true
    }
    const sameValue = (left, right) => JSON.stringify(left) === JSON.stringify(right)

    /**
     * The save model of the official `SettingsForm`: staged edits, one Save, one
     * Discard, and a draft that survives a rejected write. Reads and writes stay
     * with the controller the `configForms` service handed us — this class adds
     * no persistence of its own.
     */
    class DraftForm {
      constructor(scope) {
        this.scope = scope
        this.staged = new Map()
        this.listeners = new Set()
        this.baseline = undefined
        this.saving = false
        this.failed = false
        this.snapshot = undefined
        this.off = scope.subscribe(() => {
          this.invalidate()
        })
      }
      getSnapshot() {
        if (this.snapshot === undefined) this.snapshot = this.build()
        return this.snapshot
      }
      subscribe(listener) {
        this.listeners.add(listener)
        return () => {
          this.listeners.delete(listener)
        }
      }
      invalidate() {
        this.snapshot = undefined
        for (const listener of this.listeners) listener()
      }
      build() {
        const state = this.scope.getSnapshot()
        const value = state.value
        const staged = this.staged
        return {
          status: state.status,
          writable: state.writable === true,
          dirty: staged.size > 0,
          invalid: [...staged.values()].some((entry) => entry.invalid === true),
          saving: this.saving,
          failed: this.failed,
          read: (path) => {
            const entry = staged.get(keyOf(path))
            if (entry === undefined) return readPath(value, path)
            return entry.clear === true ? undefined : entry.value
          },
          invalidAt: (path) => {
            const entry = staged.get(keyOf(path))
            return entry !== undefined && entry.invalid === true
          },
          overridden: (path) => hasPath(state.user, path),
        }
      }
      /** Stage an edit, or drop the entry when it restates the stored value. */
      edit(path, value) {
        const key = keyOf(path)
        const validate = VALIDATORS[key]
        const invalid = validate !== undefined && !validate(value)
        if (!invalid && sameValue(readPath(this.scope.getSnapshot().value, path), value)) {
          if (this.staged.delete(key)) this.invalidate()
          return
        }
        this.baseline ??= this.scope.getSnapshot()
        this.staged.set(key, { path, value, invalid })
        this.invalidate()
      }
      /** Stage "back to the inherited value" for a field the file overrides. */
      clear(path) {
        this.baseline ??= this.scope.getSnapshot()
        this.staged.set(keyOf(path), { path, clear: true })
        this.invalidate()
      }
      discard() {
        if (this.staged.size === 0 && !this.failed) return
        this.staged.clear()
        this.baseline = undefined
        this.failed = false
        this.invalidate()
      }
      async save() {
        const snapshot = this.getSnapshot()
        if (!snapshot.dirty || snapshot.invalid || this.saving) return
        const ops = []
        for (const entry of this.staged.values()) {
          if (entry.invalid === true) continue
          ops.push(
            entry.clear === true
              ? { op: 'unset', path: entry.path }
              : { op: 'set', path: entry.path, value: entry.value },
          )
        }
        if (ops.length === 0) return
        this.saving = true
        this.invalidate()
        let landed = false
        try {
          landed = await this.scope.mutate(
            ops,
            this.baseline === undefined ? undefined : this.baseline.revision,
          )
        } catch {
          landed = false
        }
        this.saving = false
        if (landed) {
          this.staged.clear()
          this.baseline = undefined
          // A retry after a rejected batch has to clear the failure, or the
          // panel would keep claiming the save failed.
          this.failed = false
        } else {
          this.failed = true
        }
        this.invalidate()
      }
      dispose() {
        if (this.off !== undefined) this.off()
        this.off = undefined
        this.listeners.clear()
      }
    }

    /** The one action that leaves the panel: hand the profile file to the editor. */
    class DocumentAction {
      constructor(scope) {
        this.scope = scope
        this.state = { opening: false, error: null }
        this.listeners = new Set()
      }
      getSnapshot() {
        return this.state
      }
      subscribe(listener) {
        this.listeners.add(listener)
        return () => {
          this.listeners.delete(listener)
        }
      }
      update(patch) {
        this.state = { ...this.state, ...patch }
        for (const listener of this.listeners) listener()
      }
      async open() {
        if (this.state.opening) return
        this.update({ opening: true, error: null })
        try {
          const result = await this.scope.openSettingsDocument()
          if (result !== undefined && result !== null && result.ok !== true) {
            this.update({ error: (result.error && result.error.message) || 'failed' })
          }
        } catch (error) {
          this.update({ error: error instanceof Error ? error.message : String(error) })
        } finally {
          this.update({ opening: false })
        }
      }
    }

    function Switch({ checked, onChange, label, disabled }) {
      return h(
        'button',
        {
          type: 'button',
          className: 'dsw-dev-workflow-switch',
          role: 'switch',
          'aria-checked': checked,
          'aria-label': label,
          disabled,
          onClick: () => onChange(!checked),
        },
        h('span', { className: 'dsw-dev-workflow-switchThumb' }),
      )
    }

    // Copy of the primitive's SegmentedControl, including the roving tabindex
    // and the arrow/Home/End walk: those are the behaviours a keyboard user
    // depends on, so they come along with the markup.
    function Segments({ id, value, options, onChange, label, disabled }) {
      const index = Math.max(
        0,
        options.findIndex((option) => option.value === value),
      )
      const nodes = React.useRef([])
      const onKeyDown = (event) => {
        const enabled = options
          .map((option, position) => position)
          .filter((position) => options[position].disabled !== true)
        if (enabled.length === 0) return
        const current = enabled.indexOf(index)
        let next
        if (event.key === 'ArrowRight' || event.key === 'ArrowDown')
          next = enabled[(current + 1) % enabled.length]
        else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp')
          next = enabled[(current - 1 + enabled.length) % enabled.length]
        else if (event.key === 'Home') next = enabled[0]
        else if (event.key === 'End') next = enabled[enabled.length - 1]
        else return
        event.preventDefault()
        const target = options[next]
        if (target.disabled === true) return
        onChange(target.value)
        const node = nodes.current[next]
        if (node !== undefined && node !== null) node.focus()
      }
      return h(
        'div',
        {
          className: 'dsw-dev-workflow-segments',
          role: 'tablist',
          'aria-label': label,
          'data-disabled': disabled === true ? '' : undefined,
          style: {
            '--dsw-dev-workflow-segment-count': String(options.length),
            '--dsw-dev-workflow-segment-index': String(index),
          },
          onKeyDown,
        },
        h('span', { className: 'dsw-dev-workflow-segmentIndicator', 'aria-hidden': true }),
        options.map((option, position) =>
          h(
            'button',
            {
              key: option.value,
              ref: (node) => {
                nodes.current[position] = node
              },
              id: `${id}-${option.value}`,
              type: 'button',
              className: 'dsw-dev-workflow-segment',
              role: 'tab',
              'aria-selected': option.value === value,
              tabIndex: option.value === value ? 0 : -1,
              disabled: disabled === true || option.disabled === true,
              onClick: () => onChange(option.value),
            },
            option.text,
          ),
        ),
      )
    }

    function NumberInput({ id, value, invalid, disabled, onChange }) {
      const [text, setText] = useState(() => (value === undefined ? '' : String(value)))
      // Re-seed from the stored value while the field is not carrying a draft of
      // its own, so a reload after a failed write is visible.
      useEffect(() => {
        setText(value === undefined ? '' : String(value))
      }, [value])
      return h('input', {
        id,
        className: 'dsw-dev-workflow-number',
        type: 'text',
        inputMode: 'numeric',
        'aria-invalid': invalid,
        disabled,
        value: text,
        onChange: (event) => {
          const next = event.target.value
          setText(next)
          const parsed = Number(next)
          onChange(next.trim() === '' || !Number.isFinite(parsed) ? undefined : parsed)
        },
      })
    }

    function formatValue(value) {
      if (value === undefined || value === null) return ''
      if (Array.isArray(value)) {
        const parts = value.map((item) => formatValue(item)).filter((part) => part !== '')
        return parts.length === 0 ? '' : parts.join(' \u00b7 ')
      }
      if (typeof value === 'object') {
        const parts = Object.entries(value).map(([key, item]) => `${key}: ${formatValue(item)}`)
        return parts.join(' \u00b7 ')
      }
      return String(value)
    }

    function Field({ spec, form, t }) {
      const id = `dsw-dev-workflow-${keyOf(spec.path)}`
      const value = form.read(spec.path)
      const invalid = form.invalidAt(spec.path)
      const label = t(spec.label ?? `field.${spec.path[spec.path.length - 1]}`)
      const disabled = !form.writable
      const labelNode = h(
        'label',
        {
          className: 'dsw-dev-workflow-fieldLabel',
          htmlFor: spec.control === 'switch' ? undefined : id,
        },
        label,
      )
      let control
      if (spec.control === 'switch') {
        // `mode` is a two-value union, not a boolean, so a switch has to be told
        // which values it toggles between; a boolean field just uses true/false.
        const on = spec.on === undefined ? true : spec.on
        const off = spec.off === undefined ? false : spec.off
        control = h(Switch, {
          checked: value === on,
          disabled,
          label,
          onChange: (next) => form.edit(spec.path, next === true ? on : off),
        })
      } else if (spec.control === 'segments') {
        const options = spec.options.map((option) =>
          typeof option === 'string'
            ? { value: option, text: t(`value.${option}`) }
            : { value: option.value, text: t(option.label) },
        )
        control = h(Segments, {
          id,
          value,
          options,
          label,
          disabled,
          onChange: (next) => form.edit(spec.path, next),
        })
      } else if (spec.control === 'number') {
        control = h(NumberInput, {
          id,
          value,
          invalid,
          disabled,
          onChange: (next) => form.edit(spec.path, next),
        })
      } else {
        const selected = Array.isArray(value) ? value : []
        control = h(
          'div',
          { className: 'dsw-dev-workflow-checks', role: 'group', 'aria-label': label },
          selected.concat(COMMIT_TYPES.filter((type) => !selected.includes(type))).map((type) =>
            h(
              'label',
              { key: type, className: 'dsw-dev-workflow-check' },
              h('input', {
                type: 'checkbox',
                checked: selected.includes(type),
                disabled,
                onChange: () =>
                  form.edit(
                    spec.path,
                    selected.includes(type)
                      ? selected.filter((item) => item !== type)
                      : [...selected, type],
                  ),
              }),
              h('span', null, type),
            ),
          ),
        )
      }
      return h(
        'div',
        { className: 'dsw-dev-workflow-field' },
        h(
          'div',
          { className: 'dsw-dev-workflow-fieldHead' },
          labelNode,
          form.overridden(spec.path)
            ? h(
                React.Fragment,
                null,
                h('span', { className: 'dsw-dev-workflow-badge' }, t('action.overridden')),
                h(
                  'button',
                  {
                    type: 'button',
                    className: 'dsw-dev-workflow-reset',
                    onClick: () => form.clear(spec.path),
                  },
                  t('action.reset'),
                ),
              )
            : null,
        ),
        h('div', { className: 'dsw-dev-workflow-fieldBody' }, control),
        invalid ? h('p', { className: 'dsw-dev-workflow-invalid' }, t('invalid.number')) : null,
        spec.hint === undefined
          ? null
          : h('p', { className: 'dsw-dev-workflow-hint' }, t(spec.hint)),
      )
    }

    function Group({ group, open, onToggle, t, children }) {
      return h(
        'div',
        { className: 'dsw-dev-workflow-group' },
        h(
          'button',
          {
            type: 'button',
            className: 'dsw-dev-workflow-groupRow',
            'aria-expanded': open,
            onClick: onToggle,
          },
          h(
            'svg',
            {
              className: 'dsw-dev-workflow-groupChevron',
              viewBox: '0 0 16 16',
              'aria-hidden': true,
              focusable: false,
            },
            h('path', {
              d: 'M6 3.5 10.5 8 6 12.5',
              fill: 'none',
              stroke: 'currentColor',
              strokeWidth: 1.5,
              strokeLinecap: 'round',
              strokeLinejoin: 'round',
            }),
          ),
          h('span', { className: 'dsw-dev-workflow-groupTitle' }, t(`group.${group.key}`)),
        ),
        open ? h('div', { className: 'dsw-dev-workflow-groupBody' }, children) : null,
      )
    }

    function Advanced({ form, document: doc, t, openDocument, documentAvailable }) {
      return h(
        'div',
        { className: 'dsw-dev-workflow-advanced' },
        h('p', { className: 'dsw-dev-workflow-hint' }, t('advanced.note')),
        ADVANCED.map((entry) =>
          h(
            'div',
            { key: keyOf(entry.path), className: 'dsw-dev-workflow-advancedRow' },
            h('span', { className: 'dsw-dev-workflow-advancedKey' }, t(entry.label)),
            h(
              'code',
              { className: 'dsw-dev-workflow-advancedValue' },
              formatValue(form.read(entry.path)) || t('advanced.empty'),
            ),
          ),
        ),
        documentAvailable
          ? h(
              'div',
              { className: 'dsw-dev-workflow-fieldBody' },
              h(
                'button',
                {
                  type: 'button',
                  className: 'dsw-dev-workflow-button',
                  disabled: doc.opening,
                  onClick: () => {
                    openDocument()
                  },
                },
                t('advanced.open'),
              ),
              doc.error === null
                ? null
                : h('p', { className: 'dsw-dev-workflow-invalid' }, doc.error),
            )
          : null,
      )
    }

    function Section({ useForm, useDocument, t, openDocument, documentAvailable }) {
      const form = useForm((snapshot) => snapshot)
      const document = useDocument((snapshot) => snapshot)
      const [open, setOpen] = useState(() => {
        const initial = {}
        for (const group of GROUPS) initial[group.key] = group.open
        return initial
      })
      if (form.status !== 'ready') {
        return h(
          'section',
          { className: 'dsw-dev-workflow-section' },
          h('h2', { className: 'dsw-dev-workflow-title' }, t('title')),
          h('p', { className: 'dsw-dev-workflow-status', role: 'status' }, t('action.unavailable')),
        )
      }
      const blocked = !form.dirty || form.invalid || form.saving
      return h(
        'section',
        { className: 'dsw-dev-workflow-section' },
        h('h2', { className: 'dsw-dev-workflow-title' }, t('title')),
        h('p', { className: 'dsw-dev-workflow-intro' }, t('intro')),
        form.writable
          ? null
          : h(
              'p',
              { className: 'dsw-dev-workflow-status', role: 'status' },
              t('action.unavailable'),
            ),
        GROUPS.map((group) =>
          h(
            Group,
            {
              key: group.key,
              group,
              open: open[group.key] === true,
              t,
              onToggle: () =>
                setOpen((current) => ({ ...current, [group.key]: current[group.key] !== true })),
            },
            group.key === 'advanced'
              ? h(Advanced, { form, document, t, openDocument, documentAvailable })
              : FIELDS.filter((spec) => spec.group === group.key).map((spec) =>
                  h(Field, { key: keyOf(spec.path), spec, form, t }),
                ),
          ),
        ),
        h(
          'div',
          { className: 'dsw-dev-workflow-actions' },
          form.failed
            ? h(
                'p',
                { className: 'dsw-dev-workflow-note', 'data-tone': 'error' },
                t('action.failed'),
              )
            : null,
          h(
            'button',
            {
              type: 'button',
              className: 'dsw-dev-workflow-button',
              disabled: !form.dirty || form.saving,
              onClick: () => form.discard(),
            },
            t('action.discard'),
          ),
          h(
            'button',
            {
              type: 'button',
              className: 'dsw-dev-workflow-button',
              'data-variant': 'primary',
              disabled: blocked,
              onClick: () => {
                form.save()
              },
            },
            form.saving ? t('action.saving') : t('action.save'),
          ),
        ),
      )
    }

    const inject = ['slots', 'locale', 'configForms', 'remote', 'remote.settings']

    function apply(ctx) {
      const t = ctx.locale.bind(LOCALE)
      ctx.effect(
        () => ctx.locale.register(LOCALE, { en: EN, zh: ZH }),
        'dsh-dev-workflow: panel dictionaries',
      )
      const form = new DraftForm(ctx.configForms.get(NAMESPACE))
      const document = new DocumentAction(ctx.remote.settings)
      ctx.effect(
        () => () => {
          form.dispose()
        },
        'dsh-dev-workflow: panel draft',
      )
      // The navigation entry appears only once the Host serves the namespace:
      // a card for a namespace that is not there could not read or write
      // anything. Also the official shape (`whileServed` + `slots.inject`).
      const face = () => ({
        hooks: { form, document },
        openDocument: () => {
          void document.open()
        },
        documentAvailable: ctx.remote.$host.isLoopback === true,
      })
      ctx.effect(
        () =>
          ctx.configForms.whileServed([NAMESPACE], () =>
            ctx.slots.inject(SLOT, () =>
              ctx.slots.register(
                {
                  name: SLOT,
                  id: NAMESPACE,
                  order: 50,
                  locale: LOCALE,
                  label: () => t('nav'),
                  inject: face,
                },
                Section,
              ),
            ),
          ),
        'dsh-dev-workflow: settings section',
      )
    }

    // Exported for the tests, and only for them: the tables above are the one
    // description of what the page offers, so a test can compare the panel
    // against the Host schema instead of restating the field list.
    const panel = {
      namespace: NAMESPACE,
      locale: LOCALE,
      slot: SLOT,
      order: 50,
      groups: GROUPS,
      fields: FIELDS,
      advanced: ADVANCED,
      commitTypes: COMMIT_TYPES,
      gitPolicies: GIT_POLICIES,
      dictionaries: { en: EN, zh: ZH },
    }

    return { apply, inject, panel }
  },
})

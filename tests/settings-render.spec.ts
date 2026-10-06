import { describe, expect, it } from 'vitest'
import { COMMIT_TYPES, Config } from '../src/config.js'
import {
  createFormScope,
  loadPanel,
  nodeText,
  renderSection,
  unmountSection,
  walkRendered,
  type FormScope,
  type LoadedPanel,
  type RenderedNode,
} from './harness.js'

// The panel is a React component bound through the slot service: the `hooks`
// face hands it `useForm`/`useDocument` selectors, and everything else in the
// face becomes a prop. A selector only ever yields `getSnapshot()`, so an action
// left on the DraftForm instance is unreachable from the markup — the buttons
// then render, look right, and do nothing when clicked. These specs render the
// section through a stubbed `createElement` and fire the handlers, which is the
// layer the instance-level roundtrip tests never touch.

interface Form {
  getSnapshot(): {
    readonly dirty: boolean
    readonly invalid: boolean
    readonly saving: boolean
    readonly failed: boolean
    read(path: readonly string[]): unknown
  }
}

const build = async (): Promise<{ panel: LoadedPanel; scope: FormScope; form: Form }> => {
  const scope = createFormScope(Config({}))
  const panel = await loadPanel(scope)
  return { panel, scope, form: panel.injected.hooks.form as Form }
}

const allNodes = (root: unknown): RenderedNode[] => {
  const nodes: RenderedNode[] = []
  walkRendered(root, (node) => nodes.push(node))
  return nodes
}

/** The rendered field carrying `data-path`, or a failure naming the missing path. */
const fieldFor = (panel: LoadedPanel, path: string): RenderedNode => {
  const field = allNodes(renderSection(panel)).find((node) => node.props['data-path'] === path)
  expect(field, `no rendered field for ${path}`).toBeDefined()
  return field as RenderedNode
}

/** The declaration block of one rule, keyed by its exact selector. */
const declarations = (css: string, selector: string): string => {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const rule = new RegExp(`(?:^|[}])\\s*${escaped}\\{([^}]*)\\}`).exec(css)
  expect(rule, `no rule for ${selector}`).not.toBeNull()
  return (rule as RegExpExecArray)[1] as string
}

/** One property's value inside a declaration block. */
const valueOf = (body: string, property: string): string | undefined =>
  new RegExp(`(?:^|;)\\s*${property}\\s*:([^;]*)`).exec(body)?.[1]

/** Click a control inside a field, the way the browser fires its handler. */
const clickIn = (field: RenderedNode, match: (node: RenderedNode) => boolean): unknown => {
  const node = allNodes(field).find(match)
  expect(node, 'the control should be rendered').toBeDefined()
  const handler = node?.props.onClick as (() => unknown) | undefined
  expect(typeof handler, 'the control should carry a click handler').toBe('function')
  return handler?.()
}

describe('client.js rendered section', () => {
  it('renders a control for every field it describes', async () => {
    const { panel } = await build()

    for (const field of panel.description.fields) {
      fieldFor(panel, field.path.join('.'))
    }
  })

  it('stages an edit when a switch is clicked', async () => {
    const { panel, form } = await build()
    const path = ['commitCheck', 'enabled'] as const
    const before = form.getSnapshot().read(path)

    expect(form.getSnapshot().dirty).toBe(false)

    clickIn(fieldFor(panel, 'commitCheck.enabled'), (node) => node.props.role === 'switch')

    expect(form.getSnapshot().read(path)).toBe(before !== true)
    expect(form.getSnapshot().dirty).toBe(true)
  })

  it('drops a staged edit when the cancel button is clicked', async () => {
    const { panel, form } = await build()

    clickIn(fieldFor(panel, 'commitCheck.enabled'), (node) => node.props.role === 'switch')
    expect(form.getSnapshot().dirty).toBe(true)

    const footer = allNodes(renderSection(panel)).find(
      (node) =>
        typeof node.props.onClick === 'function' &&
        nodeText(node).includes(panel.description.dictionaries.en['action.discard'] as string),
    )
    expect(footer, 'the cancel button should be rendered').toBeDefined()
    ;(footer?.props.onClick as () => void)()

    expect(form.getSnapshot().dirty).toBe(false)
    expect(form.getSnapshot().read(['commitCheck', 'enabled'])).toBe(true)
  })

  it('writes the staged batch to the host when Save is clicked', async () => {
    const { panel, scope, form } = await build()

    clickIn(fieldFor(panel, 'commitCheck.enabled'), (node) => node.props.role === 'switch')
    // A staged edit never reaches the host on its own.
    expect(scope.writes).toEqual([])

    const save = allNodes(renderSection(panel)).find(
      (node) => node.props['data-variant'] === 'primary',
    )
    expect(save, 'the save button should be rendered').toBeDefined()
    await (save?.props.onClick as () => Promise<void>)()

    expect(scope.writes).toEqual([[{ op: 'set', path: ['commitCheck', 'enabled'], value: false }]])
    expect(form.getSnapshot().dirty).toBe(false)
  })

  // The official SettingsForm reports failure and nothing else, so a successful
  // save used to leave no trace at all on the page. This panel adds a note; it
  // has to appear once the batch lands and go away as soon as the page no longer
  // matches the stored value.
  it('confirms a landed save on the page and drops the note on the next edit', async () => {
    const { panel } = await build()
    const saved = (): RenderedNode | undefined =>
      allNodes(renderSection(panel)).find((node) => node.props['data-tone'] === 'success')

    expect(saved(), 'no note before saving').toBeUndefined()

    clickIn(fieldFor(panel, 'commitCheck.enabled'), (node) => node.props.role === 'switch')
    const save = allNodes(renderSection(panel)).find(
      (node) => node.props['data-variant'] === 'primary',
    )
    await (save?.props.onClick as () => Promise<void>)()

    const note = saved()
    expect(note, 'the saved note should be rendered').toBeDefined()
    expect(nodeText(note as RenderedNode)).toContain(
      panel.description.dictionaries.en['action.saved'],
    )

    clickIn(fieldFor(panel, 'commitCheck.enabled'), (node) => node.props.role === 'switch')
    expect(saved(), 'a new edit makes the note stale').toBeUndefined()
  })

  // The draft lives as long as the plugin, but the settings dialog unmounts the
  // section whenever it closes. A note kept on the instance alone therefore came
  // back the next time the user opened the page, long after the save.
  it('does not replay the saved note when the section is mounted again', async () => {
    const { panel } = await build()
    const saved = (): RenderedNode | undefined =>
      allNodes(renderSection(panel)).find((node) => node.props['data-tone'] === 'success')

    clickIn(fieldFor(panel, 'commitCheck.enabled'), (node) => node.props.role === 'switch')
    const save = allNodes(renderSection(panel)).find(
      (node) => node.props['data-variant'] === 'primary',
    )
    await (save?.props.onClick as () => Promise<void>)()
    expect(saved(), 'the note appears while the panel stays open').toBeDefined()

    // Close the dialog and open it again.
    unmountSection()
    expect(saved(), 'reopening the page must not replay an old save').toBeUndefined()
  })

  // `auto` is the default and it is not self-explanatory: the user cannot tell
  // which language it picked. The panel therefore states it, and only while
  // `auto` is selected — switching to an explicit language already says which.
  it('says which language `auto` resolves to, and only for `auto`', async () => {
    const { panel, scope } = await build()
    const notes = (): RenderedNode[] =>
      allNodes(fieldFor(panel, 'locale')).filter((node) => node.props['data-note'] !== undefined)
    const texts = (): string => notes().map(nodeText).join(' ')

    const [note] = notes()
    expect(note, 'auto is the default and should be explained').toBeDefined()
    expect(notes()).toHaveLength(1)
    // The value is resolved on this machine, so assert the shape and the
    // mapping rule rather than a hard-coded locale.
    const tag = Intl.DateTimeFormat().resolvedOptions().locale
    const resolved = tag.toLowerCase().startsWith('zh') ? 'zh-CN' : 'en-US'
    expect(texts()).toContain(panel.description.dictionaries.en[`value.${resolved}`])
    expect(texts()).toContain(tag)
    expect(texts()).not.toContain('{locale}')

    await scope.mutate([{ op: 'set', path: ['locale'], value: 'en-US' }])
    expect(notes(), 'an explicit choice needs no explanation').toHaveLength(0)
  })

  it('labels every rendered control with a string both dictionaries define', async () => {
    const { panel } = await build()
    const locales = [panel.description.dictionaries.en, panel.description.dictionaries.zh]

    for (const field of panel.description.fields) {
      for (const locale of locales) {
        expect(locale[field.label], `${field.path.join('.')} -> ${field.label}`).toBeDefined()
        if (field.hint !== undefined) expect(locale[field.hint]).toBeDefined()
        if (field.note !== undefined) expect(locale[field.note]).toBeDefined()
      }
    }
    for (const entry of panel.description.advanced) {
      for (const locale of locales) {
        expect(locale[entry.label], `advanced -> ${entry.label}`).toBeDefined()
      }
    }

    // A missing key renders as the key itself; that is what put `field.enabled`
    // on the page, so no rendered text may look like a dictionary key.
    const text = allNodes(renderSection(panel)).map(nodeText).join('\n')
    expect(text).not.toMatch(
      /(?:^|\n)\s*(?:field|group|hint|value|action|advanced)\.[\w.]+\s*(?:\n|$)/,
    )
  })

  // The code above renders through a stub, so no style is ever applied: a defect
  // that hides text under another element is invisible to it. The segments
  // control is the one such overlay — its indicator is absolutely positioned and
  // opaque, so unless the buttons take a stacking layer of their own, the
  // indicator paints over the text of whichever segment it slides to, and the
  // selected option is the one that goes blank.
  it('stacks the segment buttons above the indicator that covers them', async () => {
    const { panel } = await build()
    const css = panel.description.css

    const indicator = declarations(css, '.dsw-dev-workflow-segmentIndicator')
    expect(valueOf(indicator, 'position')).toBe('absolute')
    // Only an opaque backdrop hides anything; a transparent one could not.
    expect(valueOf(indicator, 'background')).not.toBe('transparent')

    const segment = declarations(css, '.dsw-dev-workflow-segment')
    expect(valueOf(segment, 'position')).not.toBeUndefined()
    expect(valueOf(segment, 'position')).not.toBe('static')
    expect(Number(valueOf(segment, 'z-index'))).toBeGreaterThanOrEqual(1)
  })

  // The indicator already marks the choice, but its text still reads like the
  // others. A heavier weight on the selected tab separates it without moving it.
  it('sets the selected segment a step bolder than the rest', async () => {
    const { panel } = await build()
    const css = panel.description.css

    const base = valueOf(declarations(css, '.dsw-dev-workflow-segment'), 'font-weight')
    const selected = valueOf(
      declarations(css, ".dsw-dev-workflow-segment[aria-selected='true']"),
      'font-weight',
    )
    expect(base, 'the base rule should state a weight to outweigh').not.toBeUndefined()
    expect(selected, 'the selected rule should restate the weight').not.toBeUndefined()
    expect(Number(selected)).toBeGreaterThan(Number(base))
  })

  // A wrapping flex row breaks wherever the first line happens to fill up, which
  // left the last commit type alone on a second line. A grid with a fixed column
  // count splits the list evenly instead.
  it('lays the commit types out in even columns', async () => {
    const { panel } = await build()
    const checks = declarations(panel.description.css, '.dsw-dev-workflow-checks')
    expect(valueOf(checks, 'display'), 'a wrapping row breaks wherever it fills').toBe('grid')
    const columns = Number(
      /repeat\((\d+)/.exec(valueOf(checks, 'grid-template-columns') ?? '')?.[1],
    )
    expect(columns).toBeGreaterThan(0)
    const rows = Math.ceil(COMMIT_TYPES.length / columns)
    const lastRow = COMMIT_TYPES.length - (rows - 1) * columns
    // Every row but the last is full, so a half-full tail is the even split.
    expect(lastRow).toBeGreaterThanOrEqual(columns / 2)
  })

  // The success/error note takes `flex:1`, so a row without `justify-content`
  // puts the buttons on the right only while a note is showing and back on the
  // left the rest of the time. Pinning the row keeps them in one place.
  it('keeps the footer buttons on the right whether or not a note is showing', async () => {
    const { panel } = await build()
    const actions = declarations(panel.description.css, '.dsw-dev-workflow-actions')

    expect(valueOf(actions, 'display')).toBe('flex')
    expect(valueOf(actions, 'justify-content')).toBe('flex-end')
  })
})

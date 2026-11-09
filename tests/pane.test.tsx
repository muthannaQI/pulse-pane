// pulse-pane v1.1.0 tests
import type { On } from 'claude-code'
import { expect, test } from 'claude-code/testing'

import { LANGS, STRINGS } from '../hooks/i18n'
import { clip, drawSvg, touchFile, units } from '../hooks/register'
import type { Live } from '../types'

const PANE = {
  plugin: 'pulse-pane',
  component: 'Pane',
  requestId: 'pulse-pane',
  props: {
    title: 'Pulse Pane',
    isFocused: false,
    bodyColumns: 60,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 40 },
    view: {},
  },
} as const

const ARABIC = { options: { language: 'ar' } }

// Answers the engine calls a session makes, so each test drives only the events
// it is about.
const stubSession = (on: On) => {
  on('ui.log', () => ({ value: undefined }))
  on('store.get', () => ({ value: undefined }))
  on('store.set', () => ({ value: undefined }))
  on('command.register', () => ({ value: { command: 'pulse' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('tool.call', () => ({ result: {} }))
  on('turn.start', (_, e) => ({ turnId: e.turnId }))
  on('turn.complete', () => ({ text: '' }))
}

const endTurn = (reason: 'answer' | 'aborted' | 'error') => ({
  answer: '',
  durationMs: 1200,
  isAborted: reason === 'aborted',
  turnId: 't1',
  reason,
})

test('a tool call reaches the pane on the terminal and the desktop', async ($, on) => {
  stubSession(on)

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.tool.call({ tool: 'Read', file_path: '/src/app.ts' })

  const terminal = await $.ui.mount({ ...PANE, surface: 'terminal' })
  const row = await terminal.find({ type: 'Text', text: /app\.ts/ })
  expect(row?.text).toContain('Read')
  await terminal.unmount()

  const desktop = await $.ui.mount({ ...PANE, surface: 'desktop' })
  const svg = await desktop.find({ type: 'Svg' })
  expect(svg).toBeDefined()
  await desktop.unmount()
})

test('the pane is in English when no language is set', async ($, on) => {
  stubSession(on)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect((await ui.find({ type: 'Text', text: /Idle/ }))?.text).toContain('Idle')
  await ui.unmount()
})

for (const [reason, label] of [
  ['answer', 'انتهى'],
  ['aborted', 'أُوقف'],
  ['error', 'خطأ'],
] as const) {
  test(`in Arabic, a turn that ends with "${reason}" shows ${label}`, ARABIC, async ($, on) => {
    stubSession(on)
    await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
    await $.turn.start({ text: 'hi', turnId: 't1' })
    await $.turn.complete(endTurn(reason))

    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
    expect((await ui.find({ type: 'Text', text: new RegExp(label) }))?.text).toContain(label)
    await ui.unmount()
  })
}

test('/pulse fr writes the language setting and answers in French', async ($, on) => {
  stubSession(on)
  const written: { key: string; value: unknown }[] = []
  on('config.list', () => ({ value: [{ key: 'pulse-pane.language' }] }) as never)
  on('config.set', (_, e) => {
    written.push({ key: e.key, value: e.value })
    return { value: e.value }
  })
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })

  const ran = await $.command.run({ command: 'pulse', args: ' FR ' } as never)
  expect(written).toEqual([{ key: 'pulse-pane.language', value: 'fr' }])
  expect(JSON.stringify(ran)).toContain(STRINGS.fr.languageSet)
})

test('/pulse with an unknown code changes nothing and lists the codes', async ($, on) => {
  stubSession(on)
  let wrote = false
  on('config.set', () => {
    wrote = true
    return { value: 'x' }
  })
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })

  const ran = (await $.command.run({ command: 'pulse', args: 'xx' } as never)) as { text?: string }
  expect(wrote).toBe(false)
  expect(ran.text).toContain('"xx"')
  expect(ran.text).toContain(LANGS.join(', '))
})

const busy: Live = {
  phase: 'tool',
  turnStart: 1_000,
  steps: 3,
  thinkingChars: 0,
  textChars: 0,
  running: 1,
  calls: [{ id: '1', tool: 'PowerShell', kind: 'run', label: 'npm run build --workspace=pulse-pane', start: 1_000 }],
  counts: { read: 2, edit: 1, run: 1, search: 0, web: 0, agent: 1, mcp: 0, other: 0 },
  files: { '/a/very-long-component-name.tsx': 3 },
  agents: [{ id: 'a', description: 'Analyse the whole project and write a report', type: 'x', start: 1_000 }],
  context: { percent: 40, tokens: 80_000, window: 200_000 },
  costUsd: 0.42,
  usageStale: true,
  outputTokens: 3_200,
  turns: [],
  model: 'claude-sonnet-5-5',
  now: 2_000,
}

for (const lang of LANGS) {
  test(`the drawing is complete in ${lang} at 300 and 640 px`, () => {
    const t = STRINGS[lang]
    for (const width of [300, 640]) {
      const svg = drawSvg(busy, width, t)
      expect(svg.startsWith('<svg')).toBe(true)
      expect(svg).toContain(clip(t.pipeline, 4).replace('…', ''))
      expect(svg).not.toContain('undefined')
      expect(svg).not.toContain('NaN')
    }
  })
}

test('only Arabic lays the pane out right to left', () => {
  expect(LANGS.filter(l => STRINGS[l].dir === 'rtl')).toEqual(['ar'])
})

test('wide scripts count double and combining marks count nothing', () => {
  expect(units('abc')).toBe(3)
  expect(units('工具')).toBe(4)
  expect(units('أُوقف')).toBe(4)
  expect(clip('工具分布', 5)).toBe('工具…')
  expect(clip('short', 10)).toBe('short')
})

test('the files map keeps the 50 most-touched files', () => {
  let files: Record<string, number> = { '/hot.ts': 100 }
  for (let i = 0; i < 60; i++) files = touchFile(files, `/src/f${i}.ts`)

  expect(Object.keys(files).length).toBe(50)
  expect(files['/hot.ts']).toBe(100)
  expect(touchFile(files, '/hot.ts')['/hot.ts']).toBe(101)
})

test('a failed usage read marks the cost as stale', ARABIC, async ($, on) => {
  stubSession(on)
  on('session.usage', () => {
    throw new Error('offline')
  })
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })

  // The usage read runs without being awaited; redraw until its failure lands.
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  let source = ''
  for (let i = 0; i < 50 && !source.includes('قديمة'); i++) {
    await ui.redraw()
    source = String((await ui.find({ type: 'Svg' }))?.props.source ?? '')
  }
  expect(source).toContain('التكلفة (قديمة)')
  await ui.unmount()
})

test('a value an earlier version stored is declined', ARABIC, async ($, on) => {
  on('state.get', () => ({
    value: { value: { shape: 'live-1', value: { phase: 'tool' } }, version: 1 },
  }))

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect((await ui.find({ type: 'Text', text: /خامل/ }))?.text).toContain('خامل')
  await ui.unmount()
})

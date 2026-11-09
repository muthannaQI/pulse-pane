// pulse-pane v1.0.0 tests
import type { On } from 'claude-code'
import { expect, test } from 'claude-code/testing'

import { touchFile } from '../hooks/register'

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

// Answers the engine calls a session makes, so each test drives only the events
// it is about.
const stubSession = (on: On) => {
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

for (const [reason, label] of [
  ['answer', 'انتهى'],
  ['aborted', 'أُوقف'],
  ['error', 'خطأ'],
] as const) {
  test(`a turn that ends with "${reason}" shows ${label}`, async ($, on) => {
    stubSession(on)
    await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
    await $.turn.start({ text: 'hi', turnId: 't1' })
    await $.turn.complete(endTurn(reason))

    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
    expect((await ui.find({ type: 'Text', text: new RegExp(label) }))?.text).toContain(label)
    await ui.unmount()
  })
}

test('the files map keeps the 50 most-touched files', () => {
  let files: Record<string, number> = { '/hot.ts': 100 }
  for (let i = 0; i < 60; i++) files = touchFile(files, `/src/f${i}.ts`)

  expect(Object.keys(files).length).toBe(50)
  expect(files['/hot.ts']).toBe(100)
  expect(touchFile(files, '/hot.ts')['/hot.ts']).toBe(101)
})

test('a failed usage read marks the cost as stale', async ($, on) => {
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

test('a value an earlier version stored is declined', async ($, on) => {
  on('state.get', () => ({
    value: { value: { shape: 'live-1', value: { phase: 'tool' } }, version: 1 },
  }))

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect((await ui.find({ type: 'Text', text: /خامل/ }))?.text).toContain('خامل')
  await ui.unmount()
})

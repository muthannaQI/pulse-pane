// pulse-pane v1.1.0: a live pane of what Claude Code is doing, in ten languages.
import type { EngineInterface, Register, StateDollar } from 'claude-code'

import type { AgentRow, Call, Live, Phase, ToolKind } from '../types'
import { isLang, LANGS, STRINGS, stringsFor, type Strings } from './i18n'

// What the state helpers need: the state itself, and the UI to report a failure.
type StateAndLog = Pick<EngineInterface, 'state' | 'ui'>

const PANE = 'pulse-pane'
// How many files the pane remembers; it shows the top five, the rest only keep
// the ranking honest without letting the state grow for the whole session.
const MAX_FILES = 50
const STATE_WRITE_ATTEMPTS = 5
// A desktop pane cell is roughly this many CSS pixels wide; the drawing is laid
// out at the pane's own width so its type keeps its real size.
const CELL_PX = 8
// The body columns the pane asks for while docked beside the transcript.
const PANE_COLUMNS = 72
const TITLE = 'Pulse Pane'
// The /config row of this plugin's `language` field: `<plugin>.<field>`, where a
// plugin loaded from a folder may carry an `@<source>` suffix.
const LANGUAGE_KEY = /^pulse-pane(@[^.]+)?\.language$/

const EMPTY_COUNTS = (): Record<ToolKind, number> => ({
  read: 0,
  edit: 0,
  run: 0,
  search: 0,
  web: 0,
  agent: 0,
  mcp: 0,
  other: 0,
})

const initial = (): Live => ({
  phase: 'idle',
  steps: 0,
  thinkingChars: 0,
  textChars: 0,
  running: 0,
  calls: [],
  counts: EMPTY_COUNTS(),
  files: {},
  agents: [],
  context: {},
  outputTokens: 0,
  turns: [],
  now: Date.now(),
})

// Change the tag when Live's fields change: it declines what an earlier
// version stored, which outlives a reload.
const LIVE = { plugin: 'pulse-pane', key: 'live' } as const
const SHAPE = 'live-2'

const unwrap = (held: { shape: string; value: Live } | undefined): Live =>
  held && held.shape === SHAPE ? held.value : initial()

const readLive = async ($: StateDollar): Promise<Live> => unwrap((await $.state.get(LIVE)).value)

// Read, apply, write with `ifVersion`; again on a miss, so two changes before
// a redraw both land.
const changeLive = async ($: StateAndLog, change: (s: Live) => Live): Promise<void> => {
  for (let attempt = 0; attempt < STATE_WRITE_ATTEMPTS; attempt++) {
    const held = await $.state.get(LIVE)
    const next = change(unwrap(held.value))
    const wrote = await $.state.set(LIVE, { shape: SHAPE, value: next }, { ifVersion: held.version })
    if (wrote.isSet) return
  }
  $.ui.log(`pulse-pane: a pane update was dropped after ${STATE_WRITE_ATTEMPTS} write conflicts`, { to: 'debug' })
}

// The pane's bookkeeping must never fail the tool call, agent or close it rides
// on: hooks that gate those events end their own writes with `.catch(report($))`.
const report = ($: Pick<EngineInterface, 'ui'>) => (err: unknown) =>
  $.ui.log(`pulse-pane: pane update failed: ${String(err)}`, { to: 'debug' })

const isActive = (p: Phase) => p === 'thinking' || p === 'writing' || p === 'tool'

// Counts one more touch of `file`; past MAX_FILES the least-touched entries go.
export const touchFile = (files: Record<string, number>, file: string): Record<string, number> => {
  const next = { ...files, [file]: (files[file] ?? 0) + 1 }
  const entries = Object.entries(next)
  if (entries.length <= MAX_FILES) return next
  return Object.fromEntries(entries.sort((p, q) => q[1] - p[1]).slice(0, MAX_FILES))
}

const phaseOfEnd = (reason: 'answer' | 'aborted' | 'refusal' | 'error'): Phase =>
  reason === 'answer' ? 'done' : reason === 'aborted' ? 'aborted' : 'error'

// ---------- classification ----------

const kindOf = (tool: string): ToolKind => {
  if (tool.startsWith('mcp__')) return 'mcp'
  switch (tool) {
    case 'Read':
    case 'NotebookRead':
      return 'read'
    case 'Edit':
    case 'MultiEdit':
    case 'Write':
    case 'NotebookEdit':
      return 'edit'
    case 'Bash':
    case 'PowerShell':
      return 'run'
    case 'Grep':
    case 'Glob':
    case 'LS':
      return 'search'
    case 'WebFetch':
    case 'WebSearch':
      return 'web'
    case 'Agent':
    case 'Task':
    case 'Workflow':
      return 'agent'
    default:
      return 'other'
  }
}

const baseName = (p: string) => p.replace(/[\\/]+$/, '').split(/[\\/]/).pop() ?? p

const labelOf = (tool: string, args: Record<string, unknown>): string => {
  const s = (k: string) => (typeof args[k] === 'string' ? (args[k] as string) : undefined)
  const file = s('file_path') ?? s('notebook_path') ?? s('path')
  if (file) return baseName(file)
  const cmd = s('command')
  if (cmd) return cmd.replace(/\s+/g, ' ').slice(0, 42)
  const q = s('pattern') ?? s('query') ?? s('url') ?? s('description') ?? s('prompt')
  if (q) return q.slice(0, 42)
  return tool.startsWith('mcp__') ? tool.split('__').slice(1).join(' · ') : tool
}

const fileOf = (tool: string, args: Record<string, unknown>): string | undefined => {
  if (kindOf(tool) !== 'read' && kindOf(tool) !== 'edit') return undefined
  const f = args.file_path ?? args.notebook_path
  return typeof f === 'string' ? f : undefined
}

// ---------- text width ----------

// CJK, kana, Hangul and full-width forms take about two Latin widths; combining
// marks (Arabic harakat, Devanagari vowel signs) take none.
const WIDE = /[ᄀ-ᅟ⺀-꓏가-힣豈-﫿︰-﹏＀-｠￠-￦]/
const MARK = /[̀-ͯؐ-ًؚ-ٰٟۖ-ۭऀ-ःऺ-ॏ॑-ॗॢॣ]/
const unitOf = (ch: string) => (WIDE.test(ch) ? 2 : MARK.test(ch) ? 0 : 1)

/** How many Latin-character widths `s` takes. */
export const units = (s: string) => {
  let n = 0
  for (const ch of s) n += unitOf(ch)
  return n
}

/** Shortens `s` to `max` Latin widths, marking the cut with an ellipsis. */
export const clip = (s: string, max: number) => {
  if (units(s) <= max) return s
  let out = ''
  let n = 0
  for (const ch of s) {
    const w = unitOf(ch)
    if (n + w > Math.max(1, max - 1)) break
    out += ch
    n += w
  }
  return `${out}…`
}

// ---------- drawing helpers ----------

const KIND_COLOR: Record<ToolKind, string> = {
  read: '#3B82F6',
  edit: '#F59E0B',
  run: '#22C55E',
  search: '#06B6D4',
  web: '#A855F7',
  agent: '#EC4899',
  mcp: '#14B8A6',
  other: '#94A3B8',
}

const PHASE_COLOR: Record<Phase, string> = {
  idle: '#64748B',
  thinking: '#8B5CF6',
  writing: '#22D3EE',
  tool: '#F59E0B',
  done: '#22C55E',
  aborted: '#F97316',
  error: '#EF4444',
}

const esc = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

const fmtMs = (ms: number) => {
  const s = Math.max(0, Math.floor(ms / 1000))
  const m = Math.floor(s / 60)
  return `${m}:${String(s % 60).padStart(2, '0')}`
}

const fmtK = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}k` : String(n))

const arcPath = (cx: number, cy: number, r: number, a0: number, a1: number) => {
  const p = (a: number): [number, number] => [cx + r * Math.cos(a), cy + r * Math.sin(a)]
  const [x0, y0] = p(a0)
  const [x1, y1] = p(a1)
  const large = a1 - a0 > Math.PI ? 1 : 0
  return `M ${x0.toFixed(2)} ${y0.toFixed(2)} A ${r} ${r} 0 ${large} 1 ${x1.toFixed(2)} ${y1.toFixed(2)}`
}

// Script-specific fallbacks so Chinese, Japanese and Hindi draw with a real font
// on Windows, macOS and Linux rather than boxes.
const FONT =
  "font-family='Segoe UI, system-ui, -apple-system, Noto Sans, Microsoft YaHei, PingFang SC, Yu Gothic UI, Hiragino Sans, Nirmala UI, Noto Sans Devanagari, sans-serif'"
const BG = '#0B0F14'
const CARD = '#121823'
const LINE = '#1E293B'
const TEXT = '#E2E8F0'
// Light enough for 11px labels on CARD (about 6:1); #7C8BA1 read as faded there.
const DIM = '#93A1B5'
const BRAND = '#E11D48'
const PAD = 14

// Roughly how wide one Latin character of 11-13px text is; enough to keep a
// label inside the room it was given.
const CHAR_PX = 7

type Side = { x: number; anchor: 'start' | 'end' }

// Where a card's title goes, and where the item that shares its row goes: the
// title starts at the reading side, so it is on the right for Arabic.
const titleSide = (W: number, t: Strings): Side =>
  t.dir === 'rtl' ? { x: W - PAD - 14, anchor: 'end' } : { x: PAD + 14, anchor: 'start' }
const otherSide = (W: number, t: Strings): Side =>
  t.dir === 'rtl' ? { x: PAD + 14, anchor: 'start' } : { x: W - PAD - 14, anchor: 'end' }

// `share` is the part of the row the title may take; the rest belongs to the
// item on the other side of the same row.
const card = (W: number, y: number, h: number, title: string, t: Strings, share = 1) => {
  const at = titleSide(W, t)
  const room = Math.floor(((W - PAD * 2 - 28) * share) / 7.5)
  return (
    `<rect x='${PAD}' y='${y}' width='${W - PAD * 2}' height='${h}' rx='14' fill='${CARD}' stroke='${LINE}'/>` +
    `<text x='${at.x}' y='${y + 24}' text-anchor='${at.anchor}' fill='${DIM}' font-size='13' font-weight='600' ${FONT}>${esc(clip(title, room))}</text>`
  )
}

const KINDS: ToolKind[] = ['read', 'edit', 'run', 'search', 'web', 'agent', 'mcp', 'other']

// The mark inside the status dot: it tells the end states apart without colour.
const PHASE_GLYPH: Partial<Record<Phase, string>> = {
  done: `<path d='M -6 0 L -2 4 L 6 -4' fill='none' stroke='#fff' stroke-width='2.6' stroke-linecap='round' stroke-linejoin='round'/>`,
  aborted: `<rect x='-5' y='-5' width='10' height='10' rx='1.5' fill='#fff'/>`,
  error: `<path d='M -5 -5 L 5 5 M 5 -5 L -5 5' stroke='#fff' stroke-width='2.6' stroke-linecap='round'/>`,
}

export const drawSvg = (v: Live, width = 400, t: Strings = stringsFor(undefined)): string => {
  const W = Math.round(width)
  const active = isActive(v.phase)
  const color = PHASE_COLOR[v.phase]
  const ph = t.phase[v.phase]
  // event-based reference time: the drawing changes only when something happened
  const stamps = v.calls.flatMap(c => (c.end === undefined ? [c.start] : [c.start, c.end]))
  const now = Math.max(v.turnStart ?? 0, v.turnEnd ?? 0, ...stamps, 1)
  const parts: string[] = []
  let y = 0

  // ----- header -----
  const oc = { x: 40, y: 46 }
  // Below 360px the model name would squeeze the phase description to a word.
  const stepsText = W < 360 ? t.steps(v.steps) : `${t.steps(v.steps)} · ${(v.model ?? '—').replace(/^claude-/, '')}`
  // The phase name shrinks to fit the row rather than run off it.
  const labelSize = Math.max(14, Math.min(W < 360 ? 22 : 26, Math.floor((W - 74 - PAD) / (units(ph.label) * 0.62))))
  const subRoom = Math.max(6, Math.floor((W - 74 - PAD - units(stepsText) * 6.5 - 12) / 6.8))
  parts.push(
    `<g transform='translate(${oc.x} ${oc.y})'>` +
      (active
        ? `<circle r='22' fill='${color}' opacity='0.18'><animate attributeName='r' values='18;34;18' dur='1.6s' repeatCount='indefinite'/><animate attributeName='opacity' values='0.28;0;0.28' dur='1.6s' repeatCount='indefinite'/></circle>` +
          `<circle r='22' fill='none' stroke='${color}' stroke-width='2' opacity='0.5'><animate attributeName='r' values='16;30' dur='1.6s' repeatCount='indefinite'/><animate attributeName='opacity' values='0.7;0' dur='1.6s' repeatCount='indefinite'/></circle>`
        : '') +
      `<circle r='15' fill='${color}'/>` +
      (PHASE_GLYPH[v.phase] ??
        `<circle r='5.5' fill='#fff' opacity='0.92'>${active ? `<animate attributeName='opacity' values='0.95;0.3;0.95' dur='1s' repeatCount='indefinite'/>` : ''}</circle>`) +
      `</g>`,
    `<text x='74' y='42' fill='${TEXT}' font-size='${labelSize}' font-weight='700' ${FONT}>${esc(ph.label)}</text>`,
    `<text x='74' y='64' fill='${DIM}' font-size='13' ${FONT}>${esc(clip(ph.sub, subRoom))}</text>`,
    `<text x='${W - PAD}' y='64' text-anchor='end' fill='${DIM}' font-size='12' ${FONT}>${esc(stepsText)}</text>`,
    `<rect x='${PAD}' y='80' width='${W - PAD * 2}' height='3' rx='1.5' fill='${BRAND}' opacity='0.9'/>`,
  )
  y = 96

  // ----- pipeline -----
  const ph1 = 150
  parts.push(card(W, y, ph1, t.pipeline, t, 0.55))
  const ny = y + 72
  const nodeRoom = Math.floor((W * 0.3) / 8.5)
  const nodes: { x: number; label: string; on: boolean; color: string; icon: string }[] = [
    { x: Math.round(W * 0.17), label: t.you, on: !isActive(v.phase), color: '#94A3B8', icon: 'user' },
    { x: Math.round(W * 0.5), label: t.claude, on: v.phase === 'thinking' || v.phase === 'writing', color, icon: 'brain' },
    { x: Math.round(W * 0.83), label: t.tools, on: v.phase === 'tool', color: '#F59E0B', icon: 'tool' },
  ]
  const edge = (x0: number, x1: number, on: boolean, stroke: string, back: boolean) => {
    const yy = back ? ny + 9 : ny - 9
    const d = `M ${x0} ${yy} C ${x0 + 40} ${yy}, ${x1 - 40} ${yy}, ${x1} ${yy}`
    return (
      `<path d='${d}' fill='none' stroke='${LINE}' stroke-width='4'/>` +
      (on
        ? `<path d='${d}' fill='none' stroke='${stroke}' stroke-width='4' stroke-linecap='round' stroke-dasharray='7 13'><animate attributeName='stroke-dashoffset' from='${back ? 0 : 40}' to='${back ? 40 : 0}' dur='0.9s' repeatCount='indefinite'/></path>`
        : '')
    )
  }
  const [nA, nB, nC] = [nodes[0]!.x, nodes[1]!.x, nodes[2]!.x]
  parts.push(edge(nA + 30, nB - 30, v.phase === 'thinking', '#8B5CF6', false))
  parts.push(edge(nA + 30, nB - 30, v.phase === 'writing', '#22D3EE', true))
  parts.push(edge(nB + 30, nC - 30, v.phase === 'tool', '#F59E0B', false))
  parts.push(edge(nB + 30, nC - 30, v.phase === 'tool', '#22C55E', true))
  for (const n of nodes) {
    const c = n.on ? n.color : DIM
    parts.push(
      n.on
        ? `<circle cx='${n.x}' cy='${ny}' r='32' fill='${n.color}' opacity='0.15'><animate attributeName='r' values='30;40;30' dur='1.8s' repeatCount='indefinite'/></circle>`
        : '',
      `<circle cx='${n.x}' cy='${ny}' r='28' fill='${BG}' stroke='${n.on ? n.color : LINE}' stroke-width='${n.on ? 3.5 : 2}'/>`,
    )
    if (n.icon === 'user') {
      parts.push(
        `<circle cx='${n.x}' cy='${ny - 7}' r='6.5' fill='${c}'/>`,
        `<path d='M ${n.x - 12} ${ny + 13} a 12 9 0 0 1 24 0 z' fill='${c}'/>`,
      )
    } else if (n.icon === 'brain') {
      parts.push(
        `<path d='M ${n.x - 10} ${ny} a 10 10 0 1 1 20 0 v 8 h -20 z' fill='none' stroke='${c}' stroke-width='2.5'/>`,
        `<path d='M ${n.x} ${ny - 10} v 18 M ${n.x - 5} ${ny - 2} h 10' stroke='${c}' stroke-width='2.5' stroke-linecap='round'/>`,
      )
    } else {
      parts.push(
        `<path d='M ${n.x - 9} ${ny + 9} l 18 -18 M ${n.x + 3} ${ny - 9} h 6 v 6' fill='none' stroke='${c}' stroke-width='3' stroke-linecap='round' stroke-linejoin='round'/>`,
        `<circle cx='${n.x - 9}' cy='${ny + 9}' r='4' fill='${c}'/>`,
      )
    }
    parts.push(`<text x='${n.x}' y='${ny + 50}' text-anchor='middle' fill='${n.on ? TEXT : DIM}' font-size='14' font-weight='600' ${FONT}>${esc(clip(n.label, nodeRoom))}</text>`)
  }
  const runAt = otherSide(W, t)
  const runRoom = Math.floor(((W - PAD * 2 - 28) * 0.42) / 6.8)
  parts.push(
    `<text x='${runAt.x}' y='${y + 24}' text-anchor='${runAt.anchor}' fill='${v.running > 0 ? '#F59E0B' : DIM}' font-size='12' font-weight='600' ${FONT}>${esc(clip(v.running > 0 ? t.running(v.running) : t.noneRunning, runRoom))}</text>`,
  )
  y += ph1 + 10

  // ----- timeline swimlanes -----
  const laneH = 22
  const th = 40 + KINDS.length * laneH + 34
  parts.push(card(W, y, th, t.timeline, t))
  // The label column grows with the language's longest tool-kind name.
  const laneLabelW = Math.min(90, Math.max(44, Math.max(...KINDS.map(k => units(t.kind[k]))) * CHAR_PX))
  const laneLabelX = PAD + 6 + laneLabelW
  const laneX0 = laneLabelX + 8
  const laneX1 = W - PAD - 14
  const laneTop = y + 40
  const t0 = v.turnStart ?? now
  const span = Math.max(8000, now - t0)
  KINDS.forEach((k, i) => {
    const ly = laneTop + i * laneH
    parts.push(
      `<text x='${laneLabelX}' y='${ly + 15}' text-anchor='end' fill='${KIND_COLOR[k]}' font-size='12' font-weight='600' ${FONT}>${esc(clip(t.kind[k], Math.floor(laneLabelW / CHAR_PX)))}</text>`,
      `<line x1='${laneX0}' y1='${ly + 11}' x2='${laneX1}' y2='${ly + 11}' stroke='${LINE}' stroke-width='1' stroke-dasharray='2 5'/>`,
    )
  })
  const laneOf = (k: ToolKind) => laneTop + KINDS.indexOf(k) * laneH
  for (const c of v.calls.filter(c => c.start >= t0 - 500)) {
    const x = laneX0 + ((c.start - t0) / span) * (laneX1 - laneX0)
    const end = c.end ?? now
    const w = Math.max(8, ((end - c.start) / span) * (laneX1 - laneX0))
    const ly = laneOf(c.kind) + 4
    const fill = c.isError ? '#EF4444' : KIND_COLOR[c.kind]
    const runs = c.end === undefined
    parts.push(
      `<rect x='${x.toFixed(1)}' y='${ly}' width='${Math.min(w, laneX1 - x).toFixed(1)}' height='14' rx='4' fill='${fill}' opacity='${c.agentId ? 0.55 : 0.95}'>${runs ? `<animate attributeName='opacity' values='1;0.35;1' dur='0.8s' repeatCount='indefinite'/>` : ''}</rect>`,
    )
  }
  const last = v.calls[v.calls.length - 1]
  const ly2 = y + th - 14
  if (last) {
    const col = last.isError ? '#EF4444' : KIND_COLOR[last.kind]
    const tail =
      last.end === undefined
        ? `<tspan fill='${col}'> …</tspan>`
        : last.isError
          ? ` <tspan fill='#EF4444'>${esc(t.errorWord)}</tspan>`
          : ` <tspan fill='${DIM}'>${((last.end - last.start) / 1000).toFixed(1)}s</tspan>`
    // What is left of the row after the dot, the tool name and the tail.
    const tailUnits = last.isError ? units(t.errorWord) + 1 : 6
    const labelRoom = Math.max(6, Math.floor((W - PAD * 2 - 28 - 14 - (units(last.tool) + tailUnits) * CHAR_PX) / CHAR_PX))
    parts.push(
      `<circle cx='${PAD + 16}' cy='${ly2 - 4}' r='5' fill='${col}'>${last.end === undefined ? `<animate attributeName='opacity' values='1;0.3;1' dur='0.8s' repeatCount='indefinite'/>` : ''}</circle>`,
      `<text x='${PAD + 28}' y='${ly2}' fill='${TEXT}' font-size='13' ${FONT}><tspan font-weight='600'>${esc(last.tool)}</tspan> <tspan fill='${DIM}'>${esc(clip(last.label, labelRoom))}</tspan>${tail}</text>`,
    )
  } else {
    parts.push(`<text x='${W / 2}' y='${ly2}' text-anchor='middle' fill='${DIM}' font-size='13' ${FONT}>${esc(t.noCalls)}</text>`)
  }
  y += th + 10

  // ----- stats footer (context, cost, tokens, turns) -----
  const pct = Math.min(100, Math.max(0, v.context.percent ?? 0))
  const rcx = PAD + 44
  const rr = 24
  // The three stats sit beside the context label when the row has room for them
  // in this language; otherwise they get a row of their own under it.
  const contextEnd = rcx + 36 + units(t.context) * 7.5
  const besideStart = Math.round(Math.max(W * 0.54, contextEnd + 26))
  const STATS_MIN_SPAN = 150
  const statsRow = Math.round(W * 0.89) - besideStart >= STATS_MIN_SPAN ? 0 : 56
  const fh = 118 + statsRow
  parts.push(`<rect x='${PAD}' y='${y}' width='${W - PAD * 2}' height='${fh}' rx='14' fill='${CARD}' stroke='${LINE}'/>`)
  const rcy = y + 40
  const ringColor = pct > 85 ? '#EF4444' : pct > 60 ? '#F59E0B' : '#22C55E'
  parts.push(
    `<circle cx='${rcx}' cy='${rcy}' r='${rr}' fill='none' stroke='${LINE}' stroke-width='7'/>`,
    pct > 0 ? `<path d='${arcPath(rcx, rcy, rr, -Math.PI / 2, -Math.PI / 2 + (pct / 100) * Math.PI * 2 - 0.001)}' fill='none' stroke='${ringColor}' stroke-width='7' stroke-linecap='round'/>` : '',
    `<text x='${rcx}' y='${rcy + 5}' text-anchor='middle' fill='${TEXT}' font-size='13' font-weight='700' ${FONT}>${pct}%</text>`,
    `<text x='${rcx + 36}' y='${rcy - 4}' fill='${TEXT}' font-size='13' font-weight='600' ${FONT}>${esc(t.context)}</text>`,
    W >= 360 || statsRow > 0 ? `<text x='${rcx + 36}' y='${rcy + 13}' fill='${DIM}' font-size='11' ${FONT}>${fmtK(v.context.tokens ?? 0)} / ${fmtK(v.context.window ?? 0)}</text>` : '',
  )
  const [s0, s1, s2] =
    statsRow === 0
      ? [besideStart, Math.round((besideStart + W * 0.89) / 2), Math.round(W * 0.89)]
      : [Math.round(W * 0.2), Math.round(W * 0.5), Math.round(W * 0.8)]
  const statY = rcy + statsRow
  // 11px text runs about 5.6px a Latin character; a centred title may use the
  // whole gap to its neighbour.
  const statRoom = Math.max(3, Math.floor((s1 - s0) / 5.6))
  const stat = (x: number, title: string, value: string) =>
    `<text x='${x}' y='${statY - 6}' text-anchor='middle' fill='${DIM}' font-size='11' ${FONT}>${esc(clip(title, statRoom))}</text>` +
    `<text x='${x}' y='${statY + 14}' text-anchor='middle' fill='${TEXT}' font-size='17' font-weight='700' font-variant-numeric='tabular-nums' ${FONT}>${esc(value)}</text>`
  // Where the full stale title does not fit (a narrow pane, a long language), the
  // $ value already says it is the cost, so the title is only the word "stale".
  const costTitle = !v.usageStale ? t.cost : units(t.costStale) <= statRoom ? t.costStale : t.staleShort
  parts.push(stat(s0, costTitle, v.costUsd === undefined ? '—' : `$${v.costUsd.toFixed(2)}`))
  parts.push(stat(s1, t.output, fmtK(v.outputTokens)))
  parts.push(stat(s2, t.turns, String(v.turns.length)))
  const sx = PAD + 14
  const sw = W - PAD * 2 - 28
  const sy = y + 74 + statsRow
  const turns = v.turns.slice(-16)
  const maxD = Math.max(1, ...turns.map(turn => turn.durationMs))
  const recentAt = titleSide(W, t)
  parts.push(`<text x='${recentAt.x}' y='${sy}' text-anchor='${recentAt.anchor}' fill='${DIM}' font-size='11' ${FONT}>${esc(t.recentTurns)}</text>`)
  turns.forEach((turn, i) => {
    const bw = Math.max(5, sw / 16 - 4)
    const bx = sx + i * (sw / 16)
    const bhgt = Math.max(4, (turn.durationMs / maxD) * 30)
    parts.push(`<rect x='${bx.toFixed(1)}' y='${(y + fh - 10 - bhgt).toFixed(1)}' width='${bw.toFixed(1)}' height='${bhgt.toFixed(1)}' rx='2' fill='${BRAND}' opacity='${0.4 + 0.6 * ((i + 1) / turns.length)}'/>`)
  })
  if (turns.length === 0) parts.push(`<text x='${sx}' y='${y + fh - 16}' fill='${DIM}' font-size='11' ${FONT}>${esc(t.noTurns)}</text>`)
  y += fh + 10

  // ----- tool mix -----
  const mh = 150
  parts.push(card(W, y, mh, t.toolMix, t))
  const total = KINDS.reduce((s, k) => s + v.counts[k], 0)
  const cx = PAD + 78
  const cy = y + 88
  const r = 44
  if (total === 0) {
    parts.push(`<circle cx='${cx}' cy='${cy}' r='${r}' fill='none' stroke='${LINE}' stroke-width='14'/>`)
  } else {
    let a = -Math.PI / 2
    for (const k of KINDS) {
      const n = v.counts[k]
      if (!n) continue
      const a1 = a + (n / total) * Math.PI * 2
      const gap = total > 1 ? 0.05 : 0
      parts.push(`<path d='${arcPath(cx, cy, r, a + gap / 2, Math.max(a + gap / 2 + 0.01, a1 - gap / 2))}' fill='none' stroke='${KIND_COLOR[k]}' stroke-width='14'/>`)
      a = a1
    }
  }
  parts.push(
    `<text x='${cx}' y='${cy + 7}' text-anchor='middle' fill='${TEXT}' font-size='24' font-weight='700' ${FONT}>${total}</text>`,
    `<text x='${cx}' y='${cy + 23}' text-anchor='middle' fill='${DIM}' font-size='11' ${FONT}>${esc(clip(t.calls, 12))}</text>`,
  )
  const legendRoom = Math.max(4, Math.floor((W - PAD - 14 - (cx + 88) - 20) / 7.5))
  const top = KINDS.filter(k => v.counts[k] > 0).sort((p, q) => v.counts[q] - v.counts[p]).slice(0, 5)
  top.forEach((k, i) => {
    const ly = y + 52 + i * 21
    parts.push(
      `<rect x='${cx + 70}' y='${ly - 10}' width='11' height='11' rx='3' fill='${KIND_COLOR[k]}'/>`,
      `<text x='${cx + 88}' y='${ly}' fill='${TEXT}' font-size='13' ${FONT}>${esc(clip(t.kind[k], legendRoom))} <tspan fill='${DIM}'>${v.counts[k]}</tspan></text>`,
    )
  })
  y += mh + 10

  // ----- files -----
  const files = Object.entries(v.files).sort((p, q) => q[1] - p[1]).slice(0, 5)
  const fhh = 44 + Math.max(1, files.length) * 26 + 6
  parts.push(card(W, y, fhh, t.topFiles, t))
  const maxF = files[0]?.[1] ?? 1
  if (files.length === 0) {
    parts.push(`<text x='${W / 2}' y='${y + 60}' text-anchor='middle' fill='${DIM}' font-size='13' ${FONT}>${esc(t.noFiles)}</text>`)
  }
  const barX = PAD + Math.min(150, Math.round(W * 0.42))
  const barW = W - PAD - 14 - 30 - barX
  const nameRoom = Math.floor((barX - PAD - 14 - 8) / CHAR_PX)
  files.forEach(([path, n], i) => {
    const ly = y + 54 + i * 26
    const bw = Math.max(5, (n / maxF) * barW)
    parts.push(
      `<text x='${PAD + 14}' y='${ly + 5}' fill='${TEXT}' font-size='13' ${FONT}>${esc(clip(baseName(path), nameRoom))}</text>`,
      `<rect x='${barX}' y='${ly - 6}' width='${barW}' height='12' rx='6' fill='${BG}'/>`,
      `<rect x='${barX}' y='${ly - 6}' width='${bw.toFixed(1)}' height='12' rx='6' fill='#F59E0B' opacity='0.9'/>`,
      `<text x='${W - PAD - 14}' y='${ly + 5}' text-anchor='end' fill='${DIM}' font-size='12' ${FONT}>${n}</text>`,
    )
  })
  y += fhh + 10

  // ----- agents -----
  // Title row on top, chips on their own row beneath it, laid from the reading
  // side; the three chips share the row's width so none leaves the card.
  const liveAgents = v.agents.filter(a => a.end === undefined)
  const ah = v.agents.length === 0 ? 50 : 70
  parts.push(card(W, y, ah, t.subagents, t, v.agents.length === 0 ? 1 : 0.55))
  if (v.agents.length === 0) {
    const emptyAt = titleSide(W, t)
    parts.push(`<text x='${emptyAt.x}' y='${y + 40}' text-anchor='${emptyAt.anchor}' fill='${DIM}' font-size='12' ${FONT}>${esc(t.noAgents)}</text>`)
  } else {
    const countAt = otherSide(W, t)
    parts.push(`<text x='${countAt.x}' y='${y + 24}' text-anchor='${countAt.anchor}' fill='${DIM}' font-size='11' ${FONT}>${esc(t.agentCount(liveAgents.length, v.agents.length))}</text>`)
    const shown = v.agents.slice(-3)
    const gap = 6
    const rowW = W - PAD * 2 - 28
    const chipMax = (rowW - gap * (shown.length - 1)) / shown.length
    const rtl = t.dir === 'rtl'
    let edgeX = rtl ? W - PAD - 14 : PAD + 14
    for (const a of shown) {
      const on = a.end === undefined
      const label = clip(a.description, Math.max(3, Math.floor((chipMax - 20) / CHAR_PX)))
      const wChip = Math.min(chipMax, units(label) * CHAR_PX + 24)
      const x = rtl ? edgeX - wChip : edgeX
      parts.push(
        `<rect x='${x.toFixed(1)}' y='${y + 36}' width='${wChip.toFixed(1)}' height='22' rx='11' fill='${on ? '#EC4899' : LINE}'>${on ? `<animate attributeName='opacity' values='1;0.55;1' dur='1.4s' repeatCount='indefinite'/>` : ''}</rect>`,
        `<text x='${(x + wChip / 2).toFixed(1)}' y='${y + 51}' text-anchor='middle' fill='${on ? '#fff' : DIM}' font-size='11' font-weight='600' ${FONT}>${esc(label)}</text>`,
      )
      edgeX = rtl ? x - gap : x + wChip + gap
    }
  }
  y += ah + 14

  const H = y
  return (
    `<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 ${W} ${H}' width='${W}' height='${H}' role='img'>` +
    `<rect width='${W}' height='${H}' rx='18' fill='${BG}'/>` +
    parts.join('') +
    `</svg>`
  )
}

// ---------- the module ----------

type UsageFigures = {
  context: { percent?: number; tokens?: number; window: number }
  cost?: { usd: number }
}

const withUsage = (s: Live, u: UsageFigures): Live => ({
  ...s,
  context: { percent: u.context.percent, tokens: u.context.tokens, window: u.context.window },
  costUsd: u.cost?.usd ?? s.costUsd,
  usageStale: false,
})

// Reads context and cost; on failure the pane keeps the last figures but marks
// them old, and the reason goes to the debug log.
const refreshUsage = async ($: StateAndLog & Pick<EngineInterface, 'session'>): Promise<void> => {
  try {
    const u = await $.session.usage()
    await changeLive($, s => withUsage(s, u))
  } catch (err) {
    $.ui.log(`pulse-pane: could not read session usage: ${String(err)}`, { to: 'debug' })
    await changeLive($, s => ({ ...s, usageStale: true }))
  }
}

// `/pulse <code>` writes the plugin's `language` setting, the one source of the
// pane's language; the engine reloads the module with it, so the next drawing is
// already in the new language. Answers in the language it switched to.
const setLanguage = async ($: Pick<EngineInterface, 'config' | 'ui'>, code: string, t: Strings): Promise<string> => {
  if (!isLang(code)) return t.languageUnknown(code, LANGS.join(', '))
  const row = (await $.config.list()).find(r => LANGUAGE_KEY.test(r.key))
  if (!row) {
    $.ui.log('pulse-pane: no /config row for the language setting', { to: 'debug' })
    return t.languageNotSettable
  }
  const set = await $.config.set({ key: row.key, value: code })
  if ('deny' in set) {
    $.ui.log(`pulse-pane: language change refused: ${set.deny}`, { to: 'debug' })
    return t.languageNotSettable
  }
  return STRINGS[code].languageSet
}

export const register: Register = (on, options) => {
  const t = stringsFor(options.language)

  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'pulse', description: t.commandDescription })
    const hidden = (await $.store.get('hiddenByUser')) === true
    if (!hidden) void $.ui.open({ id: PANE, title: TITLE, columns: PANE_COLUMNS })
    void refreshUsage($)

    // One tick a second moves the timer and the running bars while a turn runs;
    // every fifth tick refreshes the context and cost figures.
    let ticks = 0
    $.clock.every(1000, () => {
      ticks += 1
      void readLive($).then(v => {
        if (!isActive(v.phase) && v.running === 0) return
        void changeLive($, s => ({ ...s, now: Date.now() }))
        if (ticks % 5 === 0) void refreshUsage($)
      })
    })

    return next(e)
  })

  on('ui.close', { id: PANE }, async ($, e, next) => {
    if (e.origin.kind === 'person') await $.store.set('hiddenByUser', true).catch(report($))

    return next(e)
  }).catch(($, e, next) => (report($)(next.error), next(e)))

  on('command.run', { command: 'pulse' }, async ($, e) => {
    const code = e.args.trim().toLowerCase()
    if (code) return { text: await setLanguage($, code, t) }

    await $.store.set('hiddenByUser', false)
    await $.ui.open({ id: PANE, title: TITLE, focus: true, columns: PANE_COLUMNS })

    return { text: t.opened }
  })

  on('turn.start', async ($, e, next) => {
    if (!e.agentId) {
      await changeLive($, s => ({
        ...s,
        phase: 'thinking' as Phase,
        turnId: e.turnId,
        turnStart: Date.now(),
        turnEnd: undefined,
        steps: 0,
        thinkingChars: 0,
        textChars: 0,
        running: 0,
        now: Date.now(),
      }))
    }

    return next(e)
  })

  on('turn.step', async function* ($, e, next) {
    if (e.agentId) return yield* next(e)

    await changeLive($, s => ({ ...s, steps: s.steps + 1, model: e.model, now: Date.now() }))
    const stream = next(e)
    let thinking = 0
    let text = 0
    let phase: Phase | undefined
    let lastFlush = Date.now()
    const flush = async (force: boolean) => {
      const at = Date.now()
      if (!force && at - lastFlush < 1000) return
      lastFlush = at
      const dt = thinking
      const dx = text
      const p = phase
      thinking = 0
      text = 0
      phase = undefined
      if (dt === 0 && dx === 0 && !p) return
      await changeLive($, s => ({
        ...s,
        thinkingChars: s.thinkingChars + dt,
        textChars: s.textChars + dx,
        phase: p && s.running === 0 ? p : s.phase,
        now: at,
      }))
    }
    for await (const chunk of stream) {
      if (chunk.kind === 'thinking') {
        thinking += chunk.text.length
        phase = 'thinking'
      } else if (chunk.kind === 'text') {
        text += chunk.text.length
        phase = 'writing'
      }
      await flush(false)
      yield chunk
    }
    await flush(true)
    const result = await stream.result
    const out = result.usage?.output_tokens ?? 0
    if (out) await changeLive($, s => ({ ...s, outputTokens: s.outputTokens + out }))

    return result
  })

  on('tool.call', async ($, e, next) => {
    const args = e as unknown as Record<string, unknown>
    const kind = kindOf(e.tool)
    const call: Call = {
      id: e.tool_use_id,
      tool: e.tool,
      kind,
      label: labelOf(e.tool, args),
      start: Date.now(),
      agentId: e.agentId,
    }
    const file = fileOf(e.tool, args)
    await changeLive($, s => ({
      ...s,
      phase: 'tool' as Phase,
      running: s.running + 1,
      calls: [...s.calls, call].slice(-60),
      counts: { ...s.counts, [kind]: s.counts[kind] + 1 },
      files: file ? touchFile(s.files, file) : s.files,
      now: Date.now(),
    })).catch(report($))

    const ran = await next(e)
    const isError = ran.deny !== undefined || ran.isError === true

    await changeLive($, s => {
      const running = Math.max(0, s.running - 1)
      return {
        ...s,
        running,
        phase: (running === 0 && isActive(s.phase) ? 'thinking' : s.phase) as Phase,
        calls: s.calls.map(c => (c.id === call.id ? { ...c, end: Date.now(), isError } : c)),
        now: Date.now(),
      }
    }).catch(report($))

    return ran
  }).catch(($, e, next) => (report($)(next.error), next(e)))

  on('agent.spawn', async ($, e, next) => {
    const spawned = await next(e)
    if ('agentId' in spawned && typeof spawned.agentId === 'string') {
      const row: AgentRow = {
        id: spawned.agentId,
        description: e.description,
        type: e.subagentType,
        start: Date.now(),
      }
      await changeLive($, s => ({ ...s, agents: [...s.agents, row].slice(-12) })).catch(report($))
    }

    return spawned
  }).catch(($, e, next) => (report($)(next.error), next(e)))

  on('turn.complete', async ($, e, next) => {
    const at = Date.now()
    if (e.agentId) {
      const id = e.agentId
      await changeLive($, s => ({
        ...s,
        agents: s.agents.map(a => (a.id === id ? { ...a, end: at } : a)),
      }))
    } else {
      await changeLive($, s => {
        const tools = s.calls.filter(c => c.start >= (s.turnStart ?? 0) && !c.agentId).length
        return {
          ...s,
          phase: phaseOfEnd(e.reason),
          running: 0,
          turnEnd: at,
          now: at,
          calls: s.calls.map(c => (c.end === undefined ? { ...c, end: at } : c)),
          turns: [...s.turns, { durationMs: e.durationMs, tools, out: e.usage?.output_tokens ?? 0 }].slice(-12),
        }
      })
      void refreshUsage($)
    }

    return next(e)
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const v = await readLive($)
    const ph = t.phase[v.phase]
    const color = PHASE_COLOR[v.phase]
    const pct = v.context.percent ?? 0

    if (e.surface === 'terminal') {
      const { Box, Text } = $.ui.resolve(e)
      const room = Math.max(1, (e.viewport?.rows ?? 24) - 6)
      return (
        <Box flexDirection="column">
          <Text color={color} weight="bold">
            ● {ph.label} · {fmtMs((v.turnEnd ?? v.now) - (v.turnStart ?? v.now))}
          </Text>
          <Text dimColor>{t.terminalLine(pct, v.calls.length, fmtK(v.outputTokens))}</Text>
          {v.calls.slice(-room).map(c => (
            <Text dimColor={c.end !== undefined} color={c.isError ? 'error' : undefined}>
              {c.end === undefined ? '▶' : '✓'} {c.tool} {c.label}
            </Text>
          ))}
        </Box>
      )
    }

    const { Box, Text, Svg } = $.ui.resolve(e)
    const cols = e.props.bodyColumns
    const width = Math.max(300, Math.min(640, Math.round(cols * CELL_PX)))
    const source = drawSvg(v, width, t)
    const height = Number(/viewBox='0 0 \d+ (\d+)'/.exec(source)?.[1] ?? 900)
    const elapsed = v.turnStart ? (isActive(v.phase) ? v.now : (v.turnEnd ?? v.now)) - v.turnStart : 0
    return (
      <Box flexDirection="column" gap="xs">
        <Box flexDirection="row" justifyContent="space-between" alignItems="center" paddingX="sm">
          <Text size="heading" weight="bold" tabular color={color}>
            {fmtMs(elapsed)}
          </Text>
          <Text size="footnote" dimColor dir={t.dir}>
            {t.headerLine(fmtK(v.thinkingChars), fmtK(v.textChars), pct)}
          </Text>
        </Box>
        <Svg source={source} alt={t.alt(ph.label, v.calls.length, pct)} width={width} height={height} />
      </Box>
    )
  })
}

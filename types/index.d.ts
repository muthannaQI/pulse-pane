// pulse-pane v1.0.0: the pane's state contract.

// `aborted` and `error` are end states like `done`: they tell an interrupted or
// failed turn apart from one the model finished.
export type Phase = 'idle' | 'thinking' | 'writing' | 'tool' | 'done' | 'aborted' | 'error'

export type ToolKind =
  | 'read'
  | 'edit'
  | 'run'
  | 'search'
  | 'web'
  | 'agent'
  | 'mcp'
  | 'other'

export type Call = {
  id: string
  tool: string
  kind: ToolKind
  label: string
  start: number
  end?: number
  isError?: boolean
  agentId?: string
}

export type AgentRow = {
  id: string
  description: string
  type: string
  start: number
  end?: number
}

export type TurnRow = {
  durationMs: number
  tools: number
  out: number
}

export type Live = {
  phase: Phase
  turnId?: string
  turnStart?: number
  turnEnd?: number
  steps: number
  thinkingChars: number
  textChars: number
  running: number
  calls: Call[]
  counts: Record<ToolKind, number>
  files: Record<string, number>
  agents: AgentRow[]
  context: { percent?: number; tokens?: number; window?: number }
  costUsd?: number
  // True while the last attempt to read context and cost failed, so the pane can
  // say its figures are old instead of showing them as current.
  usageStale?: boolean
  outputTokens: number
  turns: TurnRow[]
  model?: string
  now: number
}

declare module 'claude-code' {
  interface PluginState {
    'pulse-pane': { live: Shaped<Live> }
  }
}

export type Limit = {
  /** five_hour, seven_day, spend_limit, or another kind the engine reports. */
  kind: string
  percentUsed: number
  /** ISO time the limit resets, when known. */
  resetsAt?: string
}

export type Snapshot = {
  model: string
  contextTokens?: number
  contextWindow: number
  contextPercent?: number
  limits: Limit[]
  costUsd?: number
  startedAt: number
  /** The last reading, rounded down to the minute, so the card redraws once a minute. */
  at: number
}

/** The model and effort the last main-chat request went out with. */
export type Turn = { model?: string; effort?: string }

/** What the buttons are doing: nothing, compacting, or waiting on the handoff mod. */
export type Action = 'idle' | 'compacting' | 'handoff'

declare module 'claude-code' {
  interface PluginState {
    'session-hud': { snapshot: Snapshot | null; turn: Turn; action: Action }
  }
}

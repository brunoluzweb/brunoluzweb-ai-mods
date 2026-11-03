/** What kind of thing leaves the computer. */
export type OutboxKind = 'email' | 'calendar' | 'notion' | 'drive' | 'message' | 'git' | 'github' | 'publish'

/** One call held in the band, counting down. */
export type OutboxHeld = {
  /** The tool call's id; the band's buttons are keyed by it. */
  id: string
  kind: OutboxKind
  label: string
  target: string
  title: string
  preview: string
  /** Whole seconds left before it goes. */
  left: number
}

export type OutboxStatus = 'held' | 'sent' | 'cancelled' | 'failed' | 'blocked'

/** One row of the pane: something that left this chat, or was stopped. */
export type OutboxEntry = {
  id: string
  /** Milliseconds since the epoch, when it was raised. */
  at: number
  kind: OutboxKind
  label: string
  target: string
  title: string
  status: OutboxStatus
  /** The first web address the tool answered with (a PR, a page); may be empty. */
  link: string
  /** Why it was blocked or failed, or what the person typed instead of Send. */
  note: string
}

declare module 'claude-code' {
  interface PluginState {
    outbox: {
      held: Shaped<OutboxHeld[]>
      log: Shaped<OutboxEntry[]>
      /** The id whose preview the band shows open; '' for none. */
      viewing: string
      /** True while /mods has turned the outbox off. */
      off: boolean
    }
  }
}

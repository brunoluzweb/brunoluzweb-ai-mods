import type { OutboxKind } from '../types'

// Which tool calls leave this computer, and how to say what each one does.
// Pure: no `$`, so the tests can feed it any tool name and arguments.

export type Outward = {
  kind: OutboxKind
  /** What it is, short: "Email", "Novo evento", "Git push". */
  label: string
  /** Who or where it goes: an address, a channel, a remote. May be empty. */
  target: string
  /** A subject, an event or page title, a PR title. May be empty. */
  title: string
  /** The text that goes out, for the Ver button. May be empty. */
  preview: string
}

type Args = Record<string, unknown>

// MCP servers that live inside the app or this Mac: nothing they do reaches another person.
const INSIDE = /^(ccd_|Claude_|claude-artifacts|claude-in-chrome|plugin-authoring|helper-desk|handoff|terminal|scheduled-tasks|visualize|mcp-registry|outbox|computer-use|remote-devices)/

const PREVIEW_MAX = 600

/** A value as one line of text: strings as they are, lists joined, people by their email or name. */
export function text(v: unknown, depth = 0): string {
  if (depth > 4 || v === null || v === undefined) return ''
  if (typeof v === 'string') return v.trim()
  if (typeof v === 'number' || typeof v === 'boolean') return String(v)
  if (Array.isArray(v)) return v.map(x => text(x, depth + 1)).filter(Boolean).join(', ')
  if (typeof v === 'object') {
    const o = v as Args
    for (const k of ['email', 'address', 'dateTime', 'date', 'name', 'title', 'text', 'plain_text', 'content']) {
      const s = text(o[k], depth + 1)
      if (s) return s
    }
  }
  return ''
}

function pick(args: Args, keys: readonly string[]) {
  for (const k of keys) {
    const s = text(args[k])
    if (s) return s
  }
  return ''
}

/** The first string under any of `keys`, searched through nested objects and lists. */
function deep(v: unknown, keys: readonly string[], depth = 0): string {
  if (depth > 6 || !v || typeof v !== 'object') return ''
  if (Array.isArray(v)) {
    for (const x of v) {
      const s = deep(x, keys, depth + 1)
      if (s) return s
    }
    return ''
  }
  const o = v as Args
  for (const k of keys) {
    const s = typeof o[k] === 'string' ? (o[k] as string).trim() : ''
    if (s) return s
  }
  for (const x of Object.values(o)) {
    const s = deep(x, keys, depth + 1)
    if (s) return s
  }
  return ''
}

export function cut(s: string, n: number) {
  const one = s.replace(/\s+/g, ' ').trim()
  if (n <= 0) return ''
  return one.length <= n ? one : `${one.slice(0, Math.max(0, n - 1))}…`
}

const preview = (s: string) => (s.length <= PREVIEW_MAX ? s : `${s.slice(0, PREVIEW_MAX - 1)}…`)

function human(short: string) {
  const words = short.replace(/^notion-/, '').replace(/[-_]+/g, ' ').trim()
  return words.charAt(0).toUpperCase() + words.slice(1)
}

/** `mcp__<server>__<tool>` as its two parts; anything else is not an MCP tool. */
export function mcpName(tool: string): { server: string; short: string } | null {
  if (!tool.startsWith('mcp__')) return null
  const parts = tool.split('__')
  if (parts.length < 3) return null
  return { server: parts[1] ?? '', short: parts.slice(2).join('__') }
}

const EMAIL = /^(send_message|send_email|send_mail|send_draft|reply|reply_all|reply_to_message|forward|forward_message)$/
const CALENDAR = /^(create_event|update_event|delete_event|cancel_event|respond_to_event|notion-calendar-(create|update|cancel)-events)$/
const NOTION = /^notion-(create-pages|update-page|delete-pages|delete-databases|create-comment|move-pages)$/
const DRIVE = /^(share_file|trash_file|delete_file)$/
const MESSAGE = /(^|[_-])(send|post|publish|reply|forward|share|invite)([_-]|$)/
// A tool that only looks is never outward, even when its name holds a verb above ("get_post").
const READS = /^(get|list|search|read|fetch|find|query|download|view|describe|lookup)([_-]|$)/

function fromMcp(server: string, short: string, args: Args): Outward | null {
  if (INSIDE.test(server) || READS.test(short)) return null

  if (CALENDAR.test(short)) {
    const label = /respond/.test(short)
      ? 'Resposta a convite'
      : /delete|cancel/.test(short)
        ? 'Apagar evento'
        : /update/.test(short)
          ? 'Mudar evento'
          : 'Novo evento'
    const events = Array.isArray(args.events) ? (args.events as Args[]) : [args]
    const first = events[0] ?? {}
    return {
      kind: 'calendar',
      label,
      target: pick(first, ['attendees', 'attendee_emails', 'guests', 'invitees', 'organizer']),
      title: pick(first, ['summary', 'title', 'name', 'response', 'event_id']),
      preview: preview(pick(first, ['description', 'start', 'start_time', 'startTime'])),
    }
  }

  if (NOTION.test(short)) {
    const label = /delete/.test(short)
      ? 'Apagar no Notion'
      : /comment/.test(short)
        ? 'Comentário no Notion'
        : /move/.test(short)
          ? 'Mover no Notion'
          : /update/.test(short)
            ? 'Editar no Notion'
            : 'Nova página no Notion'
    return {
      kind: 'notion',
      label,
      target: pick(args, ['parent', 'page_id', 'database_id']) || deep(args, ['page_id', 'database_id', 'data_source_id']),
      title: deep(args, ['title', 'name']),
      preview: preview(deep(args, ['content', 'text', 'body', 'markdown'])),
    }
  }

  if (DRIVE.test(short)) {
    return {
      kind: 'drive',
      label: short === 'share_file' ? 'Partilhar no Drive' : 'Apagar no Drive',
      target: pick(args, ['email', 'emails', 'email_address', 'emailAddress', 'role', 'type']),
      title: pick(args, ['file_name', 'name', 'title', 'file_id', 'fileId', 'id']),
      preview: '',
    }
  }

  const isChannel = ['channel', 'channel_id', 'channelId', 'conversation', 'conversation_id'].some(k => k in args)

  if (EMAIL.test(short) && !isChannel) {
    const label = /forward/.test(short) ? 'Reencaminhar email' : /reply/.test(short) ? 'Resposta a email' : 'Email'
    return {
      kind: 'email',
      label,
      target: pick(args, ['to', 'recipients', 'recipient', 'to_recipients', 'toRecipients', 'cc']) || (/reply/.test(short) ? 'a conversa' : ''),
      title: pick(args, ['subject', 'title']),
      preview: preview(pick(args, ['body', 'text', 'content', 'message', 'html_body', 'htmlBody', 'plain_text'])),
    }
  }

  if (EMAIL.test(short) || MESSAGE.test(short)) {
    return {
      kind: 'message',
      label: human(short),
      target: pick(args, ['channel', 'channel_id', 'channelId', 'to', 'recipient', 'recipients', 'user', 'user_id', 'conversation', 'email']),
      title: pick(args, ['title', 'subject', 'name']),
      preview: preview(pick(args, ['text', 'message', 'body', 'content', 'markdown_text'])),
    }
  }

  return null
}

// Bash. Each command of a chain is checked; the first outward one names the call.
const GIT_PUSH = /(?:^|[\s;&|(])git\s+(?:-C\s+\S+\s+)?push\b([^;&|]*)/
const GH = /(?:^|[\s;&|(])gh\s+(pr|issue|release|repo|gist)\s+(create|merge|comment|review|close|edit|ready|delete|reopen)\b([^;&|]*)/
const PUBLISH = /(?:^|[\s;&|(])(npm|pnpm|yarn|bun)\s+publish\b/

function flag(rest: string, names: readonly string[]) {
  for (const n of names) {
    const m = rest.match(new RegExp(`(?:^|\\s)${n}(?:\\s+|=)(?:"([^"]*)"|'([^']*)'|(\\S+))`))
    const v = m?.[1] ?? m?.[2] ?? m?.[3]
    if (v) return v
  }
  return ''
}

function fromBash(command: string): Outward | null {
  const push = command.match(GIT_PUSH)
  if (push) {
    const rest = push[1] ?? ''
    if (/--dry-run|(^|\s)-n(\s|$)/.test(rest)) return null
    const target = rest
      .split(/\s+/)
      .filter(w => w && !w.startsWith('-'))
      .join(' ')
    return { kind: 'git', label: /--force|(^|\s)-f(\s|$)/.test(rest) ? 'Git push forçado' : 'Git push', target: target || 'o branch atual', title: '', preview: preview(command) }
  }
  const gh = command.match(GH)
  if (gh) {
    const [, noun = '', verb = '', rest = ''] = gh
    const number = rest
      .trim()
      .split(/\s+/)
      .find(w => /^#?\d+$/.test(w))
    return {
      kind: 'github',
      label: `GitHub ${noun} ${verb}`,
      target: flag(rest, ['--repo', '-R']) || (number ? `#${number.replace('#', '')}` : ''),
      title: flag(rest, ['--title', '-t']) || flag(rest, ['--body', '-b']),
      preview: preview(command),
    }
  }
  const pub = command.match(PUBLISH)
  if (pub) return { kind: 'publish', label: `${pub[1]} publish`, target: 'o registo de pacotes', title: '', preview: preview(command) }
  return null
}

/** What this tool call sends out of this computer, or null when it sends nothing. */
export function classify(tool: string, args: Args): Outward | null {
  if (tool === 'Bash') return typeof args.command === 'string' ? fromBash(args.command) : null
  const mcp = mcpName(tool)
  return mcp ? fromMcp(mcp.server, mcp.short, args) : null
}

/** The first web address in a tool's answer: the new PR, the page, the event. */
export function linkIn(v: unknown): string {
  let s = ''
  try {
    s = typeof v === 'string' ? v : JSON.stringify(v) ?? ''
  } catch {
    s = ''
  }
  const m = s.match(/https:\/\/[^\s"'<>\\)\]]+/)
  return m ? m[0].replace(/[.,;:]+$/, '') : ''
}

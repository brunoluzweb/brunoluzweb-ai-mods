// Session HUD: a card above the prompt with the context used, the usage limits and
// when they reset, the API cost and how long the chat has run. Compactar runs
// /compact; Chat novo asks the handoff mod for a handoff.
import type { EngineInterface, Register, RenderChildren } from 'claude-code'

import type { Action, Limit, Snapshot, Turn } from '../types'

const SNAPSHOT = { plugin: 'session-hud', key: 'snapshot' } as const
const TURN = { plugin: 'session-hud', key: 'turn' } as const
const ACTION = { plugin: 'session-hud', key: 'action' } as const

const REFRESH_MS = 5_000
const SWITCH_MS = 3_000
// From here the context is getting full: Compactar turns primary.
const FULL = 70

const GOOD = '#16a34a'
const WARN = '#ca8a04'
const BAD = '#dc2626'
const level = (percent: number) => (percent >= 90 ? BAD : percent >= FULL ? WARN : GOOD)
const BAR = 10

// The labels of the desktop app's effort picker, in Portuguese.
const EFFORT: Record<string, string> = { low: 'baixo', medium: 'médio', high: 'alto', xhigh: 'extra', max: 'máximo' }
const LIMITS: Record<string, string> = { five_hour: 'Limite de 5 horas', seven_day: 'Limite semanal', spend_limit: 'Limite de gasto' }
const DAYS = ['dom.', 'seg.', 'ter.', 'qua.', 'qui.', 'sex.', 'sáb.']
const MONTHS = ['jan.', 'fev.', 'mar.', 'abr.', 'mai.', 'jun.', 'jul.', 'ago.', 'set.', 'out.', 'nov.', 'dez.']

// The /mods switchboard turns this mod off in every chat with switches.json.
// "session-hud:hidden": true in the same file hides the card in every chat.
const NAME = 'session-hud'
const HIDE_KEY = `${NAME}:hidden`

// Module variables reset on a reload; the card itself lives in $.state.
let sid = ''
let off = false
let hidden = false
// True while the main chat has a turn running: the buttons wait for it.
let working = false

// claude-opus-5-5[1m] -> Opus 5.5 1M; claude-haiku-4-5-20251001 -> Haiku 4.5
const modelName = (id: string) => {
  const long = /\[1m\]/i.test(id)
  const parts = id
    .replace(/\[.*?\]/g, '')
    .replace(/^claude-/, '')
    .split('-')
    .filter(part => !/^\d{8}$/.test(part))
  const family = parts
    .filter(part => !/^\d+$/.test(part))
    .map(word => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ')
  const version = parts.filter(part => /^\d+$/.test(part)).join('.')
  return [family || id, version, long ? '1M' : ''].filter(Boolean).join(' ')
}

const short = (n: number) =>
  n >= 1_000_000 ? `${+(n / 1_000_000).toFixed(n % 1_000_000 === 0 ? 0 : 1)}M`.replace('.', ',') : n >= 1_000 ? `${Math.round(n / 1_000)}k` : `${n}`

const span = (ms: number) => {
  const m = Math.max(0, Math.round(ms / 60_000))
  return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${m % 60} min`
}

const hhmm = (d: Date) => `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`

// Within a day: "repõe dentro de 3 h 20 min"; within a week: "repõe seg. 05:00"; later: "repõe a 12 out.".
const resetText = (iso: string, now: number) => {
  const d = new Date(iso)
  const ms = d.getTime() - now
  if (Number.isNaN(ms)) return undefined
  if (ms < 24 * 3_600_000) return `repõe dentro de ${span(ms)}`
  if (ms < 6 * 24 * 3_600_000) return `repõe ${DAYS[d.getDay()]} ${hhmm(d)}`
  return `repõe a ${d.getDate()} ${MONTHS[d.getMonth()]}`
}

const dollars = (usd: number) => `${usd.toFixed(2).replace('.', ',')} US$`

async function getSnapshot($: EngineInterface): Promise<Snapshot | null> {
  const { value } = await $.state.get(SNAPSHOT)
  return value ?? null
}

async function getTurn($: EngineInterface): Promise<Turn> {
  const { value } = await $.state.get(TURN)
  return value ?? {}
}

async function getAction($: EngineInterface): Promise<Action> {
  const { value } = await $.state.get(ACTION)
  return value ?? 'idle'
}

async function setAction($: EngineInterface, a: Action) {
  await $.state.set(ACTION, a)
}

function toast($: EngineInterface, text: string) {
  try {
    $.ui.toast(text)
  } catch {
    // The toast is only a hint.
  }
}

function invalidate($: EngineInterface) {
  try {
    $.ui.invalidate('ui.render')
  } catch {
    // The next refresh redraws anyway.
  }
}

// Reads usage, and writes the card only when something it shows has changed.
async function refresh($: EngineInterface) {
  if (off) return
  const [usage, model, now] = await Promise.all([$.session.usage(), $.session.model(), $.clock.now()])
  const next: Snapshot = {
    model,
    contextTokens: usage.context.tokens,
    contextWindow: usage.context.window,
    contextPercent: usage.context.percent,
    limits: usage.rateLimits.map(({ kind, percentUsed, resetsAt }) => ({ kind, percentUsed, resetsAt })),
    costUsd: usage.cost?.usd,
    startedAt: usage.startedAt,
    at: Math.floor(now / 60_000) * 60_000,
  }
  if (JSON.stringify(await getSnapshot($)) !== JSON.stringify(next)) await $.state.set(SNAPSHOT, next)
}

// The person's home folder, read from $HOME when the session starts. The mod's own
// folder is only the fallback: it holds /.claude/ only when installed under ~/.claude.
let userHomeDir = ''
const userHome = ($: EngineInterface) => userHomeDir || ($.plugin.root.split('/.claude/')[0] ?? '')
async function loadUserHome($: EngineInterface) {
  try {
    userHomeDir = (await $.env.get('HOME')) ?? ''
  } catch {
    userHomeDir = ''
  }
}

const switchesPath = ($: EngineInterface) => `${userHome($)}/.claude/mods/switches.json`

async function readSwitches($: EngineInterface): Promise<Record<string, unknown>> {
  const path = switchesPath($)
  if (!(await $.fs.exists(path))) return {}
  const json = JSON.parse(String(await $.fs.read(path))) as unknown
  return json && typeof json === 'object' && !Array.isArray(json) ? (json as Record<string, unknown>) : {}
}

async function readSwitch($: EngineInterface) {
  let nowOff = off
  let nowHidden = hidden
  try {
    const json = await readSwitches($)
    nowOff = json[NAME] === false
    nowHidden = json[HIDE_KEY] === true
  } catch {
    // A broken or missing file changes nothing.
  }
  if (nowOff === off && nowHidden === hidden) return
  const wasOff = off
  off = nowOff
  hidden = nowHidden
  if (wasOff && !off) await refresh($).catch(() => undefined)
  invalidate($)
}

// Read, change, write the whole file, so every chat sees the choice within 3 s.
async function setHidden($: EngineInterface, value: boolean) {
  try {
    const json = await readSwitches($)
    if (value) json[HIDE_KEY] = true
    else delete json[HIDE_KEY]
    await $.process.run(['mkdir', '-p', `${userHome($)}/.claude/mods`])
    await $.fs.write(switchesPath($), `${JSON.stringify(json, null, 2)}\n`)
  } catch (err) {
    await log($, `save hidden failed: ${String(err)}`)
  }
  hidden = value
  invalidate($)
}

async function log($: EngineInterface, line: string) {
  try {
    const path = `${userHome($)}/.claude/mods-logs/session-hud.log`
    const old = (await $.fs.exists(path)) ? String(await $.fs.read(path)) : ''
    const lines = old ? old.trimEnd().split('\n').slice(-200) : []
    lines.push(`${new Date(await $.clock.now()).toISOString()} ${sid.slice(0, 8)} ${line}`)
    await $.fs.write(path, `${lines.join('\n')}\n`)
  } catch {
    // The log must never break the card.
  }
}

async function compact($: EngineInterface) {
  await setAction($, 'compacting')
  try {
    await $.command.run({ command: 'compact' })
  } catch (err) {
    toast($, `Não foi possível compactar: ${err instanceof Error ? err.message : String(err)}`)
  } finally {
    await setAction($, 'idle')
    void refresh($).catch(() => undefined)
  }
}

// The handoff mod picks this file up within 5 seconds and shows its Refresh panel.
async function handoff($: EngineInterface) {
  const home = userHome($)
  let handoffOff = false
  try {
    handoffOff = (await readSwitches($)).handoff === false
  } catch {
    // Treat a broken file as on.
  }
  if (handoffOff) {
    toast($, 'O mod Handoff está desligado. Liga-o no /mods para passar para um chat novo.')
    return
  }
  await $.process.run(['mkdir', '-p', `${home}/.claude/handoffs`])
  await $.fs.write(`${home}/.claude/handoffs/.request-${sid}`, String(await $.clock.now()))
  await log($, 'asked for a handoff')
  await setAction($, 'handoff')
  toast($, 'Handoff pedido. Fica atento ao painel Refresh.')
  // The Refresh panel takes over from here: the button goes back after a few seconds.
  $.clock.after(8_000, () => void setAction($, 'idle').catch(() => undefined))
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const started = await next(e)
    await loadUserHome($)
    sid = await $.session.id()
    await $.command.register({
      name: 'hud',
      description: 'Session HUD: mostra ou esconde o cartão da sessão acima do prompt, em todos os chats',
      argumentHint: '[show|hide]',
      immediate: true,
    })
    await setAction($, 'idle')
    await readSwitch($).catch(() => undefined)
    $.clock.every(SWITCH_MS, () => void readSwitch($).catch(() => undefined))
    // A first reading that fails still leaves the timer running: the card fills in on its next tick.
    await refresh($).catch(() => undefined)
    $.clock.every(REFRESH_MS, () => void refresh($).catch(() => undefined))
    return started
  })

  on('command.run', { command: 'hud' }, async ($, e) => {
    if (off) return { text: 'O Session HUD está desligado. Liga-o com /mods.' }
    const arg = e.args.trim().toLowerCase()
    const hide = arg === 'hide' || arg === 'off' ? true : arg === 'show' || arg === 'on' ? false : !hidden
    await setHidden($, hide)
    if (!hide) await refresh($).catch(() => undefined)
    return {
      text: hide
        ? 'Session HUD oculto em todos os chats. Escreve /hud ou abre o /mods para o mostrar.'
        : 'Session HUD visível. Escreve /hud hide ou abre o /mods para o esconder.',
    }
  })

  // The model and effort each request in the main chat goes out with.
  on('turn.step', async function* ($, e, next) {
    if (!off && e.agentId === undefined) {
      const seen: Turn = { model: e.model, effort: e.effort === undefined ? undefined : String(e.effort) }
      const current = await getTurn($)
      if (current.model !== seen.model || current.effort !== seen.effort) await $.state.set(TURN, seen)
    }
    return yield* next(e)
  })

  on('turn.start', async ($, e, next) => {
    if (e.agentId === undefined) working = true
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const done = await next(e)
    if (e.agentId === undefined) working = false
    void refresh($).catch(() => undefined)
    return done
  })

  on('ui.press', { plugin: 'session-hud', element: 'compact' }, async ($, e) => {
    if (off) return { element: e.element }
    if (working || (await getAction($)) !== 'idle') {
      toast($, 'Espera que o Claude termine e depois compacta.')
      return { element: e.element }
    }
    void compact($)
    return { element: e.element }
  })

  on('ui.press', { plugin: 'session-hud', element: 'handoff' }, async ($, e) => {
    if (off) return { element: e.element }
    if (working || (await getAction($)) !== 'idle') {
      toast($, 'Espera que o Claude termine e depois passa para um chat novo.')
      return { element: e.element }
    }
    await handoff($).catch(err => log($, `handoff request failed: ${String(err)}`))
    return { element: e.element }
  })

  on('ui.press', { plugin: 'session-hud', element: 'hide' }, async ($, e) => {
    await setHidden($, true)
    toast($, 'Session HUD oculto. Escreve /hud ou abre o /mods para o mostrar.')
    return { element: e.element }
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (off || hidden || e.props.hasSurvey) return next(e)
    const data = await getSnapshot($)
    if (!data) return next(e)
    // What other mods draw here stays, above the card.
    const rest = await next(e)
    const { model, effort } = await getTurn($)
    const action = await getAction($)
    const { Box, Text, Button } = $.ui.resolve(e)
    const noop = () => undefined

    const meter = (percent: number) => {
      const clamped = Math.max(0, Math.min(100, percent))
      // Any use at all shows at least one block.
      const filled = clamped > 0 ? Math.max(1, Math.round(clamped / (100 / BAR))) : 0
      return (
        <Text>
          <Text color={level(clamped)}>{'━'.repeat(filled)}</Text>
          <Text dimColor>{'━'.repeat(BAR - filled)}</Text>
        </Text>
      )
    }

    // One column: a label, a reading and a line of detail. Columns share the width evenly.
    const tile = (key: string, label: string, reading: RenderChildren[], detail: string) => (
      <Box key={key} flexDirection="column" flexGrow={1} width={0} minWidth={16}>
        <Text dimColor wrap="truncate-end">
          {label}
        </Text>
        <Box flexDirection="row" alignItems="center" gap={1}>
          {reading.filter(Boolean)}
        </Box>
        <Text dimColor wrap="truncate-end">
          {detail}
        </Text>
      </Box>
    )

    const context =
      data.contextPercent === undefined
        ? tile('context', 'Contexto', [<Text bold>—</Text>], `janela de ${short(data.contextWindow)}`)
        : tile(
            'context',
            'Contexto',
            [meter(data.contextPercent), <Text bold>{`${data.contextPercent}%`}</Text>],
            `${short(data.contextTokens ?? 0)} de ${short(data.contextWindow)} tokens`,
          )

    const limits = data.limits.map((l: Limit) =>
      tile(
        `limit-${l.kind}`,
        LIMITS[l.kind] ?? l.kind,
        [meter(l.percentUsed), <Text bold>{`${Math.round(l.percentUsed)}%`}</Text>],
        (l.resetsAt === undefined ? undefined : resetText(l.resetsAt, data.at)) ?? ' ',
      ),
    )

    const session = tile(
      'session',
      'Sessão',
      [<Text bold>{span(data.at - data.startedAt)}</Text>],
      data.costUsd === undefined ? ' ' : `API ≈ ${dollars(data.costUsd)}`,
    )

    // The desktop app shows the model and effort under the prompt already; elsewhere the card does.
    const modelTile =
      e.surface === 'desktop'
        ? null
        : tile('model', 'Modelo', [<Text bold>{modelName(model ?? data.model)}</Text>], effort === undefined ? ' ' : `esforço ${EFFORT[effort] ?? effort}`)

    const busy = e.props.isWorking || action !== 'idle'
    const full = (data.contextPercent ?? 0) >= FULL

    const buttons = (
      <Box key="buttons" flexDirection="row" alignItems="center" gap={1}>
        <Button
          key="compact"
          label={action === 'compacting' ? 'A compactar…' : 'Compactar'}
          variant={full ? 'primary' : 'secondary'}
          dimColor={busy && action !== 'compacting'}
          onPress={noop}
        />
        <Button
          key="handoff"
          label={action === 'handoff' ? 'Handoff pedido' : 'Chat novo'}
          dimColor={busy && action !== 'handoff'}
          onPress={noop}
        />
        <Button key="hide" label="Esconder" role="dismiss" onPress={noop} />
      </Box>
    )

    return (
      <Box flexDirection="column">
        {rest}
        <Box flexDirection="row" alignItems="center" columnGap={3} paddingX={1}>
          {[modelTile, context, ...limits, session, buttons].filter(Boolean)}
        </Box>
      </Box>
    )
  })
}

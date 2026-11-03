import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { OutboxEntry, OutboxHeld, OutboxKind, OutboxStatus } from '../types'
import { classify, cut, linkIn } from './classify'
import type { Outward } from './classify'

// Outbox: an undo-send for Claude. Every tool call that leaves this computer
// (an email, a calendar invite, a Notion edit, a message, a git push, a GitHub
// PR) is held above the prompt for a few seconds, with Cancelar and Enviar já, or
// asked about first, by the `mode` option. Each one is listed in a side pane,
// Enviado deste chat, with what became of it and the link it made.
//
// A hook has 10 seconds of its own time, and the countdown's sleeps count, so
// the longest countdown is 8 seconds. Waiting on a question ($.ui.ask) is free.

const NAME = 'outbox'
const PANE = 'outbox'
const TITLE = 'Enviado deste chat'
const POLL_MS = 3000
const TICK_MS = 200
const LOG_MAX = 200
const BAND_MAX = 3

// UTU lima (brand.utu.wtf) as a chip with breu text, its on-accent colour, so it reads on
// light and dark grounds alike. Colours from utu-design-system/public/tokens/tokens.json.
const LIMA = '#E4FA00' // --utu-lima
const BREU = '#151413' // --utu-breu, also --utu-on-accent
const GOOD = '#16a34a'
const BAD = '#dc2626'
const WARN = '#d97706'

const held = atom({ plugin: 'outbox', key: 'held' } as const, [] as OutboxHeld[], { shape: 'held-1' })
const log = atom({ plugin: 'outbox', key: 'log' } as const, [] as OutboxEntry[], { shape: 'log-1' })
const viewing = atom({ plugin: 'outbox', key: 'viewing' } as const, '')
const offAtom = atom({ plugin: 'outbox', key: 'off' } as const, false)

type Mode = 'countdown' | 'ask' | 'log'

// Module variables start over on a reload; what the drawings read is in $.state.
// A press only leaves a choice here, and the waiting tool.call hook reads it.
const choices = new Map<string, 'cancel' | 'now'>()
let home = ''
let off = false
let seq = 0

const TO: Record<OutboxKind, string> = {
  email: 'para',
  calendar: 'com',
  notion: 'em',
  drive: 'com',
  message: 'para',
  git: 'para',
  github: 'em',
  publish: 'para',
}

/** "Email para ana@example.com · “Proposta”" */
export function describe(o: Pick<Outward, 'kind' | 'label' | 'target' | 'title'>, n = 140) {
  const target = o.target ? ` ${TO[o.kind]} ${cut(o.target, 60)}` : ''
  const title = o.title ? ` · “${cut(o.title, 60)}”` : ''
  return cut(`${o.label}${target}${title}`, n)
}

function clock(at: number) {
  const d = new Date(at)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

async function homeOf($: EngineInterface) {
  if (home) return home
  try {
    home = (await $.env.get('HOME')) ?? ''
  } catch {
    home = ''
  }
  if (!home) home = $.plugin.root.split('/.claude/')[0] ?? ''
  return home
}

async function logError($: EngineInterface, where: string, err: unknown) {
  try {
    const dir = `${await homeOf($)}/.claude/mods-logs`
    const file = `${dir}/outbox.log`
    await $.process.run(['mkdir', '-p', dir])
    let old = ''
    try {
      old = String(await $.fs.read(file))
    } catch {
      old = ''
    }
    const when = new Date(await $.clock.now()).toISOString()
    const msg = err instanceof Error ? `${err.name}: ${err.message}` : String(err)
    await $.fs.write(file, `${old}${when} ${where}: ${msg}\n`.slice(-50_000))
  } catch {
    // Logging must never stop a send or a cancel.
  }
}

// The /mods switchboard: "outbox": false in switches.json turns it off in every
// chat, and a ".open-outbox-<session id>" file asks this chat to open the pane.
async function readSwitch($: EngineInterface) {
  const root = await homeOf($)
  let now = off
  try {
    const path = `${root}/.claude/mods/switches.json`
    now = (await $.fs.exists(path)) ? (JSON.parse(String(await $.fs.read(path))) as Record<string, unknown>)[NAME] === false : false
  } catch {
    now = off
  }
  if (now !== off) {
    off = now
    await update($, offAtom, () => now)
  }
  const sid = await $.session.id()
  const req = `${root}/.claude/mods/.open-${NAME}-${sid}`
  if (await $.fs.exists(req)) {
    await $.process.run(['rm', '-f', req])
    if (!off) await $.ui.open({ id: PANE, title: TITLE })
  }
}

async function setEntry($: EngineInterface, id: string, change: Partial<OutboxEntry>) {
  await update($, log, list => list.map(x => (x.id === id ? { ...x, ...change } : x)))
}

async function dropHeld($: EngineInterface, id: string) {
  choices.delete(id)
  await update($, held, list => list.filter(x => x.id !== id))
  await update($, viewing, v => (v === id ? '' : v))
}

/** Counts down in the band; true to send, false when the person pressed Cancelar. */
async function countdown($: EngineInterface, id: string, out: Outward, seconds: number, signal: AbortSignal) {
  choices.delete(id)
  await update($, held, list => [...list.filter(x => x.id !== id), { id, ...out, left: seconds }])
  const end = (await $.clock.now()) + seconds * 1000
  let shown = seconds
  try {
    for (;;) {
      const choice = choices.get(id)
      if (choice) return choice === 'now'
      const left = end - (await $.clock.now())
      if (left <= 0) return true
      const secs = Math.ceil(left / 1000)
      if (secs !== shown) {
        shown = secs
        await update($, held, list => list.map(x => (x.id === id ? { ...x, left: secs } : x)))
      }
      await $.clock.sleep(Math.min(TICK_MS, left), { signal })
    }
  } catch {
    // The turn was interrupted: nothing goes out unasked.
    return choices.get(id) === 'now'
  } finally {
    await dropHeld($, id)
  }
}

/** Asks first; `note` holds what the person typed instead of Enviar or Cancelar. */
async function askFirst($: EngineInterface, out: Outward) {
  try {
    const pick = await $.ui.ask(`${describe(out, 200)}. Enviar agora?`, { options: ['Enviar', 'Cancelar'], header: 'Outbox' })
    if (pick === 'Enviar') return { go: true, note: '' }
    return { go: false, note: pick === 'Cancelar' ? '' : cut(pick, 300) }
  } catch {
    // Dismissed: not sent.
    return { go: false, note: '' }
  }
}

function refusal(out: Outward, note: string) {
  const what = describe(out, 200)
  const said = note ? ` They wrote: “${note}”.` : ''
  return `Outbox: the person chose not to send this (${what}), so nothing left this computer.${said} Do not try it again unless they ask.`
}

function modeOf(v: unknown): Mode {
  return v === 'ask' || v === 'log' ? v : 'countdown'
}

function secondsOf(v: unknown) {
  const n = Number(v)
  return Number.isFinite(n) ? Math.min(8, Math.max(1, Math.round(n))) : 5
}

function modeLine(mode: Mode, seconds: number) {
  if (mode === 'ask') return 'Pergunta antes de cada envio.'
  if (mode === 'log') return 'Não segura nada; só regista o que foi enviado.'
  return `Segura cada envio ${seconds} segundos acima do prompt.`
}

const GLYPH: Record<OutboxStatus, [string, string]> = {
  held: ['◷', LIMA],
  sent: ['✓', GOOD],
  cancelled: ['✕', ''],
  failed: ['!', BAD],
  blocked: ['⊘', WARN],
}

const WORD: Record<OutboxStatus, string> = {
  held: 'à espera',
  sent: 'enviado',
  cancelled: 'cancelado',
  failed: 'falhou',
  blocked: 'não correu',
}

export const register: Register = (on, options) => {
  const mode = modeOf(options.mode)
  const seconds = secondsOf(options.seconds)

  on('session.start', async ($, e, next) => {
    try {
      await $.command.register({
        name: 'outbox',
        description: 'Abre Enviado deste chat: cada email, convite, edição no Notion, mensagem, push e PR que este chat enviou ou travou',
        immediate: true,
      })
      await homeOf($)
      await readSwitch($).catch(err => logError($, 'switch', err))
      $.clock.every(POLL_MS, () => {
        void readSwitch($).catch(err => logError($, 'switch', err))
      })
    } catch (err) {
      await logError($, 'session.start', err)
    }
    return next(e)
  })

  on('command.run', { command: 'outbox' }, async $ => {
    if (off) return { text: 'O outbox está desligado. Liga-o com /mods.' }
    await $.ui.open({ id: PANE, title: TITLE })
    return { text: `Painel ${TITLE} aberto. ${modeLine(mode, seconds)}` }
  })

  on('tool.call', async ($, e, next) => {
    if (off) return next(e)
    const out = classify(String(e.tool), e as unknown as Record<string, unknown>)
    if (!out) return next(e)

    const id = e.tool_use_id || `call-${++seq}`
    const at = await $.clock.now()
    const entry: OutboxEntry = { id, at, kind: out.kind, label: out.label, target: out.target, title: out.title, status: 'held', link: '', note: '' }
    await update($, log, list => [...list.filter(x => x.id !== id), entry].slice(-LOG_MAX))

    // Nobody is watching (a -p run): nothing to press, so only list it.
    const watched = (await $.session.surfaces()).length > 0
    const how: Mode = watched ? mode : 'log'

    let go = true
    let note = ''
    if (how === 'countdown') {
      go = await countdown($, id, out, seconds, next.signal)
    } else if (how === 'ask') {
      ;({ go, note } = await askFirst($, out))
    }

    if (!go) {
      await setEntry($, id, { status: 'cancelled', note })
      void $.ui.toast(`Cancelado: ${describe(out, 80)}. Nada foi enviado.`)
      return { deny: refusal(out, note) }
    }

    const ran = await next(e)
    try {
      if (ran.deny !== undefined) {
        await setEntry($, id, { status: 'blocked', note: cut(ran.deny, 200) })
      } else if (ran.isError) {
        await setEntry($, id, { status: 'failed', note: cut(String(ran.text ?? ''), 200) })
      } else {
        await setEntry($, id, { status: 'sent', link: linkIn(ran.text ?? ran.result) })
      }
    } catch (err) {
      await logError($, 'after send', err)
    }
    return ran
  }).catch(($, e, next) => {
    // The hook failed. What it already let through stands; a press of Cancelar
    // still holds; anything else goes on as it would without the outbox.
    if (next.called) return next(e)
    const id = e.tool_use_id ?? ''
    if (id && choices.get(id) === 'cancel') {
      choices.delete(id)
      return { deny: 'Outbox: the person pressed Cancelar, so nothing was sent. Do not try it again unless they ask.' }
    }
    return next(e)
  })

  // The band's buttons. A closure lives for one drawing only, so presses come here.
  on('ui.press', { plugin: 'outbox', element: /^(cancel|now|view)-.+$/ }, async ($, e) => {
    const m = e.element.match(/^(cancel|now|view)-(.+)$/)
    const act = m?.[1] ?? ''
    const id = m?.[2] ?? ''
    try {
      if (act === 'view') await update($, viewing, v => (v === id ? '' : id))
      else if (act === 'cancel' || act === 'now') choices.set(id, act)
    } catch (err) {
      await logError($, 'press', err)
    }
    return { element: e.element }
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)
    const list = await read($, held)
    const isOff = await read($, offAtom)
    if (isOff || list.length === 0) return next(e)
    const open = await read($, viewing)
    const rest = await next(e)
    const { Box, Text, Button } = $.ui.resolve(e)
    const noop = () => undefined
    const cols = Math.max(24, e.props.bodyColumns)
    const room = Math.max(10, cols - 34)

    return (
      <Box flexDirection="column">
        {rest}
        {list.slice(0, BAND_MAX).map(item => (
          <Box key={`held-${item.id}`} flexDirection="column">
            <Box flexDirection="row" justifyContent="space-between" gap={1}>
              <Text wrap="truncate-end">
                <Text bold color={BREU} backgroundColor={LIMA}>
                  {' ◷ Outbox '}
                </Text>
                <Text> </Text>
                <Text>{cut(describe(item), Math.max(8, room - 14))}</Text>
                <Text dimColor> · envia em {item.left}s</Text>
              </Text>
              <Box flexDirection="row" gap={1}>
                {item.preview ? <Button key={`view-${item.id}`} label={open === item.id ? 'Fechar' : 'Ver'} onPress={noop} /> : null}
                <Button key={`cancel-${item.id}`} label="Cancelar" variant="primary" onPress={noop} />
                <Button key={`now-${item.id}`} label="Enviar já" onPress={noop} />
              </Box>
            </Box>
            {open === item.id && item.preview ? (
              <Text dimColor wrap="wrap">
                {item.preview}
              </Text>
            ) : null}
          </Box>
        ))}
        {list.length > BAND_MAX ? <Text dimColor>+{list.length - BAND_MAX} à espera</Text> : null}
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Link } = $.ui.resolve(e)
    const list = await read($, log)
    const isOff = await read($, offAtom)
    const cols = Math.max(24, e.props.bodyColumns)
    const room = Math.max(3, Math.floor(((e.viewport?.rows ?? 30) - 8) / 2))
    const newest = [...list].reverse()
    const count = (s: OutboxStatus) => list.filter(x => x.status === s).length
    const sent = count('sent')
    const stopped = count('cancelled')

    return (
      <Box flexDirection="column" width={cols}>
        {isOff ? <Text color={WARN}>O outbox está desligado em todos os chats. Liga-o com /mods.</Text> : null}
        {list.length === 0 ? (
          <Text dimColor wrap="wrap">
            Ainda nada saiu deste chat. Emails, convites, edições no Notion, mensagens, git pushes e PRs do GitHub aparecem aqui.
          </Text>
        ) : (
          <Text dimColor>
            Enviados: {sent} · cancelados: {stopped} · total: {list.length}
          </Text>
        )}
        {newest.slice(0, room).map(x => {
          const [glyph, color] = GLYPH[x.status]
          const second = x.title ? `“${x.title}”` : ''
          return (
            <Box key={`entry-${x.id}`} flexDirection="column" marginTop={1}>
              <Text wrap="truncate-end">
                {x.status === 'held' ? (
                  <Text color={BREU} backgroundColor={LIMA}>
                    {glyph}
                  </Text>
                ) : color ? (
                  <Text color={color}>{glyph}</Text>
                ) : (
                  <Text dimColor>{glyph}</Text>
                )}
                <Text> </Text>
                <Text dimColor>{clock(x.at)} </Text>
                <Text bold={x.status !== 'cancelled'} dimColor={x.status === 'cancelled'}>
                  {x.label}
                </Text>
                {x.target ? <Text dimColor> {`${TO[x.kind]} ${cut(x.target, cols)}`}</Text> : null}
              </Text>
              {second ? (
                <Text dimColor wrap="truncate-end">
                  {'  '}
                  {cut(second, cols - 2)}
                </Text>
              ) : null}
              <Text dimColor italic wrap="truncate-end">
                {'  '}
                {WORD[x.status]}
                {x.note ? `: ${cut(x.note, cols - 14)}` : ''}
              </Text>
              {x.link ? <Link href={x.link} label={`  ${cut(x.link, cols - 2)}`} /> : null}
            </Box>
          )
        })}
        {newest.length > room ? (
          <Text dimColor italic>
            {newest.length - room} mais antigos não mostrados
          </Text>
        ) : null}
        <Box marginTop={1} flexDirection="column">
          <Text dimColor wrap="wrap">
            {modeLine(mode, seconds)} Muda isto com /plugin configure outbox num terminal.
          </Text>
        </Box>
      </Box>
    )
  })
}

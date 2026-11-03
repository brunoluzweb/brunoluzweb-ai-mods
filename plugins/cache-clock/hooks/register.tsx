import type { EngineInterface, ModelForkResult, Register } from 'claude-code'

import type { Clock, Warm } from '../types'

const CLOCK = { plugin: 'cache-clock', key: 'clock' } as const
const WARM = { plugin: 'cache-clock', key: 'warm' } as const

const FIVE_MIN = 5 * 60_000
const ONE_HOUR = 60 * 60_000
const DEMO_MS = 60_000
// A cold chat this big gets the handoff button: re-reading it costs the most.
const BIG = 150_000
const BAR = 20

// Keep warm: one small background ping about 45 s before the cache would go cold.
// $.model.fork repeats the main thread's last request (same model, system prompt,
// tools, messages) with this one line after it, so the API reads the chat from its
// cache and the cache's timer starts again. The fork never writes the transcript.
const LEAD = 45_000
const MAX_PINGS = 30
const MAX_MS = 2 * 60 * 60_000
const MAX_FAILS = 3
const RETRY_MS = 20_000
const PING_PROMPT = 'Reply with the single word: ok'
const TIP = 'Cada ping lê o chat da cache por uma pequena parte do preço (5 a 10%). Deixá-la arrefecer obriga a escrever tudo outra vez.'
// Turns that are not the person typing: they do not count as "they are back".
const BACKGROUND = new Set(['task-notification', 'scheduled-trigger', 'peer', 'peer-send-message', 'projects-relay', 'channel', 'coordinator', 'observer', 'observer-activity', 'auto-continuation'])

const GOOD = '#16a34a'
const WARN = '#ca8a04'
const BAD = '#dc2626'
const COLD = '#2563eb'

// Module variables reset on a reload; the clock itself lives in $.state.
let sid = ''
let home = ''
let demo = false
let detected: 'unknown' | '5m' | '1h' = 'unknown'
let working = false
let pinging = false

// The /mods switchboard turns this mod off in every chat with switches.json.
// "cache-clock:hidden": true in the same file hides the clock in every chat.
const NAME = 'cache-clock'
const HIDE_KEY = `${NAME}:hidden`
let off = false
let hidden = false

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
  off = nowOff
  hidden = nowHidden
  if (off) await stopWarm($, 'Keep warm parado: o Cache Clock foi desligado no /mods.')
  else if (hidden) await stopWarm($, 'Keep warm parado: o Cache Clock está oculto.')
  await redraw($)
}

async function redraw($: EngineInterface) {
  try {
    const c = await getClock($)
    if (c) await setClock($, { ...c, now: await $.clock.now() })
    $.ui.invalidate('ui.render')
  } catch {
    // The next tick redraws anyway.
  }
}

// Read, change, write the whole file, so every chat sees the choice within 3 s.
async function setHidden($: EngineInterface, value: boolean) {
  try {
    const json = await readSwitches($)
    if (value) json[HIDE_KEY] = true
    else delete json[HIDE_KEY]
    await $.process.run(['mkdir', '-p', `${home}/.claude/mods`])
    await $.fs.write(switchesPath($), `${JSON.stringify(json, null, 2)}\n`)
  } catch (err) {
    await log($, `save hidden failed: ${String(err)}`)
  }
  hidden = value
  if (value) await stopWarm($, 'Keep warm parado: o Cache Clock está oculto.')
  await redraw($)
}

const short = (tokens: number) => `${Math.round(tokens / 1000)}k`
const mmss = (ms: number) => {
  const s = Math.max(0, Math.ceil(ms / 1000))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}
const ago = (ms: number) => {
  const m = Math.floor(ms / 60_000)
  return m < 1 ? 'agora mesmo' : m === 1 ? 'há 1 min' : m < 60 ? `há ${m} min` : `há ${Math.floor(m / 60)} h`
}

/** Where the cache length comes from: Anthropic's own reply, the demo, or a guess before the first reply. */
function lengthLabel(c: Clock) {
  if (c.ttlSource === 'demo') return 'cache de demonstração de 60 s, só neste chat'
  if (c.ttlSource === 'detected') return `cache de ${c.ttlMs === ONE_HOUR ? '1 hora' : '5 min'}, como a última resposta da Anthropic a definiu`
  return 'cache de 5 min, uma estimativa até à primeira resposta'
}

function ttl(): { ttlMs: number; ttlSource: Clock['ttlSource'] } {
  if (demo) return { ttlMs: DEMO_MS, ttlSource: 'demo' }
  if (detected === '1h') return { ttlMs: ONE_HOUR, ttlSource: 'detected' }
  if (detected === '5m') return { ttlMs: FIVE_MIN, ttlSource: 'detected' }
  return { ttlMs: FIVE_MIN, ttlSource: 'default' }
}

async function getClock($: EngineInterface): Promise<Clock | null> {
  const { value } = await $.state.get(CLOCK)
  return value ?? null
}

async function setClock($: EngineInterface, c: Clock | null) {
  await $.state.set(CLOCK, c)
}

async function getWarm($: EngineInterface): Promise<Warm | null> {
  const { value } = await $.state.get(WARM)
  return value ?? null
}

async function setWarm($: EngineInterface, w: Warm | null) {
  await $.state.set(WARM, w)
  try {
    $.ui.invalidate('ui.render')
  } catch {
    // The next tick redraws anyway.
  }
}

function toast($: EngineInterface, text: string) {
  try {
    $.ui.toast(text)
  } catch {
    // The toast is only a hint.
  }
}

// Turns keep warm on. 'none' when there is no reply yet whose cache could be kept.
async function startWarm($: EngineInterface): Promise<'on' | 'none'> {
  const c = await getClock($)
  if (!c || !c.lastEnd) return 'none'
  // Keep warm never runs out of sight: it shows the clock first.
  if (hidden) await setHidden($, false)
  await setWarm($, { startedAt: await $.clock.now(), pings: 0, read: 0, write: 0, cold: false, error: '', sending: false, failures: 0, retryAt: 0 })
  await log($, `keep warm on (${c.ttlMs / 1000} s cache, ${short(c.tokens)} tokens)`)
  return 'on'
}

async function stopWarm($: EngineInterface, why: string, shout = true) {
  const w = await getWarm($)
  if (!w) return
  await setWarm($, null)
  await log($, `keep warm off after ${w.pings} pings: ${why}`)
  if (shout) toast($, why)
}

// Once a second: sends the ping when the cache is 45 s from going cold, and keeps the caps.
async function warmTick($: EngineInterface) {
  const w = await getWarm($)
  if (!w || pinging || working) return
  if (off) return stopWarm($, 'Keep warm parado: o Cache Clock foi desligado no /mods.')
  const now = await $.clock.now()
  if (now - w.startedAt >= MAX_MS) return stopWarm($, 'Keep warm parado ao fim de 2 horas. Escreve /keepwarm para o voltar a ligar.')
  if (w.pings >= MAX_PINGS) return stopWarm($, `Keep warm parado ao fim de ${MAX_PINGS} pings. Escreve /keepwarm para o voltar a ligar.`)
  if (now < w.retryAt) return
  const c = await getClock($)
  if (!c || !c.lastEnd) return
  if (c.lastEnd + c.ttlMs - now > LEAD) return
  pinging = true
  void ping($, now).catch(async err => {
    pinging = false
    await log($, `ping failed: ${String(err)}`)
  })
}

async function ping($: EngineInterface, start: number) {
  const w0 = await getWarm($)
  if (w0) await setWarm($, { ...w0, sending: true })
  let r: ModelForkResult | null = null
  let thrown = ''
  try {
    r = await $.model.fork({ prompt: PING_PROMPT })
  } catch (err) {
    thrown = String(err)
  }
  pinging = false
  const n = (w0?.pings ?? 0) + 1
  if (r && !r.isAnswered && r.reason === 'nothing-to-fork') {
    await log($, `ping ${n}: nothing to fork yet`)
    return stopWarm($, 'Keep warm parado: ainda não há resposta para manter quente.')
  }
  const usage = r && 'usage' in r ? r.usage : null
  const read = usage?.cache_read_input_tokens ?? 0
  const write = usage?.cache_creation_input_tokens ?? 0
  // An answer, or a reply with no words, still read the chat: the cache timer restarted.
  const ok = r !== null && (r.isAnswered || r.reason === 'empty-reply')
  const error = ok ? '' : thrown ? 'error' : r && !r.isAnswered && r.reason === 'api-error' ? `${r.error}${r.status ? ` ${r.status}` : ''}` : r && !r.isAnswered ? r.reason : 'error'
  await log($, `ping ${n}: cache read ${read}, cache write ${write}, error ${error || 'none'}${thrown ? ` (${thrown.slice(0, 200)})` : ''}`)
  const w = await getWarm($)
  // Stopped while the ping was out (a prompt, /keepwarm off): only the log keeps it.
  if (!w) return
  const now = await $.clock.now()
  if (ok) {
    await setWarm($, { ...w, pings: n, read, write, cold: write > read, error: '', sending: false, failures: 0, retryAt: 0 })
    const c = await getClock($)
    if (c) await setClock($, { ...c, lastEnd: Math.max(c.lastEnd, start), now })
  } else {
    const failures = w.failures + 1
    await setWarm($, { ...w, pings: n, error, sending: false, failures, retryAt: now + RETRY_MS })
    if (failures >= MAX_FAILS) return stopWarm($, `Keep warm parado: ${MAX_FAILS} pings seguidos falharam (${error}).`)
  }
  if (n >= MAX_PINGS) await stopWarm($, `Keep warm parado ao fim de ${MAX_PINGS} pings. Escreve /keepwarm para o voltar a ligar.`)
}

function warmLine(w: Warm, left: number): string {
  const parts = ['A manter quente']
  if (w.sending) parts.push(`a enviar o ping ${w.pings + 1}`)
  else if (w.pings === 0) parts.push(`primeiro ping em ${mmss(left - LEAD)}`)
  else parts.push(`ping ${w.pings}`, `próximo em ${mmss(left - LEAD)}`)
  if (w.error) parts.push(`o último ping falhou (${w.error}), a tentar outra vez`)
  else if (w.pings > 0 && w.cold) parts.push(`a cache tinha arrefecido, por isso o ping ${w.pings} voltou a escrever ${short(w.write)} tokens nela`)
  else if (w.pings > 0) parts.push(`o último ping leu ${short(w.read)} tokens da cache`)
  return parts.join(' · ')
}

async function log($: EngineInterface, line: string) {
  try {
    const path = `${home}/.claude/mods-logs/cache-clock.log`
    const old = (await $.fs.exists(path)) ? String(await $.fs.read(path)) : ''
    const lines = old ? old.trimEnd().split('\n').slice(-200) : []
    lines.push(`${new Date(await $.clock.now()).toISOString()} ${sid.slice(0, 8)} ${line}`)
    await $.fs.write(path, `${lines.join('\n')}\n`)
  } catch {
    // The log must never break the clock.
  }
}

// Reads which cache length this chat's replies were written with (5 min or 1 hour).
async function detect($: EngineInterface) {
  if (!sid) return
  const r = await $.process.run(['python3', `${$.plugin.root}/bin/ttl.py`, sid])
  const out = r.stdout.trim()
  if (out === '5m' || out === '1h') detected = out
  else if (r.exitCode !== 0) await log($, `ttl check failed: ${r.stderr.slice(0, 200)}`)
}

// A main-chat reply just ended: the cache is warm again from now.
async function restart($: EngineInterface) {
  const now = await $.clock.now()
  const { context } = await $.session.usage()
  await detect($).catch(() => undefined)
  await setClock($, { lastEnd: now, ...ttl(), tokens: context.tokens ?? 0, now, note: '' })
}

// Once a second: moves the countdown while the band shows.
async function tick($: EngineInterface) {
  const c = await getClock($)
  if (!c || off || hidden || !c.lastEnd) return
  const now = await $.clock.now()
  // A cold clock only needs a redraw once a minute, for its "went cold" line.
  const cold = now - c.lastEnd >= c.ttlMs
  if (cold && Math.floor((now - c.lastEnd) / 60_000) === Math.floor((c.now - c.lastEnd) / 60_000) && c.now - c.lastEnd >= c.ttlMs) return
  await setClock($, { ...c, now })
}

async function handoff($: EngineInterface) {
  const c = await getClock($)
  // The handoff mod picks this file up within 5 seconds.
  await $.fs.write(`${home}/.claude/handoffs/.request-${sid}`, String(await $.clock.now()))
  await log($, `asked for a handoff at ${short(c?.tokens ?? 0)}`)
  if (c) await setClock($, { ...c, note: 'Handoff pedido. Fica atento ao painel Refresh.' })
}

// The person's home folder, read from $HOME when the session starts. The mod's own
// folder is only the fallback: it holds /.claude/ only when installed under ~/.claude,
// not when read from a marketplace folder such as ~/Projects/brunoluzweb-ai-mods.
let userHomeDir = ''
const userHome = ($: EngineInterface) => userHomeDir || ($.plugin.root.split('/.claude/')[0] ?? '')
async function loadUserHome($: EngineInterface) {
  try {
    userHomeDir = (await $.env.get('HOME')) ?? ''
  } catch {
    userHomeDir = ''
  }
  return userHome($)
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await loadUserHome($)
    sid = await $.session.id()
    home = userHome($)
    // The 60 s demo is for one chat only. Older versions saved it for every chat, so clear that.
    demo = false
    if ((await $.store.get('demo').catch(() => undefined)) === true) {
      await $.store.set('demo', false).catch(() => undefined)
      await log($, 'cleared a demo setting saved by an older version')
    }
    await readSwitch($).catch(() => undefined)
    $.clock.every(3000, () => {
      void readSwitch($).catch(() => undefined)
    })
    await $.command.register({
      name: 'cacheclock',
      description: 'Cache Clock: mostra-o ou esconde-o. "/cacheclock hide" esconde-o, "/cacheclock demo" usa uma cache de 60 s para gravar, "/cacheclock auto" volta ao normal',
      argumentHint: '[hide|demo|auto]',
      immediate: true,
    })
    await $.command.register({
      name: 'keepwarm',
      description: 'Cache Clock: mantém a cache quente com um pequeno ping em segundo plano 45 s antes de arrefecer. "/keepwarm off" para-o',
      argumentHint: '[off]',
      immediate: true,
    })
    $.clock.every(1000, () => {
      void tick($).catch(() => undefined)
      void warmTick($).catch(err => log($, `keep warm tick failed: ${String(err)}`))
    })
    void detect($).catch(() => undefined)
    return next(e)
  })

  on('turn.start', async ($, e, next) => {
    if (off) return next(e)
    // Should the engine ever raise a turn for the ping's own fork, it is not the person's turn.
    if (!(pinging && e.text === PING_PROMPT)) working = true
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    if (off) return next(e)
    const result = await next(e)
    // A helper's turn does not touch the main chat's cache.
    if (e.agentId === undefined) {
      working = false
      void restart($).catch(err => log($, `restart failed: ${String(err)}`))
    }
    return result
  })

  // The person is back: a prompt of theirs ends keep warm. Its own commands do not.
  on('prompt.submit', async ($, e, next) => {
    if (off) return next(e)
    const text = e.text.trim().toLowerCase()
    const own = text.startsWith('/keepwarm') || text.startsWith('/cacheclock') || text === PING_PROMPT.toLowerCase()
    if (!own && !BACKGROUND.has(e.origin?.kind ?? '')) {
      void stopWarm($, 'Keep warm parado: enviaste uma mensagem.').catch(() => undefined)
    }
    return next(e)
  })

  on('command.run', { command: 'keepwarm' }, async ($, e) => {
    if (off) return { text: 'O Cache Clock está desligado. Liga-o com /mods.' }
    const arg = e.args.trim().toLowerCase()
    const w = await getWarm($)
    if (arg === 'off' || (arg !== 'on' && w)) {
      await stopWarm($, 'O keep warm está desligado.', false)
      return { text: 'O keep warm está desligado. Escreve /keepwarm para o voltar a ligar.' }
    }
    if (w) return { text: 'O keep warm já está ligado. Escreve /keepwarm off para o parar.' }
    if ((await startWarm($)) === 'none') return { text: 'Ainda não há nada para manter quente. O keep warm funciona depois da primeira resposta do Claude.' }
    return { text: 'O keep warm está ligado: um pequeno ping em segundo plano cerca de 45 s antes de a cache arrefecer. Para ao fim de 2 horas, de 30 pings, ou quando enviares uma mensagem. Escreve /keepwarm off para o parar.' }
  })

  on('ui.press', { plugin: 'cache-clock', element: 'keepwarm' }, async ($, e) => {
    if (off) return { element: e.element }
    if (await getWarm($)) await stopWarm($, 'O keep warm está desligado.')
    else if ((await startWarm($)) === 'on') toast($, 'O keep warm está ligado. Escreve /keepwarm off para o parar.')
    return { element: e.element }
  })

  on('command.run', { command: 'cacheclock' }, async ($, e) => {
    if (off) return { text: 'O Cache Clock está desligado. Liga-o com /mods.' }
    const arg = e.args.trim().toLowerCase()
    const hide = arg === 'hide' || (arg !== 'demo' && arg !== 'auto' && arg !== 'show' && !hidden)
    if (arg === 'demo' || arg === 'auto') {
      // This chat only: a new chat starts with the real cache length again.
      demo = arg === 'demo'
    }
    await setHidden($, hide)
    const c = await getClock($)
    if (c) await setClock($, { ...c, ...ttl(), now: await $.clock.now() })
    if (hide) return { text: 'Cache Clock oculto em todos os chats. Escreve /cacheclock ou abre o /mods para o mostrar.' }
    const t = ttl()
    const how = lengthLabel({ ttlMs: t.ttlMs, ttlSource: t.ttlSource } as Clock)
    return { text: `O Cache Clock está ligado: ${how}. Escreve /cacheclock hide ou abre o /mods para o esconder.` }
  })

  on('ui.press', { plugin: 'cache-clock', element: 'handoff' }, async ($, e) => {
    if (off) return { element: e.element }
    await handoff($)
    return { element: e.element }
  })
  on('ui.press', { plugin: 'cache-clock', element: 'hide' }, async ($, e) => {
    const wasWarm = (await getWarm($)) !== null
    await stopWarm($, 'Keep warm parado: o Cache Clock está oculto.', false)
    await setHidden($, true)
    toast($, `Cache Clock oculto${wasWarm ? ' e keep warm parado' : ''}. Escreve /cacheclock ou abre o /mods para o mostrar.`)
    return { element: e.element }
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (off) return next(e)
    const c = await getClock($)
    if (hidden || !c || !c.lastEnd || working || e.props.isWorking || e.props.hasSurvey) return next(e)
    const rest = await next(e)
    const { Box, Text, Button } = $.ui.resolve(e)
    const noop = () => undefined
    const left = c.lastEnd + c.ttlMs - c.now
    const cost = `${short(c.tokens)} tokens`
    const w = await getWarm($)
    const warmButton = w ? <Button key="keepwarm" label="Parar keep warm" onPress={noop} /> : <Button key="keepwarm" label="Keep warm" onPress={noop} />
    const warmRow = w ? <Text color={w.cold || w.error ? BAD : COLD}>{warmLine(w, left)}</Text> : null
    const tip = <Text dimColor>{TIP}</Text>

    if (left > 0) {
      const share = left / c.ttlMs
      const filled = Math.max(1, Math.round(share * BAR))
      const color = left <= 60_000 ? BAD : share < 0.5 ? WARN : GOOD
      return (
        <Box flexDirection="column">
          {rest}
          <Box flexDirection="row" alignItems="center" justifyContent="space-between" gap={1}>
            <Text>
              <Text color={color}>◷ Cache quente </Text>
              <Text bold color={color}>
                {mmss(left)}
              </Text>
              <Text> </Text>
              <Text color={color}>{'━'.repeat(filled)}</Text>
              <Text dimColor>{'━'.repeat(BAR - filled)}</Text>
              <Text dimColor>{` ${lengthLabel(c)}.`}</Text>
              <Text dimColor> Se responderes agora, {cost} custam 5 a 10% do preço.</Text>
            </Text>
            <Box flexDirection="row" gap={1}>
              {warmButton}
              <Button key="hide" label="Esconder" role="dismiss" onPress={noop} />
            </Box>
          </Box>
          {warmRow}
          {tip}
        </Box>
      )
    }

    // The 60 s demo always shows the button, so it can be filmed in a small chat.
    const big = c.tokens >= BIG || c.ttlSource === 'demo'
    return (
      <Box flexDirection="column">
        {rest}
        <Box flexDirection="row" alignItems="center" justifyContent="space-between" gap={1}>
          <Text>
            <Text color={COLD}>❄ Cache fria</Text>
            <Text dimColor> {ago(-left)}. A tua próxima mensagem volta a ler {cost} a preço inteiro.</Text>
          </Text>
          <Box flexDirection="row" gap={1}>
            {big ? <Button key="handoff" label="Passar para um chat novo" variant="primary" onPress={noop} /> : null}
            {warmButton}
            <Button key="hide" label="Esconder" role="dismiss" onPress={noop} />
          </Box>
        </Box>
        {warmRow}
        {c.note ? <Text dimColor>{c.note}</Text> : null}
        {tip}
      </Box>
    )
  })
}

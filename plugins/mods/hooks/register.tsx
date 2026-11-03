import type { EngineInterface, Register } from 'claude-code'

// The Mods pane: one row per knowledge-work mod, with a Ligado/Desligado switch that works
// in every chat (switches.json). Mods that draw something also get Visível/Oculto,
// kept as "<name>:hidden": true in the same file. Showing a side pane, or the
// Refresh panel, also leaves an open request for this chat.
// The list is found on disk, not typed in: every folder under ~/.claude/mods with a
// plugin.json and a hooks.json that has "modules", every CLAUDE_CODE_PLUGIN_DIRS
// folder, and this chat's own ~/.claude/dev-mods/<session id>/ mods.

const PANE = 'mods'
const TITLE = 'Mods'
const NOTE = { plugin: 'mods', key: 'note' } as const
const POLL_MS = 3000
const SCAN_MS = 10_000
const BUTTONS_COLS = 36

const GOOD = '#16a34a'

// hide: has a Visível/Oculto switch. ask: Visível also leaves an open request. tip: the slash command.
type Mod = { name: string; title: string; what: string; pane: boolean; hide: boolean; ask: boolean; tip: string }
// A row in the pane: a known mod or one found on disk. switchable: its source reads switches.json.
type Row = Mod & { switchable: boolean; chatOnly: boolean }

const MODS: readonly Mod[] = [
  { name: 'cache-clock', title: 'Cache Clock', what: 'Conta o tempo até a cache arrefecer', pane: false, hide: true, ask: false, tip: '/cacheclock para mostrar ou esconder' },
  { name: 'handoff', title: 'Handoff (Refresh)', what: 'Passa um chat longo para um novo', pane: false, hide: true, ask: true, tip: '/refresh para o mostrar' },
  { name: 'screen-share', title: 'Screen-Share Mode', what: 'Esconde emails, telefones e valores no ecrã', pane: false, hide: false, ask: false, tip: '/screen-share esconde dados privados' },
  { name: 'brain-dump', title: 'Brain-Dump Shaper', what: 'Transforma prompts longos e soltos em briefs claros', pane: false, hide: false, ask: false, tip: '' },
  { name: 'reflect', title: 'Reflect', what: 'Guarda as tuas correções como regras permanentes', pane: false, hide: false, ask: false, tip: '' },
  { name: 'helper-desk', title: 'Helper Desk', what: 'Barra de tarefas acima do prompt e um cartão por subagente', pane: true, hide: true, ask: true, tip: '/helpers para abrir' },
  { name: 'chat-inventory', title: 'Chat Inventory', what: 'Conectores, ficheiros e skills que este chat usou', pane: true, hide: true, ask: true, tip: '/inventory para abrir' },
  { name: 'outbox', title: 'Outbox', what: 'Segura emails, convites, pushes e PRs uns segundos para poderes cancelar', pane: true, hide: false, ask: true, tip: '/outbox para abrir' },
]

// Module variables reset on a reload; the switches themselves live in the file.
let sid = ''
let lastRaw = ''
let cache: { at: number; rows: Row[] } | null = null

const NOT_SWITCHABLE = 'Ainda não tem interruptor. Pede ao Claude: acrescenta o interruptor do /mods a este mod.'

const homeOf = ($: EngineInterface) => userHome($)
const switchesPath = ($: EngineInterface) => `${homeOf($)}/.claude/mods/switches.json`

function cut(s: string, n: number) {
  if (n <= 0) return ''
  return s.length <= n ? s : `${s.slice(0, Math.max(0, n - 1))}…`
}

async function log($: EngineInterface, where: string, err: unknown) {
  try {
    const dir = `${homeOf($)}/.claude/mods-logs`
    const file = `${dir}/mods.log`
    await $.process.run(['mkdir', '-p', dir])
    let old = ''
    try {
      old = String(await $.fs.read(file))
    } catch {
      old = ''
    }
    const when = new Date(await $.clock.now()).toISOString()
    const msg = err instanceof Error ? err.message : String(err)
    await $.fs.write(file, `${old}${when} ${where}: ${msg}\n`.slice(-50_000))
  } catch {
    // Nowhere left to report it.
  }
}

async function readRaw($: EngineInterface) {
  try {
    const path = switchesPath($)
    if (!(await $.fs.exists(path))) return ''
    return String(await $.fs.read(path))
  } catch {
    return ''
  }
}

function parse(raw: string): Record<string, unknown> {
  try {
    const json = JSON.parse(raw) as unknown
    return json && typeof json === 'object' && !Array.isArray(json) ? (json as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

async function readSwitches($: EngineInterface) {
  return parse(await readRaw($))
}

const isOff = (json: Record<string, unknown>, name: string) => json[name] === false
const isHidden = (json: Record<string, unknown>, name: string) => json[`${name}:hidden`] === true

async function save($: EngineInterface, json: Record<string, unknown>) {
  await $.process.run(['mkdir', '-p', `${homeOf($)}/.claude/mods`])
  const text = `${JSON.stringify(json, null, 2)}\n`
  await $.fs.write(switchesPath($), text)
  lastRaw = text
}

// Read, change, write the whole file. Off is `false`; on deletes the key.
async function flip($: EngineInterface, name: string) {
  const json = await readSwitches($)
  const turnOff = !isOff(json, name)
  if (turnOff) json[name] = false
  else delete json[name]
  await save($, json)
  return turnOff
}

// Hidden is `"<name>:hidden": true`; shown deletes the key.
async function flipHidden($: EngineInterface, name: string) {
  const json = await readSwitches($)
  const key = `${name}:hidden`
  const hide = !isHidden(json, name)
  if (hide) json[key] = true
  else delete json[key]
  await save($, json)
  return hide
}

async function askOpen($: EngineInterface, name: string) {
  if (!sid) throw new Error('no session id')
  await $.fs.write(`${homeOf($)}/.claude/mods/.open-${name}-${sid}`, '')
}

async function readText($: EngineInterface, path: string) {
  try {
    if (!(await $.fs.exists(path))) return ''
    return String(await $.fs.read(path))
  } catch {
    return ''
  }
}

// Folders (or links to folders) directly inside dir. A missing dir is an empty list.
async function listDirs($: EngineInterface, dir: string) {
  try {
    const entries = await $.fs.list(dir)
    return entries.filter(x => !x.name.startsWith('.') && (x.kind === 'dir' || x.isLink)).map(x => `${dir}/${x.name}`)
  } catch {
    return []
  }
}

// Plugins installed from a marketplace: ~/.claude/plugins/cache/<marketplace>/<plugin>/<version>, newest version name last.
async function cacheDirs($: EngineInterface, home: string) {
  const out: string[] = []
  for (const market of await listDirs($, `${home}/.claude/plugins/cache`)) {
    for (const plugin of await listDirs($, market)) {
      const versions = (await listDirs($, plugin)).sort()
      const last = versions[versions.length - 1]
      if (last) out.push(last)
    }
  }
  return out
}

// CLAUDE_CODE_PLUGIN_DIRS: folders split by ':', '~' meaning the home folder.
async function envDirs($: EngineInterface) {
  let raw: string | undefined
  try {
    raw = await $.env.get('CLAUDE_CODE_PLUGIN_DIRS')
  } catch {
    return []
  }
  if (!raw) return []
  const home = homeOf($)
  return raw
    .split(':')
    .map(x => x.trim())
    .filter(Boolean)
    .map(x => (x === '~' ? home : x.startsWith('~/') ? `${home}${x.slice(1)}` : x))
    .map(x => x.replace(/\/+$/, ''))
}

function titleCase(name: string) {
  return name
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map(w => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ')
}

// Every hooks source file, tests and backups left out.
async function hooksSource($: EngineInterface, dir: string) {
  let text = ''
  try {
    const entries = await $.fs.list(`${dir}/hooks`)
    for (const x of entries) {
      if (x.kind !== 'file' || !/\.(tsx?|jsx?|mjs|cjs)$/.test(x.name) || /\.test\./.test(x.name)) continue
      if (x.size > 2_000_000) continue
      text += `${await readText($, `${dir}/hooks/${x.name}`)}\n`
    }
  } catch {
    // An unreadable hooks folder means nothing is found in it.
  }
  return text
}

function commandsIn(source: string) {
  const out: string[] = []
  for (const m of source.matchAll(/command\.register\(\s*\{\s*name:\s*['"`]([^'"`]+)['"`]/g)) {
    const name = m[1] ?? ''
    if (name && !out.includes(name)) out.push(name)
  }
  return out
}

// A mod is a plugin.json plus a hooks.json with "modules". Anything else is not one.
async function inspect($: EngineInterface, dir: string, chatOnly: boolean): Promise<Row | null> {
  const pluginRaw = await readText($, `${dir}/.claude-plugin/plugin.json`)
  if (!pluginRaw) return null
  const hooksJson = parse(await readText($, `${dir}/hooks/hooks.json`))
  if (!('modules' in hooksJson)) return null
  const plugin = parse(pluginRaw)
  const folder = dir.split('/').pop() ?? ''
  const name = typeof plugin.name === 'string' && plugin.name ? plugin.name : folder
  if (!name || name === 'mods') return null
  const source = await hooksSource($, dir)
  const known = MODS.find(m => m.name === name)
  const commands = commandsIn(source).map(c => `/${c}`)
  return {
    name,
    title: known?.title ?? titleCase(name),
    what: known?.what ?? (typeof plugin.description === 'string' ? plugin.description : ''),
    tip: known?.tip ?? commands.join(', '),
    pane: known?.pane ?? false,
    hide: known?.hide ?? false,
    ask: known?.ask ?? false,
    switchable: source.includes('switches.json'),
    chatOnly,
  }
}

// Known mods first in their old order, then new ones A to Z, then this chat's own.
async function scan($: EngineInterface): Promise<Row[]> {
  const home = homeOf($)
  const found = new Map<string, Row>()
  const dirs: [string, boolean][] = []
  for (const d of await listDirs($, `${home}/.claude/mods`)) dirs.push([d, false])
  for (const d of await envDirs($)) dirs.push([d, false])
  for (const d of await cacheDirs($, home)) dirs.push([d, false])
  if (sid) for (const d of await listDirs($, `${home}/.claude/dev-mods/${sid}`)) dirs.push([d, true])
  const seen = new Set<string>()
  for (const [dir, chatOnly] of dirs) {
    if (seen.has(dir)) continue
    seen.add(dir)
    const row = await inspect($, dir, chatOnly)
    if (row && !found.has(row.name)) found.set(row.name, row)
  }
  const rows: Row[] = MODS.map(m => {
    const hit = found.get(m.name)
    found.delete(m.name)
    return { ...m, switchable: hit ? hit.switchable : true, chatOnly: hit ? hit.chatOnly : false }
  })
  const rest = [...found.values()].sort((a, b) => a.title.localeCompare(b.title))
  return [...rows, ...rest.filter(r => !r.chatOnly), ...rest.filter(r => r.chatOnly)]
}

// The scan is kept for 10 seconds, so drawing stays fast.
async function getRows($: EngineInterface, force = false) {
  const now = await $.clock.now()
  if (!force && cache && now - cache.at < SCAN_MS) return cache.rows
  const rows = await scan($)
  cache = { at: now, rows }
  return rows
}

const sigOf = (rows: readonly Row[]) => rows.map(r => `${r.name}|${r.title}|${r.what}|${r.tip}|${r.switchable}|${r.chatOnly}`).join('\n')

// While the pane is open, look again every 10 seconds and redraw when the list changed.
async function scanPoll($: EngineInterface) {
  let open = false
  try {
    open = (await $.ui.panes()).some(p => p.id === PANE)
  } catch {
    open = false
  }
  if (!open) return
  const before = sigOf(cache?.rows ?? [])
  const rows = await getRows($, true)
  if (sigOf(rows) !== before) $.ui.invalidate('ui.render')
}

// Another chat may flip a switch: redraw when the file changes.
async function poll($: EngineInterface) {
  const raw = await readRaw($)
  if (raw === lastRaw) return
  lastRaw = raw
  $.ui.invalidate('ui.render')
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
    try {
      sid = await $.session.id()
      cache = null
      await $.command.register({ name: 'mods', description: 'Abre o painel Mods: liga ou desliga cada mod, ou mostra-o ou esconde-o, em todos os chats', immediate: true })
      lastRaw = await readRaw($)
      $.clock.every(POLL_MS, () => {
        void poll($).catch(err => log($, 'poll', err))
      })
      $.clock.every(SCAN_MS, () => {
        void scanPoll($).catch(err => log($, 'scan', err))
      })
    } catch (err) {
      await log($, 'session start', err)
    }
    return next(e)
  })

  on('command.run', { command: 'mods' }, async $ => {
    try {
      await getRows($)
    } catch (err) {
      await log($, 'scan on open', err)
    }
    await $.ui.open({ id: PANE, title: TITLE })
    return { text: 'Painel Mods aberto.' }
  })

  // Presses come here, not to onPress: a closure lives for one drawing only.
  on('ui.press', { plugin: 'mods', element: /^toggle-.+$/ }, async ($, e) => {
    const name = e.element.slice('toggle-'.length)
    const mod = (await getRows($)).find(m => m.name === name && m.switchable)
    if (!mod) return { element: e.element }
    try {
      const nowOff = await flip($, name)
      await $.state.set(NOTE, `${mod.title} está ${nowOff ? 'desligado' : 'ligado'} em todos os chats.`)
    } catch (err) {
      await log($, `toggle ${name}`, err)
      await $.state.set(NOTE, `Não foi possível mudar ${mod.title}. Vê ~/.claude/mods-logs/mods.log`)
    }
    return { element: e.element }
  })

  on('ui.press', { plugin: 'mods', element: /^show-.+$/ }, async ($, e) => {
    const name = e.element.slice('show-'.length)
    const mod = (await getRows($)).find(m => m.name === name && m.hide && m.switchable)
    if (!mod) return { element: e.element }
    try {
      if (isOff(await readSwitches($), name)) {
        await $.state.set(NOTE, `${mod.title} está desligado. Liga-o primeiro.`)
        return { element: e.element }
      }
      const nowHidden = await flipHidden($, name)
      if (!nowHidden && mod.ask) await askOpen($, name)
      await $.state.set(NOTE, `${mod.title} está ${nowHidden ? 'oculto' : 'visível'} em todos os chats.`)
    } catch (err) {
      await log($, `show ${name}`, err)
      await $.state.set(NOTE, `Não foi possível mudar ${mod.title}. Vê ~/.claude/mods-logs/mods.log`)
    }
    return { element: e.element }
  })

  // Open: for a side pane that is On and Shown, asks this chat to open it again.
  on('ui.press', { plugin: 'mods', element: /^open-.+$/ }, async ($, e) => {
    const name = e.element.slice('open-'.length)
    const mod = (await getRows($)).find(m => m.name === name && m.pane && m.switchable)
    if (!mod) return { element: e.element }
    try {
      const json = await readSwitches($)
      if (isOff(json, name) || isHidden(json, name)) {
        await $.state.set(NOTE, `${mod.title} está ${isOff(json, name) ? 'desligado' : 'oculto'}. Liga-o e mostra-o primeiro.`)
        return { element: e.element }
      }
      await askOpen($, name)
      await $.state.set(NOTE, `${mod.title} abre neste chat dentro de 3 segundos.`)
    } catch (err) {
      await log($, `open ${name}`, err)
      await $.state.set(NOTE, `Não foi possível abrir ${mod.title}. Vê ~/.claude/mods-logs/mods.log`)
    }
    return { element: e.element }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const noop = () => undefined
    const note = (await $.state.get(NOTE)).value ?? ''
    const json = await readSwitches($)
    const cols = Math.max(24, e.props.bodyColumns)
    const left = Math.max(10, cols - BUTTONS_COLS)

    let list: Row[] = []
    try {
      list = await getRows($)
    } catch (err) {
      await log($, 'scan', err)
      list = MODS.map(m => ({ ...m, switchable: true, chatOnly: false }))
    }

    const rows = list.map(m => {
      const off = m.switchable && isOff(json, m.name)
      const hidden = isHidden(json, m.name)
      const width = m.switchable ? left : cols
      const about = (
        <Box flexDirection="column" width={width}>
          <Text bold dimColor={off} wrap="truncate-end">
            {cut(m.title, width)}
          </Text>
          {m.what ? (
            <Text dimColor wrap="truncate-end">
              {cut(m.what, width)}
            </Text>
          ) : null}
          {m.tip ? (
            <Text dimColor italic wrap="truncate-end">
              {cut(m.tip, width)}
            </Text>
          ) : null}
          {m.chatOnly ? (
            <Text dimColor italic wrap="truncate-end">
              Só neste chat
            </Text>
          ) : null}
          {m.switchable ? null : (
            <Text dimColor wrap="wrap">
              {NOT_SWITCHABLE}
            </Text>
          )}
        </Box>
      )
      if (!m.switchable) {
        return (
          <Box key={`row-${m.name}`} flexDirection="row" marginTop={1}>
            {about}
          </Box>
        )
      }
      return (
        <Box key={`row-${m.name}`} flexDirection="row" justifyContent="space-between" gap={1} marginTop={1}>
          {about}
          <Box flexDirection="row" gap={1}>
            {m.pane ? (
              off || hidden ? (
                <Text dimColor>Abrir</Text>
              ) : (
                <Button key={`open-${m.name}`} onPress={noop}>
                  Abrir
                </Button>
              )
            ) : null}
            {m.hide ? (
              off ? (
                <Text dimColor>{hidden ? 'Oculto' : 'Visível'}</Text>
              ) : (
                <Button key={`show-${m.name}`} onPress={noop}>
                  {hidden ? <Text dimColor>Oculto</Text> : <Text color={GOOD}>Visível</Text>}
                </Button>
              )
            ) : null}
            <Button key={`toggle-${m.name}`} onPress={noop}>
              {off ? <Text dimColor>Desligado</Text> : <Text color={GOOD}>Ligado</Text>}
            </Button>
          </Box>
        </Box>
      )
    })

    return (
      <Box flexDirection="column" width={cols}>
        {rows}
        <Box marginTop={1} flexDirection="column">
          {note ? (
            <Text color={GOOD} wrap="truncate-end">
              {cut(note, cols)}
            </Text>
          ) : null}
          <Text dimColor wrap="wrap">
            Desligado quer dizer desligado em todos os chats. Oculto mantém-no ligado, mas fora de vista. As mudanças chegam em 3 segundos.
          </Text>
          <Text dimColor wrap="wrap">
            Os mods novos aparecem aqui sozinhos.
          </Text>
        </Box>
      </Box>
    )
  })
}

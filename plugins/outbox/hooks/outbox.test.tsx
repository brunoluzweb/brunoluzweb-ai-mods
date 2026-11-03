import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'
import type { Engine } from 'claude-code/testing'

import { classify } from './classify'

const BAND = {
  plugin: 'outbox',
  component: 'AbovePrompt',
  requestId: 'band',
  props: { hasSurvey: false, isWorking: true, maxRows: 12, bodyColumns: 110, scroll: { offset: 0, bodyRows: 12 }, view: {} },
} as const

const PANE = {
  plugin: 'outbox',
  component: 'Pane',
  requestId: 'outbox',
  props: { title: 'Sent from this chat', isFocused: false, bodyColumns: 60, placement: 'dock', scroll: { offset: 0, bodyRows: 30 }, view: {} },
} as const

const EMAIL = { tool: 'mcp__2f1c-gmail__send_message' as const, to: 'ana@example.com', subject: 'Proposta revista', body: 'Olá Ana, segue a proposta.' }

/** The world beneath the outbox: a desktop watching, a clock the test moves, and tools that count their runs. */
async function world($: Engine, on: On, answer: 'Enviar' | 'Cancelar' | 'Later please' = 'Enviar') {
  const clock = mock.clock(on, { now: 1_000_000 })
  mock.env(on, { HOME: '/home/test' })
  const runs: string[] = []
  on('session.surfaces', () => ({ value: ['desktop'] }))
  on('session.id', () => ({ value: 'session-1' }))
  on('fs.exists', () => ({ value: false }))
  on('command.register', () => ({ value: { command: 'outbox' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  // The engine's own band, beneath the outbox's rows.
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>engine</Text>
  })
  on('tool.call', (_, e) => {
    if (e.tool === 'AskUserQuestion') {
      const q = e.questions[0]?.question ?? ''
      return { result: { questions: e.questions, answers: { [q]: answer } } }
    }
    runs.push(String(e.tool))
    return { result: { id: 'm1', url: 'https://github.com/bruno/site/pull/7' } }
  })
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  return { clock, runs }
}

test('the classifier knows what leaves the computer', () => {
  expect(classify(EMAIL.tool, EMAIL)?.kind).toBe('email')
  expect(classify(EMAIL.tool, EMAIL)?.target).toBe('ana@example.com')
  expect(classify('mcp__cal__create_event', { summary: 'Reunião', attendees: [{ email: 'rui@example.com' }] })).toMatchObject({
    kind: 'calendar',
    label: 'Novo evento',
    target: 'rui@example.com',
    title: 'Reunião',
  })
  expect(classify('mcp__n__notion-create-pages', { pages: [{ properties: { title: 'Plano Q1' }, content: '# Plano' }] })).toMatchObject({
    kind: 'notion',
    title: 'Plano Q1',
  })
  expect(classify('Bash', { command: 'git add . && git push origin main' })).toMatchObject({ kind: 'git', target: 'origin main' })
  expect(classify('Bash', { command: 'gh pr create --title "Fix login" --body x' })).toMatchObject({ kind: 'github', title: 'Fix login' })
  expect(classify('mcp__slack__slack_send_message', { channel: '#geral', text: 'olá' })).toMatchObject({ kind: 'message', target: '#geral' })

  // Reads, drafts, dry runs and the app's own tools stay out.
  expect(classify('Bash', { command: 'git push --dry-run origin main' })).toBeNull()
  expect(classify('Bash', { command: 'git status' })).toBeNull()
  expect(classify('mcp__gmail__search_threads', { query: 'x' })).toBeNull()
  expect(classify('mcp__gmail__create_draft', { to: 'a@b.c' })).toBeNull()
  expect(classify('mcp__wp__get_post', { id: 1 })).toBeNull()
  expect(classify('mcp__claude-artifacts__publish_version', { content: 'x' })).toBeNull()
  expect(classify('mcp__ccd_session__start_session', {})).toBeNull()
  expect(classify('Edit', { file_path: '/a' })).toBeNull()
})

for (const surface of ['terminal', 'desktop'] as const) {
  test(`Cancel in the band stops the email (${surface})`, async ($, on) => {
    const { clock, runs } = await world($, on)
    const call = $.tool.call(EMAIL)
    await clock.settle()

    const band = await $.ui.mount({ ...BAND, surface })
    expect((await band.find({ type: 'Text', text: /envia em 5s/ }))?.text).toContain('Email para ana@example.com')
    await clock.advance(2000)
    expect(await band.find({ type: 'Text', text: /envia em 3s/ })).toBeDefined()
    const cancel = await band.find({ type: 'Button', text: /^Cancelar$/ })
    await band.press({ key: String(cancel?.key) })
    await clock.advance(250)
    await band.unmount()

    const ran = await call
    expect(runs).toEqual([])
    expect(ran.deny).toContain('chose not to send')

    const pane = await $.ui.mount({ ...PANE, surface })
    expect(await pane.find({ type: 'Text', text: /Enviados: 0 · cancelados: 1/ })).toBeDefined()
    expect(await pane.find({ type: 'Text', text: /cancelado$/ })).toBeDefined()
    await pane.unmount()
  })
}

test('the band counts down, then sends, and the pane lists it with its link', async ($, on) => {
  const { clock, runs } = await world($, on)
  const call = $.tool.call({ tool: 'Bash', command: 'gh pr create --title "Fix login"' })
  await clock.settle()
  expect(runs).toEqual([])
  await clock.advance(5200)
  const ran = await call
  expect(ran.deny).toBeUndefined()
  expect(runs).toEqual(['Bash'])

  const pane = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect((await pane.find({ type: 'Text', text: /GitHub pr create/ }))?.text).toContain('GitHub pr create')
  expect(await pane.find({ type: 'Text', text: /Enviados: 1 · cancelados: 0/ })).toBeDefined()
  expect(await pane.find({ type: 'Link' })).toBeDefined()
  await pane.unmount()

  // Gone from the band once it went.
  const band = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect(await band.find({ type: 'Text', text: /envia em/ })).toBeUndefined()
  await band.unmount()
})

test('Cancel and Send now act on the call they are drawn beside', async ($, on) => {
  const { clock, runs } = await world($, on)
  const first = $.tool.call(EMAIL)
  await clock.settle()
  const band = await $.ui.mount({ ...BAND, surface: 'desktop' })
  const cancel = await band.find({ type: 'Button', text: /^Cancelar$/ })
  expect(cancel).toBeDefined()
  await band.press({ key: String(cancel?.key) })
  await clock.advance(250)
  const ranFirst = await first
  expect(ranFirst.deny).toContain('nothing left this computer')

  const second = $.tool.call({ tool: 'Bash', command: 'git push' })
  await clock.settle()
  const now = await band.find({ type: 'Button', text: /^Enviar já$/ })
  await band.press({ key: String(now?.key) })
  await clock.advance(250)
  const ranSecond = await second
  expect(ranSecond.deny).toBeUndefined()
  expect(runs).toEqual(['Bash'])
  await band.unmount()
})

test('a tool that sends nothing is never held', async ($, on) => {
  const { runs } = await world($, on)
  const ran = await $.tool.call({ tool: 'Bash', command: 'ls -la' })
  expect(ran.deny).toBeUndefined()
  expect(runs).toEqual(['Bash'])
})

test('ask mode: Send sends', { options: { mode: 'ask' } }, async ($, on) => {
  const { runs } = await world($, on, 'Enviar')
  const ran = await $.tool.call(EMAIL)
  expect(ran.deny).toBeUndefined()
  expect(runs).toEqual([EMAIL.tool])
})

test('ask mode: words typed instead of Send reach Claude', { options: { mode: 'ask' } }, async ($, on) => {
  const { runs } = await world($, on, 'Later please')
  const ran = await $.tool.call(EMAIL)
  expect(runs).toEqual([])
  expect(ran.deny).toContain('Later please')
})

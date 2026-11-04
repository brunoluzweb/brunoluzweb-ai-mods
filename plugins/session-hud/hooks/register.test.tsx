import { expect, mock, test } from 'claude-code/testing'

const props = { isWorking: false, hasSurvey: false, maxRows: 6, bodyColumns: 120 } as never

const usage = (now: number) => ({
  startedAt: now - 2 * 3_600_000,
  context: { tokens: 383_000, window: 1_000_000, percent: 38 },
  rateLimits: [
    { kind: 'five_hour', percentUsed: 3, resetsAt: new Date(now + 4 * 3_600_000).toISOString() },
    { kind: 'seven_day', percentUsed: 26, resetsAt: new Date(now + 3 * 86_400_000).toISOString() },
  ],
  cost: { usd: 16.784 },
})

const setup = async ($: any, on: any, surface: 'desktop' | 'terminal', files: Record<string, string> = {}, calls: string[] = []) => {
  const now = Date.now()
  const clock = mock.clock(on, { now })
  on('session.start', async (_$: unknown, e: { cwd: string }) => ({ cwd: e.cwd }) as never)
  on('session.id', async () => ({ value: 'sid' }) as never)
  on('env.get', async () => ({ value: '/Users/test' }) as never)
  on('session.usage', async () => ({ value: usage(now) }) as never)
  on('session.model', async () => ({ value: 'claude-opus-5-5[1m]' }) as never)
  on('command.register', async () => ({ value: undefined }) as never)
  on('command.run', async (_$: unknown, e: { command: string }) => {
    calls.push(`/${e.command}`)
    return { text: '' } as never
  })
  on('process.run', async () => ({ value: { exitCode: 0, stdout: '', stderr: '' } }) as never)
  on('fs.exists', async (_$: unknown, e: { path: string }) => ({ value: e.path in files }) as never)
  on('fs.read', async (_$: unknown, e: { path: string }) => ({ value: files[e.path] ?? '' }) as never)
  on('fs.write', async (_$: unknown, e: { path: string; text: string }) => {
    files[e.path] = e.text
    return { value: undefined } as never
  })
  on('ui.toast', async (_$: unknown, e: { text: string }) => {
    calls.push(`toast: ${e.text}`)
    return { value: undefined } as never
  })
  on('ui.render', { component: 'AbovePrompt' }, async ($$: any, e: any) => {
    const { Text } = $$.ui.resolve(e)
    return <Text>REST</Text>
  })
  await $.session.start({ source: 'startup', cwd: '/Users/test/vault', surface, isInteractive: true } as never)
  return clock
}

for (const surface of ['desktop', 'terminal'] as const) {
  test(`draws the card on the ${surface}`, async ($, on) => {
    await setup($, on, surface)
    const v = await $.ui.mount({ plugin: 'session-hud', surface, component: 'AbovePrompt', props })
    // The desktop draws the readings in one Svg; the terminal writes them as text.
    const tree = surface === 'desktop' ? JSON.stringify(await v.drawn()) : ''
    const shows = async (re: RegExp) => (tree ? re.test(tree) : (await v.find({ text: re })) !== undefined)
    expect(await shows(/383k de 1M tokens/), 'context tokens').toBe(true)
    expect(await shows(/LIMITE DE 5 HORAS|Limite de 5 horas/), '5-hour limit').toBe(true)
    expect(await shows(/repõe dentro de 4 h \d+ min/), 'reset countdown').toBe(true)
    expect(await shows(/LIMITE SEMANAL|Limite semanal/), 'weekly limit').toBe(true)
    expect(await v.find({ text: /API ≈ 16,78 US\$/ }), 'cost').toBeDefined()
    expect(await v.find({ key: 'compact' }), 'Compactar').toBeDefined()
    expect(await v.find({ key: 'handoff' }), 'Chat novo').toBeDefined()
    expect(await v.find({ text: /REST/ }), 'other mods stay above').toBeDefined()
    // The desktop shows the model under the prompt already.
    expect((await v.find({ text: /Opus 5\.5 1M/ })) !== undefined, 'model tile').toBe(surface !== 'desktop')
  })
}

test('Compactar runs /compact', async ($, on) => {
  const calls: string[] = []
  await setup($, on, 'desktop', {}, calls)
  const v = await $.ui.mount({ plugin: 'session-hud', surface: 'desktop', component: 'AbovePrompt', props })
  await v.press({ key: 'compact' })
  expect(calls).toContain('/compact')
})

test('Chat novo asks the handoff mod with a request file', async ($, on) => {
  const files: Record<string, string> = {}
  await setup($, on, 'desktop', files)
  const v = await $.ui.mount({ plugin: 'session-hud', surface: 'desktop', component: 'AbovePrompt', props })
  await v.press({ key: 'handoff' })
  expect(Object.keys(files)).toContain('/Users/test/.claude/handoffs/.request-sid')
})

test('Chat novo says so when the handoff mod is off', async ($, on) => {
  const files: Record<string, string> = { '/Users/test/.claude/mods/switches.json': '{"handoff": false}' }
  const calls: string[] = []
  await setup($, on, 'desktop', files, calls)
  const v = await $.ui.mount({ plugin: 'session-hud', surface: 'desktop', component: 'AbovePrompt', props })
  await v.press({ key: 'handoff' })
  expect(Object.keys(files)).not.toContain('/Users/test/.claude/handoffs/.request-sid')
  expect(calls.some(c => c.includes('Handoff está desligado'))).toBe(true)
})

test('Esconder hides the card in every chat, /hud shows it again', async ($, on) => {
  const files: Record<string, string> = {}
  await setup($, on, 'desktop', files)
  let v = await $.ui.mount({ plugin: 'session-hud', surface: 'desktop', component: 'AbovePrompt', props })
  await v.press({ key: 'hide' })
  expect(files['/Users/test/.claude/mods/switches.json']).toContain('"session-hud:hidden": true')
  v = await $.ui.mount({ plugin: 'session-hud', surface: 'desktop', component: 'AbovePrompt', props })
  expect(await v.find({ key: 'compact' }), 'hidden').toBeUndefined()

  await $.command.run({ command: 'hud', args: '' } as never)
  v = await $.ui.mount({ plugin: 'session-hud', surface: 'desktop', component: 'AbovePrompt', props })
  expect(await v.find({ key: 'compact' }), 'shown again').toBeDefined()
})

test('the /mods switch turns the card off', async ($, on) => {
  const files: Record<string, string> = { '/Users/test/.claude/mods/switches.json': '{"session-hud": false}' }
  await setup($, on, 'desktop', files)
  const v = await $.ui.mount({ plugin: 'session-hud', surface: 'desktop', component: 'AbovePrompt', props })
  expect(await v.find({ key: 'compact' })).toBeUndefined()
})

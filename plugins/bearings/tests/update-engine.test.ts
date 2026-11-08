import { describe, expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

const NOW = Date.parse('2026-10-05T10:00:00.000Z')
const CWD = '/work/repo'
const FOLDER = '/home/me/.claude/projects/-work-repo/bearings'
const LOG_PATH = `${FOLDER}/session-under-test.failures.log`
const USAGE = { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }
const PANE_PROPS = {
  title: 'pane', isFocused: false, bodyColumns: 100, placement: 'dock' as const, scroll: { offset: 0, bodyRows: 60 }, view: {},
}

/**
 * A session at CWD with HOME set: an empty bearings folder, every model call recorded and
 * answered with `replies` in order, every file write recorded, the store in memory.
 */
function world(on: On, replies: string[], initialStore: Record<string, unknown> = {}) {
  const store = new Map(Object.entries(initialStore))
  const calls: { prompt: string; maxTokens: number | undefined }[] = []
  const written: { path: string; text: string }[] = []

  mock.env(on, { HOME: '/home/me' })
  on('store.get', ($, e) => ({ value: store.get(e.key) }))
  on('store.set', ($, e) => {
    store.set(e.key, e.value)
    return { value: undefined }
  })
  const clock = mock.clock(on, { now: NOW })
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('session.id', () => ({ value: 'session-under-test' }))
  const folders = { root: CWD, cwd: CWD }
  on('session.cwd', () => ({ value: folders.cwd }))
  on('session.root', () => ({ value: folders.root }))
  on('ui.open', () => ({ value: { isPlaced: true } as never }))
  on('session.usage', () => ({ value: { startedAt: NOW } }) as never)
  on('session.surfaces', () => ({ value: ['terminal'] as never }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('tool.register', ($, e) => ({ value: { tool: `mcp__bearings__${e.name}` } }))
  on('fs.list', ($, e) => {
    throw new Error(`ENOENT ${e.path}`)
  })
  on('fs.exists', () => ({ value: false }))
  on('fs.write', ($, e) => {
    written.push({ path: e.path, text: e.text as string })
    return { value: undefined }
  })
  on('process.run', () => ({ value: { exitCode: 128, stdout: '', stderr: 'no git', isStdoutTruncated: false, isStderrTruncated: false } }))
  on('model.complete', ($, e) => {
    calls.push({ prompt: e.prompt, maxTokens: e.maxTokens })
    return { value: { isAnswered: true, text: replies[calls.length - 1] ?? '{}', usage: USAGE } }
  })
  on('ui.log', () => ({ value: undefined }))
  on('turn.start', ($, e) => ({ turnId: e.turnId }))
  on('turn.complete', ($, e) => ({ text: e.answer }))
  return { calls, written, clock, store, folders }
}

/** Starts the session the way a desktop spare may: in a neutral folder, assigned to the project afterwards. */
async function startInSpareThenAssign($: Engine, folders: { root: string }) {
  folders.root = '/spare'
  await $.session.start({ cwd: '/spare', surface: null, isInteractive: true })
  folders.root = CWD
}

async function finishTurn($: Engine, turnId: string, prompt: string, answer: string) {
  await $.turn.start({ text: prompt, turnId })
  await $.turn.complete({ answer, durationMs: 1, isAborted: false, turnId, reason: 'answer' })
}

describe('the background update', () => {
  test('asks for up to 8000 tokens, and a failed reply is logged with its turn beside the session file', async ($, on) => {
    const { calls, written, clock } = world(on, ['Sure, here it comes: {"glossary": '])
    await finishTurn($, 't1', 'what is FMA?', 'the failure mechanism analyzer')
    await clock.settle()

    expect(calls.map(call => call.maxTokens)).toEqual([8000])
    const log = written.filter(one => one.path === LOG_PATH)
    expect(log.length).toBe(1)
    expect(log[0]?.text).toMatch(/^2026-10-05T10:00:00\.000Z T1 update failed: the reply holds no JSON object out=5 excerpt: Sure, here it comes: \{"glossary":\n$/)
  })

  test('the pane says how long ago "In progress" last changed', async ($, on) => {
    const { clock } = world(on, ['{"bearings":{"inProgress":["writing tests"]}}', '{"bearings":{"inProgress":["writing tests"]}}'])
    await finishTurn($, 't1', 'start the tests', 'started')
    await clock.settle()
    await finishTurn($, 't2', 'go on', 'still on it')
    await clock.settle()

    const pane = await $.ui.mount({ plugin: 'bearings', surface: 'terminal', component: 'Pane', requestId: 'bearings-map', props: PANE_PROPS })
    const markdown = await pane.find({ type: 'Markdown' })
    expect(markdown?.text).toContain('## In progress (changed 1 turn ago)\n- writing tests')
  })
})

test('a subagent starting during a main turn does not replace the main prompt', async ($, on) => {
  const { calls, clock } = world(on, ['{}'])

  await $.turn.start({ text: 'the main prompt', turnId: 'main-turn' })
  await $.turn.start({ text: 'the agent prompt', turnId: 'agent-turn', agentId: 'agent-1' })
  await $.turn.complete({ answer: 'done', durationMs: 1, isAborted: false, turnId: 'main-turn', reason: 'answer' })
  await clock.settle()

  expect(calls[0]?.prompt).toContain('the main prompt')
  expect(calls[0]?.prompt).not.toContain('the agent prompt')
})

describe('known terms', () => {
  test('a known term is hidden from the glossary pane with a count line, stored per folder, and shown again on unknown', async ($, on) => {
    const { store } = world(on, [])
    await $.tool.call({ tool: 'mcp__bearings__add', term: 'S4', meaning: 'stage four' })
    await $.tool.call({ tool: 'mcp__bearings__add', term: 'VM', meaning: 'virtual machine' })

    const marked = await $.tool.call({ tool: 'mcp__bearings__add', known: 'vm' })
    expect(marked.result).toBe('Marked "vm" as known: hidden from the glossary pane.')
    expect(store.get('known-terms:/work/repo')).toEqual(['vm'])

    const pane = await $.ui.mount({ plugin: 'bearings', surface: 'terminal', component: 'Pane', requestId: 'bearings-glossary', props: PANE_PROPS })
    expect((await pane.find({ type: 'Markdown' }))?.text).toBe('- **S4**: stage four (T0)')
    expect(await pane.find({ type: 'Text', text: '1 known term hidden (unknown: <term> shows it)' })).toBeDefined()

    await $.tool.call({ tool: 'mcp__bearings__add', unknown: 'VM' })
    expect((await pane.find({ type: 'Markdown' }))?.text).toBe('- **S4**: stage four (T0)\n- **VM**: virtual machine (T0)')
    expect(store.get('known-terms:/work/repo')).toEqual([])
  })

  test('a session start loads the folder\'s known terms from the store', async ($, on) => {
    world(on, [], { 'known-terms:/work/repo': ['VM'] })
    await $.session.start({ cwd: CWD, surface: 'terminal', isInteractive: true })
    await $.tool.call({ tool: 'mcp__bearings__add', term: 'VM', meaning: 'virtual machine' })

    const pane = await $.ui.mount({ plugin: 'bearings', surface: 'terminal', component: 'Pane', requestId: 'bearings-glossary', props: PANE_PROPS })
    expect(await pane.find({ type: 'Text', text: '1 known term hidden (unknown: <term> shows it)' })).toBeDefined()
  })

  test('a session started in a spare folder loads the real folder at its first turn and keeps its known terms', async ($, on) => {
    const { store, folders } = world(on, [], { 'known-terms:/work/repo': ['VM'] })
    await startInSpareThenAssign($, folders)

    await $.turn.start({ text: 'first prompt', turnId: 'turn-1' })
    await $.tool.call({ tool: 'mcp__bearings__add', known: 'GPU' })

    expect(store.get('known-terms:/work/repo')).toEqual(['VM', 'GPU'])
  })

  test('a line typed into a pane before the first turn loads the real folder first', async ($, on) => {
    const { store, folders } = world(on, [], { 'known-terms:/work/repo': ['VM'] })
    await startInSpareThenAssign($, folders)

    const pane = await $.ui.mount({ plugin: 'bearings', surface: 'desktop', component: 'Pane', requestId: 'bearings-map', props: PANE_PROPS })
    await pane.input({ key: 'btw-input', text: 'known: GPU' })

    expect(store.get('known-terms:/work/repo')).toEqual(['VM', 'GPU'])
  })

  test('/bearings scan before the first turn loads the real folder first', async ($, on) => {
    const { store, folders, clock } = world(on, [], { 'known-terms:/work/repo': ['VM'] })
    await startInSpareThenAssign($, folders)

    await $.command.run({ command: 'bearings', args: 'scan', origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 120 } })
    await clock.settle()
    await $.tool.call({ tool: 'mcp__bearings__add', known: 'GPU' })

    expect(store.get('known-terms:/work/repo')).toEqual(['VM', 'GPU'])
  })

  test('a subagent turn does not restart the folder', async ($, on) => {
    const { store, folders } = world(on, [], { 'known-terms:/work/repo': ['VM'] })
    await $.session.start({ cwd: CWD, surface: 'terminal', isInteractive: true })

    folders.root = '/worktree/agent'
    await $.turn.start({ text: 'agent prompt', turnId: 'agent-turn', agentId: 'agent-1' })
    folders.root = CWD
    await $.tool.call({ tool: 'mcp__bearings__add', known: 'GPU' })

    expect(store.get('known-terms:/work/repo')).toEqual(['VM', 'GPU'])
  })

  test('a shell cd does not restart the folder', async ($, on) => {
    const { store, folders } = world(on, [], { 'known-terms:/work/repo': ['VM'] })
    await $.session.start({ cwd: CWD, surface: 'terminal', isInteractive: true })

    folders.cwd = '/work/repo/sub'
    await $.turn.start({ text: 'next prompt', turnId: 'turn-2' })
    await $.tool.call({ tool: 'mcp__bearings__add', known: 'GPU' })

    expect(store.get('known-terms:/work/repo/sub')).toEqual(['VM', 'GPU'])
  })
})

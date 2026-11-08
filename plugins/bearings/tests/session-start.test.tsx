import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

import { emptyBearings } from '../hooks/merge'
import { emptyStats } from '../hooks/update'

const NOW = Date.parse('2026-10-03T12:00:00.000Z')
const HOUR = 60 * 60 * 1000
const FOLDER = '/home/me/.claude/projects/-work-repo/bearings'
const OWN_ID = 'own-session-id'

function otherSessionFile(sessionId: string, hoursAgo: number, goal: string) {
  return {
    sessionId, cwd: '/work/repo', startedAt: '', lastTouched: new Date(NOW - hoursAgo * HOUR).toISOString(), goal,
    turn: 2, glossary: [{ term: 'S4', meaning: `meaning from ${goal}`, firstTurn: 1, lastSeenTurn: 1, pin: 'none', source: 'auto' }],
    bearings: { ...emptyBearings(), goal }, btw: [], stats: emptyStats(),
  }
}

/**
 * The world beneath the plugin for an interactive start: HOME, the session's id and cwd,
 * a bearings folder holding `files`, and a record of every file written and line logged.
 */
function interactiveWorld(on: On, files: Record<string, unknown>) {
  const written: { path: string; text: string }[] = []

  mock.env(on, { HOME: '/home/me' })
  mock.clock(on, { now: NOW })
  mock.store(on)
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('session.id', () => ({ value: OWN_ID }))
  on('session.cwd', () => ({ value: '/work/repo' }))
  on('session.root', () => ({ value: '/work/repo' }))
  on('session.usage', () => ({ value: { startedAt: NOW - HOUR } }) as never)
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('tool.register', ($, e) => ({ value: { tool: `mcp__bearings__${e.name}` } }))
  on('fs.list', () => ({
    value: Object.keys(files).map(name => ({ name, kind: 'file' as const, size: 1, mtimeMs: NOW - HOUR, isLink: false })),
  }))
  on('fs.read', ($, e) => ({ value: JSON.stringify(files[e.path.slice(FOLDER.length + 1)]) }))
  on('fs.write', ($, e) => {
    written.push({ path: e.path, text: e.text })
    return { value: undefined }
  })
  on('session.surfaces', () => ({ value: ['terminal'] as never }))
  // Transcript lines only; the start's debug line is checked in participation.test.tsx.
  const logs: string[] = []
  on('ui.log', ($, e) => {
    if (e.to !== 'debug') logs.push(e.text)
    return { value: undefined }
  })
  const appended: unknown[] = []
  on('session.append', ($, e, next) => {
    appended.push(e.message)
    return next(e)
  })
  return { written, logs, appended }
}

test('cold start with no other session active in the last 48 h appends nothing', async ($, on) => {
  const { logs, appended } = interactiveWorld(on, { 'stale.json': otherSessionFile('stale-session', 49, 'old work') })

  await $.session.start({ cwd: '/work/repo', surface: 'terminal', isInteractive: true })

  expect(appended).toEqual([])
  expect(logs).toEqual([])
})

test('cold start with another active session appends a row', async ($, on) => {
  const { logs, appended } = interactiveWorld(on, {
    'other.json': otherSessionFile('other-session', 2, 'fix the dashboard'),
    'stale.json': otherSessionFile('stale-session', 49, 'old work'),
  })

  await $.session.start({ cwd: '/work/repo', surface: 'terminal', isInteractive: true })

  expect(appended.length).toBe(1)
  expect(JSON.stringify(appended[0])).toContain('fix the dashboard')
  expect(JSON.stringify(appended[0])).not.toContain('old work')
  expect(logs).toEqual([])
})

test('every session file carries the signature', async ($, on) => {
  const { written } = interactiveWorld(on, {})
  await $.session.start({ cwd: '/work/repo', surface: 'terminal', isInteractive: true })

  await $.tool.call({ tool: 'mcp__bearings__add', term: 'S4', meaning: 'stage four' })

  const json = written.find(one => one.path === `${FOLDER}/${OWN_ID}.json`)
  expect(json).toBeDefined()
  const saved = JSON.parse(json?.text ?? '{}')
  expect({ sessionId: saved.sessionId, cwd: saved.cwd, startedAt: saved.startedAt, lastTouched: saved.lastTouched, goal: saved.goal }).toEqual({
    sessionId: OWN_ID,
    cwd: '/work/repo',
    startedAt: new Date(NOW - HOUR).toISOString(),
    lastTouched: new Date(NOW).toISOString(),
    goal: '',
  })
})

test('a non-interactive session registers nothing, reads no files and draws no band', async ($, on) => {
  const calls: string[] = []
  // The gate reads the entrypoint and the surfaces; neither names the VS Code panel here.
  mock.env(on, { CLAUDE_CODE_ENTRYPOINT: 'sdk-ts' })
  on('session.surfaces', () => ({ value: [] as never }))
  on('ui.log', () => ({ value: undefined }))
  for (const event of ['command.register', 'tool.register', 'fs.list', 'fs.write', 'store.get', 'session.append'] as const) {
    on(event, () => {
      calls.push(event)
      throw new Error(`${event} must not be called`)
    })
  }
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('ui.render', { component: 'AbovePrompt' }, ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text key="engine-band">engine band</Text>
  })

  await $.session.start({ cwd: '/work/repo', surface: null, isInteractive: false })
  expect(calls).toEqual([])

  const band = await $.ui.mount({
    plugin: 'bearings', surface: 'terminal', component: 'AbovePrompt',
    props: { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: 100, scroll: { offset: 0, bodyRows: 10 }, view: {} },
  })
  expect(await band.find({ key: 'open-glossary' })).toBeUndefined()
  expect(await band.find({ text: 'engine band' })).toBeDefined()
})

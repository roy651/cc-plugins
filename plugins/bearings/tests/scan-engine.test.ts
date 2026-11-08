import { describe, expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

import { emptyBearings } from '../hooks/merge'
import { emptyStats } from '../hooks/update'

const NOW = Date.parse('2026-10-04T12:00:00.000Z')
const CWD = '/work/repo'
const FOLDER = '/home/me/.claude/projects/-work-repo/bearings'
const MD_PATH = `${FOLDER}/session-under-test.md`
const USAGE = { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }
const PANE_PROPS = {
  title: 'pane', isFocused: false, bodyColumns: 100, placement: 'dock' as const, scroll: { offset: 0, bodyRows: 60 }, view: {},
}

const SCAN_REPLY = JSON.stringify({
  glossary: { upsert: [{ term: 'ReTraj', meaning: 'the re-ranking stage' }] },
  bearings: { goal: 'ship the plugin', inProgress: ['tests'], factsAdd: ['marketplace is cc-plugins'] },
})
const LEAN_REBUILD = JSON.stringify({ glossary: { upsert: [{ term: 'T', meaning: 'm' }] } })
const FULL_REBUILD = JSON.stringify({ bearings: { goal: 'g', inProgress: ['a', 'b', 'c'] } })

interface WorldOptions {
  /** Files of the repo, relative to its root. A file not listed is missing. */
  repoFiles?: Record<string, string>
  isGitRepo?: boolean
  surfaces?: string[]
  /** Other sessions' files in the bearings folder. */
  sessionFiles?: Record<string, unknown>
  transcript?: string[]
  rebuildReply?: string
}

/**
 * The world beneath the plugin: a repo at CWD, git answering or failing, a bearings folder,
 * and a record of every model call (scan or rebuild, told apart by the prompt), process run and log line.
 */
function world(on: On, options: WorldOptions = {}) {
  const repoFiles = options.repoFiles ?? {}
  const sessionFiles = options.sessionFiles ?? {}
  const scanPrompts: string[] = []
  const rebuildPrompts: string[] = []
  const events: string[] = []

  mock.env(on, { HOME: '/home/me' })
  mock.store(on)
  const clock = mock.clock(on, { now: NOW })
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('session.id', () => ({ value: 'session-under-test' }))
  on('session.cwd', () => ({ value: CWD }))
  on('session.root', () => ({ value: CWD }))
  on('session.usage', () => ({ value: { startedAt: NOW } }) as never)
  on('session.surfaces', () => ({ value: (options.surfaces ?? ['terminal']) as never }))
  on('session.messages', () => ({ value: (options.transcript ?? []).map(text => ({ role: 'user', text, toolUses: [] })) as never }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('tool.register', ($, e) => ({ value: { tool: `mcp__bearings__${e.name}` } }))
  on('fs.list', ($, e) => {
    const names = e.path === FOLDER ? Object.keys(sessionFiles) : e.path === CWD ? [...Object.keys(repoFiles).filter(name => !name.includes('/')), 'src'] : []
    if (names.length === 0) throw new Error(`ENOENT ${e.path}`)
    return { value: names.map(name => ({ name, kind: name === 'src' ? 'dir' as const : 'file' as const, size: 1, mtimeMs: NOW, isLink: false })) }
  })
  on('fs.read', ($, e) => {
    if (e.path.startsWith(`${FOLDER}/`)) return { value: JSON.stringify(sessionFiles[e.path.slice(FOLDER.length + 1)]) }
    const text = repoFiles[e.path.slice(CWD.length + 1)]
    if (text === undefined) throw new Error(`ENOENT ${e.path}`)
    return { value: text }
  })
  on('fs.write', () => ({ value: undefined }))
  on('fs.exists', () => ({ value: true }))
  on('process.run', ($, e) => {
    events.push(`run ${e.argv.join(' ')}`)
    const isGit = e.argv[0] === 'git'
    const fails = isGit && options.isGitRepo === false
    const stdout = !isGit ? '' : e.argv[1] === 'log' ? 'abc123 Add the scan' : ' M hooks/register.tsx'
    return { value: { exitCode: fails ? 128 : 0, stdout: fails ? '' : stdout, stderr: fails ? 'not a git repository' : '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('model.complete', ($, e) => {
    const isScan = e.prompt.includes('<repo>')
    ;(isScan ? scanPrompts : rebuildPrompts).push(e.prompt)
    events.push(isScan ? 'scan call' : 'rebuild call')
    const text = isScan ? SCAN_REPLY : options.rebuildReply ?? FULL_REBUILD
    return { value: { isAnswered: true, text, usage: USAGE } }
  })
  on('ui.log', ($, e) => {
    if (e.to !== 'debug') events.push(`log ${e.text}`)
    return { value: undefined }
  })
  on('ui.open', () => ({ value: { isPlaced: true } as never }))
  on('session.append', ($, e, next) => {
    events.push('append')
    return next(e)
  })
  return { scanPrompts, rebuildPrompts, events, clock }
}

function sourceNames(prompt: string | undefined): string[] {
  return [...(prompt ?? '').matchAll(/<source name="([^"]+)"/g)].map(found => found[1]!)
}

function typedBearings(args: string) {
  return { command: 'bearings', args, origin: { kind: 'composer' as const }, presentation: { isFullscreen: true, columns: 120 } }
}

const ALL_FILES = {
  '.claude/handoff.md': 'handoff notes', 'CLAUDE.md': 'instructions', 'AGENTS.md': 'agents', 'README.md': 'readme',
}

describe('what a scan reads', () => {
  test('every source, in order: handoff, CLAUDE.md, AGENTS.md, README, git log, git status, the file list', async ($, on) => {
    const { scanPrompts, clock } = world(on, { repoFiles: ALL_FILES })
    await $.command.run(typedBearings('scan'))
    await clock.settle()

    expect(sourceNames(scanPrompts[0])).toEqual([
      '.claude/handoff.md', 'CLAUDE.md', 'AGENTS.md', 'README.md', 'git log --oneline -15', 'git status --short', 'top-level files',
    ])
    expect(scanPrompts[0]).toContain('abc123 Add the scan')
  })

  test('missing files and a folder that is not a git repo are skipped without a word', async ($, on) => {
    const { scanPrompts, events, clock } = world(on, { repoFiles: { 'CLAUDE.md': 'instructions', 'README.rst': 'readme' }, isGitRepo: false })
    await $.command.run(typedBearings('scan'))
    await clock.settle()

    expect(sourceNames(scanPrompts[0])).toEqual(['CLAUDE.md', 'README.rst', 'top-level files'])
    expect(events.filter(event => event.startsWith('log'))).toEqual([])
  })

  test('large files are cut to the 30,000-character budget and marked cut', async ($, on) => {
    const { scanPrompts, clock } = world(on, { repoFiles: { 'CLAUDE.md': 'c'.repeat(40_000), 'README.md': 'r'.repeat(40_000) } })
    await $.command.run(typedBearings('scan'))
    await clock.settle()

    const contents = [...(scanPrompts[0] ?? '').matchAll(/<source name="[^"]+"[^>]*>\n([\s\S]*?)\n<\/source>/g)].map(found => found[1]!)
    expect(contents.reduce((sum, text) => sum + text.length, 0)).toBeLessThanOrEqual(30_000)
    expect(scanPrompts[0]).toContain('<source name="CLAUDE.md" cut="true">')
  })

  test('the scan\'s items show in the pane marked "(from repo)"', async ($, on) => {
    const { clock } = world(on, { repoFiles: ALL_FILES })
    await $.command.run(typedBearings('scan'))
    await clock.settle()

    const pane = await $.ui.mount({ plugin: 'bearings', surface: 'terminal', component: 'Pane', requestId: 'bearings-map', props: PANE_PROPS })
    expect(await pane.find({ type: 'Markdown', text: '## Goal (changed this turn)\nship the plugin (from repo)' })).toBeDefined()
  })
})

describe('when a scan runs', () => {
  test('trigger 1: a cold start with nothing inherited scans once', async ($, on) => {
    const { scanPrompts, clock } = world(on, { repoFiles: ALL_FILES })
    await $.session.start({ cwd: CWD, surface: 'terminal', isInteractive: true })
    await clock.settle()
    expect(scanPrompts.length).toBe(1)
  })

  test('trigger 1 does not fire when the cold start inherited another session', async ($, on) => {
    const other = {
      sessionId: 'other-session', cwd: CWD, startedAt: '', lastTouched: new Date(NOW - 3_600_000).toISOString(), goal: 'other work',
      turn: 2, glossary: [], bearings: { ...emptyBearings(), goal: 'other work' }, btw: [], stats: emptyStats(),
    }
    const { scanPrompts, events, clock } = world(on, { repoFiles: ALL_FILES, sessionFiles: { 'other-session.json': other } })
    await $.session.start({ cwd: CWD, surface: 'terminal', isInteractive: true })
    await clock.settle()

    expect(scanPrompts.length).toBe(0)
    // The inherited row was appended, so the cold start got past the trigger.
    expect(events).toContain('append')
  })

  test('trigger 2: a lean rebuild is followed by one scan', async ($, on) => {
    const lean = world(on, { repoFiles: ALL_FILES, transcript: ['we discussed something'], rebuildReply: LEAN_REBUILD })
    const pane = await $.ui.mount({ plugin: 'bearings', surface: 'terminal', component: 'Pane', requestId: 'bearings-map', props: PANE_PROPS })
    await pane.press({ key: 'rebuild' })
    expect(lean.events.filter(event => event.endsWith('call'))).toEqual(['rebuild call', 'scan call'])
  })

  test('trigger 2 does not fire after a full rebuild', async ($, on) => {
    const full = world(on, { repoFiles: ALL_FILES, transcript: ['we discussed something'], rebuildReply: FULL_REBUILD })
    const pane = await $.ui.mount({ plugin: 'bearings', surface: 'terminal', component: 'Pane', requestId: 'bearings-map', props: PANE_PROPS })
    await pane.press({ key: 'rebuild' })
    expect(full.events.filter(event => event.endsWith('call'))).toEqual(['rebuild call'])
  })

  test('a transcript of only slash-command rows makes no rebuild call and one scan call', async ($, on) => {
    const { rebuildPrompts, scanPrompts, clock } = world(on, {
      repoFiles: ALL_FILES,
      transcript: ['<local-command-caveat>The command below was run directly.</local-command-caveat>', '<command-name>/bearings</command-name><command-args>rebuild</command-args>'],
    })
    await $.command.run(typedBearings('rebuild'))
    await clock.settle()
    expect(rebuildPrompts.length).toBe(0)
    expect(scanPrompts.length).toBe(1)
  })

  test('/bearings scan in the VS Code panel logs its start and end, then opens the .md', async ($, on) => {
    const { events, clock } = world(on, { repoFiles: ALL_FILES, surfaces: ['vscode'] })
    const result = await $.command.run(typedBearings('scan'))
    await clock.settle()

    expect(result.text).toBeUndefined()
    expect(events.filter(event => !event.startsWith('run git'))).toEqual([
      'log scanning the repo for bearings',
      'scan call',
      'log scanned 7 sources from the repo',
      `run code ${MD_PATH}`,
      `log opened ${MD_PATH} in VS Code`,
    ])
  })
})

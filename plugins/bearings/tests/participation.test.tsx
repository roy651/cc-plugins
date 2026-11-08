import { describe, expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

import { participationAtStart } from '../hooks/participation'

const BAND_PROPS = { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: 100, scroll: { offset: 0, bodyRows: 10 }, view: {} }

/** A non-interactive start: records the commands registered and the debug lines; no HOME, so no files. */
function sdkWorld(on: On, entrypoint: string, extraEnv: Record<string, string> = {}) {
  const commands: string[] = []
  const debugLines: string[] = []

  mock.env(on, { CLAUDE_CODE_ENTRYPOINT: entrypoint, ...extraEnv })
  mock.store(on)
  mock.clock(on, { now: Date.parse('2026-10-04T09:00:00.000Z') })
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('session.attach', ($, e) => ({ clientId: e.clientId }))
  on('session.id', () => ({ value: 'panel-session' }))
  on('session.cwd', () => ({ value: '/work/repo' }))
  on('session.root', () => ({ value: '/work/repo' }))
  on('session.surfaces', () => ({ value: [] as never }))
  on('command.register', ($, e) => {
    commands.push(e.name)
    return { value: { command: e.name } }
  })
  on('tool.register', ($, e) => ({ value: { tool: `mcp__bearings__${e.name}` } }))
  on('ui.log', ($, e) => {
    if (e.to === 'debug') debugLines.push(e.text)
    return { value: undefined }
  })
  on('ui.render', { component: 'AbovePrompt' }, ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>engine band</Text>
  })
  return { commands, debugLines }
}

const SDK_START = { cwd: '/work/repo', surface: null, isInteractive: false }

describe('participation at start', () => {
  test('the decision: interactive is active, the VS Code panel by entrypoint or surface is panel, the rest off', () => {
    expect(participationAtStart({ isInteractive: true, entrypoint: 'cli', surfaces: ['terminal'] })).toBe('active')
    expect(participationAtStart({ isInteractive: false, entrypoint: 'claude-vscode', surfaces: [] })).toBe('panel')
    expect(participationAtStart({ isInteractive: false, entrypoint: undefined, surfaces: ['vscode'] })).toBe('panel')
    expect(participationAtStart({ isInteractive: false, entrypoint: 'sdk-ts', surfaces: [] })).toBe('off')
  })

  test('the decision for Desktop: its own session is active, a run from its shell is off', () => {
    expect(participationAtStart({ isInteractive: false, entrypoint: 'claude-desktop', surfaces: [] })).toBe('active')
    expect(participationAtStart({ isInteractive: false, entrypoint: 'claude-desktop', surfaces: [], isChildSession: true })).toBe('off')
  })

  test('a non-interactive start with the Desktop entrypoint takes part: commands registered, band drawn', async ($, on) => {
    const { commands, debugLines } = sdkWorld(on, 'claude-desktop')

    await $.session.start(SDK_START)

    expect(commands).toEqual(['glossary', 'bearings'])
    expect(debugLines).toEqual([
      'session start: isInteractive=false surface=null surfaces=[] entrypoint=claude-desktop participation=active',
    ])
    const band = await $.ui.mount({ plugin: 'bearings', surface: 'desktop', component: 'AbovePrompt', props: BAND_PROPS })
    expect(await band.find({ key: 'open-glossary' })).toBeDefined()
  })

  test('a claude -p run from a Desktop shell stays off', async ($, on) => {
    const { commands, debugLines } = sdkWorld(on, 'claude-desktop', { CLAUDE_CODE_CHILD_SESSION: '1' })

    await $.session.start(SDK_START)

    expect(commands).toEqual([])
    expect(debugLines[0]).toContain('participation=off')
  })

  test('a non-interactive start with the VS Code entrypoint takes part: commands registered, no band', async ($, on) => {
    const { commands, debugLines } = sdkWorld(on, 'claude-vscode')

    await $.session.start(SDK_START)

    expect(commands).toEqual(['glossary', 'bearings'])
    expect(debugLines).toEqual([
      'session start: isInteractive=false surface=null surfaces=[] entrypoint=claude-vscode participation=panel',
    ])
    const band = await $.ui.mount({ plugin: 'bearings', surface: 'terminal', component: 'AbovePrompt', props: BAND_PROPS })
    expect(await band.find({ key: 'open-glossary' })).toBeUndefined()
    expect(await band.find({ text: 'engine band' })).toBeDefined()
  })

  test('a session that starts off switches on when VS Code attaches', async ($, on) => {
    const { commands, debugLines } = sdkWorld(on, 'sdk-ts')

    await $.session.start(SDK_START)
    expect(commands).toEqual([])
    expect(debugLines[0]).toContain('participation=off')

    await $.session.attach({ surface: 'mobile', clientId: 'mobile:default' })
    expect(commands).toEqual([])

    await $.session.attach({ surface: 'vscode', clientId: 'vscode:default' })
    expect(commands).toEqual(['glossary', 'bearings'])
    expect(debugLines[1]).toBe('VS Code attached: participation=panel')
  })
})

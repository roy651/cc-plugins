import { describe, expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

import type { Bearings, StoredFact } from '../types'
import { CURATOR_EVERY, CURATOR_MIN_POOL, CURATOR_SYSTEM, EARLIER_SHOWN, HOLD_LIMIT, RECENT_LIMIT } from '../hooks/facts'
import { emptyBearings } from '../hooks/merge'
import { RANKING_UPDATE_SYSTEM, UPDATE_SYSTEM } from '../hooks/prompts'
import { emptyStats } from '../hooks/update'

const NOW = Date.parse('2026-10-05T10:00:00.000Z')
const CWD = '/work/repo'
const FOLDER = '/home/me/.claude/projects/-work-repo/bearings'
const SESSION_ID = 'session-under-test'
const JSON_PATH = `${FOLDER}/${SESSION_ID}.json`
const MD_PATH = `${FOLDER}/${SESSION_ID}.md`
const LOG_PATH = `${FOLDER}/${SESSION_ID}.failures.log`
const USAGE = { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }
const PANE_PROPS = {
  title: 'pane', isFocused: false, bodyColumns: 100, placement: 'dock' as const, scroll: { offset: 0, bodyRows: 60 }, view: {},
}

interface ModelCall {
  model: string | undefined
  system: string | undefined
  prompt: string
  effort: string | undefined
}

/** A session with HOME set: model calls answered with `replies` in order, files recorded, `files` readable in the bearings folder. */
function world(on: On, replies: string[], files: Record<string, unknown> = {}, isCuratorRefused = false) {
  const calls: ModelCall[] = []
  const written: { path: string; text: string }[] = []
  const appended: string[] = []

  mock.env(on, { HOME: '/home/me' })
  mock.store(on)
  const clock = mock.clock(on, { now: NOW })
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('session.id', () => ({ value: SESSION_ID }))
  on('session.cwd', () => ({ value: CWD }))
  on('session.root', () => ({ value: CWD }))
  on('ui.open', () => ({ value: { isPlaced: true } as never }))
  on('session.usage', () => ({ value: { startedAt: NOW } }) as never)
  on('session.surfaces', () => ({ value: ['terminal'] as never }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('tool.register', ($, e) => ({ value: { tool: `mcp__bearings__${e.name}` } }))
  on('fs.list', () => ({ value: Object.keys(files).map(name => ({ name, kind: 'file' as const, size: 1, mtimeMs: NOW, isLink: false })) }))
  on('fs.read', ($, e) => ({ value: JSON.stringify(files[e.path.slice(FOLDER.length + 1)]) }))
  on('fs.exists', () => ({ value: false }))
  on('fs.write', ($, e) => {
    written.push({ path: e.path, text: e.text as string })
    return { value: undefined }
  })
  on('model.complete', ($, e) => {
    calls.push({ model: e.model, system: e.system, prompt: e.prompt, effort: e.effort })
    if (isCuratorRefused && e.system === CURATOR_SYSTEM) throw new Error('the engine refused the model name')
    return { value: { isAnswered: true, text: replies[calls.length - 1] ?? '{}', usage: USAGE } }
  })
  on('ui.log', () => ({ value: undefined }))
  on('session.append', ($, e, next) => {
    appended.push(JSON.stringify(e.message))
    return next(e)
  })
  on('turn.start', ($, e) => ({ turnId: e.turnId }))
  on('turn.complete', ($, e) => ({ text: e.answer }))
  return { calls, written, clock, appended }
}

async function finishTurn($: Engine, turnId: string, prompt = 'next step', answer = 'done') {
  await $.turn.start({ text: prompt, turnId })
  await $.turn.complete({ answer, durationMs: 1, isAborted: false, turnId, reason: 'answer' })
}

function lastSaved(written: { path: string; text: string }[]): Bearings {
  const saves = written.filter(one => one.path === JSON_PATH)
  return (JSON.parse(saves[saves.length - 1]!.text) as { bearings: Bearings }).bearings
}

function lastMarkdown(written: { path: string; text: string }[]): string {
  return written.filter(one => one.path === MD_PATH).at(-1)!.text
}

function factTexts(count: number, firstNumber = 1): string[] {
  return Array.from({ length: count }, (_, index) => `plain words number ${firstNumber + index} here`)
}

function addFactsReply(texts: string[], importance = 1): string {
  return JSON.stringify({ bearings: { inProgress: ['working'], factsAdd: texts.map(text => ({ text, importance })) } })
}

function mountBearings($: Engine) {
  return $.ui.mount({ plugin: 'bearings', surface: 'terminal', component: 'Pane', requestId: 'bearings-map', props: PANE_PROPS })
}

describe('when the curator runs', () => {
  test('it runs after the update once the pool has the minimum, on the curator model', { options: { curatorModel: 'opus' } }, async ($, on) => {
    const { calls, clock, written } = world(on, [addFactsReply(factTexts(CURATOR_MIN_POOL)), '{}'])
    await finishTurn($, 't1')
    await clock.settle()

    expect(calls.map(call => call.system)).toEqual([UPDATE_SYSTEM, CURATOR_SYSTEM])
    expect(calls[1]?.model).toBe('opus')
    expect(calls[1]?.prompt).toContain('f1 (1, 0, 0): plain words number 1 here')
    expect(calls[1]?.prompt).toContain('In progress:\n- working')
    expect(lastSaved(written).lastCuratedTurn).toBe(1)
  })

  test('its default model is sonnet, and both calls run at medium effort', async ($, on) => {
    const { calls, clock } = world(on, [addFactsReply(factTexts(CURATOR_MIN_POOL)), '{}'])
    await finishTurn($, 't1')
    await clock.settle()
    expect(calls[1]?.model).toBe('sonnet')
    expect(calls.map(call => call.effort)).toEqual(['medium', 'medium'])
  })

  test('it does not run below the minimum pool', async ($, on) => {
    const { calls, clock } = world(on, [addFactsReply(factTexts(CURATOR_MIN_POOL - 1))])
    await finishTurn($, 't1')
    await clock.settle()
    expect(calls.length).toBe(1)
  })

  test('after a run it waits 5 turns', async ($, on) => {
    const { calls, clock } = world(on, [addFactsReply(factTexts(CURATOR_MIN_POOL)), '{}'])
    for (let turn = 1; turn <= 6; turn++) {
      await finishTurn($, `t${turn}`)
      await clock.settle()
    }
    expect(calls.filter(call => call.system === CURATOR_SYSTEM).length).toBe(2)
    // One update per turn and a curator at turns 1 and 6.
    expect(calls.length).toBe(8)
  })
})

describe('applying the curator', () => {
  test('importance, merge and retire apply by id; unknown ids are ignored', async ($, on) => {
    const curatorReply = JSON.stringify({
      importance: { f1: 3, f99: 2, f2: 9 },
      merge: [{ keep: 'f3', drop: ['f4', 'f98'], text: 'merged wording' }],
      retire: ['f5', 'f97'],
    })
    const { clock, written } = world(on, [addFactsReply(factTexts(CURATOR_MIN_POOL)), curatorReply])
    await finishTurn($, 't1')
    await clock.settle()

    const facts = lastSaved(written).facts
    expect(facts.length).toBe(CURATOR_MIN_POOL - 2)
    expect(facts.find(fact => fact.id === 'f1')?.importance).toBe(3)
    expect(facts.find(fact => fact.id === 'f2')?.importance).toBe(1)
    expect(facts.find(fact => fact.id === 'f3')?.text).toBe('merged wording')
    expect(facts.some(fact => fact.id === 'f4' || fact.id === 'f5')).toBe(false)
  })

  test('a merge keeps the highest importance, the latest turn seen and the sum of mentions', async ($, on) => {
    const firstReply = JSON.stringify({ bearings: { factsAdd: [
      ...factTexts(CURATOR_MIN_POOL - 1).map(text => ({ text, importance: 1 })),
      { text: 'the important one', importance: 3 },
    ] } })
    const seenReply = JSON.stringify({ bearings: { factsSeen: ['f15', 'f15'] } })
    const mergeReply = JSON.stringify({ merge: [{ keep: 'f1', drop: ['f15'] }] })
    // Updates for turns 3 to 1 + CURATOR_EVERY, then the second curator call answers with the merge.
    const { clock, written } = world(on, [firstReply, '{}', seenReply, ...Array(CURATOR_EVERY - 1).fill('{}'), mergeReply])
    for (let turn = 1; turn <= 1 + CURATOR_EVERY; turn++) {
      await finishTurn($, `t${turn}`)
      await clock.settle()
    }

    const kept = lastSaved(written).facts.find(fact => fact.id === 'f1')
    expect(kept).toMatchObject({ importance: 3, lastSeenTurn: 2, mentions: 2 })
    expect(lastSaved(written).facts.some(fact => fact.id === 'f15')).toBe(false)
  })

  test('protected facts are never changed, dropped or retired', async ($, on) => {
    const curatorReply = JSON.stringify({
      importance: { f1: 3 },
      merge: [{ keep: 'f1', drop: ['f3'], text: 'rewritten' }, { keep: 'f4', drop: ['f2'] }],
      retire: ['f1', 'f2'],
    })
    const { clock, written } = world(on, [addFactsReply(factTexts(CURATOR_MIN_POOL)), curatorReply])
    await $.tool.call({ tool: 'mcp__bearings__add', fact: 'hand added one' })
    await $.tool.call({ tool: 'mcp__bearings__add', fact: 'hand added two', pin: 'session' })
    await finishTurn($, 't1')
    await clock.settle()

    const facts = lastSaved(written).facts
    expect(facts.find(fact => fact.id === 'f1')).toMatchObject({ text: 'hand added one', importance: 1 })
    expect(facts.some(fact => fact.id === 'f2')).toBe(true)
    expect(facts.some(fact => fact.id === 'f3')).toBe(true)
  })

  test('a malformed reply is logged as curator, leaves the facts as they were, and does not retry next turn', async ($, on) => {
    const { calls, clock, written } = world(on, [addFactsReply(factTexts(CURATOR_MIN_POOL)), 'no json here'])
    await finishTurn($, 't1')
    await clock.settle()
    await finishTurn($, 't2')
    await clock.settle()

    const log = written.filter(one => one.path === LOG_PATH).at(-1)?.text ?? ''
    expect(log).toContain('T1 curator failed: the reply holds no JSON object')
    expect(lastSaved(written).facts.length).toBe(CURATOR_MIN_POOL)
    expect(lastSaved(written).lastCuratedTurn).toBe(1)
    expect(calls.filter(call => call.system === CURATOR_SYSTEM).length).toBe(1)
  })

  test('a curator call the engine refuses is logged as curator, the turn still advances, and the queue goes on', async ($, on) => {
    const { calls, clock, written } = world(on, [addFactsReply(factTexts(CURATOR_MIN_POOL))], {}, true)
    await finishTurn($, 't1')
    await clock.settle()
    await finishTurn($, 't2')
    await clock.settle()

    const log = written.filter(one => one.path === LOG_PATH).at(-1)?.text ?? ''
    expect(log).toContain('T1 curator failed: the call was refused (')
    expect(calls.filter(call => call.system === CURATOR_SYSTEM).length).toBe(1)
    expect(lastSaved(written).lastCuratedTurn).toBe(1)
  })

  test('a curator reply with the wrong shape is a failure too', async ($, on) => {
    const { clock, written } = world(on, [addFactsReply(factTexts(CURATOR_MIN_POOL)), '{"retire":"f1"}'])
    await finishTurn($, 't1')
    await clock.settle()
    const log = written.filter(one => one.path === LOG_PATH).at(-1)?.text ?? ''
    expect(log).toContain('curator failed: "retire" is not a list of ids')
    expect(lastSaved(written).facts.length).toBe(CURATOR_MIN_POOL)
  })

  test('a rebuild clears the curator mark, so the curator runs on the next update', async ($, on) => {
    const messages = [{ role: 'user' as const, text: 'hello', toolUses: [] }]
    on('session.messages', () => ({ value: messages as never }))
    const rebuildReply = JSON.stringify({ bearings: { goal: 'a stated goal', factsAdd: factTexts(CURATOR_MIN_POOL) } })
    const { calls, clock } = world(on, [addFactsReply(factTexts(CURATOR_MIN_POOL)), '{}', rebuildReply, '{}', '{}'])
    await finishTurn($, 't1')
    await clock.settle()

    const pane = await mountBearings($)
    await pane.press({ key: 'rebuild' })
    await clock.settle()
    await finishTurn($, 't2')
    await clock.settle()

    expect(calls.filter(call => call.system === CURATOR_SYSTEM).length).toBe(2)
  })
})

describe('what the pane, the file and the compaction note show', () => {
  // Turn 1 adds what is past the Recent window by turn 7. Turn 7 adds more importance 3 facts than Hold takes and more importance 1 than Recent takes.
  const firstReply = addFactsReply(factTexts(40, 1000))
  // Calls in order: turn 1 update and curator, updates for turns 2 to 6, the curator at turn 6, then turn 7's update.
  const replies = [firstReply, '{}', '{}', '{}', '{}', '{}', '{}', '{}']
  const secondReply = JSON.stringify({ bearings: { factsAdd: [
    ...factTexts(HOLD_LIMIT + 2, 2000).map(text => ({ text, importance: 3 })),
    ...factTexts(RECENT_LIMIT + 3, 3000).map(text => ({ text, importance: 1 })),
  ] } })

  test('the pane shows Hold and Recent at their limits; the Earlier button opens its top and says how many more the file has', async ($, on) => {
    const parts = world(on, [...replies, secondReply])
    for (let turn = 1; turn <= 7; turn++) {
      await finishTurn($, `t${turn}`)
      await parts.clock.settle()
    }

    const pane = await mountBearings($)
    const main = (await pane.find({ type: 'Markdown' }))?.text ?? ''
    const holdPart = main.slice(main.indexOf('## Key facts'), main.indexOf('## Recent facts'))
    const recentPart = main.slice(main.indexOf('## Recent facts'))
    expect(holdPart.split('\n- ').length - 1).toBe(HOLD_LIMIT)
    expect(recentPart.split('\n- ').length - 1).toBe(RECENT_LIMIT)
    expect(main).not.toContain('## Earlier facts')
    expect(main).not.toContain('## Facts to hold')

    const earlierCount = 40 + 2 + 3
    const toggle = await pane.find({ key: 'toggle-earlier' })
    expect(toggle?.text).toBe(`Show earlier facts (${earlierCount})`)

    await pane.press({ key: 'toggle-earlier' })
    const opened = (await pane.findAll({ type: 'Markdown' }))[1]?.text ?? ''
    expect(opened.split('\n').filter(line => line.startsWith('- ')).length).toBe(EARLIER_SHOWN)
    expect(opened).toContain(`_${earlierCount - EARLIER_SHOWN} more in the file._`)
  })

  test('a tier with no facts is left out of the pane', async ($, on) => {
    const parts = world(on, [addFactsReply(['just one detail'])])
    await finishTurn($, 't1')
    await parts.clock.settle()

    const main = (await (await mountBearings($)).find({ type: 'Markdown' }))?.text ?? ''
    expect(main).toContain('## Recent facts\n- just one detail')
    expect(main).not.toContain('## Key facts')
  })

  test('the .md file holds every fact, under all three headings', async ($, on) => {
    const parts = world(on, [...replies, secondReply])
    for (let turn = 1; turn <= 7; turn++) {
      await finishTurn($, `t${turn}`)
      await parts.clock.settle()
    }

    const file = lastMarkdown(parts.written)
    for (const heading of ['## Key facts', '## Recent facts', '## Earlier facts']) expect(file).toContain(heading)
    for (const text of [...factTexts(40, 1000), ...factTexts(HOLD_LIMIT + 2, 2000), ...factTexts(RECENT_LIMIT + 3, 3000)]) {
      expect(file).toContain(`- ${text}`)
    }
  })

  test('the compaction note holds only Hold and Recent', async ($, on) => {
    const parts = world(on, [...replies, secondReply])
    on('session.compact', ($, e) => ({ messages: e.messages }))
    for (let turn = 1; turn <= 7; turn++) {
      await finishTurn($, `t${turn}`)
      await parts.clock.settle()
    }

    await $.session.compact({ trigger: 'manual', messages: [{ role: 'user', text: 'the conversation so far', toolUses: [] }] } as never)
    expect(parts.appended.length).toBe(1)
    const note = parts.appended[0]!
    expect(note).toContain('## Key facts')
    expect(note).toContain('## Recent facts')
    expect(note).not.toContain('## Earlier facts')
    expect(note).not.toContain('plain words number 1000 here')
  })
})

describe('the ranking flag', () => {
  const pool = factTexts(CURATOR_MIN_POOL - 2)

  test('llm: the update uses the ranking prompt and the tiers follow its rank', { options: { ranking: 'llm' } }, async ($, on) => {
    const rankReply = JSON.stringify({ bearings: { factsRank: { hold: ['f3'], recent: ['f1'] } } })
    const parts = world(on, [addFactsReply(pool), rankReply])
    await finishTurn($, 't1')
    await parts.clock.settle()
    await finishTurn($, 't2')
    await parts.clock.settle()

    expect(parts.calls[0]?.system).toBe(RANKING_UPDATE_SYSTEM)
    const main = (await (await mountBearings($)).find({ type: 'Markdown' }))?.text ?? ''
    expect(main).toContain('## Key facts\n- plain words number 3 here\n\n## Recent facts\n- plain words number 1 here')
    expect(lastMarkdown(parts.written)).toContain('## Key facts\n- plain words number 3 here\n\n## Recent facts\n- plain words number 1 here')
  })

  test('mechanical: a rank stored by an earlier run is ignored in the pane and the file', async ($, on) => {
    const facts = [
      { id: 'f1', text: 'the scored fact', lastSeenTurn: 3, pin: 'none', source: 'auto', importance: 3, mentions: 0 },
      { id: 'f2', text: 'the ranked fact', lastSeenTurn: 3, pin: 'none', source: 'auto', importance: 1, mentions: 0 },
    ]
    const bearings = { ...emptyBearings(), goal: 'g', facts, nextFactId: 3, updatedAtTurn: 3, factRank: { turn: 3, hold: ['f2'], recent: [] } }
    const saved = { sessionId: SESSION_ID, cwd: CWD, startedAt: '', lastTouched: new Date(NOW).toISOString(), goal: 'g', turn: 3, glossary: [], bearings, btw: [], stats: emptyStats() }
    const parts = world(on, [], { [`${SESSION_ID}.json`]: saved })
    await $.session.start({ cwd: CWD, surface: 'terminal', isInteractive: true })
    await $.tool.call({ tool: 'mcp__bearings__add', term: 'T', meaning: 'forces a save' })

    const main = (await (await mountBearings($)).find({ type: 'Markdown' }))?.text ?? ''
    expect(main).toContain('## Key facts\n- the scored fact')
    expect(lastMarkdown(parts.written)).toContain('## Key facts\n- the scored fact')
  })

  test('llm: a turn whose reply has no rank falls back to mechanical', { options: { ranking: 'llm' } }, async ($, on) => {
    const rankReply = JSON.stringify({ bearings: { factsRank: { hold: ['f3'], recent: ['f1'] } } })
    const parts = world(on, [addFactsReply(pool), rankReply, '{}'])
    for (const turnId of ['t1', 't2', 't3']) {
      await finishTurn($, turnId)
      await parts.clock.settle()
    }

    const main = (await (await mountBearings($)).find({ type: 'Markdown' }))?.text ?? ''
    expect(main).not.toContain('## Key facts')
    expect(main).toContain('## Recent facts\n')
  })

  test('llm: a fact added in the same reply as the rank is placed by its importance', { options: { ranking: 'llm' } }, async ($, on) => {
    const reply = JSON.stringify({ bearings: {
      factsAdd: [{ text: 'a new limit', importance: 3 }, { text: 'a new detail', importance: 1 }],
      factsRank: { hold: ['f1'], recent: ['f2'] },
    } })
    const parts = world(on, [addFactsReply(pool), reply])
    await finishTurn($, 't1')
    await parts.clock.settle()
    await finishTurn($, 't2')
    await parts.clock.settle()

    const main = (await (await mountBearings($)).find({ type: 'Markdown' }))?.text ?? ''
    expect(main).toContain('## Key facts\n- a new limit\n- plain words number 1 here\n\n## Recent facts\n- a new detail\n- plain words number 2 here')
  })

  test('an unknown flag value means mechanical: the prompt does not ask for a rank and a rank is not applied', { options: { ranking: 'magic' } }, async ($, on) => {
    const rankReply = JSON.stringify({ bearings: { factsRank: { hold: ['f3'], recent: ['f1'] } } })
    const parts = world(on, [addFactsReply(pool), rankReply])
    await finishTurn($, 't1')
    await parts.clock.settle()
    await finishTurn($, 't2')
    await parts.clock.settle()

    expect(parts.calls[0]?.system).toBe(UPDATE_SYSTEM)
    expect(lastSaved(parts.written).factRank).toBeUndefined()
  })

  test('mechanical by default: a rank in a reply is not applied', async ($, on) => {
    const rankReply = JSON.stringify({ bearings: { factsRank: { hold: ['f3'], recent: ['f1'] } } })
    const parts = world(on, [addFactsReply(pool), rankReply])
    await finishTurn($, 't1')
    await parts.clock.settle()
    await finishTurn($, 't2')
    await parts.clock.settle()

    expect(parts.calls[0]?.system).toBe(UPDATE_SYSTEM)
    expect(lastSaved(parts.written).factRank).toBeUndefined()
  })
})

describe('the drop command', () => {
  const decisionsReply = JSON.stringify({ bearings: { openDecisions: ['Should we ship today?', 'Which model do we use?'] } })

  for (const [paneId, inputKey] of [['bearings-map', 'btw-input'], ['bearings-glossary', 'glossary-input']] as const) {
    test(`typed in ${paneId}, it removes the matching open decision and saves`, async ($, on) => {
      const parts = world(on, [decisionsReply])
      await finishTurn($, 't1')
      await parts.clock.settle()

      const pane = await $.ui.mount({ plugin: 'bearings', surface: 'terminal', component: 'Pane', requestId: paneId, props: PANE_PROPS })
      await pane.input({ key: inputKey, text: 'drop: should we' })
      await parts.clock.settle()

      expect(lastSaved(parts.written).openDecisions).toEqual(['Which model do we use?'])
    })
  }
})

describe('old data through the engine', () => {
  const oldFacts: StoredFact[] = [
    { text: 'an old fact', lastSeenTurn: 2, pin: 'none', source: 'auto' },
    { text: 'an old pinned fact', lastSeenTurn: 2, pin: 'session', source: 'operator' },
  ]
  const { nextFactId: _unset, ...oldBearings } = emptyBearings()
  const savedSession = {
    sessionId: SESSION_ID, cwd: CWD, startedAt: '', lastTouched: new Date(NOW).toISOString(), goal: 'old goal', turn: 3,
    glossary: [], bearings: { ...oldBearings, goal: 'old goal', facts: oldFacts }, btw: [], stats: emptyStats(),
  }

  test('a resumed old-format session gets ids, and they are saved', async ($, on) => {
    const parts = world(on, ['{}'], { [`${SESSION_ID}.json`]: savedSession })
    await $.session.start({ cwd: CWD, surface: 'terminal', isInteractive: true })
    await finishTurn($, 't1')
    await parts.clock.settle()

    expect(parts.calls[0]?.prompt).toContain('f2 (1): an old pinned fact')
    expect(lastSaved(parts.written).facts).toEqual([
      { id: 'f1', text: 'an old fact', lastSeenTurn: 2, pin: 'none', source: 'auto', importance: 1, mentions: 0 },
      { id: 'f2', text: 'an old pinned fact', lastSeenTurn: 2, pin: 'session', source: 'operator', importance: 1, mentions: 0 },
    ])
    expect(lastSaved(parts.written).nextFactId).toBe(3)
  })

  test('after a resume of old data, a new fact continues the ids', async ($, on) => {
    const parts = world(on, ['{}'], { [`${SESSION_ID}.json`]: savedSession })
    await $.session.start({ cwd: CWD, surface: 'terminal', isInteractive: true })
    await $.tool.call({ tool: 'mcp__bearings__add', fact: 'added after the resume' })

    expect(lastSaved(parts.written).facts.map(fact => fact.id)).toEqual(['f1', 'f2', 'f3'])
    expect(lastSaved(parts.written).nextFactId).toBe(4)
  })
})

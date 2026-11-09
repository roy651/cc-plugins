import { describe, expect, test } from 'claude-code/testing'

import type { GlossaryEntry } from '../types'
import { applyDelta, applyScanDelta, dropOpenDecision, emptyBearings, parseDelta, protectedOnly, restoreFirstTurns } from '../hooks/merge'
import type { Delta, Snapshot } from '../hooks/merge'

function entry(term: string, meaning: string, extra: Partial<GlossaryEntry> = {}): GlossaryEntry {
  return { term, meaning, firstTurn: 1, lastSeenTurn: 1, pin: 'none', source: 'auto', ...extra }
}

function delta(glossary: Partial<Delta['glossary']>, bearings: Delta['bearings'] = {}): Delta {
  return { glossary: { upsert: [], seen: [], ...glossary }, bearings }
}

describe('applyDelta glossary', () => {
  test('upsert adds a new term first seen at this turn', () => {
    const result = applyDelta({ glossary: [], bearings: null }, delta({ upsert: [{ term: 'FMA', meaning: 'failure mechanism analyzer' }] }), 4)
    expect(result.glossary).toEqual([entry('FMA', 'failure mechanism analyzer', { firstTurn: 4, lastSeenTurn: 4 })])
  })

  test('upsert replaces an automatic meaning and keeps the first turn', () => {
    const before: Snapshot = { glossary: [entry('FMA', 'old meaning')], bearings: null }
    const result = applyDelta(before, delta({ upsert: [{ term: 'fma', meaning: 'new meaning' }] }), 7)
    expect(result.glossary[0]).toEqual(entry('FMA', 'new meaning', { firstTurn: 1, lastSeenTurn: 7 }))
  })

  test('seen moves lastSeenTurn and nothing else', () => {
    const before: Snapshot = { glossary: [entry('BME', 'behavioral model extractor')], bearings: null }
    const result = applyDelta(before, delta({ seen: ['BME'] }), 9)
    expect(result.glossary[0]).toEqual(entry('BME', 'behavioral model extractor', { lastSeenTurn: 9 }))
  })

  test('a pinned entry keeps its meaning against an automatic upsert, but counts as seen', () => {
    const before: Snapshot = { glossary: [entry('REC', 'recommendation', { pin: 'session' })], bearings: null }
    const result = applyDelta(before, delta({ upsert: [{ term: 'REC', meaning: 'something invented' }] }), 5)
    expect(result.glossary[0]?.meaning).toBe('recommendation')
    expect(result.glossary[0]?.lastSeenTurn).toBe(5)
  })

  test('entries the operator or the main model added keep their meaning', () => {
    const before: Snapshot = {
      glossary: [entry('A', 'from operator', { source: 'operator' }), entry('B', 'from claude', { source: 'claude' })],
      bearings: null,
    }
    const result = applyDelta(before, delta({ upsert: [{ term: 'A', meaning: 'x' }, { term: 'B', meaning: 'y' }] }), 3)
    expect(result.glossary.map(one => one.meaning)).toEqual(['from operator', 'from claude'])
  })

  test('the input snapshot is not changed', () => {
    const before: Snapshot = { glossary: [entry('FMA', 'old')], bearings: null }
    applyDelta(before, delta({ upsert: [{ term: 'FMA', meaning: 'new' }] }), 2)
    expect(before.glossary[0]?.meaning).toBe('old')
  })
})

describe('applyDelta bearings', () => {
  test('only the fields the delta names change', () => {
    const before: Snapshot = { glossary: [], bearings: { ...emptyBearings(), goal: 'ship it', inProgress: ['tests'] } }
    const result = applyDelta(before, delta({}, { inProgress: ['review'] }), 6)
    expect(result.bearings?.goal).toBe('ship it')
    expect(result.bearings?.inProgress).toEqual(['review'])
    expect(result.bearings?.updatedAtTurn).toBe(6)
  })

  test('factsAdd adds once, factsSeen touches', () => {
    const before: Snapshot = { glossary: [], bearings: emptyBearings() }
    const first = applyDelta(before, delta({}, { factsAdd: [{ text: 'Temperature is 0.1', importance: 1 }, { text: 'temperature is 0.1', importance: 1 }] }), 2)
    expect(first.bearings?.facts.length).toBe(1)
    const second = applyDelta(first, delta({}, { factsSeen: ['Temperature is 0.1'] }), 8)
    expect(second.bearings?.facts[0]?.lastSeenTurn).toBe(8)
  })

  test('the inherited header goes once this session updates', () => {
    const before: Snapshot = { glossary: [], bearings: { ...emptyBearings(), inheritedFrom: { sessionId: 'abc', savedAt: '2026-10-01T00:00:00.000Z' } } }
    expect(applyDelta(before, delta({}), 1).bearings?.inheritedFrom).toBeUndefined()
  })
})

describe('parseDelta', () => {
  test('reads a delta wrapped in a code fence', () => {
    const parsed = parseDelta('```json\n{"glossary":{"upsert":[{"term":"X","meaning":"y"}],"seen":[]},"bearings":{"goal":"g"}}\n```')
    expect(parsed).toEqual(delta({ upsert: [{ term: 'X', meaning: 'y' }] }, { goal: 'g' }))
  })

  test('says why a reply is not a delta', () => {
    expect('error' in parseDelta('no json here')).toBe(true)
    expect('error' in parseDelta('{"glossary": {"upsert": "nope"}}')).toBe(true)
    expect('error' in parseDelta('{"bearings": {"subGoals": "one"}}')).toBe(true)
  })
})

describe('rebuild helpers', () => {
  test('a rebuild starts from the pinned and hand-added entries only, and known terms keep their first turn', () => {
    const before: Snapshot = {
      glossary: [
        entry('OLD', 'stale', { firstTurn: 2 }),
        entry('KEEP', 'pinned meaning', { pin: 'project' }),
        entry('MINE', 'operator meaning', { source: 'operator' }),
        entry('SAME', 'known term', { firstTurn: 3 }),
      ],
      bearings: { ...emptyBearings(), goal: 'old goal', facts: [
        { id: 'f1', text: 'kept fact', lastSeenTurn: 1, pin: 'session', source: 'auto', importance: 1, mentions: 0 },
        { id: 'f2', text: 'dropped fact', lastSeenTurn: 1, pin: 'none', source: 'auto', importance: 1, mentions: 0 },
      ] },
    }
    const start = protectedOnly(before)
    expect(start.glossary.map(one => one.term)).toEqual(['KEEP', 'MINE'])
    expect(start.bearings?.goal).toBe('')
    expect(start.bearings?.facts.map(one => one.text)).toEqual(['kept fact'])

    const rebuilt = applyDelta(start, delta({ upsert: [{ term: 'SAME', meaning: 'fresh' }, { term: 'KEEP', meaning: 'overwrite attempt' }] }), 20)
    const result = restoreFirstTurns(before, rebuilt)
    expect(result.glossary.find(one => one.term === 'SAME')?.firstTurn).toBe(3)
    expect(result.glossary.find(one => one.term === 'KEEP')?.meaning).toBe('pinned meaning')
  })
})

describe('dropped open decisions', () => {
  const withDecisions: Snapshot = {
    glossary: [],
    bearings: { ...emptyBearings(), openDecisions: ['Question A?', 'Question B?'], changedAtTurn: { openDecisions: 3 } },
  }

  function dropA(): Snapshot {
    return dropOpenDecision(withDecisions, 'question a', 6).snapshot
  }

  test('a reply already in flight that restates the old list does not bring a dropped decision back or move the changed turn', () => {
    const afterReply = applyDelta(dropA(), delta({}, { openDecisions: ['question a?', 'Question B?'] }), 7)
    expect(afterReply.bearings?.openDecisions).toEqual(['Question B?'])
    expect(afterReply.bearings?.changedAtTurn?.openDecisions).toBe(6)
  })

  test('a reply that really changes the list still records the change, without the dropped item', () => {
    const afterReply = applyDelta(dropA(), delta({}, { openDecisions: ['Question A?', 'Question B?', 'Question C?'] }), 7)
    expect(afterReply.bearings?.openDecisions).toEqual(['Question B?', 'Question C?'])
    expect(afterReply.bearings?.changedAtTurn?.openDecisions).toBe(7)
  })

  test('dropped decisions are taken out before the cap, so they do not use up its room', () => {
    const eight = Array.from({ length: 8 }, (_, index) => `item ${index + 1}`)
    const dropped: Snapshot = { glossary: [], bearings: { ...emptyBearings(), droppedDecisions: ['item 8'] } }
    expect(applyDelta(dropped, delta({}, { openDecisions: eight }), 2).bearings?.openDecisions).toEqual(eight.slice(0, 7))
  })

  test('a rebuild carries the dropped decisions, so it does not bring one back', () => {
    const start = protectedOnly(dropA())
    expect(start.bearings?.droppedDecisions).toEqual(['Question A?'])
    expect(applyDelta(start, delta({}, { openDecisions: ['Question A?', 'Question B?'] }), 9).bearings?.openDecisions).toEqual(['Question B?'])
  })

  test('a scan leaves out dropped decisions, and fills nothing when only dropped ones remain', () => {
    const dropped: Snapshot = { glossary: [], bearings: { ...emptyBearings(), droppedDecisions: ['Question A?'] } }
    expect(applyScanDelta(dropped, delta({}, { openDecisions: ['question a?', 'Question C?'] }), 0).bearings?.openDecisions).toEqual(['Question C?'])

    const onlyDropped = applyScanDelta(dropped, delta({}, { openDecisions: ['Question A?'] }), 4).bearings
    expect(onlyDropped?.openDecisions).toEqual([])
    expect(onlyDropped?.changedAtTurn?.openDecisions).toBeUndefined()
    expect(onlyDropped?.repoFields).toEqual([])
  })

  test('the last 20 dropped texts are kept', () => {
    const twentyFive = Array.from({ length: 25 }, (_, index) => `question ${String(index + 1).padStart(2, '0')}`)
    let snapshot: Snapshot = { glossary: [], bearings: { ...emptyBearings(), openDecisions: twentyFive } }
    for (const question of twentyFive) snapshot = dropOpenDecision(snapshot, question, 5).snapshot
    expect(snapshot.bearings?.droppedDecisions).toEqual(twentyFive.slice(5))
  })

  test('a dropped list is no longer the repo\'s, so a later scan cannot overwrite it', () => {
    const fromRepo: Snapshot = { glossary: [], bearings: { ...emptyBearings(), openDecisions: ['Question A?', 'Question B?'], repoFields: ['openDecisions', 'goal'] } }
    const dropped = dropOpenDecision(fromRepo, 'question a', 6).snapshot
    expect(dropped.bearings?.repoFields).toEqual(['goal'])
    expect(applyScanDelta(dropped, delta({}, { openDecisions: ['A new repo question'] }), 7).bearings?.openDecisions).toEqual(['Question B?'])
  })
})

describe('list caps', () => {
  const twelve = Array.from({ length: 12 }, (_, index) => `item ${index + 1}`)

  test('sub-goals and expected next keep their newest 10 (the last ones); other lists are not capped', () => {
    const result = applyDelta({ glossary: [], bearings: null }, delta({}, { subGoals: twelve, expectedNext: twelve, doneRecently: twelve }), 3)
    expect(result.bearings?.subGoals).toEqual(twelve.slice(2))
    expect(result.bearings?.expectedNext.length).toBe(10)
    expect(result.bearings?.doneRecently.length).toBe(12)
  })

  test('open decisions keep their newest 7', () => {
    const result = applyDelta({ glossary: [], bearings: null }, delta({}, { openDecisions: twelve }), 3)
    expect(result.bearings?.openDecisions).toEqual(twelve.slice(5))
  })

  test('open decisions restated unchanged keep the turn they last changed', () => {
    const first = applyDelta({ glossary: [], bearings: null }, delta({}, { openDecisions: ['one question'] }), 3)
    const restated = applyDelta(first, delta({}, { openDecisions: ['one question'] }), 8)
    expect(restated.bearings?.changedAtTurn?.openDecisions).toBe(3)
  })

  test('a scan is capped the same way', () => {
    const result = applyScanDelta({ glossary: [], bearings: null }, delta({}, { subGoals: twelve }), 0)
    expect(result.bearings?.subGoals).toEqual(twelve.slice(2))
  })
})

describe('the turn each field last changed', () => {
  test('a field that changes records the turn; one restated unchanged keeps its turn', () => {
    const first = applyDelta({ glossary: [], bearings: null }, delta({}, { goal: 'ship', inProgress: ['tests'] }), 4)
    expect(first.bearings?.changedAtTurn).toEqual({ goal: 4, inProgress: 4 })

    const restated = applyDelta(first, delta({}, { goal: 'Ship', inProgress: ['Tests'] }), 9)
    expect(restated.bearings?.changedAtTurn).toEqual({ goal: 4, inProgress: 4 })

    const changed = applyDelta(restated, delta({}, { inProgress: ['tests', 'review'] }), 12)
    expect(changed.bearings?.changedAtTurn).toEqual({ goal: 4, inProgress: 12 })
  })

  test('a scan that fills a field records the turn', () => {
    const result = applyScanDelta({ glossary: [], bearings: null }, delta({}, { goal: 'from the repo', expectedNext: ['x'] }), 0)
    expect(result.bearings?.changedAtTurn).toEqual({ goal: 0, expectedNext: 0 })
  })
})

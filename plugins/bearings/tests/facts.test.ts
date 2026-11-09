import { describe, expect, test } from 'claude-code/testing'
import type { ModelUsage } from 'claude-code'

import type { Bearings, Fact, StoredFact } from '../types'
import {
  factRankFrom, factsForUpdate, factTiers, HOLD_LIMIT, holdScore, markMentionedFacts, mechanicalTiers, normalizeFacts, pushNewFact, RECENT_LIMIT, SHORTLIST_SIZE, shortlist,
} from '../hooks/facts'
import { addFact, applyDelta, applyScanDelta, emptyBearings, keepHighestFactId, mergeProjectPins, parseDelta, protectedOnly } from '../hooks/merge'
import type { Delta, Snapshot } from '../hooks/merge'
import { scanPrompt, updatePrompt } from '../hooks/prompts'
import { pruneStale } from '../hooks/retention'
import { applyBackgroundUpdate, applyRebuildReply, emptyStats } from '../hooks/update'

const usage: ModelUsage = { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }

function fact(number: number, extra: Partial<Fact> = {}): Fact {
  return { id: `f${number}`, text: `fact ${number}`, lastSeenTurn: 10, pin: 'none', source: 'auto', importance: 1, mentions: 0, ...extra }
}

function numbered(count: number, extra: Partial<Fact> = {}, firstNumber = 1): Fact[] {
  return Array.from({ length: count }, (_, index) => fact(firstNumber + index, extra))
}

function bearingsWith(facts: Fact[], extra: Partial<Bearings> = {}): Bearings {
  return { ...emptyBearings(), facts, nextFactId: 1000, updatedAtTurn: 10, ...extra }
}

function idsOf(facts: Fact[]): string[] {
  return facts.map(one => one.id)
}

function delta(bearings: Delta['bearings']): Delta {
  return { glossary: { upsert: [], seen: [] }, bearings }
}

function parsedBearings(reply: unknown): Delta['bearings'] {
  const parsed = parseDelta(JSON.stringify({ bearings: reply }))
  if ('error' in parsed) throw new Error(parsed.error)
  return parsed.bearings
}

const oldFacts: StoredFact[] = [
  { text: 'first old fact', lastSeenTurn: 3, pin: 'none', source: 'auto' },
  { text: 'second old fact', lastSeenTurn: 4, pin: 'session', source: 'operator' },
]

describe('old data', () => {
  test('old facts get unique ids in stored order, importance 1 and no mentions; the text is unchanged', () => {
    const { nextFactId: _unset, ...old } = emptyBearings()
    const normalized = normalizeFacts({ ...old, facts: oldFacts })
    expect(normalized.facts).toEqual([
      { id: 'f1', text: 'first old fact', lastSeenTurn: 3, pin: 'none', source: 'auto', importance: 1, mentions: 0 },
      { id: 'f2', text: 'second old fact', lastSeenTurn: 4, pin: 'session', source: 'operator', importance: 1, mentions: 0 },
    ])
    expect(normalized.nextFactId).toBe(3)
  })

  test('an id given on read stays the same across reads and saves, and a new fact never repeats one', () => {
    const { nextFactId: _unset, ...old } = emptyBearings()
    const firstRead = normalizeFacts({ ...old, facts: oldFacts })
    const secondReadOfTheSameOldValue = normalizeFacts({ ...old, facts: oldFacts })
    expect(secondReadOfTheSameOldValue).toEqual(firstRead)
    expect(normalizeFacts(firstRead)).toEqual(firstRead)

    const savedAndRead = normalizeFacts(JSON.parse(JSON.stringify(firstRead)) as Bearings)
    expect(savedAndRead).toEqual(firstRead)

    const added = addFact({ glossary: [], bearings: savedAndRead }, 'a new fact', 'operator', 5).bearings!
    expect(idsOf(added.facts)).toEqual(['f1', 'f2', 'f3'])
    expect(new Set(idsOf(added.facts)).size).toBe(3)
  })

  test('nextFactId never goes back, so the id of a deleted fact is not issued again', () => {
    const bearings = normalizeFacts({ ...emptyBearings(), facts: [fact(1), fact(7)], nextFactId: 8 })
    const withoutNewest = normalizeFacts({ ...bearings, facts: [bearings.facts[0]!] })
    expect(withoutNewest.nextFactId).toBe(8)

    pushNewFact(withoutNewest, 'after the delete', 'auto', 11, 1)
    expect(idsOf(withoutNewest.facts)).toEqual(['f1', 'f8'])
    expect(withoutNewest.nextFactId).toBe(9)
  })

  test('a repeated id gets a new one; the first holder keeps it', () => {
    const normalized = normalizeFacts({ ...emptyBearings(), facts: [fact(1), fact(1, { text: 'same id' }), fact(2)], nextFactId: 3 })
    expect(idsOf(normalized.facts)).toEqual(['f1', 'f3', 'f2'])
  })

  test('a stored project pin in the old format gets an id that does not collide; a known pin keeps its id', () => {
    const session = bearingsWith([fact(1), fact(2, { text: 'already here', pin: 'project' })], { nextFactId: 3 })
    const pins = {
      glossary: [],
      facts: [
        { text: 'old format pin', lastSeenTurn: 1, pin: 'project', source: 'operator' } as StoredFact,
        { id: 'f1', text: 'pin from another session', lastSeenTurn: 1, pin: 'project', source: 'operator' } as StoredFact,
        { id: 'f9', text: 'already here', lastSeenTurn: 1, pin: 'project', source: 'operator' } as StoredFact,
      ],
    }
    const merged = mergeProjectPins({ glossary: [], bearings: session }, pins).bearings!
    const idByText = new Map(merged.facts.map(one => [one.text, one.id]))

    expect(new Set(idsOf(merged.facts)).size).toBe(merged.facts.length)
    expect(idByText.get('fact 1')).toBe('f1')
    expect(idByText.get('already here')).toBe('f2')
    expect(idByText.get('old format pin')).toBe('f3')
    expect(idByText.get('pin from another session')).toBe('f4')
    expect(merged.facts.find(one => one.text === 'old format pin')).toMatchObject({ importance: 1, mentions: 0 })
  })

  test('a rebuild numbers its new facts well past the session, keeps protected ids, and clears the curator mark and the rank', () => {
    const before = bearingsWith([fact(5, { pin: 'session' })], { nextFactId: 6, lastCuratedTurn: 4, factRank: { turn: 10, hold: ['f5'], recent: [] } })
    const start = protectedOnly({ glossary: [], bearings: before }).bearings!
    expect(start.nextFactId).toBe(1006)
    expect(idsOf(start.facts)).toEqual(['f5'])
    expect(start.lastCuratedTurn).toBeUndefined()
    expect(start.factRank).toBeUndefined()
  })

  test('a finished rebuild keeps the highest next id, whichever side reached it', () => {
    const rebuilt: Snapshot = { glossary: [], bearings: bearingsWith([], { nextFactId: 1006 }) }
    const updatedPastIt: Snapshot = { glossary: [], bearings: bearingsWith([], { nextFactId: 2000 }) }
    const behindIt: Snapshot = { glossary: [], bearings: bearingsWith([], { nextFactId: 9 }) }
    expect(keepHighestFactId(updatedPastIt, rebuilt).bearings?.nextFactId).toBe(2000)
    expect(keepHighestFactId(behindIt, rebuilt).bearings?.nextFactId).toBe(1006)
  })

  test('a factsReplace for an id issued during the rebuild does not change a rebuilt fact', () => {
    const before = bearingsWith([], { nextFactId: 6 })
    const start = protectedOnly({ glossary: [], bearings: before })
    const reply = JSON.stringify({ bearings: { factsAdd: ['a rebuilt fact'] } })
    const rebuilt = applyRebuildReply(start, emptyStats(), { isAnswered: true, text: reply, usage }, 11).snapshot

    const inFlight = applyDelta(rebuilt, delta({ factsReplace: [{ id: 'f6', text: 'meant for another fact', importance: 2 }] }), 12).bearings!
    expect(inFlight.facts.map(one => one.text)).toEqual(['a rebuilt fact'])
  })
})

describe('scoring and tiers', () => {
  test('the score is importance plus capped mentions minus decay', () => {
    expect(Number(holdScore(fact(1, { importance: 2, mentions: 5, lastSeenTurn: 8 }), 10).toFixed(4))).toBe(2.71)
    expect(Number(holdScore(fact(1, { importance: 1, mentions: 1, lastSeenTurn: 10 }), 10).toFixed(4))).toBe(1.25)
  })

  test('Hold takes the best importance 2 and 3 facts up to its limit', () => {
    const facts = [...numbered(12, { importance: 2 }), fact(13, { importance: 3 })]
    const { hold, recent } = mechanicalTiers(facts, 10)
    expect(hold.length).toBe(HOLD_LIMIT)
    expect(hold[0]?.id).toBe('f13')
    expect(idsOf(recent).length).toBe(3)
  })

  test('importance 1 stays out of Hold even with room to spare', () => {
    const { hold, recent } = mechanicalTiers(numbered(3), 10)
    expect(hold).toEqual([])
    expect(recent.length).toBe(3)
  })

  test('pinned and hand-added facts are all shown, past the limit, ahead of scored ones', () => {
    const pinned = numbered(HOLD_LIMIT + 2, { pin: 'session', lastSeenTurn: 1 })
    const handAdded = fact(50, { source: 'operator', lastSeenTurn: 1 })
    const important = fact(60, { importance: 3 })
    const { hold, recent } = mechanicalTiers([...pinned, handAdded, important], 10)
    expect(hold.length).toBe(HOLD_LIMIT + 3)
    expect(idsOf(hold)).not.toContain('f60')
    expect(idsOf(recent)).toEqual(['f60'])
  })

  test('Recent is the rest seen within 5 turns, newest first, up to its limit; a fact 5 turns old is out', () => {
    const facts = [fact(1, { lastSeenTurn: 5 }), fact(2, { lastSeenTurn: 6 }), fact(3, { lastSeenTurn: 10 })]
    expect(idsOf(mechanicalTiers(facts, 10).recent)).toEqual(['f3', 'f2'])
    expect(mechanicalTiers(numbered(RECENT_LIMIT + 4), 10).recent.length).toBe(RECENT_LIMIT)
  })

  test('Earlier is the rest by score, highest first', () => {
    const facts = [fact(1, { lastSeenTurn: 1 }), fact(2, { lastSeenTurn: 1, mentions: 2 }), fact(3, { lastSeenTurn: 2 })]
    expect(idsOf(mechanicalTiers(facts, 10).earlier)).toEqual(['f2', 'f3', 'f1'])
  })

  test('every fact is in exactly one tier', () => {
    const facts = [
      ...numbered(14, { importance: 3 }),
      ...numbered(15, { lastSeenTurn: 9 }, 100),
      ...numbered(20, { lastSeenTurn: 1 }, 200),
      fact(300, { pin: 'project', lastSeenTurn: 1 }),
    ]
    const tiers = mechanicalTiers(facts, 10)
    const placed = [...tiers.hold, ...tiers.recent, ...tiers.earlier]
    expect(placed.length).toBe(facts.length)
    expect(new Set(idsOf(placed)).size).toBe(facts.length)
  })

  test('an empty pool gives empty tiers and an empty shortlist', () => {
    const tiers = mechanicalTiers([], 10)
    expect(tiers).toEqual({ hold: [], recent: [], earlier: [] })
    expect(shortlist(tiers)).toEqual([])
  })

  test('the shortlist is Hold, then Recent, then the top of Earlier, up to its size', () => {
    const facts = [
      fact(1, { importance: 3, lastSeenTurn: 1 }),
      fact(2, { lastSeenTurn: 10 }),
      ...numbered(60, { lastSeenTurn: 2 }, 100),
      fact(200, { lastSeenTurn: 2, mentions: 3 }),
    ]
    const list = shortlist(mechanicalTiers(facts, 10))
    expect(list.length).toBe(SHORTLIST_SIZE)
    expect(idsOf(list).slice(0, 3)).toEqual(['f1', 'f2', 'f200'])
  })
})

describe('the update delta', () => {
  test('factsAdd reads objects and bare strings; an importance outside 1 to 3 becomes 1', () => {
    expect(parsedBearings({ factsAdd: [{ text: 'a', importance: 3 }, 'b', { text: 'c', importance: 7 }, { text: 'd', importance: '2' }, { nothing: 1 }, ''] }).factsAdd).toEqual([
      { text: 'a', importance: 3 }, { text: 'b', importance: 1 }, { text: 'c', importance: 1 }, { text: 'd', importance: 1 },
    ])
  })

  test('a factsAdd that is not a list is a failure', () => {
    expect(parseDelta(JSON.stringify({ bearings: { factsAdd: 'x' } }))).toEqual({ error: '"bearings.factsAdd" is not a list' })
  })

  test('added facts take the next ids and the given importance', () => {
    const before: Snapshot = { glossary: [], bearings: bearingsWith([], { nextFactId: 4 }) }
    const after = applyDelta(before, delta({ factsAdd: [{ text: 'a', importance: 3 }] }), 2).bearings!
    expect(after.facts).toEqual([{ id: 'f4', text: 'a', lastSeenTurn: 2, pin: 'none', source: 'auto', importance: 3, mentions: 0 }])
    expect(after.nextFactId).toBe(5)
  })

  test('factsSeen matches by id and by exact text, and counts a mention', () => {
    const before: Snapshot = { glossary: [], bearings: bearingsWith([fact(1), fact(2), fact(3)]) }
    const after = applyDelta(before, delta({ factsSeen: ['f1', 'Fact 2', 'f99'] }), 20).bearings!
    expect(after.facts.map(one => [one.lastSeenTurn, one.mentions])).toEqual([[20, 1], [20, 1], [10, 0]])
  })

  test('factsReplace rewrites an unprotected fact in place, keeping its id', () => {
    const before: Snapshot = { glossary: [], bearings: bearingsWith([fact(1), fact(2)]) }
    const after = applyDelta(before, delta({ factsReplace: [{ id: 'f1', text: 'sharper', importance: 2 }] }), 20).bearings!
    expect(after.facts[0]).toEqual(fact(1, { text: 'sharper', importance: 2, lastSeenTurn: 20 }))
    expect(after.facts.length).toBe(2)
  })

  test('factsReplace leaves a protected fact unchanged and adds the new text as a new fact', () => {
    const pinned = fact(1, { pin: 'session' })
    const before: Snapshot = { glossary: [], bearings: bearingsWith([pinned]) }
    const after = applyDelta(before, delta({ factsReplace: [{ id: 'f1', text: 'other', importance: 2 }] }), 20).bearings!
    expect(after.facts[0]).toEqual(pinned)
    expect(after.facts[1]).toMatchObject({ id: 'f1000', text: 'other', importance: 2, pin: 'none', source: 'auto' })
  })

  test('factsReplace on a repo fact makes it the conversation\'s', () => {
    const before: Snapshot = { glossary: [], bearings: bearingsWith([fact(1, { source: 'repo' })]) }
    const after = applyDelta(before, delta({ factsReplace: [{ id: 'f1', text: 'corrected', importance: 2 }] }), 20).bearings!
    expect(after.facts[0]?.source).toBe('auto')
  })

  test('factsReplace with an unknown id changes nothing', () => {
    const before: Snapshot = { glossary: [], bearings: bearingsWith([fact(1)]) }
    expect(applyDelta(before, delta({ factsReplace: [{ id: 'f9', text: 'x', importance: 2 }] }), 20).bearings?.facts).toEqual([fact(1)])
  })

  test('a scan adds facts marked repo, with ids', () => {
    const scanned = applyScanDelta({ glossary: [], bearings: null }, delta({ factsAdd: [{ text: 'from the readme', importance: 2 }] }), 0).bearings!
    expect(scanned.facts).toEqual([{ id: 'f1', text: 'from the readme', lastSeenTurn: 0, pin: 'none', source: 'repo', importance: 2, mentions: 0 }])
  })

  test('a rebuild ignores factsReplace and factsRank in its replies', () => {
    const before: Snapshot = { glossary: [], bearings: bearingsWith([fact(1)]) }
    const reply = JSON.stringify({ bearings: { factsAdd: ['new'], factsReplace: [{ id: 'f1', text: 'changed', importance: 3 }], factsRank: { hold: ['f1'], recent: [] } } })
    const after = applyRebuildReply(before, emptyStats(), { isAnswered: true, text: reply, usage }, 11).snapshot.bearings!
    expect(after.facts.map(one => one.text)).toEqual(['fact 1', 'new'])
    expect(after.factRank).toBeUndefined()
  })

  test('the scan prompt sees the shortlist', () => {
    const snapshot: Snapshot = { glossary: [], bearings: bearingsWith(numbered(45, { lastSeenTurn: 1 })) }
    const facts = (JSON.parse(/<current>\n(.*)\n<\/current>/.exec(scanPrompt(snapshot, [], 10))![1]!) as { bearings: { facts: string[]; olderFactCount: number } }).bearings
    expect(facts.facts.length).toBe(SHORTLIST_SIZE)
    expect(facts.olderFactCount).toBe(5)
  })
})

describe('the mention check', () => {
  const shownNothing = new Set<string>()

  test('one distinctive token of 6 or more characters counts as a mention', () => {
    const bearings = bearingsWith([fact(1, { text: 'the limit lives in hooks/merge.ts' })])
    const after = markMentionedFacts(bearings, shownNothing, 'I changed `hooks/merge.ts` today.', 15)
    expect(after.facts[0]).toMatchObject({ lastSeenTurn: 15, mentions: 1 })
  })

  test('tokens of 4 or 5 characters need two matches', () => {
    const bearings = bearingsWith([fact(1, { text: 'use v1.2 with 3.14 here' })])
    expect(markMentionedFacts(bearings, shownNothing, 'we use v1.2', 15).facts[0]?.mentions).toBe(0)
    expect(markMentionedFacts(bearings, shownNothing, 'v1.2 and 3.14 agree.', 15).facts[0]?.mentions).toBe(1)
  })

  test('a fact made only of plain words never matches, even word for word', () => {
    const text = 'the operator prefers small careful commits'
    const after = markMentionedFacts(bearingsWith([fact(1, { text })]), shownNothing, text, 15)
    expect(after.facts[0]).toEqual(fact(1, { text }))
  })

  test('a fact the update call saw is left to the call, so it is not counted twice', () => {
    const before: Snapshot = { glossary: [], bearings: bearingsWith([fact(1, { text: 'see hooks/merge.ts' }), fact(2, { text: 'see hooks/facts.ts' })]) }
    const reply = JSON.stringify({ bearings: { factsSeen: ['f1'] } })
    const context = { knownTerms: [], ranking: 'mechanical' as const, shownFactIds: new Set(['f1']), turnText: 'hooks/merge.ts and hooks/facts.ts' }
    const after = applyBackgroundUpdate(before, emptyStats(), { isAnswered: true, text: reply, usage }, 12, context).snapshot.bearings!
    expect(after.facts.map(one => one.mentions)).toEqual([1, 1])
  })

  test('a fact the reply just added is not counted as mentioned by the turn it came from', () => {
    const before: Snapshot = { glossary: [], bearings: bearingsWith([]) }
    const reply = JSON.stringify({ bearings: { factsAdd: ['the limit lives in hooks/merge.ts'] } })
    const context = { knownTerms: [], ranking: 'mechanical' as const, shownFactIds: new Set<string>(), turnText: 'I changed hooks/merge.ts' }
    const after = applyBackgroundUpdate(before, emptyStats(), { isAnswered: true, text: reply, usage }, 12, context).snapshot.bearings!
    expect(after.facts[0]?.mentions).toBe(0)
  })

  test('a fact re-added by its text gets one mention for the turn, not two', () => {
    const text = 'the limit lives in hooks/merge.ts'
    const before: Snapshot = { glossary: [], bearings: bearingsWith([fact(1, { text })]) }
    const reply = JSON.stringify({ bearings: { factsAdd: [text] } })
    const context = { knownTerms: [], ranking: 'mechanical' as const, shownFactIds: new Set<string>(), turnText: 'I changed hooks/merge.ts' }
    const after = applyBackgroundUpdate(before, emptyStats(), { isAnswered: true, text: reply, usage }, 12, context).snapshot.bearings!
    expect(after.facts[0]?.mentions).toBe(1)
  })

  test('a mention keeps a fact from being pruned that turn', () => {
    const before: Snapshot = { glossary: [], bearings: bearingsWith([fact(1, { text: 'see hooks/merge.ts', lastSeenTurn: 1 })]) }
    const context = { knownTerms: [], ranking: 'mechanical' as const, shownFactIds: new Set<string>(), turnText: 'hooks/merge.ts' }
    const after = applyBackgroundUpdate(before, emptyStats(), { isAnswered: true, text: '{}', usage }, 31, context).snapshot.bearings!
    expect(after.facts.length).toBe(1)
  })
})

describe('pruning', () => {
  test('an importance 3 fact survives 30 unseen turns; an importance 2 fact does not', () => {
    const snapshot: Snapshot = { glossary: [], bearings: bearingsWith([fact(1, { importance: 3, lastSeenTurn: 1 }), fact(2, { importance: 2, lastSeenTurn: 1 })]) }
    expect(idsOf(pruneStale(snapshot, 31, []).bearings!.facts)).toEqual(['f1'])
  })
})

describe('the llm rank', () => {
  const facts = [...numbered(12, { importance: 2 }), ...numbered(12, {}, 100)]

  test('the tiers follow the rank while it belongs to the latest update', () => {
    const bearings = bearingsWith(facts, { factRank: { turn: 10, hold: ['f105', 'f2'], recent: ['f106'] } })
    const tiers = factTiers(bearings, 10, 'llm')
    expect(idsOf(tiers.hold)).toEqual(['f105', 'f2'])
    expect(idsOf(tiers.recent)).toEqual(['f106'])
    expect(tiers.earlier.length).toBe(facts.length - 3)
  })

  test('a rank from an earlier turn, or none, falls back to the scores', () => {
    const mechanical = mechanicalTiers(facts, 10)
    expect(factTiers(bearingsWith(facts, { factRank: { turn: 9, hold: ['f105'], recent: [] } }), 10, 'llm')).toEqual(mechanical)
    expect(factTiers(bearingsWith(facts), 10, 'llm')).toEqual(mechanical)
  })

  test('mechanical ranking ignores a rank even when it is current', () => {
    const bearings = bearingsWith(facts, { factRank: { turn: 10, hold: ['f105'], recent: ['f106'] } })
    const mechanical = mechanicalTiers(facts, 10)
    expect(factTiers(bearings, 10, 'mechanical')).toEqual(mechanical)
    expect(idsOf(factsForUpdate(bearings, 10, 'mechanical'))).toEqual(idsOf([...mechanical.hold, ...mechanical.recent]))
  })

  test('a stored rank none of whose ids is left in the pool falls back to the scores', () => {
    const bearings = bearingsWith(facts, { factRank: { turn: 10, hold: ['f990'], recent: ['f991'] } })
    expect(factTiers(bearings, 10, 'llm')).toEqual(mechanicalTiers(facts, 10))
  })

  test('a reply whose rank names no fact in the pool stores no rank, even with new facts beside it', () => {
    const before: Snapshot = { glossary: [], bearings: bearingsWith([fact(1)], { nextFactId: 2 }) }
    expect(applyDelta(before, delta({ factsRank: { hold: [], recent: [] } }), 11).bearings?.factRank).toBeUndefined()
    expect(applyDelta(before, delta({ factsRank: { hold: ['f77'], recent: [] } }), 11).bearings?.factRank).toBeUndefined()
    expect(applyDelta(before, delta({ factsAdd: [{ text: 'new', importance: 3 }], factsRank: { hold: [], recent: [] } }), 11).bearings?.factRank).toBeUndefined()
  })

  test('factsRank accepts entries written the way the prompt shows them, and drops those with no id', () => {
    expect(parsedBearings({ factsRank: { hold: ['f12 (3)', 'f4', 'no id here'], recent: ['f9 (1): the text of it'] } }).factsRank).toEqual({ hold: ['f12', 'f4'], recent: ['f9'] })
  })

  test('ids no longer in the pool are skipped, a repeated id counts once, and a fact is in one tier only', () => {
    const bearings = bearingsWith(facts, { factRank: { turn: 10, hold: ['f999', 'f1', 'f1'], recent: ['f1', 'f2'] } })
    const tiers = factTiers(bearings, 10, 'llm')
    expect(idsOf(tiers.hold)).toEqual(['f1'])
    expect(idsOf(tiers.recent)).toEqual(['f2'])
  })

  test('pinned facts stay in Hold whatever the rank says, and the limits hold', () => {
    const pinned = fact(500, { pin: 'session', lastSeenTurn: 1 })
    const manyIds = numbered(12).map(one => one.id)
    const bearings = bearingsWith([...facts, pinned], { factRank: { turn: 10, hold: manyIds, recent: ['f500', 'f100'] } })
    const tiers = factTiers(bearings, 10, 'llm')
    expect(idsOf(tiers.hold)[0]).toBe('f500')
    expect(tiers.hold.length).toBe(HOLD_LIMIT)
    expect(idsOf(tiers.recent)).toEqual(['f100'])
  })

  test('a fact added in the same reply: importance 3 first in Hold, the others first in Recent, trimmed to the limits', () => {
    const ranked = { hold: numbered(HOLD_LIMIT).map(one => one.id), recent: numbered(RECENT_LIMIT, {}, 100).map(one => one.id) }
    const added = [fact(900, { importance: 3 }), fact(901), fact(902, { importance: 2 })]
    const rank = factRankFrom(ranked, added, 10)
    expect(rank.hold[0]).toBe('f900')
    expect(rank.hold.length).toBe(HOLD_LIMIT)
    expect(rank.recent.slice(0, 2)).toEqual(['f901', 'f902'])
    expect(rank.recent.length).toBe(RECENT_LIMIT)
  })

  test('applying a reply builds the rank with its new facts placed; without factsRank no rank is written', () => {
    const before: Snapshot = { glossary: [], bearings: bearingsWith([fact(1)], { nextFactId: 2 }) }
    const applied = applyDelta(before, delta({ factsAdd: [{ text: 'new', importance: 3 }], factsRank: { hold: ['f1'], recent: [] } }), 11).bearings!
    expect(applied.factRank).toEqual({ turn: 11, hold: ['f2', 'f1'], recent: [] })
    expect(applyDelta(before, delta({ factsAdd: [{ text: 'new', importance: 3 }] }), 11).bearings?.factRank).toBeUndefined()
  })

  test('factsRank that is not two lists counts as no rank, and the rest of the reply still applies', () => {
    expect(parsedBearings({ factsRank: 'all of them', inProgress: ['x'] })).toEqual({ inProgress: ['x'] })
    expect(parsedBearings({ factsRank: { hold: 'f1' } }).factsRank).toBeUndefined()
  })

  test('the update prompt with llm ranking shows at most the shortlist', () => {
    const snapshot: Snapshot = { glossary: [], bearings: bearingsWith(numbered(45, { lastSeenTurn: 1 })) }
    const facts = (JSON.parse(/<current>\n(.*)\n<\/current>/.exec(updatePrompt(snapshot, [], 10, 'llm'))![1]!) as { bearings: { facts: string[] } }).bearings.facts
    expect(facts.length).toBe(SHORTLIST_SIZE)
  })
})

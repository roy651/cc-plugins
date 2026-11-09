import { expect, test } from 'claude-code/testing'

import type { GlossaryEntry } from '../types'
import { isNew, pruneStale, splitByRecency } from '../hooks/retention'
import { emptyBearings } from '../hooks/merge'
import type { Fact } from '../types'

function seenAt(term: string, lastSeenTurn: number, pin: GlossaryEntry['pin'] = 'none'): GlossaryEntry {
  return { term, meaning: 'm', firstTurn: 1, lastSeenTurn, pin, source: 'auto' }
}

test('an entry stays in the main list for 30 turns after it was last seen, then folds into Earlier', () => {
  const entries = [seenAt('A', 10), seenAt('B', 11)]

  const atTurn39 = splitByRecency(entries, 39)
  expect(atTurn39.recent.map(one => one.term)).toEqual(['A', 'B'])

  const atTurn40 = splitByRecency(entries, 40)
  expect(atTurn40.recent.map(one => one.term)).toEqual(['B'])
  expect(atTurn40.earlier.map(one => one.term)).toEqual(['A'])
})

test('a pinned entry never folds', () => {
  const split = splitByRecency([seenAt('S', 1, 'session'), seenAt('P', 1, 'project')], 500)
  expect(split.earlier).toEqual([])
})

test('"new" means first seen in the last 3 turns, never inherited', () => {
  const entry = { firstTurn: 8, source: 'auto' }
  expect(isNew(entry, 10)).toBe(true)
  expect(isNew(entry, 11)).toBe(false)
  expect(isNew({ firstTurn: 0, source: 'inherited' }, 0)).toBe(false)
})

function factSeenAt(text: string, lastSeenTurn: number, extra: Partial<Fact> = {}): Fact {
  return { id: `id of ${text}`, text, lastSeenTurn, pin: 'none', source: 'auto', importance: 1, mentions: 0, ...extra }
}

test('an automatic term or fact unseen for 30 turns is deleted; at 29 it stays', () => {
  const snapshot = {
    glossary: [seenAt('OLD', 10), seenAt('KEEP', 11)],
    bearings: { ...emptyBearings(), facts: [factSeenAt('old fact', 10), factSeenAt('kept fact', 11)] },
  }
  const pruned = pruneStale(snapshot, 40, [])
  expect(pruned.glossary.map(one => one.term)).toEqual(['KEEP'])
  expect(pruned.bearings?.facts.map(one => one.text)).toEqual(['kept fact'])
})

test('pinned items, items added on request, and known terms are never pruned; repo and inherited ones are', () => {
  const snapshot = {
    glossary: [
      seenAt('PINNED', 1, 'session'),
      { ...seenAt('BY_OPERATOR', 1), source: 'operator' as const },
      { ...seenAt('BY_CLAUDE', 1), source: 'claude' as const },
      seenAt('KNOWN', 1),
      { ...seenAt('FROM_REPO', 1), source: 'repo' as const },
      { ...seenAt('INHERITED', 1), source: 'inherited' as const },
    ],
    bearings: {
      ...emptyBearings(),
      facts: [factSeenAt('pinned', 1, { pin: 'project' }), factSeenAt('by operator', 1, { source: 'operator' }), factSeenAt('repo', 1, { source: 'repo' })],
    },
  }
  const pruned = pruneStale(snapshot, 500, ['known'])
  expect(pruned.glossary.map(one => one.term)).toEqual(['PINNED', 'BY_OPERATOR', 'BY_CLAUDE', 'KNOWN'])
  expect(pruned.bearings?.facts.map(one => one.text)).toEqual(['pinned', 'by operator'])
})

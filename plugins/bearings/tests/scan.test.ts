import { describe, expect, test } from 'claude-code/testing'

import type { GlossaryEntry } from '../types'
import { factTiers } from '../hooks/facts'
import { bearingsSections, glossaryLine, heldFactSections } from '../hooks/markdown'
import { applyDelta, applyScanDelta, emptyBearings, isLean } from '../hooks/merge'
import type { Delta, Snapshot } from '../hooks/merge'
import { conversationText, transcriptChunks } from '../hooks/prompts'
import { fitToBudget, pickReadme, SCAN_INPUT_LIMIT } from '../hooks/scan'

function delta(glossary: Partial<Delta['glossary']>, bearings: Delta['bearings'] = {}): Delta {
  return { glossary: { upsert: [], seen: [], ...glossary }, bearings }
}

function entry(term: string, meaning: string, extra: Partial<GlossaryEntry> = {}): GlossaryEntry {
  return { term, meaning, firstTurn: 1, lastSeenTurn: 1, pin: 'none', source: 'auto', ...extra }
}

describe('the scan budget', () => {
  test('sources keep their order and fit 30,000 characters in all; short ones whole, long ones cut evenly', () => {
    const sources = [
      { name: '.claude/handoff.md', text: 'h'.repeat(50_000) },
      { name: 'CLAUDE.md', text: 'c'.repeat(2_000) },
      { name: 'README.md', text: 'r'.repeat(50_000) },
      { name: 'top-level files', text: 'f'.repeat(1_000) },
    ]
    const fitted = fitToBudget(sources)

    expect(fitted.map(one => one.name)).toEqual(['.claude/handoff.md', 'CLAUDE.md', 'README.md', 'top-level files'])
    expect(fitted.reduce((sum, one) => sum + one.text.length, 0)).toBe(SCAN_INPUT_LIMIT)
    expect(fitted.map(one => one.text.length)).toEqual([13_500, 2_000, 13_500, 1_000])
    expect(fitted.map(one => one.isCut === true)).toEqual([true, false, true, false])
  })

  test('an uneven split gives the remainder to the earlier source', () => {
    const fitted = fitToBudget([{ name: 'a', text: 'a'.repeat(100) }, { name: 'b', text: 'b'.repeat(100) }], 11)
    expect(fitted.map(one => one.text.length)).toEqual([6, 5])
  })

  test('README.md is preferred, else the first README* by name', () => {
    expect(pickReadme(['README.rst', 'README.md'])).toBe('README.md')
    expect(pickReadme(['src', 'readme.txt', 'README.rst'])).toBe('README.rst')
    expect(pickReadme(['src'])).toBeNull()
  })
})

describe('repo items', () => {
  test('a scan lands as repo items, fills only empty fields, and shows "(from repo)"', () => {
    const before: Snapshot = { glossary: [], bearings: { ...emptyBearings(), inProgress: ['from the conversation'] } }
    const scanned = applyScanDelta(before, delta(
      { upsert: [{ term: 'ReTraj', meaning: 'the trajectory re-ranking stage' }] },
      { goal: 'ship the plugin', inProgress: ['repo says this'], expectedNext: ['publish'], factsAdd: [{ text: 'the marketplace is cc-plugins', importance: 1 }] },
    ), 0)

    expect(scanned.glossary[0]?.source).toBe('repo')
    expect(scanned.bearings?.goal).toBe('ship the plugin')
    expect(scanned.bearings?.inProgress).toEqual(['from the conversation'])
    expect(scanned.bearings?.facts[0]?.source).toBe('repo')
    expect(scanned.bearings?.repoFields?.sort()).toEqual(['expectedNext', 'goal'])

    expect(glossaryLine(scanned.glossary[0]!)).toBe('- **ReTraj**: the trajectory re-ranking stage (from repo)')
    const markdown = bearingsSections(scanned.bearings!, heldFactSections(factTiers(scanned.bearings!, 0, 'mechanical')))
    expect(markdown).toContain('## Goal\nship the plugin (from repo)')
    expect(markdown).toContain('- publish (from repo)')
    expect(markdown).toContain('- from the conversation\n')
    expect(markdown).toContain('- the marketplace is cc-plugins (from repo)')
  })

  test('a later update replaces repo items; the replaced ones lose the mark', () => {
    const scanned = applyScanDelta({ glossary: [], bearings: null }, delta(
      { upsert: [{ term: 'ReTraj', meaning: 'repo meaning' }] },
      { goal: 'repo goal', factsAdd: [{ text: 'repo fact', importance: 1 }] },
    ), 0)
    const updated = applyDelta(scanned, delta(
      { upsert: [{ term: 'ReTraj', meaning: 'what the conversation says' }] },
      { goal: 'conversation goal', factsAdd: [{ text: 'repo fact', importance: 1 }] },
    ), 4)

    expect(updated.glossary[0]).toEqual(entry('ReTraj', 'what the conversation says', { firstTurn: 0, lastSeenTurn: 4 }))
    expect(updated.bearings?.goal).toBe('conversation goal')
    expect(updated.bearings?.repoFields).toEqual([])
    expect(updated.bearings?.facts[0]?.source).toBe('auto')
  })

  test('a scan never overwrites a pinned or a non-repo entry, nor a field the conversation set', () => {
    const before: Snapshot = {
      glossary: [entry('PIN', 'pinned words', { pin: 'session', source: 'repo' }), entry('CONV', 'conversation words')],
      bearings: { ...emptyBearings(), goal: 'conversation goal' },
    }
    const scanned = applyScanDelta(before, delta(
      { upsert: [{ term: 'PIN', meaning: 'scan words' }, { term: 'CONV', meaning: 'scan words' }] },
      { goal: 'scan goal' },
    ), 2)
    expect(scanned.glossary.map(one => one.meaning)).toEqual(['pinned words', 'conversation words'])
    expect(scanned.bearings?.goal).toBe('conversation goal')
  })

  test('lean means no goal, or fewer than 3 items across sub-goals, in progress, next and facts', () => {
    expect(isLean(null)).toBe(true)
    expect(isLean({ ...emptyBearings(), inProgress: ['a', 'b', 'c'] })).toBe(true)
    expect(isLean({ ...emptyBearings(), goal: 'g', inProgress: ['a', 'b'] })).toBe(true)
    expect(isLean({ ...emptyBearings(), goal: 'g', inProgress: ['a', 'b'], expectedNext: ['c'] })).toBe(false)
  })
})

test('slash-command rows are not conversation: a transcript of only them folds to nothing', () => {
  const commandRows = [
    { role: 'user' as const, text: '<local-command-caveat>The command below was run directly in Claude Code.</local-command-caveat>' },
    { role: 'user' as const, text: '<command-name>/bearings</command-name>\n  <command-message>bearings</command-message>\n  <command-args>rebuild</command-args>' },
  ]
  expect(transcriptChunks(commandRows)).toEqual([])
  expect(conversationText('<command-name>/x</command-name> and a real question')).toBe('and a real question')
})

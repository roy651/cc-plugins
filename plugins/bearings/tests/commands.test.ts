import { describe, expect, test } from 'claude-code/testing'

import { applyKnownCommand, applyPaneCommand, applyToolAdd, parsePaneCommand, toolKnownCommand } from '../hooks/commands'
import { emptyBearings, mergeProjectPins, projectPinsOf } from '../hooks/merge'
import type { Snapshot } from '../hooks/merge'

const base: Snapshot = {
  glossary: [{ term: 'FMA', meaning: 'failure mechanism analyzer', firstTurn: 1, lastSeenTurn: 1, pin: 'none', source: 'auto' }],
  bearings: { ...emptyBearings(), facts: [{ id: 'f0', text: 'Temperature is 0.1 for runs', lastSeenTurn: 1, pin: 'none', source: 'auto', importance: 1, mentions: 0 }] },
}

describe('parsePaneCommand', () => {
  test('reads add: and fact: lines', () => {
    expect(parsePaneCommand('add: S4 = the ReTraj stage four')).toEqual({ kind: 'add', term: 'S4', meaning: 'the ReTraj stage four' })
    expect(parsePaneCommand('  ADD:x=y=z ')).toEqual({ kind: 'add', term: 'x', meaning: 'y=z' })
    expect(parsePaneCommand('fact: the VM has 64 GiB')).toEqual({ kind: 'fact', text: 'the VM has 64 GiB' })
  })

  test('reads the pin commands', () => {
    expect(parsePaneCommand('pin: FMA')).toEqual({ kind: 'pin', target: 'FMA', pin: 'session' })
    expect(parsePaneCommand('pin project: FMA')).toEqual({ kind: 'pin', target: 'FMA', pin: 'project' })
    expect(parsePaneCommand('unpin: FMA')).toEqual({ kind: 'unpin', target: 'FMA' })
  })

  test('anything else is no command', () => {
    expect(parsePaneCommand('what is FMA?')).toBeNull()
    expect(parsePaneCommand('add: no equals sign')).toBeNull()
  })
})

describe('applyPaneCommand', () => {
  test('pin, pin project and unpin a term', () => {
    const pinned = applyPaneCommand(base, { kind: 'pin', target: 'fma', pin: 'session' }, 2)
    expect(pinned.snapshot.glossary[0]?.pin).toBe('session')

    const projectPinned = applyPaneCommand(pinned.snapshot, { kind: 'pin', target: 'FMA', pin: 'project' }, 2)
    expect(projectPinned.snapshot.glossary[0]?.pin).toBe('project')
    expect(projectPinsOf(projectPinned.snapshot).glossary.map(one => one.term)).toEqual(['FMA'])

    const unpinned = applyPaneCommand(projectPinned.snapshot, { kind: 'unpin', target: 'FMA' }, 2)
    expect(unpinned.snapshot.glossary[0]?.pin).toBe('none')
    expect(projectPinsOf(unpinned.snapshot).glossary).toEqual([])
  })

  test('a pin falls back to a fact that starts with the text', () => {
    const result = applyPaneCommand(base, { kind: 'pin', target: 'temperature', pin: 'session' }, 2)
    expect(result.snapshot.bearings?.facts[0]?.pin).toBe('session')
  })

  test('a pin that matches nothing says so and changes nothing', () => {
    const result = applyPaneCommand(base, { kind: 'pin', target: 'nothing like it', pin: 'session' }, 2)
    expect(result.snapshot).toEqual(base)
    expect(result.message).toContain('No term or fact')
  })

  test('add: and fact: are marked as the operator\'s', () => {
    const added = applyPaneCommand(base, { kind: 'add', term: 'FMA', meaning: 'my own words' }, 5)
    expect(added.snapshot.glossary[0]).toEqual({ term: 'FMA', meaning: 'my own words', firstTurn: 1, lastSeenTurn: 5, pin: 'none', source: 'operator' })

    const fact = applyPaneCommand(base, { kind: 'fact', text: 'ssh to the VM is allowed' }, 5)
    expect(fact.snapshot.bearings?.facts[1]).toEqual({
      id: 'f1', text: 'ssh to the VM is allowed', lastSeenTurn: 5, pin: 'none', source: 'operator', importance: 1, mentions: 0,
    })
  })
})

describe('project pins', () => {
  test('stored project pins load over a session, the stored meaning winning', () => {
    const stored = { glossary: [{ term: 'FMA', meaning: 'pinned words', firstTurn: 0, lastSeenTurn: 0, pin: 'project' as const, source: 'operator' as const }], facts: [] }
    const merged = mergeProjectPins(base, stored)
    expect(merged.glossary).toEqual(stored.glossary)
  })

  test('no pins on an empty session leaves it empty', () => {
    expect(mergeProjectPins({ glossary: [], bearings: null }, { glossary: [], facts: [] })).toEqual({ glossary: [], bearings: null })
  })
})

describe('applyToolAdd', () => {
  test('adds a term marked as the main model\'s, pinned when asked', () => {
    const result = applyToolAdd(base, { term: 'D15', meaning: 'the new tokens column', pin: 'project' }, 3)
    if ('error' in result) throw new Error(result.error)
    expect(result.snapshot.glossary[1]).toEqual({ term: 'D15', meaning: 'the new tokens column', firstTurn: 3, lastSeenTurn: 3, pin: 'project', source: 'claude' })
  })

  test('refuses input it cannot use', () => {
    expect('error' in applyToolAdd(base, { term: 'X' }, 1)).toBe(true)
    expect('error' in applyToolAdd(base, {}, 1)).toBe(true)
    expect('error' in applyToolAdd(base, { fact: 'f', pin: 'forever' }, 1)).toBe(true)
  })
})

describe('known terms', () => {
  test('reads known: and unknown: lines', () => {
    expect(parsePaneCommand('known: FMA')).toEqual({ kind: 'known', term: 'FMA' })
    expect(parsePaneCommand('Unknown:  FMA ')).toEqual({ kind: 'unknown', term: 'FMA' })
  })

  test('marking adds the term once; a term not in the glossary yet can be marked', () => {
    const marked = applyKnownCommand([], base.glossary, { kind: 'known', term: 'FMA' })
    expect(marked).toEqual({ knownTerms: ['FMA'], message: 'Marked "FMA" as known: hidden from the glossary pane.' })

    const again = applyKnownCommand(['FMA'], base.glossary, { kind: 'known', term: 'fma' })
    expect(again).toEqual({ knownTerms: ['FMA'], message: '"fma" is already known.' })

    const absent = applyKnownCommand([], base.glossary, { kind: 'known', term: 'BME' })
    expect(absent.message).toBe('Marked "BME" as known: hidden from the glossary pane. It is not in the glossary yet.')
  })

  test('unknown takes the mark off, matching case-insensitively', () => {
    expect(applyKnownCommand(['FMA', 'BME'], base.glossary, { kind: 'unknown', term: 'fma' }))
      .toEqual({ knownTerms: ['BME'], message: '"fma" shows in the glossary pane again.' })
    expect(applyKnownCommand([], base.glossary, { kind: 'unknown', term: 'FMA' }).message).toBe('"FMA" is not marked known.')
  })

  test('the tool input names a known command with "known" or "unknown", else none', () => {
    expect(toolKnownCommand({ known: ' FMA ' })).toEqual({ kind: 'known', term: 'FMA' })
    expect(toolKnownCommand({ unknown: 'FMA' })).toEqual({ kind: 'unknown', term: 'FMA' })
    expect(toolKnownCommand({ term: 'FMA', meaning: 'x' })).toBeNull()
  })
})

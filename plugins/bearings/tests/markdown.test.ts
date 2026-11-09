import { expect, test } from 'claude-code/testing'

import { bearingsSections, changedAgo, PRINTED_VIEW_LIMIT, printedView } from '../hooks/markdown'
import { emptyBearings } from '../hooks/merge'
import type { Snapshot } from '../hooks/merge'
import { transcriptChunks } from '../hooks/prompts'

const snapshot: Snapshot = {
  glossary: [{ term: 'S4', meaning: 'stage four', firstTurn: 2, lastSeenTurn: 2, pin: 'none', source: 'auto' }],
  bearings: { ...emptyBearings(), goal: 'ship it' },
}

test('a printed view is that view\'s part of the .md file', () => {
  expect(printedView('glossary', snapshot, '/f/s.md', 'mechanical')).toBe('# Glossary\n\n- **S4**: stage four (T2)\n')
  expect(printedView('bearings', snapshot, '/f/s.md', 'mechanical').startsWith('# Bearings\n\n## Goal\nship it')).toBe(true)
})

test('a long printed view is cut, its last line naming the .md file', () => {
  const long: Snapshot = { ...snapshot, bearings: { ...emptyBearings(), goal: 'g'.repeat(20_000) } }
  const text = printedView('bearings', long, '/f/s.md', 'mechanical')
  expect(text.length).toBeLessThan(PRINTED_VIEW_LIMIT + 200)
  expect(text.split('\n').at(-1)).toBe(`... cut at ${PRINTED_VIEW_LIMIT} characters. The rest is in /f/s.md`)
})

test('the transcript packs into chunks in order, a long message cut across chunks, empty ones left out', () => {
  const chunks = transcriptChunks([
    { role: 'user', text: 'a'.repeat(20) },
    { role: 'assistant', text: '' },
    { role: 'assistant', text: 'b'.repeat(20) },
    { role: 'user', text: 'c'.repeat(150) },
  ], 100)
  expect(chunks.every(chunk => chunk.length <= 100)).toBe(true)
  expect(chunks[0]).toBe(`<operator>\n${'a'.repeat(20)}\n</operator>\n<assistant>\n${'b'.repeat(20)}\n</assistant>`)
  expect(chunks.slice(1).join('')).toBe(`<operator>\n${'c'.repeat(150)}\n</operator>`)
})

test('with the current turn, a heading whose field recorded a change says how long ago', () => {
  const bearings = { ...emptyBearings(), goal: 'ship it', inProgress: ['tests'], changedAtTurn: { inProgress: 7 } }
  const pane = bearingsSections(bearings, [], 10)
  expect(pane).toContain('## In progress (changed 3 turns ago)\n- tests')
  expect(pane).toContain('## Goal\nship it')
  expect(bearingsSections(bearings, [])).toContain('## In progress\n- tests')
})

test('the change age reads this turn, 1 turn, N turns', () => {
  expect(changedAgo(5, 5)).toBe('changed this turn')
  expect(changedAgo(4, 5)).toBe('changed 1 turn ago')
  expect(changedAgo(1, 5)).toBe('changed 4 turns ago')
})

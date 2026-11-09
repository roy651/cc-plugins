import { expect, test } from 'claude-code/testing'

import { emptyBearings } from '../hooks/merge'
import type { Snapshot } from '../hooks/merge'
import { RANKING_UPDATE_SYSTEM, REBUILD_SYSTEM, SCAN_SYSTEM, updatePrompt, UPDATE_SYSTEM } from '../hooks/prompts'

const snapshot: Snapshot = {
  glossary: [{ term: 'FMA', meaning: 'failure mechanism analyzer', firstTurn: 1, lastSeenTurn: 1, pin: 'none', source: 'auto' }],
  bearings: {
    ...emptyBearings(),
    goal: 'ship it',
    facts: [
      { id: 'f1', text: 'seen at turn 39', lastSeenTurn: 39, pin: 'none', source: 'auto', importance: 1, mentions: 0 },
      { id: 'f2', text: 'seen at turn 10', lastSeenTurn: 10, pin: 'none', source: 'auto', importance: 1, mentions: 0 },
      { id: 'f3', text: 'pinned at turn 2', lastSeenTurn: 2, pin: 'session', source: 'auto', importance: 1, mentions: 0 },
    ],
  },
}

function currentState(prompt: string): { glossaryTerms: string[]; bearings: { facts: string[]; olderFactCount: number } } {
  return JSON.parse(/<current>\n(.*)\n<\/current>/.exec(prompt)![1]!)
}

test('the update sends glossary term names without meanings', () => {
  const prompt = updatePrompt(snapshot, [], 40, 'mechanical')
  expect(currentState(prompt).glossaryTerms).toEqual(['FMA'])
  expect(prompt).not.toContain('failure mechanism analyzer')
})

test('with mechanical ranking the update sends Hold and Recent as id (importance): text and counts the rest', () => {
  const state = currentState(updatePrompt(snapshot, [], 40, 'mechanical'))
  expect(state.bearings.facts).toEqual(['f3 (1): pinned at turn 2', 'f1 (1): seen at turn 39'])
  expect(state.bearings.olderFactCount).toBe(1)
})

test('with llm ranking the update sends the longer shortlist', () => {
  const state = currentState(updatePrompt(snapshot, [], 40, 'llm'))
  expect(state.bearings.facts).toEqual(['f3 (1): pinned at turn 2', 'f1 (1): seen at turn 39', 'f2 (1): seen at turn 10'])
  expect(state.bearings.olderFactCount).toBe(0)
})

test('each prompt names only the fact fields its call may answer', () => {
  expect(UPDATE_SYSTEM).toContain('"factsReplace"')
  expect(UPDATE_SYSTEM).not.toContain('"factsRank"')
  expect(RANKING_UPDATE_SYSTEM).toContain('"factsRank"')
  for (const system of [SCAN_SYSTEM, REBUILD_SYSTEM]) {
    expect(system).not.toContain('"factsReplace"')
    expect(system).not.toContain('"factsRank"')
    expect(system).toContain('"factsAdd": [{ "text": "...", "importance": 1 }]')
  }
})

test('only the llm prompt requires factsRank, in every reply, as an exception to changed fields only', () => {
  expect(RANKING_UPDATE_SYSTEM).toContain('Always include "factsRank" in every reply, as the exception to "Include any other field only when it changes"')
  expect(RANKING_UPDATE_SYSTEM).toContain('restate it even when the order has not changed')
  for (const system of [UPDATE_SYSTEM, REBUILD_SYSTEM, SCAN_SYSTEM]) expect(system).not.toContain('factsRank')
})

test('the update prompts require openDecisions every turn and say when to drop a question; rebuild and scan do not', () => {
  for (const system of [UPDATE_SYSTEM, RANKING_UPDATE_SYSTEM]) {
    expect(system).toContain('Always include "openDecisions" as well, as the exception to "Include any other field only when it changes"')
    expect(system).toContain('Drop a question once it is answered, overtaken by events or no longer relevant, and keep it while it is still waiting on the operator')
  }
  for (const system of [REBUILD_SYSTEM, SCAN_SYSTEM]) expect(system).not.toContain('Always include "openDecisions"')
})

test('the importance scale is in every prompt that adds facts', () => {
  for (const system of [UPDATE_SYSTEM, RANKING_UPDATE_SYSTEM, REBUILD_SYSTEM, SCAN_SYSTEM]) {
    expect(system).toContain('Most new facts are 1')
  }
})

test('the update rules ask for inProgress every time and cap two lists at 10', () => {
  expect(UPDATE_SYSTEM).toContain('always include "inProgress", restated from the newest turns even when it has not changed')
  expect(UPDATE_SYSTEM).toContain('"subGoals" and "expectedNext" hold at most 10 items each: drop items that are done and merge near-duplicates')
})

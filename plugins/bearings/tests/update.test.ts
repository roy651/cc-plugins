import { expect, test } from 'claude-code/testing'
import type { ModelUsage } from 'claude-code'

import { emptyBearings } from '../hooks/merge'
import type { Snapshot } from '../hooks/merge'
import { applyBackgroundUpdate, applyRebuildReply, emptyStats, failureLogLine } from '../hooks/update'

const usage: ModelUsage = { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 5, cache_creation_input_tokens: 10 }

const before: Snapshot = {
  glossary: [{ term: 'FMA', meaning: 'failure mechanism analyzer', firstTurn: 1, lastSeenTurn: 1, pin: 'none', source: 'auto' }],
  bearings: { ...emptyBearings(), goal: 'ship the mod' },
}

test('a malformed reply keeps the state and counts one failure', () => {
  const outcome = applyRebuildReply(before, emptyStats(), { isAnswered: true, text: 'Sure! Here is the delta: {not json', usage }, 2)
  expect(outcome.snapshot).toBe(before)
  expect(outcome.failure).not.toBeNull()
  expect(outcome.stats).toEqual({ calls: 1, failures: 1, inputTokens: 110, outputTokens: 20, cacheReadTokens: 5 })
})

test('an unanswered call keeps the state and counts one failure', () => {
  const outcome = applyRebuildReply(before, emptyStats(), { isAnswered: false, reason: 'api-error', status: 529, error: 'overloaded', usage }, 2)
  expect(outcome.snapshot).toBe(before)
  expect(outcome.failure).toBe('api-error 529 overloaded')
  expect(outcome.stats.failures).toBe(1)
})

test('nothing to fork made no request: no call, no failure counted', () => {
  const outcome = applyRebuildReply(before, emptyStats(), { isAnswered: false, reason: 'nothing-to-fork' }, 2)
  expect(outcome.snapshot).toBe(before)
  expect(outcome.stats).toEqual(emptyStats())
})

test('a good reply is applied and counted as a call without failure', () => {
  const reply = '{"glossary":{"upsert":[{"term":"BME","meaning":"behavioral model extractor"}],"seen":["FMA"]},"bearings":{"inProgress":["writing tests"]}}'
  const outcome = applyRebuildReply(before, emptyStats(), { isAnswered: true, text: reply, usage }, 4)
  expect(outcome.failure).toBeNull()
  expect(outcome.snapshot.glossary.map(one => [one.term, one.lastSeenTurn])).toEqual([['FMA', 4], ['BME', 4]])
  expect(outcome.snapshot.bearings?.inProgress).toEqual(['writing tests'])
  expect(outcome.stats).toEqual({ calls: 1, failures: 0, inputTokens: 110, outputTokens: 20, cacheReadTokens: 5 })
})

test('the background update prunes stale automatic terms after applying, and keeps known ones', () => {
  const stale: Snapshot = {
    glossary: [
      { term: 'OLD', meaning: 'm', firstTurn: 1, lastSeenTurn: 1, pin: 'none', source: 'auto' },
      { term: 'KNOWN', meaning: 'm', firstTurn: 1, lastSeenTurn: 1, pin: 'none', source: 'auto' },
    ],
    bearings: emptyBearings(),
  }
  const reply = '{"glossary":{"upsert":[{"term":"NEW","meaning":"m"}]}}'
  const context = { knownTerms: ['known'], ranking: 'mechanical' as const, shownFactIds: new Set<string>(), turnText: '' }
  const outcome = applyBackgroundUpdate(stale, emptyStats(), { isAnswered: true, text: reply, usage }, 31, context)
  expect(outcome.snapshot.glossary.map(one => one.term)).toEqual(['KNOWN', 'NEW'])
})

test('a failed background update prunes nothing', () => {
  const context = { knownTerms: [], ranking: 'mechanical' as const, shownFactIds: new Set<string>(), turnText: '' }
  const outcome = applyBackgroundUpdate(before, emptyStats(), { isAnswered: true, text: 'no json', usage }, 500, context)
  expect(outcome.snapshot).toBe(before)
})

test('a failure log line holds the time, turn, call, reason, output tokens and the start of the reply on one line', () => {
  const answered = failureLogLine('2026-10-05T10:00:00.000Z', 'update', 7, 'the reply is not valid JSON', {
    isAnswered: true, text: `{"glossary":\n  ${'x'.repeat(400)}`, usage,
  })
  expect(answered).toBe(`2026-10-05T10:00:00.000Z T7 update failed: the reply is not valid JSON out=20 excerpt: {"glossary": ${'x'.repeat(287)}`)

  const unanswered = failureLogLine('t', 'scan', 2, 'api-error 529 overloaded', {
    isAnswered: false, reason: 'api-error', status: 529, error: 'overloaded', usage,
  })
  expect(unanswered).toBe('t T2 scan failed: api-error 529 overloaded out=20')

  expect(failureLogLine('t', 'curator', 3, 'the engine refused the call', null)).toBe('t T3 curator failed: the engine refused the call')
})

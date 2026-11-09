import type { ModelForkResult, ModelUsage } from 'claude-code'

import type { Ranking, UpdateStats } from '../types'
import { applyCuratorChanges, markMentionedFacts, parseCuratorReply } from './facts'
import type { CuratorChanges } from './facts'
import { applyDelta, applyScanDelta, parseDelta } from './merge'
import type { Delta, Snapshot } from './merge'
import { pruneStale } from './retention'

export function emptyStats(): UpdateStats {
  return { calls: 0, failures: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 }
}

/** Input counts both the uncached tokens and those written to the cache: both are billed as fresh input. */
export function addUsage(stats: UpdateStats, usage: ModelUsage, isFailure: boolean): UpdateStats {
  return {
    calls: stats.calls + 1,
    failures: stats.failures + (isFailure ? 1 : 0),
    inputTokens: stats.inputTokens + usage.input_tokens + usage.cache_creation_input_tokens,
    outputTokens: stats.outputTokens + usage.output_tokens,
    cacheReadTokens: stats.cacheReadTokens + usage.cache_read_input_tokens,
  }
}

/** Why a model call left no text, in a few words. */
export function describeFailure(reply: Exclude<ModelForkResult, { isAnswered: true }>): string {
  if (reply.reason === 'api-error') return `api-error ${reply.status ?? 'no status'} ${reply.error}`
  return reply.reason
}

export interface ReplyOutcome {
  snapshot: Snapshot
  stats: UpdateStats
  /** Why the state was left unchanged, or null when the reply was applied. */
  failure: string | null
}

/**
 * Turns a model reply into the next state. A call that did not answer, or an answer
 * that does not parse, leaves the snapshot as it was and counts one failure.
 * `parse` reads the reply's text and `merge` says how the parsed reply joins the current state.
 */
function applyReply<Parsed extends object>(
  snapshot: Snapshot,
  stats: UpdateStats,
  reply: ModelForkResult,
  parse: (text: string) => Parsed | { error: string },
  merge: (parsed: Parsed) => Snapshot,
): ReplyOutcome {
  if (!reply.isAnswered) {
    // nothing-to-fork made no request, so it costs nothing and is no call.
    const nextStats = reply.reason === 'nothing-to-fork' ? stats : addUsage(stats, reply.usage, true)
    return { snapshot, stats: nextStats, failure: describeFailure(reply) }
  }

  const parsed = parse(reply.text)
  if ('error' in parsed) {
    return { snapshot, stats: addUsage(stats, reply.usage, true), failure: parsed.error as string }
  }
  return { snapshot: merge(parsed as Parsed), stats: addUsage(stats, reply.usage, false), failure: null }
}

function withoutRank(delta: Delta): Delta {
  const { factsRank: _factsRank, ...bearings } = delta.bearings
  return { ...delta, bearings }
}

/** A rebuild sees only the shortlist and works from a nearly empty pool, so it may not rewrite or rank facts. */
function withoutFactEdits(delta: Delta): Delta {
  const { factsReplace: _factsReplace, factsRank: _factsRank, ...bearings } = delta.bearings
  return { ...delta, bearings }
}

export function applyRebuildReply(snapshot: Snapshot, stats: UpdateStats, reply: ModelForkResult, turn: number): ReplyOutcome {
  return applyReply(snapshot, stats, reply, parseDelta, delta => applyDelta(snapshot, withoutFactEdits(delta), turn))
}

export interface BackgroundUpdateContext {
  knownTerms: readonly string[]
  ranking: Ranking
  /** The facts the update call was shown: the mention check leaves these to the call. */
  shownFactIds: ReadonlySet<string>
  /** The prompts and answers of the turns the call covered. */
  turnText: string
}

/** The background update after each turn: the reply applied, unseen facts checked for mentions, then the stale automatic items pruned. */
export function applyBackgroundUpdate(
  snapshot: Snapshot,
  stats: UpdateStats,
  reply: ModelForkResult,
  turn: number,
  context: BackgroundUpdateContext,
): ReplyOutcome {
  const readableDelta = (delta: Delta) => (context.ranking === 'llm' ? delta : withoutRank(delta))
  const outcome = applyReply(snapshot, stats, reply, parseDelta, delta => applyDelta(snapshot, readableDelta(delta), turn))
  if (outcome.failure !== null || outcome.snapshot.bearings === null) return outcome

  const bearings = markMentionedFacts(outcome.snapshot.bearings, context.shownFactIds, context.turnText, turn)
  return { ...outcome, snapshot: pruneStale({ ...outcome.snapshot, bearings }, turn, context.knownTerms) }
}

export function applyScanReply(snapshot: Snapshot, stats: UpdateStats, reply: ModelForkResult, turn: number): ReplyOutcome {
  return applyReply(snapshot, stats, reply, parseDelta, delta => applyScanDelta(snapshot, delta, turn))
}

/** The curator's reply joins the state as it is now. A snapshot with no Bearings has nothing to curate. */
export function applyCuratorReply(snapshot: Snapshot, stats: UpdateStats, reply: ModelForkResult): ReplyOutcome {
  const merge = (changes: CuratorChanges): Snapshot =>
    (snapshot.bearings === null ? snapshot : { ...snapshot, bearings: applyCuratorChanges(snapshot.bearings, changes) })
  return applyReply(snapshot, stats, reply, parseCuratorReply, merge)
}

/** How much of a failed reply's text its log line keeps. */
export const FAILURE_EXCERPT_LIMIT = 300

/** One line of the failure log: when, the turn, which call, why, the output tokens and the reply's start. `reply` is null for a call the engine refused to send. */
export function failureLogLine(at: string, what: string, turn: number, failure: string, reply: ModelForkResult | null): string {
  const outputTokens = reply !== null && 'usage' in reply ? ` out=${reply.usage.output_tokens}` : ''
  const text = reply?.isAnswered === true ? reply.text.replace(/\s+/g, ' ').trim() : ''
  const excerpt = text === '' ? '' : ` excerpt: ${text.slice(0, FAILURE_EXCERPT_LIMIT)}`
  return `${at} T${turn} ${what} failed: ${failure}${outputTokens}${excerpt}`
}

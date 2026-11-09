import type { Pin } from '../types'
import { isProtected, sameText } from './merge'
import type { Snapshot } from './merge'

/** An entry stays in the main list while it was seen within this many turns. */
export const RECENT_TURNS = 30

/** "New" in the band means first seen within this many turns. */
export const NEW_TURNS = 3

interface Seen {
  lastSeenTurn: number
  pin: Pin
}

/** Pinned entries always stay in the main list; the rest fold into "Earlier" after 30 turns unseen. */
export function isRecent(item: Seen, currentTurn: number): boolean {
  return item.pin !== 'none' || currentTurn - item.lastSeenTurn < RECENT_TURNS
}

export function splitByRecency<T extends Seen>(items: T[], currentTurn: number): { recent: T[]; earlier: T[] } {
  return {
    recent: items.filter(item => isRecent(item, currentTurn)),
    earlier: items.filter(item => !isRecent(item, currentTurn)),
  }
}

export function isNew(entry: { firstTurn: number; source: string }, currentTurn: number): boolean {
  return entry.source !== 'inherited' && currentTurn - entry.firstTurn < NEW_TURNS
}

/** An automatic entry or fact unseen for this many turns is deleted from the state. */
export const PRUNE_TURNS = 30

export function isKnown(term: string, knownTerms: readonly string[]): boolean {
  return knownTerms.some(known => sameText(known, term))
}

/**
 * Deletes the glossary entries and facts unseen for 30 turns that nobody asked to keep:
 * pinned items, items the operator or the main model added, known terms and importance 3 facts always stay.
 */
export function pruneStale(snapshot: Snapshot, currentTurn: number, knownTerms: readonly string[]): Snapshot {
  const isStale = (item: { lastSeenTurn: number }) => currentTurn - item.lastSeenTurn >= PRUNE_TURNS
  const glossary = snapshot.glossary.filter(entry => isProtected(entry) || isKnown(entry.term, knownTerms) || !isStale(entry))
  const bearings = snapshot.bearings === null
    ? null
    : { ...snapshot.bearings, facts: snapshot.bearings.facts.filter(fact => isProtected(fact) || fact.importance === 3 || !isStale(fact)) }
  return { glossary, bearings }
}

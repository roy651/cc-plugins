import type { Bearings, BearingsField, Fact, GlossaryEntry, Importance, Pin, Source, StoredFact } from '../types'
import { extractJsonObject, factRankFrom, isProtected, isRecord, normalizeFacts, pushNewFact, rankNamesPoolFact, readImportance, REBUILD_ID_GAP } from './facts'

export { isProtected }

/** The two things the mod keeps, as one value the merge functions take and return. */
export interface Snapshot {
  glossary: GlossaryEntry[]
  bearings: Bearings | null
}

/** What the background model answers: changes to apply, never the whole state. */
export interface Delta {
  glossary: {
    upsert: { term: string; meaning: string }[]
    seen: string[]
  }
  bearings: {
    goal?: string
    subGoals?: string[]
    doneRecently?: string[]
    inProgress?: string[]
    expectedNext?: string[]
    openDecisions?: string[]
    factsAdd?: NewFact[]
    /** Fact ids; an exact fact text matches too. */
    factsSeen?: string[]
    factsReplace?: FactReplacement[]
    factsRank?: { hold: string[]; recent: string[] }
  }
}

interface NewFact {
  text: string
  importance: Importance
}

interface FactReplacement extends NewFact {
  id: string
}

const LIST_FIELDS = ['subGoals', 'doneRecently', 'inProgress', 'expectedNext', 'openDecisions'] as const

/** The most items these lists keep. The prompt asks the model to stay under it, and the merge enforces it. */
export const LIST_CAPS: Partial<Record<BearingsField, number>> = { subGoals: 10, expectedNext: 10, openDecisions: 7 }

/** Lists go newest last, so a list over its cap keeps its last items. */
export function capList(field: BearingsField, list: string[]): string[] {
  const cap = LIST_CAPS[field]
  return cap === undefined || list.length <= cap ? list : list.slice(-cap)
}

/** How many dropped open decisions are remembered. */
const DROPPED_DECISIONS_KEPT = 20

/** A list from a model's reply, ready to store: without the open decisions the operator dropped, then capped. */
function listFromModel(field: BearingsField, list: string[], bearings: Bearings): string[] {
  const dropped = bearings.droppedDecisions ?? []
  const kept = field === 'openDecisions' ? list.filter(item => !dropped.some(text => sameText(text, item))) : list
  return capList(field, kept)
}

function sameList(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((item, index) => sameText(item, b[index]!))
}

/** Records that `field` changed at `turn`. */
function markChanged(bearings: Bearings, field: BearingsField, turn: number): void {
  bearings.changedAtTurn = { ...bearings.changedAtTurn, [field]: turn }
}

export function emptyBearings(): Bearings {
  return {
    goal: '',
    subGoals: [],
    doneRecently: [],
    inProgress: [],
    expectedNext: [],
    openDecisions: [],
    facts: [],
    nextFactId: 1,
    updatedAtTurn: 0,
  }
}

export function sameText(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase()
}

// ---------------------------------------------------------------------------
// Parsing the model's reply

/** Reads the model's reply into a Delta, or says why it cannot. */
export function parseDelta(reply: string): Delta | { error: string } {
  const json = extractJsonObject(reply)
  if (json === null) return { error: 'the reply holds no JSON object' }

  let parsed: unknown
  try {
    parsed = JSON.parse(json)
  } catch (error) {
    return { error: `the reply is not valid JSON (${(error as Error).message})` }
  }
  if (!isRecord(parsed)) return { error: 'the reply is not a JSON object' }

  const glossary = parsed.glossary ?? {}
  const bearings = parsed.bearings ?? {}
  if (!isRecord(glossary)) return { error: '"glossary" is not an object' }
  if (!isRecord(bearings)) return { error: '"bearings" is not an object' }

  const upsert = glossary.upsert ?? []
  if (!Array.isArray(upsert)) return { error: '"glossary.upsert" is not a list' }
  const seen = readStringList(glossary.seen, 'glossary.seen')
  if ('error' in seen) return seen

  const delta: Delta = {
    glossary: {
      upsert: upsert.filter(isTermAndMeaning).map(item => ({ term: item.term.trim(), meaning: item.meaning.trim() })),
      seen: seen.list,
    },
    bearings: {},
  }

  if (bearings.goal !== undefined) {
    if (typeof bearings.goal !== 'string') return { error: '"bearings.goal" is not a string' }
    delta.bearings.goal = bearings.goal
  }
  for (const field of [...LIST_FIELDS, 'factsSeen'] as const) {
    if (bearings[field] === undefined) continue
    const list = readStringList(bearings[field], `bearings.${field}`)
    if ('error' in list) return list
    delta.bearings[field] = list.list
  }

  if (bearings.factsAdd !== undefined) {
    if (!Array.isArray(bearings.factsAdd)) return { error: '"bearings.factsAdd" is not a list' }
    delta.bearings.factsAdd = bearings.factsAdd.flatMap(readNewFact)
  }
  if (bearings.factsReplace !== undefined) {
    if (!Array.isArray(bearings.factsReplace)) return { error: '"bearings.factsReplace" is not a list' }
    delta.bearings.factsReplace = bearings.factsReplace.flatMap(readReplacement)
  }
  const rank = readFactsRank(bearings.factsRank)
  if (rank !== undefined) delta.bearings.factsRank = rank
  return delta
}

/** A new fact as an object, or as a bare string (importance 1). Anything else is left out. */
function readNewFact(item: unknown): NewFact[] {
  if (typeof item === 'string') return item.trim() === '' ? [] : [{ text: item, importance: 1 }]
  if (!isRecord(item) || typeof item.text !== 'string' || item.text.trim() === '') return []
  return [{ text: item.text, importance: readImportance(item.importance) }]
}

function readReplacement(item: unknown): FactReplacement[] {
  if (!isRecord(item) || typeof item.id !== 'string') return []
  const id = item.id
  return readNewFact(item).map(fact => ({ ...fact, id }))
}

/** A rank that is not two lists counts as no rank: the update's other changes still apply. */
function readFactsRank(value: unknown): { hold: string[]; recent: string[] } | undefined {
  if (!isRecord(value)) return undefined
  const hold = readStringList(value.hold ?? [], 'hold')
  const recent = readStringList(value.recent ?? [], 'recent')
  return 'error' in hold || 'error' in recent ? undefined : { hold: hold.list.flatMap(leadingFactId), recent: recent.list.flatMap(leadingFactId) }
}

/** The id at the start of a rank entry: the model may answer `f12` or copy the form it was shown, `f12 (3): text`. */
function leadingFactId(entry: string): string[] {
  const id = /^\s*(f\d+)/.exec(entry)?.[1]
  return id === undefined ? [] : [id]
}

function isTermAndMeaning(item: unknown): item is { term: string; meaning: string } {
  return isRecord(item) && typeof item.term === 'string' && typeof item.meaning === 'string' && item.term.trim() !== ''
}

function readStringList(value: unknown, name: string): { list: string[] } | { error: string } {
  if (value === undefined) return { list: [] }
  if (!Array.isArray(value)) return { error: `"${name}" is not a list` }
  return { list: value.filter((item): item is string => typeof item === 'string' && item.trim() !== '') }
}

// ---------------------------------------------------------------------------
// Applying a delta

export function applyDelta(snapshot: Snapshot, delta: Delta, turn: number): Snapshot {
  return {
    glossary: applyGlossaryDelta(snapshot.glossary, delta.glossary, turn),
    bearings: applyBearingsDelta(snapshot.bearings ?? emptyBearings(), delta.bearings, turn),
  }
}

function applyGlossaryDelta(entries: GlossaryEntry[], delta: Delta['glossary'], turn: number): GlossaryEntry[] {
  let result = entries.map(entry => ({ ...entry }))

  for (const { term, meaning } of delta.upsert) {
    const existing = result.find(entry => sameText(entry.term, term))
    if (existing === undefined) {
      result = [...result, { term, meaning, firstTurn: turn, lastSeenTurn: turn, pin: 'none', source: 'auto' }]
      continue
    }
    existing.lastSeenTurn = turn
    if (!isProtected(existing)) {
      existing.meaning = meaning
      existing.source = 'auto'
    }
  }

  for (const term of delta.seen) {
    const existing = result.find(entry => sameText(entry.term, term))
    if (existing !== undefined) existing.lastSeenTurn = turn
  }
  return result
}

function applyBearingsDelta(current: Bearings, delta: Delta['bearings'], turn: number): Bearings {
  const next: Bearings = { ...current, facts: current.facts.map(fact => ({ ...fact })), updatedAtTurn: turn }
  // Once this session has updated the map, it no longer reads as another session's.
  delete next.inheritedFrom

  // A field the conversation sets is no longer the repo's.
  if (delta.goal !== undefined) {
    if (!sameText(delta.goal, current.goal)) markChanged(next, 'goal', turn)
    next.goal = delta.goal
    next.repoFields = withoutField(next.repoFields, 'goal')
  }
  for (const field of LIST_FIELDS) {
    const list = delta[field]
    if (list === undefined) continue
    const capped = listFromModel(field, list, current)
    // A list restated unchanged keeps the turn it last changed.
    if (!sameList(capped, current[field])) markChanged(next, field, turn)
    next[field] = capped
    next.repoFields = withoutField(next.repoFields, field)
  }

  const idsBefore = new Set(next.facts.map(fact => fact.id))
  for (const { text, importance } of delta.factsAdd ?? []) addOrTouchFact(next, text, 'auto', turn, importance)
  for (const seen of delta.factsSeen ?? []) touchSeenFact(next.facts, seen, turn)
  for (const replacement of delta.factsReplace ?? []) replaceFact(next, replacement, turn)

  if (delta.factsRank !== undefined && rankNamesPoolFact(delta.factsRank, next.facts)) {
    const added = next.facts.filter(fact => !idsBefore.has(fact.id))
    next.factRank = factRankFrom(delta.factsRank, added, turn)
  }
  return next
}

/** On a working copy: adds the fact, or counts a mention of the one that already has this text. */
function addOrTouchFact(bearings: Bearings, text: string, source: Source, turn: number, importance: Importance): void {
  const existing = bearings.facts.find(fact => sameText(fact.text, text))
  if (existing === undefined) {
    pushNewFact(bearings, text, source, turn, importance)
    return
  }
  // The conversation restating a repo fact makes it the conversation's.
  if (existing.source === 'repo') existing.source = source
  existing.lastSeenTurn = turn
  existing.mentions += 1
}

function touchSeenFact(facts: Fact[], idOrText: string, turn: number): void {
  const existing = facts.find(fact => fact.id === idOrText) ?? facts.find(fact => sameText(fact.text, idOrText))
  if (existing === undefined) return
  existing.lastSeenTurn = turn
  existing.mentions += 1
}

/** Rewrites an unprotected fact in place. A protected fact stays as it is and the new text becomes a fact of its own. */
function replaceFact(bearings: Bearings, replacement: FactReplacement, turn: number): void {
  const existing = bearings.facts.find(fact => fact.id === replacement.id)
  if (existing === undefined) return
  if (isProtected(existing)) {
    addOrTouchFact(bearings, replacement.text, 'auto', turn, replacement.importance)
    return
  }
  existing.text = replacement.text.trim()
  existing.importance = replacement.importance
  existing.lastSeenTurn = turn
  // The conversation rewriting a repo fact makes it the conversation's.
  if (existing.source === 'repo') existing.source = 'auto'
}

function withoutField(fields: BearingsField[] | undefined, field: BearingsField): BearingsField[] | undefined {
  return fields?.filter(one => one !== field)
}

// ---------------------------------------------------------------------------
// Repo scan: fills only what is empty or came from an earlier scan

/**
 * Applies a scan's delta. Its entries and items are marked `repo`. It never overwrites an entry,
 * fact or field that the conversation, a person or the main model wrote, nor a pinned one.
 */
export function applyScanDelta(snapshot: Snapshot, delta: Delta, turn: number): Snapshot {
  return {
    glossary: applyScanGlossary(snapshot.glossary, delta.glossary.upsert, turn),
    bearings: applyScanBearings(snapshot.bearings ?? emptyBearings(), delta.bearings, turn),
  }
}

function applyScanGlossary(entries: GlossaryEntry[], upsert: Delta['glossary']['upsert'], turn: number): GlossaryEntry[] {
  let result = entries
  for (const { term, meaning } of upsert) {
    const existing = result.find(entry => sameText(entry.term, term))
    if (existing === undefined) {
      result = [...result, { term, meaning, firstTurn: turn, lastSeenTurn: turn, pin: 'none', source: 'repo' }]
    } else if (existing.source === 'repo' && existing.pin === 'none') {
      result = result.map(entry => (entry === existing ? { ...entry, meaning, lastSeenTurn: turn } : entry))
    }
  }
  return result
}

function applyScanBearings(current: Bearings, delta: Delta['bearings'], turn: number): Bearings {
  const next: Bearings = { ...current, facts: [...current.facts] }
  const repoFields = new Set(current.repoFields ?? [])
  const mayFill = (field: BearingsField, isEmpty: boolean) => isEmpty || repoFields.has(field)

  if (delta.goal !== undefined && delta.goal.trim() !== '' && mayFill('goal', current.goal.trim() === '')) {
    next.goal = delta.goal
    markChanged(next, 'goal', turn)
    repoFields.add('goal')
  }
  for (const field of LIST_FIELDS) {
    const list = delta[field]
    if (list === undefined) continue
    const kept = listFromModel(field, list, current)
    if (kept.length === 0 || !mayFill(field, current[field].length === 0)) continue
    next[field] = kept
    markChanged(next, field, turn)
    repoFields.add(field)
  }
  for (const { text, importance } of delta.factsAdd ?? []) {
    if (!next.facts.some(fact => sameText(fact.text, text))) pushNewFact(next, text, 'repo', turn, importance)
  }

  next.repoFields = [...repoFields]
  return next
}

/** A Bearings worth filling from the repo: no goal, or fewer than 3 items across sub-goals, in progress, next and facts. */
export function isLean(bearings: Bearings | null): boolean {
  if (bearings === null || bearings.goal.trim() === '') return true
  const items = bearings.subGoals.length + bearings.inProgress.length + bearings.expectedNext.length + bearings.facts.length
  return items < 3
}

// ---------------------------------------------------------------------------
// Rebuild: regenerate from the transcript, keeping what a person protected

/** What a rebuild starts from: only the pinned and hand-added entries; everything automatic is regenerated. */
export function protectedOnly(snapshot: Snapshot): Snapshot {
  return {
    glossary: snapshot.glossary.filter(isProtected),
    bearings: {
      ...emptyBearings(),
      facts: (snapshot.bearings?.facts ?? []).filter(isProtected),
      nextFactId: (snapshot.bearings?.nextFactId ?? 1) + REBUILD_ID_GAP,
      droppedDecisions: snapshot.bearings?.droppedDecisions,
    },
  }
}

/** The finished rebuild, with the highest next fact id either side reached, so no id is issued twice. */
export function keepHighestFactId(current: Snapshot, rebuilt: Snapshot): Snapshot {
  if (rebuilt.bearings === null) return rebuilt
  const nextFactId = Math.max(rebuilt.bearings.nextFactId, current.bearings?.nextFactId ?? 1)
  return { ...rebuilt, bearings: { ...rebuilt.bearings, nextFactId } }
}

/** After a rebuild, a term known before keeps the turn it was first seen in. */
export function restoreFirstTurns(before: Snapshot, rebuilt: Snapshot): Snapshot {
  const firstTurnOf = (term: string) => before.glossary.find(entry => sameText(entry.term, term))?.firstTurn
  return {
    ...rebuilt,
    glossary: rebuilt.glossary.map(entry => ({ ...entry, firstTurn: firstTurnOf(entry.term) ?? entry.firstTurn })),
  }
}

// ---------------------------------------------------------------------------
// Additions and pins made by a person (pane input) or the main model (tool)

/** Adds a term, or replaces its meaning: an explicit add wins over whatever was there. */
export function addTerm(snapshot: Snapshot, term: string, meaning: string, source: Source, turn: number): Snapshot {
  const existing = snapshot.glossary.find(entry => sameText(entry.term, term))
  const glossary = existing === undefined
    ? [...snapshot.glossary, { term: term.trim(), meaning: meaning.trim(), firstTurn: turn, lastSeenTurn: turn, pin: 'none' as Pin, source }]
    : snapshot.glossary.map(entry => (entry === existing ? { ...entry, meaning: meaning.trim(), lastSeenTurn: turn, source } : entry))
  return { ...snapshot, glossary }
}

export function addFact(snapshot: Snapshot, text: string, source: Source, turn: number): Snapshot {
  const bearings = snapshot.bearings ?? emptyBearings()
  const existing = bearings.facts.find(fact => sameText(fact.text, text))
  if (existing === undefined) {
    const next = { ...bearings }
    pushNewFact(next, text, source, turn, 1)
    return { ...snapshot, bearings: next }
  }
  const facts = bearings.facts.map(fact => (fact === existing ? { ...fact, lastSeenTurn: turn, source } : fact))
  return { ...snapshot, bearings: { ...bearings, facts } }
}

/**
 * Sets the pin of the glossary term named `target`, or else of the fact whose text
 * starts with it. Says which kind it matched, or null when nothing did.
 */
export function setPin(snapshot: Snapshot, target: string, pin: Pin): { snapshot: Snapshot; matched: 'term' | 'fact' | null } {
  const term = snapshot.glossary.find(entry => sameText(entry.term, target))
  if (term !== undefined) {
    const glossary = snapshot.glossary.map(entry => (entry === term ? { ...entry, pin } : entry))
    return { snapshot: { ...snapshot, glossary }, matched: 'term' }
  }

  const bearings = snapshot.bearings
  const wanted = target.trim().toLowerCase()
  const fact = bearings?.facts.find(one => one.text.toLowerCase().startsWith(wanted))
  if (bearings === null || fact === undefined) return { snapshot, matched: null }

  const facts = bearings.facts.map(one => (one === fact ? { ...one, pin } : one))
  return { snapshot: { ...snapshot, bearings: { ...bearings, facts } }, matched: 'fact' }
}

/**
 * Removes the first open decision that starts with `target`, ignoring case, and remembers its text
 * so a reply already on its way cannot restate it. `matched` says whether one did.
 */
export function dropOpenDecision(snapshot: Snapshot, target: string, turn: number): { snapshot: Snapshot; matched: boolean } {
  const bearings = snapshot.bearings
  const wanted = target.trim().toLowerCase()
  const index = bearings?.openDecisions.findIndex(question => question.toLowerCase().startsWith(wanted)) ?? -1
  if (bearings === null || index === -1) return { snapshot, matched: false }

  const next: Bearings = {
    ...bearings,
    openDecisions: bearings.openDecisions.filter((_, position) => position !== index),
    droppedDecisions: [...(bearings.droppedDecisions ?? []), bearings.openDecisions[index]!].slice(-DROPPED_DECISIONS_KEPT),
    repoFields: withoutField(bearings.repoFields, 'openDecisions'),
  }
  markChanged(next, 'openDecisions', turn)
  return { snapshot: { ...snapshot, bearings: next }, matched: true }
}

// ---------------------------------------------------------------------------
// Project pins: kept in the store per working directory, loaded into every session there

export interface ProjectPins {
  glossary: GlossaryEntry[]
  facts: StoredFact[]
}

/** The store key of one working directory's project pins. */
export function projectPinsKey(cwd: string): string {
  return `project-pins:${cwd}`
}

export function projectPinsOf(snapshot: Snapshot): ProjectPins {
  return {
    glossary: snapshot.glossary.filter(entry => entry.pin === 'project'),
    facts: (snapshot.bearings?.facts ?? []).filter(fact => fact.pin === 'project'),
  }
}

/** Lays the stored project pins over a snapshot: the stored meaning and text win. */
export function mergeProjectPins(snapshot: Snapshot, pins: ProjectPins): Snapshot {
  let glossary = snapshot.glossary
  for (const pinned of pins.glossary) {
    const others = glossary.filter(entry => !sameText(entry.term, pinned.term))
    glossary = [...others, { ...pinned, pin: 'project' }]
  }

  if (snapshot.bearings === null && pins.facts.length === 0) return { glossary, bearings: null }

  const bearings = snapshot.bearings ?? emptyBearings()
  let facts: StoredFact[] = bearings.facts
  for (const pinned of pins.facts) {
    const inThisSession = facts.find(fact => sameText(fact.text, pinned.text))
    const others = facts.filter(fact => fact !== inThisSession)
    // A stored id came from another session: only an id this session already gave the fact is kept.
    const { id: _idFromAnotherSession, ...withoutId } = pinned
    facts = [...others, { ...withoutId, ...(inThisSession?.id === undefined ? {} : { id: inThisSession.id }), pin: 'project' }]
  }
  return { glossary, bearings: normalizeFacts({ ...bearings, facts }) }
}

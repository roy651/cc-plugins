import type { Bearings, Fact, FactRank, Importance, Pin, Ranking, Source, StoredFact } from '../types'

export const HOLD_LIMIT = 10
export const RECENT_LIMIT = 10
export const RECENT_WINDOW = 5
export const EARLIER_SHOWN = 15
export const SHORTLIST_SIZE = 40
export const CURATOR_EVERY = 5
export const CURATOR_MIN_POOL = 15
export const MENTION_BONUS = 0.25
export const MENTION_BONUS_CAP = 3
export const HOLD_DECAY = 0.02

/**
 * A rebuild runs outside the update queue, so an update can issue ids while it works, and a reply
 * already in flight can name them afterwards. Rebuilt facts are numbered this far ahead so such an id never lands on one.
 */
export const REBUILD_ID_GAP = 1000

/** Pinned entries and entries a person or the main model added are never overwritten by the background model. */
export function isProtected(entry: { pin: Pin; source: Source }): boolean {
  return entry.pin !== 'none' || entry.source === 'operator' || entry.source === 'claude'
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Takes the JSON object out of a reply that may wrap it in a code fence or a sentence. */
export function extractJsonObject(reply: string): string | null {
  const start = reply.indexOf('{')
  const end = reply.lastIndexOf('}')
  return start === -1 || end < start ? null : reply.slice(start, end + 1)
}

// ---------------------------------------------------------------------------
// Ids and old data

/** An importance a reply or an old file gave: anything but 2 or 3 reads as 1. */
export function readImportance(value: unknown): Importance {
  return value === 2 || value === 3 ? value : 1
}

function highestIdNumber(facts: StoredFact[]): number {
  const numbers = facts.map(fact => Number(/^f(\d+)$/.exec(fact.id ?? '')?.[1] ?? 0))
  return Math.max(0, ...numbers)
}

/**
 * Gives every fact an id, an importance and a mention count, for Bearings written before those
 * existed. A missing or repeated id gets the next free one, in stored order. Running it twice changes nothing.
 */
export function normalizeFacts(stored: Omit<Bearings, 'facts' | 'nextFactId'> & { facts: StoredFact[]; nextFactId?: number }): Bearings {
  let nextFactId = Math.max(stored.nextFactId ?? 1, highestIdNumber(stored.facts) + 1)
  const usedIds = new Set<string>()

  const facts = stored.facts.map(fact => {
    const id = fact.id === undefined || usedIds.has(fact.id) ? `f${nextFactId++}` : fact.id
    usedIds.add(id)
    return { ...fact, id, importance: readImportance(fact.importance), mentions: fact.mentions ?? 0 }
  })
  return { ...stored, facts, nextFactId }
}

/** Adds a new fact, with the next free id, to a working copy of the Bearings. */
export function pushNewFact(bearings: Bearings, text: string, source: Source, turn: number, importance: Importance): void {
  const fact: Fact = { id: `f${bearings.nextFactId}`, text: text.trim(), lastSeenTurn: turn, pin: 'none', source, importance, mentions: 0 }
  bearings.facts = [...bearings.facts, fact]
  bearings.nextFactId += 1
}

// ---------------------------------------------------------------------------
// Scoring and tiers

export function holdScore(fact: Fact, turn: number): number {
  return fact.importance + Math.min(fact.mentions, MENTION_BONUS_CAP) * MENTION_BONUS - HOLD_DECAY * (turn - fact.lastSeenTurn)
}

/** Highest score first; on a tie the fact added later comes first. */
function bestScoreFirst(facts: Fact[], turn: number): Fact[] {
  return [...facts].reverse().sort((a, b) => holdScore(b, turn) - holdScore(a, turn))
}

/** Latest seen first; on a tie the fact added later comes first. */
function newestSeenFirst(facts: Fact[]): Fact[] {
  return [...facts].reverse().sort((a, b) => b.lastSeenTurn - a.lastSeenTurn)
}

function without(facts: Fact[], excluded: Fact[]): Fact[] {
  const excludedSet = new Set(excluded)
  return facts.filter(fact => !excludedSet.has(fact))
}

/** Every protected fact, past the limit if need be, then as many of `chosen` as the limit leaves room for. */
function holdWithProtected(facts: Fact[], chosen: Fact[], turn: number): Fact[] {
  const protectedFacts = bestScoreFirst(facts.filter(isProtected), turn)
  const room = Math.max(0, HOLD_LIMIT - protectedFacts.length)
  return [...protectedFacts, ...chosen.filter(fact => !isProtected(fact)).slice(0, room)]
}

export interface FactTiers {
  hold: Fact[]
  recent: Fact[]
  earlier: Fact[]
}

/** The three views computed from scores alone. A fact is in exactly one. */
export function mechanicalTiers(facts: Fact[], turn: number): FactTiers {
  const candidates = bestScoreFirst(facts.filter(fact => fact.importance >= 2), turn)
  const hold = holdWithProtected(facts, candidates, turn)

  const rest = without(facts, hold)
  const recent = newestSeenFirst(rest.filter(fact => turn - fact.lastSeenTurn < RECENT_WINDOW)).slice(0, RECENT_LIMIT)
  return { hold, recent, earlier: bestScoreFirst(without(rest, recent), turn) }
}

/** The three views in the order the update call ranked them. Ids no longer in the pool are skipped. */
function rankedTiers(facts: Fact[], rank: FactRank, turn: number): FactTiers {
  const factById = new Map(facts.map(fact => [fact.id, fact]))
  const ranked = (ids: string[]) => [...new Set(ids)].flatMap(id => factById.get(id) ?? [])

  const hold = holdWithProtected(facts, ranked(rank.hold), turn)
  const recent = without(ranked(rank.recent), hold).slice(0, RECENT_LIMIT)
  return { hold, recent, earlier: bestScoreFirst(without(facts, [...hold, ...recent]), turn) }
}

/** Whether at least one id of a rank is a fact in the pool. A rank that names none says nothing usable. */
export function rankNamesPoolFact(rank: { hold: string[]; recent: string[] }, facts: Fact[]): boolean {
  const poolIds = new Set(facts.map(fact => fact.id))
  return [...rank.hold, ...rank.recent].some(id => poolIds.has(id))
}

/** The tiers now: with `llm`, the update call's rank while it belongs to the latest update and names a fact in the pool; else the scores. */
export function factTiers(bearings: Bearings, turn: number, ranking: Ranking): FactTiers {
  const rank = bearings.factRank
  const isRankUsable = ranking === 'llm' && rank !== undefined && rank.turn === bearings.updatedAtTurn && rankNamesPoolFact(rank, bearings.facts)
  return isRankUsable ? rankedTiers(bearings.facts, rank, turn) : mechanicalTiers(bearings.facts, turn)
}

export function shortlist(tiers: FactTiers): Fact[] {
  return [...tiers.hold, ...tiers.recent, ...tiers.earlier].slice(0, SHORTLIST_SIZE)
}

/** The facts the update call reads: Hold and Recent, or the longer shortlist when it ranks them. */
export function factsForUpdate(bearings: Bearings, turn: number, ranking: Ranking): Fact[] {
  const tiers = factTiers(bearings, turn, ranking)
  return ranking === 'llm' ? shortlist(tiers) : [...tiers.hold, ...tiers.recent]
}

/**
 * The rank an update's reply gives. Facts added in that same reply could not be named, so an
 * importance 3 goes first in Hold and the others first in Recent, and both are trimmed to their limits.
 */
export function factRankFrom(rank: { hold: string[]; recent: string[] }, added: Fact[], turn: number): FactRank {
  const addedHold = added.filter(fact => fact.importance === 3).map(fact => fact.id)
  const addedRecent = added.filter(fact => fact.importance !== 3).map(fact => fact.id)
  return {
    turn,
    hold: [...addedHold, ...rank.hold].slice(0, HOLD_LIMIT),
    recent: [...addedRecent, ...rank.recent].slice(0, RECENT_LIMIT),
  }
}

// ---------------------------------------------------------------------------
// Mention check: facts the update call did not see, found in the turn's text

const TOKEN_SEPARATORS = /[\s,;:()[\]{}<>"'`=|*]+/
const TOKEN_EDGE_PUNCTUATION = /^[.\-!?]+|[.\-!?]+$/g

function tokensOf(text: string): string[] {
  return text.toLowerCase().split(TOKEN_SEPARATORS).map(token => token.replace(TOKEN_EDGE_PUNCTUATION, '')).filter(token => token !== '')
}

/** Tokens specific enough to count as a mention: a number, a path, a file name, a snake_case name. */
function distinctiveTokens(text: string): string[] {
  return [...new Set(tokensOf(text))].filter(token => token.length >= 4 && /[\d_/.]/.test(token))
}

function isMentioned(fact: Fact, turnTokens: Set<string>): boolean {
  const found = distinctiveTokens(fact.text).filter(token => turnTokens.has(token))
  return found.some(token => token.length >= 6) || found.length >= 2
}

/**
 * Marks the facts the update call was not shown that the turn's text mentions. A fact already
 * seen this turn is skipped: the reply added or touched it, so finding it here would count it twice.
 */
export function markMentionedFacts(bearings: Bearings, shownIds: ReadonlySet<string>, turnText: string, turn: number): Bearings {
  const turnTokens = new Set(tokensOf(turnText))
  const isNewMention = (fact: Fact) => !shownIds.has(fact.id) && fact.lastSeenTurn !== turn && isMentioned(fact, turnTokens)
  const facts = bearings.facts.map(fact => (isNewMention(fact) ? { ...fact, lastSeenTurn: turn, mentions: fact.mentions + 1 } : fact))
  return { ...bearings, facts }
}

// ---------------------------------------------------------------------------
// The curator: a periodic, separate call that corrects importance and tidies the pool

export const IMPORTANCE_GUIDE = `Importance: 3 is a constraint, limit or agreed choice that stays true and would cause a mistake if forgotten. 2 is useful beyond the current step. 1 is a detail of the moment. Most new facts are 1. Events belong in "doneRecently". Nothing is refused: a low importance only places a fact lower.`

export const CURATOR_SYSTEM = `You tidy the list of facts kept for a person who follows a long working conversation between an operator and an AI assistant.

You receive the goal, the sub-goals, what is in progress, and every fact as: id (importance, turns since seen, mentions): text. Answer with one JSON object and nothing else, in this shape.

{ "importance": { "f12": 3 }, "merge": [{ "keep": "f12", "drop": ["f3"], "text": "optional" }], "retire": ["f7"] }

- "importance": only the facts whose importance should change.
- "merge": facts that say the same thing. "keep" stays and "drop" goes. "text" is the merged wording, when the kept wording is not enough.
- "retire": facts that are no longer true or no longer matter.
- Leave out anything you would not change.

${IMPORTANCE_GUIDE}`

export function isCuratorDue(bearings: Bearings, turn: number): boolean {
  if (bearings.facts.length < CURATOR_MIN_POOL) return false
  return bearings.lastCuratedTurn === undefined || turn - bearings.lastCuratedTurn >= CURATOR_EVERY
}

function bulletLines(items: string[]): string {
  return items.length === 0 ? '(none)' : items.map(item => `- ${item}`).join('\n')
}

export function curatorPrompt(bearings: Bearings, turn: number): string {
  const factLines = bearings.facts.map(fact => `${fact.id} (${fact.importance}, ${turn - fact.lastSeenTurn}, ${fact.mentions}): ${fact.text}`)
  return `Goal: ${bearings.goal === '' ? '(not stated)' : bearings.goal}

Sub-goals:
${bulletLines(bearings.subGoals)}

In progress:
${bulletLines(bearings.inProgress)}

Facts:
${factLines.join('\n')}

Answer with the JSON only.`
}

export interface CuratorChanges {
  importance: [string, Importance][]
  merge: { keep: string; drop: string[]; text?: string }[]
  retire: string[]
}

function isImportance(value: unknown): value is Importance {
  return value === 1 || value === 2 || value === 3
}

function isStringList(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(item => typeof item === 'string')
}

function isMergeItem(item: unknown): item is CuratorChanges['merge'][number] {
  if (!isRecord(item) || typeof item.keep !== 'string' || !isStringList(item.drop)) return false
  return item.text === undefined || typeof item.text === 'string'
}

/** Reads the curator's reply, or says why it cannot. */
export function parseCuratorReply(reply: string): CuratorChanges | { error: string } {
  const json = extractJsonObject(reply)
  if (json === null) return { error: 'the reply holds no JSON object' }

  let parsed: unknown
  try {
    parsed = JSON.parse(json)
  } catch (error) {
    return { error: `the reply is not valid JSON (${(error as Error).message})` }
  }
  if (!isRecord(parsed)) return { error: 'the reply is not a JSON object' }

  const importance = parsed.importance ?? {}
  const merge = parsed.merge ?? []
  const retire = parsed.retire ?? []
  if (!isRecord(importance)) return { error: '"importance" is not an object' }
  if (!Array.isArray(merge) || !merge.every(isMergeItem)) return { error: '"merge" is not a list of merges' }
  if (!isStringList(retire)) return { error: '"retire" is not a list of ids' }

  const validImportance = Object.entries(importance).filter((entry): entry is [string, Importance] => isImportance(entry[1]))
  return { importance: validImportance, merge, retire }
}

function mergeFacts(facts: Fact[], merge: CuratorChanges['merge'][number]): Fact[] {
  const kept = facts.find(fact => fact.id === merge.keep)
  if (kept === undefined || isProtected(kept)) return facts

  const dropped = facts.filter(fact => merge.drop.includes(fact.id) && fact !== kept && !isProtected(fact))
  for (const fact of dropped) {
    kept.importance = readImportance(Math.max(kept.importance, fact.importance))
    kept.lastSeenTurn = Math.max(kept.lastSeenTurn, fact.lastSeenTurn)
    kept.mentions += fact.mentions
  }
  if (merge.text !== undefined && merge.text.trim() !== '') kept.text = merge.text.trim()
  return without(facts, dropped)
}

/** Applies the curator's reply by id, so facts added meanwhile are safe. Unknown ids and protected facts are left alone. */
export function applyCuratorChanges(bearings: Bearings, changes: CuratorChanges): Bearings {
  let facts = bearings.facts.map(fact => ({ ...fact }))

  for (const [id, importance] of changes.importance) {
    const fact = facts.find(one => one.id === id)
    if (fact !== undefined && !isProtected(fact)) fact.importance = importance
  }
  for (const merge of changes.merge) facts = mergeFacts(facts, merge)
  facts = facts.filter(fact => isProtected(fact) || !changes.retire.includes(fact.id))

  return { ...bearings, facts }
}

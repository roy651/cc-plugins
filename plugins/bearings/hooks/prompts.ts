import type { Fact, Ranking } from '../types'
import { factsForUpdate, HOLD_LIMIT, IMPORTANCE_GUIDE, mechanicalTiers, RECENT_LIMIT, shortlist } from './facts'
import type { Snapshot } from './merge'
import type { ScanSource } from './scan'

/** One finished main-thread turn, as the background update reads it. */
export interface TurnText {
  turn: number
  prompt: string
  answer: string
}

/** Each side of a turn is capped before it reaches the background model. */
export const TURN_TEXT_LIMIT = 6000

const FACTS_ADD_FIELD = '"factsAdd": [{ "text": "...", "importance": 1 }]'
const FACTS_SEEN_FIELD = '"factsSeen": ["f12"]'
const FACTS_REPLACE_FIELD = '"factsReplace": [{ "id": "f12", "text": "...", "importance": 2 }]'
const FACTS_RANK_FIELD = '"factsRank": { "hold": ["f12"], "recent": ["f9"] }'

/** The delta's shape, with only the fact fields this call may answer. */
function deltaShape(factFields: string[]): string {
  return `{
  "glossary": {
    "upsert": [{ "term": "...", "meaning": "..." }],
    "seen": ["term"]
  },
  "bearings": {
    "goal": "...",
    "subGoals": ["..."],
    "doneRecently": ["..."],
    "inProgress": ["..."],
    "expectedNext": ["..."],
    "openDecisions": ["..."],
${factFields.map(field => `    ${field}`).join(',\n')}
  }
}`
}

const RULES = `Rules:
- Take every meaning only from the conversation text. If a term's meaning is not stated there, write "meaning not stated in the conversation". Never invent a meaning.
- Terms are acronyms, coined labels, ids (backlog rows, gap codes, ticket numbers and the like) and key terms of the work.
- Keep each meaning to one line.
- Bearings items are short, plain sentences.
- Open decisions are only questions the assistant asked the operator that the operator has not answered yet.
- Facts are things to hold in mind while working (numbers, paths, constraints, agreed choices).
- Lists go oldest first, newest last.
- "subGoals" and "expectedNext" hold at most 10 items each: drop items that are done and merge near-duplicates.
- ${IMPORTANCE_GUIDE}`

const FACTS_ADD_AND_SEEN_RULE = `- "factsAdd": new facts, each with its importance. "factsSeen": the ids of known facts the new turns rely on again.`
const FACTS_REPLACE_RULE = `- "factsReplace": a known fact the new turns correct or sharpen: its id, the new text and its importance.`
const FACTS_RANK_RULE = `- "factsRank": the ids from "facts" to keep in view, most useful first: at most ${HOLD_LIMIT} in "hold" for what to keep in mind throughout, at most ${RECENT_LIMIT} in "recent" for what matters right now. Always include "factsRank" in every reply, as the exception to "Include any other field only when it changes": restate it even when the order has not changed.`

const OPEN_DECISIONS_RULE = `- Always include "openDecisions" as well, as the exception to "Include any other field only when it changes": restate it every turn, with at most 7 items. Drop a question once it is answered, overtaken by events or no longer relevant, and keep it while it is still waiting on the operator.`

/** The system prompt of the calls that read the conversation. Only the fact fields and the rules specific to the call differ. */
function conversationSystem(factFields: string[], callRules: string[]): string {
  return `You keep a glossary and a map of where the work stands for a person who follows a long working conversation between an operator and an AI assistant, and who often steps away.

You receive the current glossary's terms (names only, without their meanings) and the map as JSON, and the newest turn or turns of the conversation. Answer with one JSON object and nothing else: a delta in this shape.

${deltaShape(factFields)}

- "upsert": terms that are new, or whose meaning the new turns state or change.
- "seen": known terms the new turns mention without changing their meaning.
- In "bearings", always include "inProgress", restated from the newest turns even when it has not changed. Include any other field only when it changes. A list you include replaces the old list whole.
- The map's "facts" holds the facts most in view, each as \`f12 (3): text\` (id, importance, text), and "olderFactCount" counts the rest.
${callRules.join('\n')}

${RULES}`
}

const UPDATE_FACT_FIELDS = [FACTS_ADD_FIELD, FACTS_SEEN_FIELD, FACTS_REPLACE_FIELD]
const UPDATE_RULES = [OPEN_DECISIONS_RULE, FACTS_ADD_AND_SEEN_RULE, FACTS_REPLACE_RULE]

export const UPDATE_SYSTEM = conversationSystem(UPDATE_FACT_FIELDS, UPDATE_RULES)
export const RANKING_UPDATE_SYSTEM = conversationSystem([...UPDATE_FACT_FIELDS, FACTS_RANK_FIELD], [...UPDATE_RULES, FACTS_RANK_RULE])
export const REBUILD_SYSTEM = conversationSystem([FACTS_ADD_FIELD, FACTS_SEEN_FIELD], [FACTS_ADD_AND_SEEN_RULE])

export function updateSystem(ranking: Ranking): string {
  return ranking === 'llm' ? RANKING_UPDATE_SYSTEM : UPDATE_SYSTEM
}

function cap(text: string): string {
  return text.length <= TURN_TEXT_LIMIT ? text : `${text.slice(0, TURN_TEXT_LIMIT)} ... (cut)`
}

/**
 * The glossary and map as the background model reads them, kept small: term names
 * without meanings, the facts the caller picked with their ids, and the rest as a count.
 */
function currentStateJson(snapshot: Snapshot, shownFacts: Fact[]): string {
  const bearings = snapshot.bearings
  return JSON.stringify({
    glossaryTerms: snapshot.glossary.map(entry => entry.term),
    bearings: bearings === null ? null : {
      goal: bearings.goal,
      subGoals: bearings.subGoals,
      doneRecently: bearings.doneRecently,
      inProgress: bearings.inProgress,
      expectedNext: bearings.expectedNext,
      openDecisions: bearings.openDecisions,
      facts: shownFacts.map(fact => `${fact.id} (${fact.importance}): ${fact.text}`),
      olderFactCount: bearings.facts.length - shownFacts.length,
    },
  })
}

/** Rebuild and scan read the shortlist, whatever the ranking setting. */
function shortlistJson(snapshot: Snapshot, currentTurn: number): string {
  const shown = snapshot.bearings === null ? [] : shortlist(mechanicalTiers(snapshot.bearings.facts, currentTurn))
  return currentStateJson(snapshot, shown)
}

export function updatePrompt(snapshot: Snapshot, turns: TurnText[], currentTurn: number, ranking: Ranking): string {
  const shown = snapshot.bearings === null ? [] : factsForUpdate(snapshot.bearings, currentTurn, ranking)
  const turnBlocks = turns.map(turn =>
    `<turn number="${turn.turn}">\n<operator>\n${cap(turn.prompt)}\n</operator>\n<assistant>\n${cap(turn.answer)}\n</assistant>\n</turn>`,
  )
  return `<current>\n${currentStateJson(snapshot, shown)}\n</current>\n\n<new_turns>\n${turnBlocks.join('\n')}\n</new_turns>\n\nAnswer with the JSON delta only.`
}

/** One message of the transcript as the rebuild reads it: who wrote it and its text, nothing else. */
export interface TranscriptMessage {
  role: 'user' | 'assistant'
  text: string
}

/** The rebuild sends the transcript in pieces of about this many characters, one call each. */
export const REBUILD_CHUNK_LIMIT = 60_000

function messageBlock(message: TranscriptMessage): string {
  const tag = message.role === 'user' ? 'operator' : 'assistant'
  return `<${tag}>\n${message.text}\n</${tag}>`
}

/** Cuts a text longer than `limit` into consecutive pieces of at most `limit` characters. */
function splitToLimit(text: string, limit: number): string[] {
  const pieces: string[] = []
  for (let start = 0; start < text.length; start += limit) pieces.push(text.slice(start, start + limit))
  return pieces
}

/** The markup a slash command leaves in the transcript (its caveat, name, args, output): no conversation. */
const COMMAND_MARKUP = /<(local-command-caveat|command-name|command-message|command-args|local-command-stdout|local-command-stderr)>[\s\S]*?<\/\1>/g

/** A message's text without slash-command markup; '' for a row that only records a command. */
export function conversationText(text: string): string {
  return text.replace(COMMAND_MARKUP, '').trim()
}

/**
 * The transcript, in order, packed into chunks of at most `limit` characters.
 * Messages with no conversation text are left out; one longer than a chunk is cut across several.
 */
export function transcriptChunks(messages: TranscriptMessage[], limit = REBUILD_CHUNK_LIMIT): string[] {
  const pieces = messages
    .map(message => ({ ...message, text: conversationText(message.text) }))
    .filter(message => message.text !== '')
    .flatMap(message => splitToLimit(messageBlock(message), limit))

  const chunks: string[] = []
  let current = ''
  for (const piece of pieces) {
    const joined = current === '' ? piece : `${current}\n${piece}`
    if (joined.length <= limit) {
      current = joined
      continue
    }
    chunks.push(current)
    current = piece
  }
  if (current !== '') chunks.push(current)
  return chunks
}

/** One step of a rebuild: the state so far and the next piece of the transcript, answered as a delta. */
export function rebuildChunkPrompt(snapshot: Snapshot, chunk: string, index: number, total: number, currentTurn: number): string {
  return `<current>\n${shortlistJson(snapshot, currentTurn)}\n</current>\n\n<transcript_part number="${index + 1}" of="${total}">\n${chunk}\n</transcript_part>\n\nThis is part ${index + 1} of ${total} of the whole conversation, in order. Answer with the JSON delta only.`
}

export function btwPrompt(question: string): string {
  return `A side question from the operator, asked from a side panel. Your answer is shown to them there and does not enter the conversation. Answer briefly, for a human reader, in plain prose. Take no actions, propose no tool calls and do not talk about tools.

Question: ${question}`
}

/** The last messages the btw fallback reads beside the glossary and bearings. */
export const BTW_FALLBACK_MESSAGES = 20

/** For a btw question when there is no conversation to fork (a resumed process before its first request). */
export function btwFallbackPrompt(question: string, bearingsMarkdown: string, recent: TranscriptMessage[]): string {
  const messages = recent.slice(-BTW_FALLBACK_MESSAGES).map(messageBlock).join('\n')
  return `You answer a side question from the operator of a long working conversation between them and an AI assistant. You do not have the whole conversation: only its glossary and map of where the work stands, and its last messages. Answer briefly, for a human reader, in plain prose. If these do not hold the answer, say so.

<bearings>
${bearingsMarkdown}
</bearings>

<last_messages>
${messages}
</last_messages>

Question: ${question}`
}

export const BTW_FALLBACK_MARK = '(from bearings, not the full conversation)'

export const SCAN_SYSTEM = `You keep a glossary and a map of where the work stands for a person who works in a code repository with an AI assistant, and who often steps away. The conversation has said little so far, so you start the map from the repository itself.

You receive the current glossary's terms (names only) and the map as JSON, and the repository's own notes: a handoff file, instruction files, the README, recent commits, uncommitted changes and the top-level files. Deduce from them the goal, sub-goals, what is in progress, what is expected next, and facts to hold, and take glossary terms that these files define. Answer with one JSON object and nothing else: a delta in this shape.

${deltaShape([FACTS_ADD_FIELD, FACTS_SEEN_FIELD])}

- Fill only what the files support; leave a field out when they say nothing about it.
- "seen" and "factsSeen": leave empty.

${RULES}`

/** The scan's one request: the state so far and the repository's sources, each already cut to fit. */
export function scanPrompt(snapshot: Snapshot, sources: ScanSource[], currentTurn: number): string {
  const blocks = sources.map(source =>
    `<source name="${source.name}"${source.isCut === true ? ' cut="true"' : ''}>\n${source.text}\n</source>`,
  )
  return `<current>\n${shortlistJson(snapshot, currentTurn)}\n</current>\n\n<repo>\n${blocks.join('\n')}\n</repo>\n\nAnswer with the JSON delta only.`
}

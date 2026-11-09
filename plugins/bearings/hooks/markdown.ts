import type { Bearings, BearingsField, Fact, GlossaryEntry, Ranking } from '../types'
import { EARLIER_SHOWN, factTiers } from './facts'
import type { FactTiers } from './facts'
import type { Snapshot } from './merge'

/** A Markdown element draws at most 10000 characters; stay under it with room for the cut note. */
export const MARKDOWN_LIMIT = 9500

export function capText(text: string, limit: number): string {
  if (text.length <= limit) return text
  return `${text.slice(0, limit)}\n\n... (cut at ${limit} characters)`
}

function pinMark(pin: GlossaryEntry['pin']): string {
  if (pin === 'session') return ' [pinned]'
  if (pin === 'project') return ' [project pin]'
  return ''
}

const FROM_REPO = ' (from repo)'

function whenSeen(entry: GlossaryEntry): string {
  if (entry.source === 'inherited') return 'earlier session'
  if (entry.source === 'repo') return 'from repo'
  return `T${entry.firstTurn}`
}

export function glossaryLine(entry: GlossaryEntry): string {
  const when = whenSeen(entry)
  return `- **${entry.term}**: ${entry.meaning} (${when})${pinMark(entry.pin)}`
}

export function glossaryList(entries: GlossaryEntry[]): string {
  const newestFirst = [...entries].sort((a, b) => b.lastSeenTurn - a.lastSeenTurn)
  return newestFirst.map(glossaryLine).join('\n')
}

function bulletList(items: string[], mark = ''): string {
  return items.length === 0 ? '_none_' : items.map(item => `- ${item}${mark}`).join('\n')
}

export function factList(facts: Fact[]): string {
  if (facts.length === 0) return '_none_'
  return facts.map(fact => `- ${fact.text}${fact.source === 'repo' ? FROM_REPO : ''}${pinMark(fact.pin)}`).join('\n')
}

function factSection(title: string, facts: Fact[]): string[] {
  return facts.length === 0 ? [] : [`## ${title}\n${factList(facts)}`]
}

/** What the pane and the compaction note show of the facts. A tier with no facts is left out. */
export function heldFactSections(tiers: FactTiers): string[] {
  return [...factSection('Hold', tiers.hold), ...factSection('Recent', tiers.recent)]
}

/** What the .md file and a print show: every tier, in full. */
function allFactSections(tiers: FactTiers): string[] {
  return [...heldFactSections(tiers), ...factSection('Earlier', tiers.earlier)]
}

/** The pane's Earlier list: the top of it, and how many more the .md file holds. */
export function earlierFactsText(earlier: Fact[]): string {
  const shown = factList(earlier.slice(0, EARLIER_SHOWN))
  const moreCount = earlier.length - EARLIER_SHOWN
  return moreCount > 0 ? `${shown}\n\n_${moreCount} more in the file._` : shown
}

/** "changed 3 turns ago" style, for a field that last changed at `changedAt`. */
export function changedAgo(changedAt: number, currentTurn: number): string {
  const turns = currentTurn - changedAt
  if (turns <= 0) return 'changed this turn'
  return turns === 1 ? 'changed 1 turn ago' : `changed ${turns} turns ago`
}

/**
 * The Bearings sections in the order of the Bearings shape, followed by the fact sections the caller picked.
 * With `currentTurn` (the pane), each heading whose field records a change says how long ago it changed.
 */
export function bearingsSections(bearings: Bearings, factSections: string[], currentTurn?: number): string {
  const repoFields = bearings.repoFields ?? []
  const mark = (field: BearingsField) => (repoFields.includes(field) ? FROM_REPO : '')
  const heading = (title: string, field: BearingsField) => {
    const changedAt = bearings.changedAtTurn?.[field]
    if (currentTurn === undefined || changedAt === undefined) return `## ${title}`
    return `## ${title} (${changedAgo(changedAt, currentTurn)})`
  }
  return [
    `${heading('Goal', 'goal')}\n${bearings.goal === '' ? '_not stated yet_' : `${bearings.goal}${mark('goal')}`}`,
    `${heading('Sub-goals', 'subGoals')}\n${bulletList(bearings.subGoals, mark('subGoals'))}`,
    `${heading('Done recently', 'doneRecently')}\n${bulletList(bearings.doneRecently, mark('doneRecently'))}`,
    `${heading('In progress', 'inProgress')}\n${bulletList(bearings.inProgress, mark('inProgress'))}`,
    `${heading('Expected next', 'expectedNext')}\n${bulletList(bearings.expectedNext, mark('expectedNext'))}`,
    `${heading('Open decisions', 'openDecisions')}\n${bulletList(bearings.openDecisions, mark('openDecisions'))}`,
    ...factSections,
  ].join('\n\n')
}

/** The Bearings half of the session's .md file. */
export function bearingsFileSection(snapshot: Snapshot, ranking: Ranking): string {
  const bearings = snapshot.bearings
  if (bearings === null) return '# Bearings\n\n_No bearings yet._\n'
  return `# Bearings\n\n${bearingsSections(bearings, allFactSections(factTiers(bearings, bearings.updatedAtTurn, ranking)))}\n`
}

/** The Glossary half of the session's .md file. */
export function glossaryFileSection(snapshot: Snapshot): string {
  return `# Glossary\n\n${snapshot.glossary.length === 0 ? '_No terms yet._' : glossaryList(snapshot.glossary)}\n`
}

/** The readable file and the text handed to the model: Bearings first, then the whole Glossary. */
export function snapshotMarkdown(snapshot: Snapshot, ranking: Ranking): string {
  return `${bearingsFileSection(snapshot, ranking)}\n${glossaryFileSection(snapshot)}`
}

export function viewSection(view: 'glossary' | 'bearings', snapshot: Snapshot, ranking: Ranking): string {
  return view === 'glossary' ? glossaryFileSection(snapshot) : bearingsFileSection(snapshot, ranking)
}

/** What `/glossary print` answers: the model reads it, so it stays about ten tokens. */
export function printStub(view: 'glossary' | 'bearings', n: number): string {
  return `${view === 'glossary' ? 'Glossary' : 'Bearings'} view #${n} shown to the person (not in the conversation).`
}

/** The print number a command's output row names, or null when it names none. */
export function printNumberOf(rowText: string): number | null {
  const found = /#(\d+)/.exec(rowText)
  return found === null ? null : Number(found[1])
}

/** A print as its output row draws it: cut to fit one Markdown element, the .md path as the last line. */
export function printDrawing(markdown: string, markdownPath: string | null): string {
  const footer = markdownPath === null ? '' : `\n\n_Full file: ${markdownPath}_`
  const cutNoteRoom = 60
  return capText(markdown, MARKDOWN_LIMIT - footer.length - cutNoteRoom) + footer
}

/** The single log line in VS Code when the .md cannot be opened, cut at about this length. */
export const PRINTED_VIEW_LIMIT = 8000

/** The text of a printed view: the view's part of the .md file, cut with a last line naming the file. */
export function printedView(view: 'glossary' | 'bearings', snapshot: Snapshot, markdownPath: string | null, ranking: Ranking): string {
  const text = viewSection(view, snapshot, ranking)
  if (text.length <= PRINTED_VIEW_LIMIT) return text
  const where = markdownPath ?? "this session's .md file"
  return `${text.slice(0, PRINTED_VIEW_LIMIT)}\n\n... cut at ${PRINTED_VIEW_LIMIT} characters. The rest is in ${where}`
}

/** "3 minutes ago" style, coarse on purpose: the header only needs a rough age. */
export function relativeTime(thenMs: number, nowMs: number): string {
  const minutes = Math.round((nowMs - thenMs) / 60000)
  if (minutes < 1) return 'just now'
  if (minutes < 60) return `${minutes} min ago`
  const hours = Math.round(minutes / 60)
  if (hours < 48) return `${hours} h ago`
  return `${Math.round(hours / 24)} days ago`
}

import { addFact, addTerm, dropOpenDecision, sameText, setPin } from './merge'
import type { Snapshot } from './merge'
import { isKnown } from './retention'
import type { GlossaryEntry, Pin } from '../types'

/** A command that edits the glossary, the facts or the open decisions. */
export type SnapshotCommand =
  | { kind: 'add'; term: string; meaning: string }
  | { kind: 'fact'; text: string }
  | { kind: 'pin'; target: string; pin: 'session' | 'project' }
  | { kind: 'unpin'; target: string }
  | { kind: 'drop'; target: string }

/** A command that marks a term the operator already knows, or takes the mark off. */
export type KnownCommand = { kind: 'known' | 'unknown'; term: string }

/** A line typed into a pane's input that edits the glossary, the facts or the known terms. */
export type PaneCommand = SnapshotCommand | KnownCommand

export const COMMAND_HELP =
  'Commands: "add: <term> = <meaning>", "fact: <text>", "pin: <term>", "pin project: <term>", "unpin: <term>", ' +
  '"known: <term>", "unknown: <term>", "drop: <start of text>".'

/** The store key of one working directory's known terms. */
export function knownTermsKey(cwd: string): string {
  return `known-terms:${cwd}`
}

/** Reads one input line as a command, or null when it is none (then it may be a btw question). */
export function parsePaneCommand(line: string): PaneCommand | null {
  const text = line.trim()

  const add = /^add:\s*(.+?)\s*=\s*(.+)$/i.exec(text)
  if (add) return { kind: 'add', term: add[1]!, meaning: add[2]!.trim() }

  const fact = /^fact:\s*(.+)$/i.exec(text)
  if (fact) return { kind: 'fact', text: fact[1]!.trim() }

  const pinProject = /^pin project:\s*(.+)$/i.exec(text)
  if (pinProject) return { kind: 'pin', target: pinProject[1]!.trim(), pin: 'project' }

  const pin = /^pin:\s*(.+)$/i.exec(text)
  if (pin) return { kind: 'pin', target: pin[1]!.trim(), pin: 'session' }

  const unpin = /^unpin:\s*(.+)$/i.exec(text)
  if (unpin) return { kind: 'unpin', target: unpin[1]!.trim() }

  const known = /^known:\s*(.+)$/i.exec(text)
  if (known) return { kind: 'known', term: known[1]!.trim() }

  const unknown = /^unknown:\s*(.+)$/i.exec(text)
  if (unknown) return { kind: 'unknown', term: unknown[1]!.trim() }

  const drop = /^drop:\s*(.+)$/i.exec(text)
  if (drop) return { kind: 'drop', target: drop[1]!.trim() }

  return null
}

export function isKnownCommand(command: PaneCommand): command is KnownCommand {
  return command.kind === 'known' || command.kind === 'unknown'
}

/**
 * Marks a term known (hidden from the glossary pane, never pruned) or takes the mark off, and
 * says in one line what it did. A term not in the glossary yet can be marked: it stays hidden when it comes.
 */
export function applyKnownCommand(
  knownTerms: readonly string[],
  glossary: readonly GlossaryEntry[],
  command: KnownCommand,
): { knownTerms: string[]; message: string } {
  const wasKnown = isKnown(command.term, knownTerms)
  if (command.kind === 'unknown') {
    if (!wasKnown) return { knownTerms: [...knownTerms], message: `"${command.term}" is not marked known.` }
    return {
      knownTerms: knownTerms.filter(known => !sameText(known, command.term)),
      message: `"${command.term}" shows in the glossary pane again.`,
    }
  }

  if (wasKnown) return { knownTerms: [...knownTerms], message: `"${command.term}" is already known.` }
  const isInGlossary = glossary.some(entry => sameText(entry.term, command.term))
  const notYet = isInGlossary ? '' : ' It is not in the glossary yet.'
  return {
    knownTerms: [...knownTerms, command.term],
    message: `Marked "${command.term}" as known: hidden from the glossary pane.${notYet}`,
  }
}

/** Applies a pane command made by the operator, and says in one line what it did. */
export function applyPaneCommand(snapshot: Snapshot, command: SnapshotCommand, turn: number): { snapshot: Snapshot; message: string } {
  switch (command.kind) {
    case 'add':
      return { snapshot: addTerm(snapshot, command.term, command.meaning, 'operator', turn), message: `Added "${command.term}".` }
    case 'fact':
      return { snapshot: addFact(snapshot, command.text, 'operator', turn), message: 'Added the fact.' }
    case 'pin':
    case 'unpin': {
      const pin = command.kind === 'pin' ? command.pin : 'none'
      const result = setPin(snapshot, command.target, pin)
      const message = result.matched === null
        ? `No term or fact matches "${command.target}".`
        : `${command.kind === 'pin' ? `Pinned (${command.pin})` : 'Unpinned'} "${command.target}".`
      return { snapshot: result.snapshot, message }
    }
    case 'drop': {
      const result = dropOpenDecision(snapshot, command.target, turn)
      return { snapshot: result.snapshot, message: result.matched ? `Dropped "${command.target}".` : `No open decision matches "${command.target}".` }
    }
  }
}

/** The input of the `mcp__bearings__add` tool, as the main model sends it. */
export interface ToolAddInput {
  term?: unknown
  meaning?: unknown
  fact?: unknown
  pin?: unknown
  known?: unknown
  unknown?: unknown
}

/** The tool input as a known-term command, or null when it asks for none. */
export function toolKnownCommand(input: ToolAddInput): KnownCommand | null {
  if (nonEmpty(input.known)) return { kind: 'known', term: input.known.trim() }
  if (nonEmpty(input.unknown)) return { kind: 'unknown', term: input.unknown.trim() }
  return null
}

const PINS: readonly Pin[] = ['none', 'session', 'project']

function nonEmpty(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== ''
}

/** Applies an add the main model made on the operator's request, or says what is wrong with the input. */
export function applyToolAdd(snapshot: Snapshot, input: ToolAddInput, turn: number): { snapshot: Snapshot; message: string } | { error: string } {
  const pin = input.pin ?? 'none'
  if (!PINS.includes(pin as Pin)) return { error: `"pin" must be one of ${PINS.join(', ')}.` }

  if (nonEmpty(input.term)) {
    if (!nonEmpty(input.meaning)) return { error: 'A term needs a "meaning".' }
    const added = addTerm(snapshot, input.term, input.meaning, 'claude', turn)
    const pinned = pin === 'none' ? added : setPin(added, input.term, pin as Pin).snapshot
    return { snapshot: pinned, message: `Added the term "${input.term.trim()}" to the Bearings glossary.` }
  }

  if (nonEmpty(input.fact)) {
    const added = addFact(snapshot, input.fact, 'claude', turn)
    const pinned = pin === 'none' ? added : setPin(added, input.fact, pin as Pin).snapshot
    return { snapshot: pinned, message: 'Added the fact to Bearings.' }
  }

  return { error: 'Give "term" with "meaning", or "fact".' }
}

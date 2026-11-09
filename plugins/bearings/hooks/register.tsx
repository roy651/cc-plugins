import { atom, read, update } from 'claude-code'
import type { CommandRunResult, EngineInterface, ModelForkResult, Register } from 'claude-code'

import type {
  Bearings, BtwExchange, GlossaryEntry, Participation, PendingPrompt, PrintedView, Ranking, SessionSummary, UpdateStats,
} from '../types'
import {
  applyKnownCommand, applyPaneCommand, applyToolAdd, COMMAND_HELP, isKnownCommand, knownTermsKey, parsePaneCommand,
  toolKnownCommand,
} from './commands'
import type { KnownCommand, ToolAddInput } from './commands'
import { CURATOR_SYSTEM, curatorPrompt, factsForUpdate, factTiers, isCuratorDue, normalizeFacts } from './facts'
import {
  bearingsSections, capText, earlierFactsText, glossaryList, heldFactSections, MARKDOWN_LIMIT, printDrawing, printedView, printNumberOf, printStub,
  relativeTime, snapshotMarkdown, viewSection,
} from './markdown'
import {
  emptyBearings, isLean, keepHighestFactId, mergeProjectPins, projectPinsKey, projectPinsOf, protectedOnly, restoreFirstTurns,
} from './merge'
import type { ProjectPins, Snapshot } from './merge'
import { appendBounded, bearingsFolder, failureLogPath, firstLine, readSessionFiles, saveSession } from './persist'
import type { FileAccess, SavedSession } from './persist'
import {
  BTW_FALLBACK_MARK, BTW_FALLBACK_MESSAGES, btwFallbackPrompt, btwPrompt, rebuildChunkPrompt, REBUILD_SYSTEM, scanPrompt, SCAN_SYSTEM,
  transcriptChunks, updatePrompt, updateSystem,
} from './prompts'
import type { TranscriptMessage, TurnText } from './prompts'
import { isVsCodePanel, participationAtStart } from './participation'
import { createSerialQueue } from './queue'
import { isKnown, isNew, splitByRecency } from './retention'
import {
  activeOthers, coldStartNote, compactionNote, inheritedBearings, mergeGlossaries, seedGlossary,
  sessionSections, shortId, summarize,
} from './sessions'
import { FILE_LIST_SOURCE, fitToBudget, GIT_LOG_SOURCE, GIT_STATUS_SOURCE, pickReadme, SCAN_FILES } from './scan'
import type { ScanSource } from './scan'
import {
  addUsage, applyBackgroundUpdate, applyCuratorReply, applyRebuildReply, applyScanReply, describeFailure, emptyStats, failureLogLine,
} from './update'
import type { ReplyOutcome } from './update'

// The engine checks that `$` is only passed to functions declared at the top of
// this file and that state atoms are declared here too, so everything that talks
// to the engine lives here; the logic it calls is in the sibling modules, which
// are plain functions.

const DEFAULT_MODEL = 'sonnet'
const DEFAULT_CURATOR_MODEL = 'haiku'
const GLOSSARY_PANE = 'bearings-glossary'
const BEARINGS_PANE = 'bearings-map'

const BTW_KEPT = 20
const PRINTS_KEPT = 20

/** What `/bearings` opens in VS Code before the first update has written the session's .md. */
const MARKDOWN_PLACEHOLDER = '# Bearings\n\nNo bearings yet. They appear after the first turn completes.\n'
/** How often the folder listing is re-read to see the other sessions here. */
const OTHER_SESSIONS_POLL_MS = 60_000
/** The reply cap of every background call (update, rebuild, scan). */
const BACKGROUND_MAX_TOKENS = 8000

// Session state, declared in PluginState (types/index.d.ts).
const glossaryAtom = atom({ plugin: 'bearings', key: 'glossary' } as const, [] as GlossaryEntry[])
const bearingsAtom = atom({ plugin: 'bearings', key: 'bearings' } as const, null as Bearings | null)
const turnAtom = atom({ plugin: 'bearings', key: 'turn' } as const, 0)
const btwAtom = atom({ plugin: 'bearings', key: 'btw' } as const, [] as BtwExchange[])
const statsAtom = atom({ plugin: 'bearings', key: 'stats' } as const, emptyStats() as UpdateStats)
const pendingPromptAtom = atom({ plugin: 'bearings', key: 'pendingPrompt' } as const, null as PendingPrompt | null)
const isUpdatingAtom = atom({ plugin: 'bearings', key: 'isUpdating' } as const, false)
const isScanningAtom = atom({ plugin: 'bearings', key: 'isScanning' } as const, false)
const rebuildProgressAtom = atom({ plugin: 'bearings', key: 'rebuildProgress' } as const, null as { done: number; total: number } | null)
const btwPendingQuestionAtom = atom({ plugin: 'bearings', key: 'btwPendingQuestion' } as const, null as string | null)
const btwNoticeAtom = atom({ plugin: 'bearings', key: 'btwNotice' } as const, null as string | null)
const isGlossaryEarlierOpenAtom = atom({ plugin: 'bearings', key: 'isGlossaryEarlierOpen' } as const, false)
const isBearingsEarlierOpenAtom = atom({ plugin: 'bearings', key: 'isBearingsEarlierOpen' } as const, false)
const otherSessionsAtom = atom({ plugin: 'bearings', key: 'otherSessions' } as const, [] as SessionSummary[])
const isOtherSessionsOpenAtom = atom({ plugin: 'bearings', key: 'isOtherSessionsOpen' } as const, false)
const participationAtom = atom({ plugin: 'bearings', key: 'participation' } as const, 'unknown' as Participation)
const startedFolderAtom = atom({ plugin: 'bearings', key: 'startedFolder' } as const, null as string | null)
const printsAtom = atom({ plugin: 'bearings', key: 'prints' } as const, [] as PrintedView[])
const knownTermsAtom = atom({ plugin: 'bearings', key: 'knownTerms' } as const, [] as string[])

/** How a rebuild or a scan ended, in one line for the log. */
interface WorkOutcome {
  isDone: boolean
  message: string
}

// Turns that finish while an update runs are folded into the next single call.
const updates = createSerialQueue<TurnText>()

// A hot reload drops the module's timers and resets this flag, so the next turn starts the poll again.
let isPollingOtherSessions = false

// The `ranking` option, set by `register`. Options are fixed for one load, and many functions that write or draw the facts need it.
let factRanking: Ranking = 'mechanical'

const ADD_TOOL_DESCRIPTION =
  'Adds a term with its meaning, or a fact, to the Bearings glossary and map the operator reads in a side pane. ' +
  'Call it only when the operator asks you to add, note or pin something there. ' +
  'Give "term" and "meaning", or "fact". "pin": "session" keeps it in view all session, ' +
  '"project" keeps it in every session in this folder. ' +
  'Give "known" with a term the operator already knows to hide it from the glossary pane, "unknown" to show it again.'

const ADD_TOOL_SCHEMA = {
  type: 'object',
  properties: {
    term: { type: 'string', description: 'The acronym, label, id or key term.' },
    meaning: { type: 'string', description: 'One line, taken from the conversation.' },
    fact: { type: 'string', description: 'A fact to hold, in one short sentence.' },
    pin: { type: 'string', enum: ['none', 'session', 'project'] },
    known: { type: 'string', description: 'A term the operator already knows: hidden from the glossary pane in this folder.' },
    unknown: { type: 'string', description: 'A known term to show in the glossary pane again.' },
  },
}

// -------------------------------------------------------------------------
// State: the glossary and bearings as one snapshot, the files, the project pins

/**
 * The Bearings with every fact normalized. Whatever route old facts came in by (a resumed file or
 * a value kept across a hot reload), they pass here before anything uses them. Ids given here
 * follow the stored order, so each read gives the same ones until a write stores them.
 */
async function readBearings($: EngineInterface): Promise<Bearings | null> {
  const stored = await read($, bearingsAtom)
  return stored === null ? null : normalizeFacts(stored)
}

async function readSnapshot($: EngineInterface): Promise<Snapshot> {
  return { glossary: await read($, glossaryAtom), bearings: await readBearings($) }
}

/** Reads both values, applies `change`, writes both. Slow work (model calls) happens before, so the read is fresh. */
async function changeSnapshot($: EngineInterface, change: (snapshot: Snapshot) => Snapshot): Promise<void> {
  const next = change(await readSnapshot($))
  await update($, glossaryAtom, () => next.glossary)
  await update($, bearingsAtom, () => next.bearings)
}

async function hasContent($: EngineInterface): Promise<boolean> {
  const snapshot = await readSnapshot($)
  return snapshot.bearings !== null || snapshot.glossary.length > 0
}

async function readProjectPins($: EngineInterface, cwd: string): Promise<ProjectPins> {
  const stored = (await $.store.get(projectPinsKey(cwd))) as ProjectPins | undefined
  return stored ?? { glossary: [], facts: [] }
}

/** Keeps the store's project pins equal to the entries pinned `project` now. */
async function syncProjectPins($: EngineInterface): Promise<void> {
  const cwd = await $.session.cwd()
  await $.store.set(projectPinsKey(cwd), projectPinsOf(await readSnapshot($)))
}

/** This working directory's session-file folder and a way to reach it, or null where HOME is unset. */
async function sessionFolder($: EngineInterface, cwd: string): Promise<{ folder: string; files: FileAccess } | null> {
  const home = await $.env.get('HOME')
  if (home === undefined || home === '') return null
  const files: FileAccess = {
    read: path => $.fs.read(path),
    write: (path, text) => $.fs.write(path, text),
    list: path => $.fs.list(path),
  }
  return { folder: bearingsFolder(home, cwd), files }
}

/** Writes `<session id>.json` and `<session id>.md`. A failed write is logged, never thrown. */
async function saveFiles($: EngineInterface): Promise<void> {
  const place = await sessionFolder($, await $.session.cwd())
  if (place === null) return

  const snapshot = await readSnapshot($)
  const saved: SavedSession = {
    sessionId: await $.session.id(),
    cwd: await $.session.cwd(),
    startedAt: new Date((await $.session.usage()).startedAt).toISOString(),
    lastTouched: new Date(await $.clock.now()).toISOString(),
    goal: firstLine(snapshot.bearings?.goal ?? ''),
    turn: await read($, turnAtom),
    glossary: snapshot.glossary,
    bearings: snapshot.bearings,
    btw: await read($, btwAtom),
    stats: await read($, statsAtom),
  }
  try {
    await saveSession(place.files, place.folder, saved, snapshotMarkdown(snapshot, factRanking))
  } catch (error) {
    $.ui.log(`could not write ${place.folder}: ${(error as Error).message}`)
  }
}

/** Loads this folder's known terms from the store into the session. */
async function loadKnownTerms($: EngineInterface, cwd: string): Promise<void> {
  const stored = (await $.store.get(knownTermsKey(cwd))) as string[] | undefined
  await update($, knownTermsAtom, () => stored ?? [])
}

/** Applies a known or unknown command to the session and the store, and says what it did. */
async function applyKnown($: EngineInterface, command: KnownCommand): Promise<string> {
  const applied = applyKnownCommand(await read($, knownTermsAtom), await read($, glossaryAtom), command)
  await update($, knownTermsAtom, () => applied.knownTerms)
  await $.store.set(knownTermsKey(await $.session.cwd()), applied.knownTerms)
  return applied.message
}

/** Appends one line to the session's failure log. A failed write is logged, never thrown. */
async function logFailure($: EngineInterface, what: string, turn: number, failure: string, reply: ModelForkResult | null): Promise<void> {
  const place = await sessionFolder($, await $.session.cwd())
  if (place === null) return
  const path = failureLogPath(place.folder, await $.session.id())
  const line = failureLogLine(new Date(await $.clock.now()).toISOString(), what, turn, failure, reply)
  try {
    const existing = (await $.fs.exists(path)) ? await $.fs.read(path) : ''
    await $.fs.write(path, appendBounded(existing, line))
  } catch (error) {
    $.ui.log(`could not write ${path}: ${(error as Error).message}`)
  }
}

/** Adds one user row the model reads and the person does not see as typed. */
async function appendNote($: EngineInterface, text: string): Promise<void> {
  await $.session.append({ message: { type: 'user', content: [{ type: 'text', text }] } })
}

/** Non-interactive runs (-p, the SDK, a fixer) take no part: every hook passes through. */
async function isOff($: EngineInterface): Promise<boolean> {
  return (await read($, participationAtom)) === 'off'
}

// -------------------------------------------------------------------------
// Other sessions in this folder

/** Every session file in this folder, this session's own included, or none where HOME is unset. */
async function readFolderSessions($: EngineInterface, cwd: string): Promise<SavedSession[]> {
  const place = await sessionFolder($, cwd)
  return place === null ? [] : readSessionFiles(place.files, place.folder)
}

async function readOtherActiveSessions($: EngineInterface): Promise<SavedSession[]> {
  const sessions = await readFolderSessions($, await $.session.cwd())
  return activeOthers(sessions, await $.session.id(), await $.clock.now())
}

async function refreshOtherSessions($: EngineInterface): Promise<void> {
  try {
    const others = (await readOtherActiveSessions($)).map(summarize)
    await update($, otherSessionsAtom, () => others)
  } catch (error) {
    $.ui.log(`could not read the other sessions (${(error as Error).message})`, { to: 'debug' })
  }
}

/** Reads the folder now, then once a minute. Started at most once per module load. */
function ensureOtherSessionsPoll($: EngineInterface): void {
  if (isPollingOtherSessions) return
  isPollingOtherSessions = true
  void refreshOtherSessions($)
  $.clock.every(OTHER_SESSIONS_POLL_MS, () => void refreshOtherSessions($))
}

// -------------------------------------------------------------------------
// Session start

/**
 * When this session holds nothing yet: restores this session's own file (a resume), or else
 * seeds the glossary with the union of the other sessions active in this folder and tells the
 * model about them in one row (nothing when none is active). Then lays the project pins on top.
 * With nothing restored or inherited, the repo is scanned once, from a timer so the start does not wait.
 */
async function coldStart($: EngineInterface, model: string, cwd: string): Promise<void> {
  if (await hasContent($)) return

  const sessionId = await $.session.id()
  const sessions = await readFolderSessions($, cwd)
  const own = sessions.find(session => session.sessionId === sessionId)
  const others = activeOthers(sessions, sessionId, await $.clock.now())

  if (own !== undefined) {
    await changeSnapshot($, () => ({ glossary: own.glossary, bearings: own.bearings }))
    await update($, turnAtom, () => own.turn)
    await update($, btwAtom, () => own.btw)
    await update($, statsAtom, () => own.stats)
  } else if (others.length > 0) {
    const seeded = seedGlossary(mergeGlossaries(others))
    await changeSnapshot($, () => ({ glossary: seeded, bearings: inheritedBearings(others[0]!, emptyBearings()) }))
  }

  const pins = await readProjectPins($, cwd)
  await changeSnapshot($, snapshot => mergeProjectPins(snapshot, pins))

  if (own === undefined && others.length === 0) {
    $.clock.after(0, () => void logIfNotDone($, () => scanRepo($, model)))
  }

  const note = own === undefined ? coldStartNote(others, await $.clock.now()) : null
  if (note !== null) await appendNote($, note)
}

// -------------------------------------------------------------------------
// The three model calls: background update, rebuild, btw

/** The model settings of the update that runs after each turn. */
interface UpdateSettings {
  model: string
  curatorModel: string
  ranking: Ranking
}

async function runUpdate($: EngineInterface, settings: UpdateSettings, turns: TurnText[]): Promise<void> {
  const latestTurn = turns[turns.length - 1]?.turn ?? 0
  await update($, isUpdatingAtom, () => true)
  try {
    const before = await readSnapshot($)
    const reply = await $.model.complete({
      model: settings.model,
      system: updateSystem(settings.ranking),
      prompt: updatePrompt(before, turns, latestTurn, settings.ranking),
      maxTokens: BACKGROUND_MAX_TOKENS,
    })

    const shownFacts = before.bearings === null ? [] : factsForUpdate(before.bearings, latestTurn, settings.ranking)
    const context = {
      knownTerms: await read($, knownTermsAtom),
      ranking: settings.ranking,
      shownFactIds: new Set(shownFacts.map(fact => fact.id)),
      turnText: turns.map(turn => `${turn.prompt}\n${turn.answer}`).join('\n'),
    }
    const failure = await applyOutcome(
      $, 'update', (snapshot, stats) => applyBackgroundUpdate(snapshot, stats, reply, latestTurn, context),
    )
    if (failure !== null) await logFailure($, 'update', latestTurn, failure, reply)

    await runCuratorIfDue($, settings.curatorModel, latestTurn)
  } finally {
    await update($, isUpdatingAtom, () => false)
  }
}

/** The curated turn advances before the call, so a failure does not retry every turn. */
async function runCuratorIfDue($: EngineInterface, curatorModel: string, turn: number): Promise<void> {
  const bearings = await readBearings($)
  if (bearings === null || !isCuratorDue(bearings, turn)) return

  await changeSnapshot($, snapshot => (snapshot.bearings === null ? snapshot : { ...snapshot, bearings: { ...snapshot.bearings, lastCuratedTurn: turn } }))
  let reply: ModelForkResult
  try {
    reply = await $.model.complete({
      model: curatorModel,
      system: CURATOR_SYSTEM,
      prompt: curatorPrompt(bearings, turn),
      maxTokens: BACKGROUND_MAX_TOKENS,
    })
  } catch (error) {
    // The engine rejects a call it refuses to send, such as a blocked `curatorModel`.
    const failure = `the call was refused (${(error as Error).message})`
    $.ui.log(`curator failed, nothing changed (${failure})`)
    await logFailure($, 'curator', turn, failure, null)
    return
  }

  const failure = await applyOutcome($, 'curator', (snapshot, stats) => applyCuratorReply(snapshot, stats, reply))
  if (failure !== null) await logFailure($, 'curator', turn, failure, reply)
}

/** The transcript as the rebuild and the btw fallback read it: each message's role and text, no tool calls. */
async function readTranscript($: EngineInterface): Promise<TranscriptMessage[]> {
  return (await $.session.messages()).map(message => ({ role: message.role, text: message.text }))
}

/**
 * Regenerates the glossary and bearings from the whole transcript, not a fork (a resumed
 * process has nothing to fork until its first request). The transcript goes through the
 * background update's path in chunks, in order, each call taking the state so far. It starts
 * from the pinned and hand-added entries only, and nothing changes unless every chunk applies.
 */
async function rebuild($: EngineInterface, model: string): Promise<WorkOutcome> {
  if ((await read($, rebuildProgressAtom)) !== null) return { isDone: false, message: 'a rebuild is already running' }

  const chunks = transcriptChunks(await readTranscript($))
  if (chunks.length === 0) {
    // Nothing to fold, so no model call: the result would be empty, which is lean, so scan the repo.
    const scan = await scanRepo($, model)
    return { isDone: scan.isDone, message: `the transcript holds no conversation yet, so ${scan.message}` }
  }

  await update($, rebuildProgressAtom, () => ({ done: 0, total: chunks.length }))
  try {
    const before = await readSnapshot($)
    const turn = await read($, turnAtom)
    let rebuilt = protectedOnly(before)

    for (const [index, chunk] of chunks.entries()) {
      const reply = await $.model.complete({
        model,
        system: REBUILD_SYSTEM,
        prompt: rebuildChunkPrompt(rebuilt, chunk, index, chunks.length, turn),
        maxTokens: BACKGROUND_MAX_TOKENS,
      })
      const outcome = applyRebuildReply(rebuilt, await read($, statsAtom), reply, turn)
      await update($, statsAtom, () => outcome.stats)
      if (outcome.failure !== null) {
        await logFailure($, `rebuild part ${index + 1} of ${chunks.length}`, turn, outcome.failure, reply)
        return {
          isDone: false,
          message: `rebuild failed at part ${index + 1} of ${chunks.length}, nothing changed (${outcome.failure})`,
        }
      }
      rebuilt = outcome.snapshot
      await update($, rebuildProgressAtom, () => ({ done: index + 1, total: chunks.length }))
    }

    await changeSnapshot($, current => keepHighestFactId(current, restoreFirstTurns(before, rebuilt)))
    await saveFiles($)
    const message = `rebuilt from ${chunks.length} chunks`
    if (!isLean(rebuilt.bearings)) return { isDone: true, message }

    // The transcript said too little to map the work: fill the gaps from the repo.
    const scan = await scanRepo($, model)
    return { isDone: true, message: `${message}; the result was lean, so ${scan.message}` }
  } finally {
    await update($, rebuildProgressAtom, () => null)
  }
}

/** The pane shows a rebuild's progress, so only a failure needs a line. */
async function logIfNotDone($: EngineInterface, work: () => Promise<WorkOutcome>): Promise<void> {
  const outcome = await work()
  if (!outcome.isDone) $.ui.log(outcome.message)
}

/**
 * `/bearings rebuild` and `/bearings scan`. The work runs from a timer so the command does not hold
 * the prompt. In the terminal the Bearings pane opens and shows it. In the VS Code panel, which has
 * no pane, one line says it started and one how it ended, then the .md opens as `/bearings` does.
 */
async function startFromCommand($: EngineInterface, model: string, what: 'rebuild' | 'scan'): Promise<CommandRunResult> {
  await restartIfFolderChanged($, model)
  const work =() => (what === 'rebuild' ? rebuild($, model) : scanRepo($, model))
  if (await isInVsCodePanel($)) {
    $.ui.log(what === 'rebuild' ? 'rebuilding bearings from the transcript' : 'scanning the repo for bearings')
    $.clock.after(0, () => void finishInPanel($, work))
    return {}
  }
  await openBearings($)
  $.clock.after(0, () => void logIfNotDone($, work))
  return {}
}

async function finishInPanel($: EngineInterface, work: () => Promise<WorkOutcome>): Promise<void> {
  const outcome = await work()
  $.ui.log(outcome.message)
  await openInVsCode($, 'bearings')
}

// -------------------------------------------------------------------------
// Repo scan: seeds Bearings from the repo's own notes when the conversation says little

/** The file's text, or null when it is missing or unreadable. */
async function readFileOrNull($: EngineInterface, path: string): Promise<string | null> {
  try {
    return await $.fs.read(path)
  } catch {
    return null
  }
}

/** A git command's output in `cwd`, or null when git fails (not a repo, no git). */
async function gitOutput($: EngineInterface, argv: readonly string[], cwd: string): Promise<string | null> {
  try {
    const ran = await $.process.run(argv, { cwd })
    return ran.exitCode === 0 ? ran.stdout.trim() : null
  } catch {
    return null
  }
}

/** The scan's sources, most valuable first, missing ones skipped, cut together to the budget. */
async function readScanSources($: EngineInterface, cwd: string): Promise<ScanSource[]> {
  const topLevel = await $.fs.list(cwd).catch(() => [])
  const readme = pickReadme(topLevel.map(entry => entry.name))
  const sources: ScanSource[] = []

  for (const name of [...SCAN_FILES, ...(readme === null ? [] : [readme])]) {
    const text = await readFileOrNull($, `${cwd}/${name}`)
    if (text !== null && text.trim() !== '') sources.push({ name, text })
  }

  const gitLog = await gitOutput($, ['git', 'log', '--oneline', '-15'], cwd)
  if (gitLog !== null && gitLog !== '') sources.push({ name: GIT_LOG_SOURCE, text: gitLog })
  const gitStatus = await gitOutput($, ['git', 'status', '--short'], cwd)
  if (gitStatus !== null) sources.push({ name: GIT_STATUS_SOURCE, text: gitStatus === '' ? '(no uncommitted changes)' : gitStatus })

  if (topLevel.length > 0) {
    const names = topLevel.map(entry => (entry.kind === 'dir' ? `${entry.name}/` : entry.name))
    sources.push({ name: FILE_LIST_SOURCE, text: names.join('\n') })
  }
  return fitToBudget(sources)
}

/** One model call over the repo's notes; its entries come in marked `repo` and fill only gaps. */
async function scanRepo($: EngineInterface, model: string): Promise<WorkOutcome> {
  if (await read($, isScanningAtom)) return { isDone: false, message: 'a scan is already running' }
  await update($, isScanningAtom, () => true)
  try {
    const sources = await readScanSources($, await $.session.cwd())
    if (sources.length === 0) return { isDone: false, message: 'scan skipped: the folder has no notes, git or files to read' }

    const reply = await $.model.complete({
      model,
      system: SCAN_SYSTEM,
      prompt: scanPrompt(await readSnapshot($), sources, await read($, turnAtom)),
      maxTokens: BACKGROUND_MAX_TOKENS,
    })
    const turn = await read($, turnAtom)
    const outcome = applyScanReply(await readSnapshot($), await read($, statsAtom), reply, turn)
    await update($, statsAtom, () => outcome.stats)
    if (outcome.failure !== null) {
      await logFailure($, 'scan', turn, outcome.failure, reply)
      return { isDone: false, message: `scan failed, nothing changed (${outcome.failure})` }
    }

    await changeSnapshot($, () => outcome.snapshot)
    await saveFiles($)
    return { isDone: true, message: `scanned ${sources.length} sources from the repo` }
  } finally {
    await update($, isScanningAtom, () => false)
  }
}

/**
 * Applies a reply to the state as it is now (not when the call started), records its cost, saves on success.
 * Returns why it failed, or null.
 */
async function applyOutcome(
  $: EngineInterface,
  what: string,
  apply: (snapshot: Snapshot, stats: UpdateStats) => ReplyOutcome,
): Promise<string | null> {
  const outcome = apply(await readSnapshot($), await read($, statsAtom))
  await update($, statsAtom, () => outcome.stats)
  if (outcome.failure !== null) {
    $.ui.log(`${what} failed, nothing changed (${outcome.failure})`)
    return outcome.failure
  }
  await changeSnapshot($, () => outcome.snapshot)
  await saveFiles($)
  return null
}

async function addBtwExchange($: EngineInterface, question: string, answer: string): Promise<void> {
  const exchange = { question, answer, atTurn: await read($, turnAtom) }
  await update($, btwAtom, thread => [...thread, exchange].slice(-BTW_KEPT))
}

async function askBtw($: EngineInterface, model: string, question: string): Promise<void> {
  await update($, btwPendingQuestionAtom, () => question)
  await update($, btwNoticeAtom, () => null)
  try {
    const reply = await $.model.fork({ prompt: btwPrompt(question) })
    if (reply.isAnswered) {
      await update($, statsAtom, stats => addUsage(stats, reply.usage, false))
      await addBtwExchange($, question, reply.text.trim())
    } else if (reply.reason === 'nothing-to-fork') {
      await answerBtwFromBearings($, model, question)
    } else {
      await update($, statsAtom, stats => addUsage(stats, reply.usage, true))
      await update($, btwNoticeAtom, () => `No answer (${describeFailure(reply)}).`)
    }
  } finally {
    await update($, btwPendingQuestionAtom, () => null)
  }
}

/** With nothing to fork (a resumed process before its first request), answer from the bearings and the last messages. */
async function answerBtwFromBearings($: EngineInterface, model: string, question: string): Promise<void> {
  const recent = (await readTranscript($)).slice(-BTW_FALLBACK_MESSAGES)
  const prompt = btwFallbackPrompt(question, snapshotMarkdown(await readSnapshot($), factRanking), recent)
  const reply = await $.model.complete({ model, prompt })

  if (reply.isAnswered) {
    await update($, statsAtom, stats => addUsage(stats, reply.usage, false))
    await addBtwExchange($, question, `${reply.text.trim()}\n\n_${BTW_FALLBACK_MARK}_`)
  } else {
    await update($, statsAtom, stats => addUsage(stats, reply.usage, true))
    await update($, btwNoticeAtom, () => `No answer (${describeFailure(reply)}).`)
  }
}

// -------------------------------------------------------------------------
// Manual additions: the panes' inputs and the main model's tool

/** A pane input line: a command edits the glossary or facts; anything else is a btw question where `isBtw`. */
async function submitPaneInput($: EngineInterface, model: string, line: string, isBtw: boolean): Promise<void> {
  const text = line.trim()
  if (text === '') return
  await restartIfFolderChanged($, model)

  const command = parsePaneCommand(text)
  if (command === null) {
    if (isBtw) await askBtw($, model, text)
    else $.ui.toast(COMMAND_HELP)
    return
  }
  if (isKnownCommand(command)) {
    $.ui.toast(await applyKnown($, command))
    return
  }

  const applied = applyPaneCommand(await readSnapshot($), command, await read($, turnAtom))
  await changeSnapshot($, () => applied.snapshot)
  $.ui.toast(applied.message)
  await syncProjectPins($)
  await saveFiles($)
}

async function addFromTool($: EngineInterface, input: ToolAddInput): Promise<{ result: string } | { deny: string }> {
  const knownCommand = toolKnownCommand(input)
  if (knownCommand !== null) return { result: await applyKnown($, knownCommand) }

  const outcome = applyToolAdd(await readSnapshot($), input, await read($, turnAtom))
  if ('error' in outcome) return { deny: outcome.error }

  await changeSnapshot($, () => outcome.snapshot)
  await syncProjectPins($)
  await saveFiles($)
  return { result: outcome.message }
}

/** This session's .md file, or null where HOME is unset. It holds both views. */
async function markdownPathOf($: EngineInterface): Promise<string | null> {
  const place = await sessionFolder($, await $.session.cwd())
  return place === null ? null : `${place.folder}/${await $.session.id()}.md`
}

/**
 * `/glossary` and `/bearings`. In VS Code, whose chat panel draws no plugin pane, they open the
 * session's .md file in an editor tab. With `print`, the view is drawn in the command's output
 * row. Otherwise they open the pane.
 */
async function runViewCommand(
  $: EngineInterface,
  model: string,
  view: 'glossary' | 'bearings',
  args: string,
): Promise<CommandRunResult> {
  const word = args.trim()
  if (view === 'bearings' && (word === 'rebuild' || word === 'scan')) return startFromCommand($, model, word)
  if (await isInVsCodePanel($)) {
    await openInVsCode($, view)
    return {}
  }
  if (args.trim() === 'print') return printView($, view)

  if (view === 'glossary') await openGlossary($)
  else await openBearings($)
  return { text: `${view === 'glossary' ? 'Glossary' : 'Bearings'} pane opened.` }
}

/**
 * Keeps the view as it is now and answers a short stub naming it (`#<n>`); the model reads the
 * stub only. The CommandOutput hook draws the kept view in place of the stub's row.
 */
async function printView($: EngineInterface, view: 'glossary' | 'bearings'): Promise<CommandRunResult> {
  const markdown = viewSection(view, await readSnapshot($), factRanking)
  const markdownPath = await markdownPathOf($)
  let n = 0
  await update($, printsAtom, prints => {
    n = (prints[prints.length - 1]?.n ?? 0) + 1
    return [...prints, { n, view, markdown, markdownPath }].slice(-PRINTS_KEPT)
  })
  return { text: printStub(view, n) }
}

/** The drawing of the print an output row names, or null when the row names none or it is gone. */
async function printDrawingFor($: EngineInterface, view: 'glossary' | 'bearings', rowText: string): Promise<string | null> {
  const n = printNumberOf(rowText)
  if (n === null) return null
  const print = (await read($, printsAtom)).find(one => one.n === n && one.view === view)
  return print === undefined ? null : printDrawing(print.markdown, print.markdownPath)
}

/** Opens the .md file with `code`; with no file or a failing `code`, logs the view as one line and says why. */
async function openInVsCode($: EngineInterface, view: 'glossary' | 'bearings'): Promise<void> {
  const path = await markdownPathOf($)
  const failure = await runCode($, path)
  if (failure === null) {
    $.ui.log(`opened ${path} in VS Code`)
    return
  }
  $.ui.log(printedView(view, await readSnapshot($), path, factRanking))
  $.ui.log(`not opened in VS Code: ${failure}`)
}

/** Runs `code <path>`; null when it worked, else why not. A .md not written yet gets a placeholder first. */
async function runCode($: EngineInterface, path: string | null): Promise<string | null> {
  if (path === null) return 'HOME is not set, so the session has no .md file'
  try {
    if (!(await $.fs.exists(path))) await $.fs.write(path, MARKDOWN_PLACEHOLDER)
    const ran = await $.process.run(['code', path])
    return ran.exitCode === 0 ? null : `code exited with ${ran.exitCode} (${firstLine(ran.stderr)})`
  } catch (error) {
    return `code could not run (${(error as Error).message})`
  }
}

/** Whether this is the VS Code chat panel: by the entrypoint, or by a `vscode` surface on the roster. */
async function isInVsCodePanel($: EngineInterface): Promise<boolean> {
  const entrypoint = await $.env.get('CLAUDE_CODE_ENTRYPOINT')
  return isVsCodePanel({ entrypoint, surfaces: await $.session.surfaces() })
}

/** Registers the commands and the tool, builds the cold start, and starts watching the folder. */
async function startParticipating($: EngineInterface, model: string, cwd: string): Promise<void> {
  await $.command.register({
    name: 'glossary', description: 'Open the Bearings glossary pane (print: show it in the transcript)', argumentHint: '[print]',
  })
  await $.command.register({
    name: 'bearings',
    description: 'Open the Bearings pane (print: in the transcript; rebuild: from the transcript; scan: from the repo)',
    argumentHint: '[print|rebuild|scan]',
  })
  await $.tool.register({ name: 'add', description: ADD_TOOL_DESCRIPTION, inputSchema: ADD_TOOL_SCHEMA })
  await startInFolder($, model, cwd)
  ensureOtherSessionsPoll($)
}

/** Loads what is kept per folder and builds the cold start for that folder. */
async function startInFolder($: EngineInterface, model: string, cwd: string): Promise<void> {
  const root = await $.session.root()
  await update($, startedFolderAtom, () => root)
  await loadKnownTerms($, cwd)

  try {
    await coldStart($, model, cwd)
  } catch (error) {
    $.ui.log(`cold start skipped (${(error as Error).message})`)
  }
}

/**
 * The desktop app can start a spare session in a neutral folder and assign it to a project later,
 * so `session.start` may have seen the wrong folder. When the project root has changed since that
 * start, runs the per-folder start for the real one, before anything writes to its store keys.
 * It compares the root because a shell `cd` does not move it, and `cwd` would follow one.
 */
async function restartIfFolderChanged($: EngineInterface, model: string): Promise<void> {
  const startedFolder = await read($, startedFolderAtom)
  if (startedFolder === null) return

  const root = await $.session.root()
  if (root !== startedFolder) await startInFolder($, model, root)
}

function openGlossary($: EngineInterface) {
  return $.ui.open({ id: GLOSSARY_PANE, title: 'Glossary' })
}

function openBearings($: EngineInterface) {
  return $.ui.open({ id: BEARINGS_PANE, title: 'Bearings' })
}

export const register: Register = (on, options) => {
  const model = typeof options.model === 'string' && options.model.trim() !== '' ? options.model.trim() : DEFAULT_MODEL
  const curatorModel =
    typeof options.curatorModel === 'string' && options.curatorModel.trim() !== '' ? options.curatorModel.trim() : DEFAULT_CURATOR_MODEL
  factRanking = options.ranking === 'llm' ? 'llm' : 'mechanical'
  const updateSettings: UpdateSettings = { model, curatorModel, ranking: factRanking }

  // -------------------------------------------------------------------------
  // Events

  on('session.start', async ($, e, next) => {
    const signals = {
      isInteractive: e.isInteractive,
      entrypoint: await $.env.get('CLAUDE_CODE_ENTRYPOINT'),
      surfaces: await $.session.surfaces(),
      isChildSession: (await $.env.get('CLAUDE_CODE_CHILD_SESSION')) !== undefined,
    }
    const participation = participationAtStart(signals)
    await update($, participationAtom, () => participation)
    $.ui.log(
      `session start: isInteractive=${signals.isInteractive} surface=${e.surface} ` +
        `surfaces=[${signals.surfaces.join(', ')}] entrypoint=${signals.entrypoint ?? '(unset)'} participation=${participation}`,
      { to: 'debug' },
    )

    if (participation !== 'off') await startParticipating($, model, e.cwd)
    return next(e)
  })

  // A session that started off switches on when the VS Code panel attaches later.
  on('session.attach', async ($, e, next) => {
    if (e.surface === 'vscode' && (await read($, participationAtom)) === 'off') {
      await update($, participationAtom, () => 'panel')
      $.ui.log('VS Code attached: participation=panel', { to: 'debug' })
      await startParticipating($, model, await $.session.cwd())
    }
    return next(e)
  })

  on('command.run', { command: 'glossary' }, async ($, e) => runViewCommand($, model, 'glossary', e.args))
  on('command.run', { command: 'bearings' }, async ($, e) => runViewCommand($, model, 'bearings', e.args))

  // A printed view's output row: its stub text is replaced by the view as it was printed.
  on('ui.render', { component: 'CommandOutput', props: { command: 'glossary' } }, async ($, e, next) => {
    const drawing = await printDrawingFor($, 'glossary', e.props.text)
    if (drawing === null) return next(e)
    const { Markdown } = $.ui.resolve(e)
    return <Markdown text={drawing} />
  })

  on('ui.render', { component: 'CommandOutput', props: { command: 'bearings' } }, async ($, e, next) => {
    const drawing = await printDrawingFor($, 'bearings', e.props.text)
    if (drawing === null) return next(e)
    const { Markdown } = $.ui.resolve(e)
    return <Markdown text={drawing} />
  })

  on('tool.call', { tool: 'mcp__bearings__add' }, async ($, e) => addFromTool($, e as ToolAddInput))

  // turn.start also fires for subagents; only the main thread's prompt is kept until its turn completes.
  on('turn.start', async ($, e, next) => {
    if (e.agentId !== undefined || (await isOff($))) return next(e)
    await restartIfFolderChanged($, model)
    await update($, pendingPromptAtom, () => ({ turnId: e.turnId, text: e.text }))
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    if (e.agentId !== undefined || (await isOff($))) return next(e)
    ensureOtherSessionsPoll($)

    const turn = await update($, turnAtom, count => count + 1)
    const pending = await read($, pendingPromptAtom)
    const prompt = pending !== null && pending.turnId === e.turnId ? pending.text : ''
    await update($, pendingPromptAtom, () => null)

    if (prompt.trim() !== '' || e.answer.trim() !== '') {
      const finished: TurnText = { turn, prompt, answer: e.answer }
      // A timer starts the update outside this dispatch, so the turn ends without waiting for it.
      $.clock.after(0, () => updates.push(finished, turns => runUpdate($, updateSettings, turns)))
    }
    return next(e)
  })

  on('session.compact', async ($, e, next) => {
    const result = await next(e)
    const isMainCompaction = e.agentId === undefined && e.trigger !== 'precompute'
    if (!isMainCompaction || result.skip !== undefined || (await isOff($))) return result

    const bearings = await readBearings($)
    const others = (await readOtherActiveSessions($)).map(summarize)
    if (bearings === null && others.length === 0) return result

    const turn = await read($, turnAtom)
    const own = bearings === null ? '_No bearings yet._' : bearingsSections(bearings, heldFactSections(factTiers(bearings, turn, factRanking)))
    await appendNote($, compactionNote(own, others, await $.clock.now()))
    return result
  })

  // -------------------------------------------------------------------------
  // Drawing: the band above the prompt and the two panes

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const participation = await read($, participationAtom)
    if (e.props.hasSurvey || participation === 'off' || participation === 'panel') return next(e)
    const { Box, Button, Text } = $.ui.resolve(e)

    const glossary = await read($, glossaryAtom)
    const bearings = await read($, bearingsAtom)
    const turn = await read($, turnAtom)
    const isBusy =
      (await read($, isUpdatingAtom)) || (await read($, isScanningAtom)) || (await read($, rebuildProgressAtom)) !== null
    const otherCount = (await read($, otherSessionsAtom)).length

    const knownTerms = await read($, knownTermsAtom)
    const newCount = glossary.filter(entry => isNew(entry, turn) && !isKnown(entry.term, knownTerms)).length
    const bearingsAge = bearings === null ? 'not built yet' : turnsAgo(turn - bearings.updatedAtTurn)

    return (
      <Box flexDirection="row" gap={2}>
        <Button key="open-glossary" plain hotkey="g" label={`Glossary · ${newCount} new`} onPress={() => void openGlossary($)} />
        <Button key="open-bearings" plain hotkey="b" label={`Bearings · ${bearingsAge}`} onPress={() => void openBearings($)} />
        {otherCount > 0 && <Text dimColor>· {otherCountLabel(otherCount)}</Text>}
        {isBusy && <Text dimColor>updating</Text>}
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: GLOSSARY_PANE }, async ($, e) => {
    const elements = $.ui.resolve(e)
    const { Box, Button, Markdown, Text } = elements
    const Input = 'Input' in elements ? elements.Input : undefined

    const turn = await read($, turnAtom)
    const isEarlierOpen = await read($, isGlossaryEarlierOpenAtom)
    const knownTerms = await read($, knownTermsAtom)
    const glossary = await read($, glossaryAtom)
    const shown = glossary.filter(entry => !isKnown(entry.term, knownTerms))
    const knownCount = glossary.length - shown.length
    const { recent, earlier } = splitByRecency(shown, turn)

    return (
      <Box flexDirection="column" gap={1}>
        {recent.length === 0
          ? <Text dimColor>No terms in the last 30 turns.</Text>
          : <Markdown text={capText(glossaryList(recent), MARKDOWN_LIMIT)} />}
        {earlier.length > 0 && (
          <Button
            key="toggle-earlier"
            plain
            dimColor
            label={`${isEarlierOpen ? 'Hide' : 'Show'} earlier (${earlier.length})`}
            onPress={() => void update($, isGlossaryEarlierOpenAtom, isOpen => !isOpen)}
          />
        )}
        {earlier.length > 0 && isEarlierOpen && <Markdown dimColor text={capText(glossaryList(earlier), MARKDOWN_LIMIT)} />}
        {knownCount > 0 && <Text dimColor>{knownCountLabel(knownCount)}</Text>}
        {Input !== undefined && (
          <Input
            key="glossary-input"
            placeholder="add: term = meaning · fact: text · pin: term · pin project: term · unpin: term · known: term"
            onSubmit={value => void submitPaneInput($, model, value, false)}
          />
        )}
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: BEARINGS_PANE }, async ($, e) => {
    const elements = $.ui.resolve(e)
    const { Box, Button, Markdown, Text } = elements
    const Input = 'Input' in elements ? elements.Input : undefined

    const turn = await read($, turnAtom)
    const bearings = (await readBearings($)) ?? emptyBearings()
    const isEarlierOpen = await read($, isBearingsEarlierOpenAtom)
    const rebuildProgress = await read($, rebuildProgressAtom)
    const thread = await read($, btwAtom)
    const pendingQuestion = await read($, btwPendingQuestionAtom)
    const notice = await read($, btwNoticeAtom)
    const stats = await read($, statsAtom)
    const tiers = factTiers(bearings, turn, factRanking)
    const earlierFacts = tiers.earlier
    const inherited = bearings.inheritedFrom
    const otherSessions = await read($, otherSessionsAtom)
    const isOthersOpen = await read($, isOtherSessionsOpenAtom)
    const now = await $.clock.now()

    return (
      <Box flexDirection="column" gap={1}>
        {inherited !== undefined && (
          <Text dimColor>
            glossary seeded from the other sessions here (newest {shortId(inherited.sessionId)}, {relativeTime(Date.parse(inherited.savedAt), now)})
          </Text>
        )}
        <Markdown text={capText(bearingsSections(bearings, heldFactSections(tiers), turn), MARKDOWN_LIMIT)} />
        {earlierFacts.length > 0 && (
          <Button
            key="toggle-earlier"
            plain
            dimColor
            label={`${isEarlierOpen ? 'Hide' : 'Show'} earlier facts (${earlierFacts.length})`}
            onPress={() => void update($, isBearingsEarlierOpenAtom, isOpen => !isOpen)}
          />
        )}
        {earlierFacts.length > 0 && isEarlierOpen && <Markdown dimColor text={capText(earlierFactsText(earlierFacts), MARKDOWN_LIMIT)} />}
        {otherSessions.length > 0 && (
          <Button
            key="toggle-other-sessions"
            plain
            dimColor
            label={`${isOthersOpen ? 'Hide' : 'Show'} other sessions here (${otherSessions.length})`}
            onPress={() => void update($, isOtherSessionsOpenAtom, isOpen => !isOpen)}
          />
        )}
        {otherSessions.length > 0 && isOthersOpen && (
          <Markdown text={capText(`## Other sessions here\n\n${sessionSections(otherSessions, now)}`, MARKDOWN_LIMIT)} />
        )}
        <Button key="rebuild" hotkey="r" label={rebuildLabel(rebuildProgress)} onPress={() => void logIfNotDone($, async () => { await restartIfFolderChanged($, model); return rebuild($, model) })} />
        {thread.length > 0 && <Markdown text={capText(btwThread(thread), MARKDOWN_LIMIT)} />}
        {pendingQuestion !== null && <Text dimColor>thinking: {pendingQuestion}</Text>}
        {notice !== null && <Text dimColor>{notice}</Text>}
        {Input !== undefined && (
          <Input
            key="btw-input"
            placeholder="btw: a side question (or add: / fact: / pin: / drop: commands)"
            submitLabel="ask"
            onSubmit={value => void submitPaneInput($, model, value, true)}
          />
        )}
        <Text dimColor>{statsLine(stats)}</Text>
      </Box>
    )
  })
}

// ---------------------------------------------------------------------------
// Small text helpers for the drawing

function turnsAgo(turns: number): string {
  if (turns <= 0) return 'updated this turn'
  return turns === 1 ? 'updated 1 turn ago' : `updated ${turns} turns ago`
}

function rebuildLabel(progress: { done: number; total: number } | null): string {
  return progress === null ? 'Rebuild' : `rebuilding ${Math.min(progress.done + 1, progress.total)} of ${progress.total}`
}

function knownCountLabel(count: number): string {
  return count === 1 ? '1 known term hidden (unknown: <term> shows it)' : `${count} known terms hidden (unknown: <term> shows one)`
}

function otherCountLabel(count: number): string {
  return count === 1 ? '1 other session here' : `${count} other sessions here`
}

function statsLine(stats: UpdateStats): string {
  return `${stats.calls} calls · ${stats.failures} failures · ${stats.inputTokens} in · ${stats.outputTokens} out · ${stats.cacheReadTokens} cache read`
}

function btwThread(exchanges: BtwExchange[]): string {
  return exchanges.map(one => `**btw (T${one.atTurn}):** ${one.question}\n\n${one.answer}`).join('\n\n---\n\n')
}

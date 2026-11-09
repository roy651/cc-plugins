export type Pin = 'none' | 'session' | 'project'

/** Who wrote an entry. `repo` came from a scan of the repo's files (handoff, CLAUDE.md, README, git) and any update replaces it. */
export type Source = 'auto' | 'operator' | 'claude' | 'inherited' | 'repo'

export interface GlossaryEntry {
  term: string
  meaning: string
  firstTurn: number
  lastSeenTurn: number
  pin: Pin
  source: Source
}

/** 3 stays true and causes a mistake if forgotten, 2 is useful beyond the current step, 1 is a detail of the moment. */
export type Importance = 1 | 2 | 3

export interface Fact {
  /** `f<n>`, unique in the session. */
  id: string
  text: string
  lastSeenTurn: number
  pin: Pin
  source: Source
  importance: Importance
  /** How many times the fact was mentioned again after it was added. */
  mentions: number
}

/** A fact as a file or a value written before ids, importance and mentions existed may hold it. */
export type StoredFact = Omit<Fact, 'id' | 'importance' | 'mentions'> & Partial<Pick<Fact, 'id' | 'importance' | 'mentions'>>

/** The order an update call gave the facts, with `userConfig.ranking` set to `llm`. It holds only for the update of `turn`. */
export interface FactRank {
  turn: number
  hold: string[]
  recent: string[]
}

/** Who orders the facts in view: local scoring, or the update call. */
export type Ranking = 'mechanical' | 'llm'

/** The Bearings fields a repo scan may fill: the goal and the lists (facts carry their own source). */
export type BearingsField = 'goal' | 'subGoals' | 'doneRecently' | 'inProgress' | 'expectedNext' | 'openDecisions'

export interface Bearings {
  goal: string
  subGoals: string[]
  doneRecently: string[]
  inProgress: string[]
  expectedNext: string[]
  openDecisions: string[]
  facts: Fact[]
  /** The number of the next fact id. It only goes up, so an id is never issued twice. */
  nextFactId: number
  updatedAtTurn: number
  /** The turn the curator last ran on, or tried to. Unset before its first run and after a rebuild. */
  lastCuratedTurn?: number
  factRank?: FactRank
  inheritedFrom?: { sessionId: string; savedAt: string }
  /** Fields whose current content came from a repo scan; an update that sets a field takes it off. */
  repoFields?: BearingsField[]
  /** The turn each field's content last changed. A field missing here has not changed since this record began. */
  changedAtTurn?: Partial<Record<BearingsField, number>>
}

export interface BtwExchange {
  question: string
  answer: string
  atTurn: number
}

export interface UpdateStats {
  calls: number
  failures: number
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
}

/** The prompt of the main-thread turn that is running, kept until its turn.complete. */
export interface PendingPrompt {
  turnId: string
  text: string
}

/** Another session working in the same folder, as its file last said: what the band and pane show of it. */
export interface SessionSummary {
  sessionId: string
  lastTouched: string
  goal: string
  inProgress: string[]
  expectedNext: string[]
  openDecisions: string[]
}

/**
 * Whether this session takes part: `active` for the interactive terminal or desktop session,
 * `panel` for the VS Code chat panel (it takes part but draws no band or pane), `off` for a
 * non-interactive run (-p, other SDK hosts, a fixer), `unknown` until session.start says (a hot
 * reload of a session that started before this key existed stays `unknown` and counts as active).
 */
export type Participation = 'unknown' | 'active' | 'panel' | 'off'

/** One `/glossary print` or `/bearings print`: the view as it was then, drawn in that command's output row. */
export interface PrintedView {
  /** The number the output row's stub text names (`#<n>`). */
  n: number
  view: 'glossary' | 'bearings'
  markdown: string
  markdownPath: string | null
}

declare module 'claude-code' {
  interface PluginState {
    bearings: {
      glossary: GlossaryEntry[]
      bearings: Bearings | null
      /** Count of completed main-thread turns. */
      turn: number
      /** The last 20 side questions and their answers. */
      btw: BtwExchange[]
      stats: UpdateStats
      pendingPrompt: PendingPrompt | null
      isUpdating: boolean
      isScanning: boolean
      /** While a rebuild runs: how many transcript chunks are done of how many; null otherwise. */
      rebuildProgress: { done: number; total: number } | null
      /** The btw question being answered right now, shown as "thinking". */
      btwPendingQuestion: string | null
      /** A one-line message under the btw thread (nothing to fork, a failed call). */
      btwNotice: string | null
      isGlossaryEarlierOpen: boolean
      isBearingsEarlierOpen: boolean
      /** Other sessions active in this folder in the last 48 h, newest first; re-read once a minute. */
      otherSessions: SessionSummary[]
      isOtherSessionsOpen: boolean
      participation: Participation
      /** The project root the per-folder start last ran for; null before it has run. */
      startedFolder: string | null
      /** The last 20 printed views, oldest first. */
      prints: PrintedView[]
      /** Terms the operator already knows: hidden from the glossary pane, never pruned. Kept per folder in the store. */
      knownTerms: string[]
    }
  }
}

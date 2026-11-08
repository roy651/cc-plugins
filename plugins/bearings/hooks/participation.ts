import type { Participation } from '../types'

/** What Claude Code's VS Code extension sets as the session's entrypoint (`CLAUDE_CODE_ENTRYPOINT`). */
export const VSCODE_ENTRYPOINT = 'claude-vscode'

/** What the desktop app's Code tab sets as the session's entrypoint. */
export const DESKTOP_ENTRYPOINT = 'claude-desktop'

export interface StartSignals {
  isInteractive: boolean
  entrypoint: string | undefined
  surfaces: readonly string[]
  /** Whether `CLAUDE_CODE_CHILD_SESSION` is set: the run was started from another session's shell. */
  isChildSession?: boolean
}

/** The VS Code chat panel runs on the Agent SDK (not interactive) but is a person's session. */
export function isVsCodePanel(signals: Pick<StartSignals, 'entrypoint' | 'surfaces'>): boolean {
  return signals.entrypoint === VSCODE_ENTRYPOINT || signals.surfaces.includes('vscode')
}

/**
 * The Code tab runs on the Agent SDK (not interactive) but is a person's session.
 * A `claude -p` started from that session's shell inherits the entrypoint and is not one.
 */
function isDesktopSession(signals: StartSignals): boolean {
  return signals.entrypoint === DESKTOP_ENTRYPOINT && !signals.isChildSession
}

/**
 * `active` for the interactive terminal or desktop session, `panel` for the VS Code chat panel
 * (no band or panes there), `off` for everything else: `-p`, other SDK hosts, fixers.
 */
export function participationAtStart(signals: StartSignals): Participation {
  if (signals.isInteractive || isDesktopSession(signals)) return 'active'
  return isVsCodePanel(signals) ? 'panel' : 'off'
}

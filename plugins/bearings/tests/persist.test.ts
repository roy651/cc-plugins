import { expect, test } from 'claude-code/testing'

import { snapshotMarkdown } from '../hooks/markdown'
import { emptyBearings } from '../hooks/merge'
import { appendBounded, bearingsFolder, failureLogPath, readSessionFiles, saveSession } from '../hooks/persist'
import type { FileAccess, SavedSession } from '../hooks/persist'
import { emptyStats } from '../hooks/update'

/** Files in memory; `mtimeMs` given per write so a test controls which file is newer. */
function memoryFiles() {
  const files = new Map<string, { text: string; mtimeMs: number }>()
  let nextMtime = Date.parse('2026-10-03T09:00:00.000Z')
  const access: FileAccess = {
    read: async path => {
      const file = files.get(path)
      if (file === undefined) throw new Error(`ENOENT ${path}`)
      return file.text
    },
    write: async (path, text) => {
      nextMtime += 60_000
      files.set(path, { text, mtimeMs: nextMtime })
    },
    list: async folder => {
      const entries = [...files.entries()].filter(([path]) => path.startsWith(`${folder}/`))
      if (entries.length === 0) throw new Error(`ENOENT ${folder}`)
      return entries.map(([path, file]) => ({ name: path.slice(folder.length + 1), kind: 'file', mtimeMs: file.mtimeMs }))
    },
  }
  return { files, access }
}

function savedSession(sessionId: string, lastTouched: string, goal: string): SavedSession {
  return {
    sessionId,
    cwd: '/w',
    startedAt: '2026-10-03T07:00:00.000Z',
    lastTouched,
    goal,
    turn: 12,
    glossary: [{ term: 'FMA', meaning: 'failure mechanism analyzer', firstTurn: 3, lastSeenTurn: 11, pin: 'session', source: 'auto' }],
    bearings: { ...emptyBearings(), goal, updatedAtTurn: 12 },
    btw: [],
    stats: emptyStats(),
  }
}

test('the folder sits beside Claude\'s own project folder', () => {
  expect(bearingsFolder('/Users/me', '/Users/me/work/repo')).toBe('/Users/me/.claude/projects/-Users-me-work-repo/bearings')
})

test('a saved session reads back whole, signature included, with the Markdown beside it', async () => {
  const { files, access } = memoryFiles()
  const saved = savedSession('session-a', '2026-10-03T08:00:00.000Z', 'first goal')

  await saveSession(access, '/f', saved, snapshotMarkdown(saved, 'mechanical'))

  expect(await readSessionFiles(access, '/f')).toEqual([saved])
  const markdown = files.get('/f/session-a.md')?.text ?? ''
  expect(markdown.indexOf('# Bearings')).toBeLessThan(markdown.indexOf('# Glossary'))
})

test('a file written before the signature existed reads with its mtime as lastTouched and its goal from Bearings', async () => {
  const { files, access } = memoryFiles()
  const legacy = { sessionId: 'old-format', savedAt: '2026-10-01T00:00:00.000Z', turn: 1, glossary: [], bearings: { ...emptyBearings(), goal: 'legacy goal\nsecond line' }, btw: [], stats: emptyStats() }
  files.set('/f/old-format.json', { text: JSON.stringify(legacy), mtimeMs: Date.parse('2026-10-03T12:00:00.000Z') })

  const [read] = await readSessionFiles(access, '/f')
  expect(read?.lastTouched).toBe('2026-10-03T12:00:00.000Z')
  expect(read?.goal).toBe('legacy goal')
})

test('sessions come newest first; broken files and a missing folder read as nothing', async () => {
  const { access } = memoryFiles()
  await saveSession(access, '/f', savedSession('older', '2026-10-02T08:00:00.000Z', 'a'), '')
  await saveSession(access, '/f', savedSession('newer', '2026-10-03T08:00:00.000Z', 'b'), '')
  await access.write('/f/broken.json', '{ half written')

  expect((await readSessionFiles(access, '/f')).map(one => one.sessionId)).toEqual(['newer', 'older'])
  expect(await readSessionFiles(access, '/nowhere')).toEqual([])
})

test('the failure log sits beside the session file and drops its oldest whole lines past the limit', () => {
  expect(failureLogPath('/f', 's1')).toBe('/f/s1.failures.log')
  expect(appendBounded('', 'one')).toBe('one\n')
  expect(appendBounded('one\n', 'two')).toBe('one\ntwo\n')

  const full = appendBounded('aaaa\nbbbb\n', 'cccc', 12)
  expect(full).toBe('bbbb\ncccc\n')
  expect(appendBounded('aaaa\n', 'bbbb', 12)).toBe('aaaa\nbbbb\n')
})

# bearings

Bearings is a Claude Code mod that helps you regain context. It is for people who step away from a long session, or who run several sessions at once, and need to see again what the work is about. A mod is a plugin that draws extra interface inside Claude Code. This one adds a band above the prompt with two views.

- **Glossary** lists the terms and ids from recent turns (acronyms, coined labels, backlog rows, gap codes) with a one-line meaning taken from the conversation. When the conversation does not state a meaning, it says so and does not guess.
- **Bearings** shows the goal, sub-goals, what was done recently, what is in progress, what is expected next, the open decisions waiting on you, and the facts in view: Hold and Recent.

The Bearings pane, open beside the conversation. The band with the two buttons sits above the prompt.

![The Bearings pane beside the conversation](docs/images/bearings-pane.png)

The Glossary pane. Each entry ends with the turn where the term first appeared.

![The Glossary pane beside the conversation](docs/images/glossary-pane.png)

## Requirements

Claude Code 2.1.287 or later. Check with:

```
claude --version
```

## Install

```
claude plugin marketplace add roy651/cc-plugins
claude plugin install bearings@cc-plugins
```

Then run `/reload-plugins` in an open session, or start a new one. Run `/plugin` and check that bearings is listed as an active mod. Claude Code asks you to trust the folder the first time. Accept the prompt, because mods do not load in an untrusted folder.

To work on the mod from a clone, start Claude Code with:

```
claude --plugin-dir <clone>/plugins/bearings
```

Or set `CLAUDE_CODE_PLUGIN_DIRS` to the same path in the `env` block of `~/.claude/settings.json`. The mod then loads in every session and reloads when you save a file.

## Use

The band above the prompt has two buttons and a status:

- `Glossary · <n> new` opens the Glossary pane (hotkey `g`). "New" means first seen in the last 3 turns.
- `Bearings · <age>` opens the Bearings pane (hotkey `b`).
- `updating` shows while the background update or a rebuild runs.
- `<n> other sessions here` appears when other sessions are active in the same folder.

To use a hotkey, click the button in the fullscreen terminal, or press ctrl+x then tab to reach the band and then the key. The same panes open with the slash commands:

```
/glossary
/bearings
```

Add `print` (`/bearings print`) to draw the view inline in the conversation instead of opening a pane. Claude reads only a one-line stub, not the view. In the VS Code chat panel the commands open the session's Markdown file instead.

`/bearings rebuild` regenerates the glossary and bearings from the whole transcript, as the pane's Rebuild button does, keeping pinned and hand-added entries.

When the conversation has said little, Bearings starts from the repo instead. A scan reads `.claude/handoff.md`, `CLAUDE.md`, `AGENTS.md`, the README, the last 15 commits, the uncommitted changes and the top-level file list, and fills only the gaps. What it adds is marked `(from repo)`, and the conversation replaces it as it goes. A scan runs once at the start of a session that inherits nothing, after a rebuild that comes out thin, and on demand with `/bearings scan`.

Both panes have an input line. Lines are read as commands when they start with one of these prefixes:

```
add: <term> = <meaning>
fact: <text>
pin: <term>
pin project: <term>
unpin: <term>
known: <term>
unknown: <term>
```

`add:` adds or replaces a glossary entry. `fact:` adds a fact to Bearings. `pin:` and `unpin:` take a term or the start of a fact text. `known:` marks a term you already know: it stays in the glossary and is still updated, but the Glossary pane hides it behind a count line, and it is never pruned. Known terms are kept per folder. `unknown:` shows the term again. Any other line typed in the Glossary pane shows the list of commands. Any other line typed in the Bearings pane is a btw question.

A btw question is a side question about the conversation. It is answered briefly in the pane and never enters the main conversation. The last 20 are kept.

The Rebuild button in the Bearings pane (hotkey `r`) regenerates the glossary and the bearings from the whole conversation. It reads the text of every message (not tool output) and feeds it to the background model in chunks, so it also works right after `claude --resume`. Pinned and added entries are kept.

You can also ask Claude in the conversation to add a term or a fact. Claude then calls the `add` tool (listed as `mcp__bearings__add`), and the entry appears in the panes.

**Pins and the 30-turn limit.** A glossary entry stays in the main list while it was seen in the last 30 turns. After each background update, terms and facts the background model added that have not been seen for 30 turns are deleted. Pinned entries, entries you or Claude added, known terms and importance 3 facts are never deleted. Glossary entries that go unseen move to a collapsed "Earlier" section. A pin keeps an entry in the main list. `pin:` holds it for this session, and `pin project:` holds it in every session started in the same folder.

**Facts: Hold, Recent, Earlier.** Facts stay in one pool, and each turn local scoring sorts them into three views. A fact is in exactly one.

- **Hold** has every pinned or hand-added fact, then the most important facts, up to 10.
- **Recent** has the rest seen in the last 5 turns, newest first, up to 10.
- **Earlier** has everything else. The "Show earlier facts" button opens the top 15 and says how many more are in the `.md` file.

The update call gives each new fact an importance from 1 to 3. Mentions raise a fact's score and time lowers it. After compaction the session receives Hold and Recent only. The `.md` file and `/bearings print` keep all three views in full. Every 10 turns, once there are at least 15 facts, a separate call corrects importance, merges duplicates and retires what no longer matters. It never touches pinned or hand-added facts.

Two options in `/config` under the plugin's options affect this. `curatorModel` picks the model for that call (default `haiku`). `ranking` is `mechanical` by default, which means local scoring. Set it to `llm` and the update call also re-ranks a shortlist of 40 facts, which costs more tokens per turn.

## Several sessions in one folder

Each session writes only its own file, signed with its session id, folder, start time, last activity and current goal. There is no shared file and no lock. Sessions active in the last 48 hours are merged when read, without a model call. Older files stay on disk and are ignored.

- The Bearings pane has a collapsed "Other sessions here" section with one block per active session: its goal, in progress, expected next and open decisions.
- The merged glossary is the union by term. When two sessions give different meanings for one term, both are shown, each tagged with the first 8 characters of its session id.
- A new session starts with its glossary seeded from the other active sessions. It also receives one note in the conversation with the merged view, up to about 6000 characters. If no other session is active, it receives nothing. A resumed session reloads its own file instead.
- After compaction, the session receives its own Bearings and one line per other active session (id, time, goal).

Subagents do not take part. Non-interactive runs (`claude -p`, the SDK) register nothing: no band, no updates, no files.

## Where it runs

| Surface | Result |
|---|---|
| Terminal CLI, including JetBrains and editor terminals | Full |
| Claude desktop app, Code tab | Full |
| VS Code extension chat panel | Background updates and files work. No band or panes. `/glossary` and `/bearings` open the session's live Markdown file in an editor tab (needs the `code` command on your PATH). `/bearings rebuild` logs when it starts and ends, then opens the file. For btw and editing, run `claude` in the VS Code terminal. |
| Remote Control from claude.ai or mobile | Updates run. The views draw only in the terminal on your machine. |
| Cloud sessions | Not loaded unless the plugin is installed there |

## Cost and privacy

After each turn, one call goes to the background model with the turn's prompt and final reply plus the current glossary, the bearings and the facts in view. That is a few thousand tokens. The default model is `sonnet`. Change it in `/config` under the plugin's options. Every 10 turns one more call goes to the curator model.

A repo scan is one call to the same model. Its input is capped near 30,000 characters of the repo's notes, git output and file list, plus the current glossary and bearings.

A btw question asks the session's own model over the whole conversation. This is cheap while the prompt cache is warm and a full-context read when it is cold. Right after a resume it is answered by the background model from the glossary, the bearings and the last 20 messages instead, and says so. Rebuild uses the background model over the text of every message.

Files are written to `~/.claude/projects/<folder>/bearings/<session id>.json` and `.md`, on your machine only. The `.md` file is the same content as readable Markdown.

## Development

```
claude plugin validate plugins/bearings
claude plugin test plugins/bearings
```

## License

MIT. See [LICENSE](../../LICENSE).

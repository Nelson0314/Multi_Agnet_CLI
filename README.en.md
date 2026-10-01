<p align="center"><img src="assets/icon-256.png" width="96" alt="" /></p>

<h1 align="center">Multi-Agent CLI</h1>

<p align="center"><a href="README.md">繁體中文</a> · English</p>

If you keep several Claude Code sessions open on one project, every reboot means opening a stack of terminals, `cd`-ing into the folder and running `--resume` for each one. This desktop app puts them in one window. The sidebar lists every Claude and Codex session in the folder. Click one and it opens as a terminal on the right, up to 6 side by side. Quit and reopen, and the same sessions come back.

![Terminal theme, English UI](docs/screenshots/terminal-en.png)

## Features

- Session history per project for Claude and Codex, with search, rename and copy-id.
- Each pane is a real terminal (node-pty + xterm.js) running your own `claude` and `codex`.
- Up to 6 panes. The grid follows the window's aspect ratio, and a short last row stretches so no cell is left empty.
- Each pane header shows the session name, Claude or Codex, the account, and context usage such as `76% · 152k / 200k`.
- A dashboard with the remaining 5-hour and weekly quota for every Claude and Codex account, colored by what is left (green above 50%, yellow 20–50%, red below 20%), plus context for each open pane.
- Separate Claude and Codex accounts, each with its own sign-in and its own active account, so Claude and Codex can use different accounts. Accounts of the same tool share session history, so another account can resume the same session.
- When an account runs out of usage, every pane on it moves to another account in one step: the old process exits and the same session resumes on the new account. No `/login` in each window.
- Five themes (Terminal, Graphite, Sand, Mono, Paper). The whole UI uses your system's terminal font, and the Claude and Codex labels keep their brand colors.
- English and Traditional Chinese UI, switchable in Dashboard, Appearance.

## Install

You need Node.js 22.12 or newer and a working, signed-in `claude`. Install `codex` too if you want Codex.

```bash
git clone https://github.com/Nelson0314/Multi_Agnet_CLI.git
cd Multi_Agnet_CLI
npm install
```

`npm install` puts a Multi-Agent CLI shortcut on your desktop:

| OS | Shortcut |
| --- | --- |
| Windows | `Desktop\Multi-Agent CLI.lnk` |
| macOS | `~/Desktop/Multi-Agent CLI.app` |
| Linux | `~/Desktop/multi-agent-cli.desktop`, also added to the app menu |

Run `npm run shortcut` to recreate it, or set `MULTI_AGENT_NO_SHORTCUT=1` during install to skip it. `npm start` in the project folder also works.

To update:

```bash
cd Multi_Agnet_CLI
git pull
npm install
```

Platform notes:

- macOS and Windows use node-pty's prebuilt binaries, so no compiler is needed.
- Linux needs `build-essential` and `python3`; `npm install` compiles node-pty.
- The app looks up `claude` and `codex` through your login shell, so installs via nvm, Homebrew or global npm are found.

## Usage

| Action | How |
| --- | --- |
| Open a project | Project button, top left |
| Open a past session | Click it in the sidebar. An open one gets focused instead. `↻` reloads the history |
| New session | `+ Claude` or `+ Codex`, optionally with a name |
| Plain terminal | `+ PowerShell` (`+ Shell` on macOS and Linux) opens a normal terminal in the project folder. Windows uses `pwsh` when PowerShell 7 is installed, otherwise Windows PowerShell. It is restored with the layout and carries the active Claude and Codex accounts, so `claude` or `codex` typed there use those accounts |
| Rename | Double-click the pane title, or right-click in the list |
| Maximize | `⤢` on the pane |
| Resize panes | Drag the lines between panes: vertical lines change widths, horizontal lines change row heights, double-click to even them out. Sizes are kept as ratios, so the panes still fill the window when it is resized, and they are restored on the next launch |
| Focus pane N | `Ctrl/⌘ + 1…6` |
| Sidebar | Collapsed to a thin strip with a single `›` by default; hover to float the full sidebar over the panes. `‹` `›` or `Ctrl/⌘ + B` keeps it open or collapses it |
| Copy, paste | `⌘C` `⌘V` on macOS; `Ctrl+Shift+C` `Ctrl+Shift+V` on Windows and Linux. `Ctrl+V` stays with Claude Code for pasting images |
| Resume on another account, restart | `⇄` on the pane |
| Sign in, add or switch accounts | The Claude and Codex account menus, top right |
| Theme, font size, font, language | Dashboard, Appearance |
| Pane buttons | Shown when the mouse is over a pane or the pane has focus |

Closing a pane ends the process. The session stays on disk and can be reopened from the list.

## Appearance

The terminal font defaults to what your OS terminal uses: SF Mono or Menlo on macOS, Cascadia Mono or Consolas on Windows, DejaVu Sans Mono on Linux. Chinese text also uses monospaced fonts: Sarasa Mono TC, Noto Sans Mono CJK TC or the console font MingLiU on Windows, PingFang on macOS, Noto Sans Mono CJK TC on Linux. Set any other font in Terminal font.

Themes only change the app's background, text and borders. Program output in the panes keeps its own colors, and the 16-color ANSI palette matches your OS terminal: Campbell from Windows Terminal, Terminal.app on macOS, Tango from GNOME Terminal on Linux.

With a light theme such as Paper, run `/theme` in Claude Code and choose `Auto (match terminal)`. The app answers Claude's background-color query, so Claude switches to its light palette.

## Accounts

Claude and Codex accounts are managed separately. The top bar has two account menus, one per tool, each with its own list, sign-in and active account. A Claude pane uses the active Claude account, a Codex pane the active Codex account. Claude panes also get the active Codex account, so a Codex sub-agent started by Claude uses it too.

The default Claude account is your existing `~/.claude` and the default Codex account is your existing `~/.codex`. Nothing is moved.

- Adding a Claude account creates a new `CLAUDE_CONFIG_DIR` and opens a small terminal running `claude auth login`. With "share session history" checked (the default), its `projects/`, `settings.json`, `CLAUDE.md`, `commands/`, `agents/` and `skills/` are symlinked (junctions on Windows) to `~/.claude`.
- Adding a Codex account creates a new `CODEX_HOME` and runs `codex login`. With "share session history" checked, its `sessions/`, `config.toml`, `AGENTS.md`, `session_index.jsonl` and prompt history point to `~/.codex`. The sign-in (`auth.json`) stays separate.

If the browser shows a code instead of finishing the Claude sign-in on its own, paste it into the field under the small terminal. `Ctrl+V` also pastes in that terminal.

Picking another account in a menu makes new sessions use it. If panes are still open on other accounts of that tool, the app asks whether to move them too.

Only add accounts you own, and follow each service's terms.

### When an account runs out

Claude Code picks its account when it starts, and a running process cannot switch. Running `/login` in one window also replaces the sign-in for every window that shares the same config folder, and the other windows keep using the old token until they restart. That is why one exhausted account normally means typing `/login` in every window.

Here every account has its own config folder, so different accounts can run side by side. When an account runs out, every pane on it, in every open project, moves to the account with the most usage left:

1. Panes that were cut off by the limit, and idle panes, move right away: the process exits, and the same session resumes on the new account with `claude --resume <id>` (or `codex resume <id>`). The conversation is kept.
2. A pane that was cut off gets a short message asking it to continue. You can turn this off with "Continue after switching".
3. Panes that are still working keep running and move when they stop, so work in progress is not interrupted. The pane shows a note with a "Switch now" button.
4. New sessions use the new account too.

What counts as out of usage: a pane prints a usage-limit message (for example `You've hit your session limit`) and the account's usage confirms it, or the usage check every 2 minutes reports a 5-hour or weekly window at 100% while panes use that account. Text alone is not trusted, because the same words can just be on screen. If the usage cannot be read, the app asks instead of switching.

"When usage runs out" in the dashboard settings: Ask (a bar at the top with one button that moves every pane), Switch account (automatic), or Do nothing.

Before a Claude pane starts on a non-default account that shares history, the app copies a few things from `~/.claude.json` that are not covered by the shared folders: folder trust, user and local MCP servers, allowed tools and first-run setup. Without them the resumed session would stop at the "trust this folder?" dialog or be missing tools. The account's own values are never overwritten.

## Claude and Codex

The reasoning is in [docs/DESIGN.md](docs/DESIGN.md) (Traditional Chinese).

Codex as a sub-agent: "Let Claude call Codex" in the account menu runs `claude mcp add --scope user codex -- codex mcp-server`. Claude can then start a Codex session with `codex` and continue it with `codex-reply`. Codex sessions started this way show up in the Codex tab with a sub-agent label, and you can open them to read or take over.

### Codex joins the team

No setup. A Codex pane starts from the same place as a Claude pane:

| A Codex pane gets | From |
| --- | --- |
| The pane-to-pane tools and a short team note | This app, passed with `-c` so your `config.toml` is not changed |
| Your global instructions for Claude | `~/.claude/CLAUDE.md` of the active Claude account |
| Project instructions | `CLAUDE.md`, `.claude/CLAUDE.md` and `CLAUDE.local.md` in every folder from the filesystem root down to the working folder, plus `.claude/rules/*.md`. `@path` imports are expanded. Rules with `paths` are listed with their scope and read when needed |
| Skills | Name, description and `SKILL.md` path of each skill in `~/.claude/skills` and the project's `.claude/skills`, unless Codex already has a skill with that name |
| MCP servers | Claude's user and local servers and the approved ones in the project's `.mcp.json`. stdio and HTTP servers are carried over with `${VAR}` expanded. SSE servers and names containing `.` are skipped. A server already defined in Codex's `config.toml` keeps Codex's definition |

The other way round, Claude panes get the project's `AGENTS.md` (unless `CLAUDE.md` already imports it) and `$CODEX_HOME/AGENTS.md`. Any `developer_instructions` you set in Codex's `config.toml` stay first.

Hover a pane title to see which files, skills and MCP servers it was given. To turn this off, clear "Share instructions between Claude and Codex" in the dashboard settings.

## Panes talking to each other

Every Claude and Codex pane starts with a set of MCP tools and a short note telling the agent it runs next to other panes and should use these tools to reach them, instead of starting its own `claude` or `codex` process. Nothing to install. The `[mcp_servers.multi-agent]` block older versions wrote to Codex's `config.toml` is removed at startup.

| Tool | What it does |
| --- | --- |
| `list_panes` | Pane numbers, kinds and names in the current project |
| `send_to_pane` | Send a message to another pane |
| `read_pane` | Read another pane's latest reply, or the last screen lines of a shell pane |
| `wait_for_reply` | Wait until a Claude or Codex pane finishes answering and return the reply |

For example, tell the Claude pane "ask the Codex in pane 3 to review src/api.ts and summarize its reply". Claude calls the tools itself, and both sides of the conversation stay on screen.

- Messages start with their source, such as `[from pane 2 · Claude · API refactor]`.
- Messages are sent directly after the target has been quiet for 2 seconds. Turn on "Confirm pane messages" to have them wait in the target's input until you press Enter.
- Codex panes start with `codex --no-daemon` when the installed Codex has that flag. Newer Codex versions otherwise run the conversation on a shared background server, whose tools cannot reach the pane and report "not reachable".
- At most 12 messages between the same two panes in 10 minutes, so two agents cannot loop forever.
- The server listens on localhost only, and its token is given only to panes opened by the app.

## Where context and usage numbers come from

Claude panes report Claude Code's own numbers through its statusline: context used, context window size, and 5-hour and weekly usage. The pane header and dashboard therefore match what Claude shows, and they follow the new session after `/clear`. If you already have your own statusline, it still runs and shows. Until the first report arrives, the numbers are computed from the session transcript.

## Session names

The name you type for a new session, and any rename inside the app, is written back to Claude's and Codex's own records, the same as running `/rename`, so `claude -r` and `codex resume` show it too. For Claude the name is written once the first message creates the transcript.

## Where the data comes from

| Data | Source |
| --- | --- |
| Claude sessions, names, context | `~/.claude/projects/<encoded path>/<sessionId>.jsonl`. Names come from `/rename`, then the auto title, then the first prompt |
| Codex sessions, context, usage | `$CODEX_HOME/sessions/YYYY/MM/DD/rollout-*.jsonl`. With several Codex accounts sharing history, usage is read from each account's own open sessions |
| Claude 5-hour and weekly usage | The OAuth usage endpoint behind Claude Code's `/usage`, with the token from `.credentials.json` or the macOS Keychain |
| Account email | Claude: `oauthAccount` in `<config dir>/.claude.json`. Codex: the `id_token` in `$CODEX_HOME/auth.json` |
| App settings and open panes | `state.json` in `~/Library/Application Support/multi-agent-cli` (macOS), `%APPDATA%\multi-agent-cli` (Windows) or `~/.config/multi-agent-cli` (Linux) |

Context usage is `input + cache_creation + cache_read` tokens of the last main-thread reply divided by the context window: 200k by default, 1M when usage exceeds 200k or the model is marked 1M.

## Known limits

- The Claude usage endpoint is undocumented. If its format changes, the dashboard says usage could not be loaded and everything else keeps working.
- macOS may ask for Keychain access the first time. Choose Always Allow.
- With an expired token, usage is unavailable until you open any session on that account.
- Codex usage comes from the last Codex reply, so it appears after you have used Codex once on that account.
- Limit detection matches terminal text and then checks the usage numbers. If a CLI changes its wording, update `LIMIT_PATTERNS` in `src/main/ptyManager.js`.
- Claude's permission rules, hooks and slash commands are not carried over to Codex; the two work differently. Remote MCP servers that need OAuth have to be signed in from Codex separately (`codex mcp login <name>`).
- On Windows the command goes through `cmd.exe`, which limits length and cannot carry line breaks, so a Codex pane's shared instructions are written to a file that Codex is told to read first. macOS and Linux pass them directly.
- Moving a pane restarts its process. Text typed into the input box but not sent is lost, and background tasks started inside that session stop. Shell panes keep the account they started with.
- The Linux shortcut passes `--no-sandbox` because Electron installed from npm has no setuid `chrome-sandbox`.

- Around 0.15x, Codex changed how messages are written in its session files (`item_completed` with `UserMessage` / `AgentMessage`). Both the old and new forms are read (tested with 0.159.3). Sessions compressed to `.jsonl.zst` do not show up in the Codex tab.

## Development

```bash
npm test          # unit tests
npm run icons     # regenerate png, ico and icns from assets/icon.svg
npm run shortcut  # recreate the desktop shortcut
```

## License

MIT

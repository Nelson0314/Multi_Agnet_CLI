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
- A dashboard with the remaining 5-hour and weekly quota for every Claude account and for Codex, colored by what is left (green above 50%, yellow 20–50%, red below 20%), plus context for each open pane.
- Multiple Claude accounts. Each one is a `CLAUDE_CONFIG_DIR` with shared session history, so another account can `--resume` the same session.
- When usage runs out, the pane offers to resume on another Claude account or to hand the work to Codex with a handoff file.
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
| Plain terminal | `+ PowerShell` (`+ Shell` on macOS and Linux) opens a normal terminal in the project folder. Windows uses `pwsh` when PowerShell 7 is installed, otherwise Windows PowerShell. It is restored with the layout and carries the active account's settings, so `claude` typed there uses the same account |
| Rename | Double-click the pane title, or right-click in the list |
| Maximize | `⤢` on the pane |
| Resize panes | Drag the lines between panes: vertical lines change widths, horizontal lines change row heights, double-click to even them out. Sizes are kept as ratios, so the panes still fill the window when it is resized, and they are restored on the next launch |
| Focus pane N | `Ctrl/⌘ + 1…6` |
| Sidebar | Collapsed to a thin strip with a single `›` by default; hover to float the full sidebar over the panes. `‹` `›` or `Ctrl/⌘ + B` keeps it open or collapses it |
| Copy, paste | `⌘C` `⌘V` on macOS; `Ctrl+Shift+C` `Ctrl+Shift+V` on Windows and Linux. `Ctrl+V` stays with Claude Code for pasting images |
| Resume on another account, hand off | `⇄` on the pane |
| Sign in, add or switch accounts | Account menu, top right |
| Theme, font size, font, language | Dashboard, Appearance |
| Pane buttons | Shown when the mouse is over a pane or the pane has focus |

Closing a pane ends the process. The session stays on disk and can be reopened from the list.

## Appearance

The terminal font defaults to what your OS terminal uses: SF Mono or Menlo on macOS, Cascadia Mono or Consolas on Windows, DejaVu Sans Mono on Linux. Chinese text also uses monospaced fonts: Sarasa Mono TC, Noto Sans Mono CJK TC or the console font MingLiU on Windows, PingFang on macOS, Noto Sans Mono CJK TC on Linux. Set any other font in Terminal font.

Themes only change the app's background, text and borders. Program output in the panes keeps its own colors, and the 16-color ANSI palette matches your OS terminal: Campbell from Windows Terminal, Terminal.app on macOS, Tango from GNOME Terminal on Linux.

With a light theme such as Paper, run `/theme` in Claude Code and choose `Auto (match terminal)`. The app answers Claude's background-color query, so Claude switches to its light palette.

## Accounts

The default account is your existing `~/.claude`. Nothing is moved.

Adding an account creates a new `CLAUDE_CONFIG_DIR` and opens a small terminal running `claude auth login`. With "share session history" checked (the default), the new account's `projects/`, `settings.json`, `CLAUDE.md`, `commands/`, `agents/` and `skills/` are symlinked (junctions on Windows) to `~/.claude`. When account A runs out, account B can `claude --resume` the same session with the full conversation.

Switching the active account only affects new sessions. Open panes can be moved one at a time from `⇄`.

Only add accounts you own, and follow each service's terms.

## Claude and Codex

The reasoning is in [docs/DESIGN.md](docs/DESIGN.md) (Traditional Chinese).

Codex as a sub-agent: "Let Claude call Codex" in the account menu runs `claude mcp add --scope user codex -- codex mcp-server`. Claude can then start a Codex session with `codex` and continue it with `codex-reply`. Codex sessions started this way show up in the Codex tab with a sub-agent label, and you can open them to read or take over.

When usage runs out, either because the pane prints a usage-limit message or because the usage API reports the 5-hour window at 100%, the pane shows these options:

1. Resume the same session on another Claude account that still has usage.
2. Write a handoff file and start Codex in the same pane, told to read it first.
3. Once Claude resets, hand the work back from Codex the same way.

Handoff files go to `.multi-agent/handoffs/` in the project and contain the original request, the todo list, changed files, `git status`, `git diff --stat` and the last 12 messages. The folder is added to `.git/info/exclude`.

In the dashboard settings you can choose Ask, Hand off automatically or Do nothing, and whether another account or Codex comes first.

## Panes talking to each other

Every Claude pane starts with a set of MCP tools and a short note telling Claude it runs next to other panes and should use these tools to reach them, instead of starting its own `codex` process. Nothing to install. For Codex panes, click "Let Codex panes talk to other panes" in the account menu once.

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
| Codex sessions, context, usage | `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl` |
| Claude 5-hour and weekly usage | The OAuth usage endpoint behind Claude Code's `/usage`, with the token from `.credentials.json` or the macOS Keychain |
| Account email | `oauthAccount` in `<config dir>/.claude.json` |
| App settings and open panes | `state.json` in `~/Library/Application Support/multi-agent-cli` (macOS), `%APPDATA%\multi-agent-cli` (Windows) or `~/.config/multi-agent-cli` (Linux) |

Context usage is `input + cache_creation + cache_read` tokens of the last main-thread reply divided by the context window: 200k by default, 1M when usage exceeds 200k or the model is marked 1M.

## Known limits

- The Claude usage endpoint is undocumented. If its format changes, the dashboard says usage could not be loaded and everything else keeps working.
- macOS may ask for Keychain access the first time. Choose Always Allow.
- With an expired token, usage is unavailable until you open any session on that account.
- Codex usage comes from the last Codex reply, so it appears after you have used Codex once.
- Limit detection matches terminal text. If a CLI changes its wording, update `LIMIT_PATTERNS` in `src/main/ptyManager.js`.
- The Linux shortcut passes `--no-sandbox` because Electron installed from npm has no setuid `chrome-sandbox`.

- Newer Codex versions can move sessions to a paginated, compressed format (after `codex migrate-rollouts --apply`). The app reads classic `rollout-*.jsonl` files only, so migrated sessions do not show up in the Codex tab.

## Development

```bash
npm test          # unit tests
npm run icons     # regenerate png, ico and icns from assets/icon.svg
npm run shortcut  # recreate the desktop shortcut
```

## License

MIT

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
- A dashboard with 5-hour and weekly usage for every Claude account and for Codex, plus context for each open pane.
- Multiple Claude accounts. Each one is a `CLAUDE_CONFIG_DIR` with shared session history, so another account can `--resume` the same session.
- When usage runs out, the pane offers to resume on another Claude account or to hand the work to Codex with a handoff file.
- Five low-saturation themes (Terminal, Graphite, Sand, Mono, Paper). The whole UI uses your system's terminal font.
- English and Traditional Chinese UI, switchable from the top bar.

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
| Open a past session | Click it in the sidebar. An open one gets focused instead |
| New session | `+ Claude` or `+ Codex`, optionally with a name |
| Rename | Double-click the pane title, or right-click in the list |
| Maximize | `⤢` on the pane |
| Focus pane N | `Ctrl/⌘ + 1…6` |
| Copy, paste | `⌘C` `⌘V` on macOS; `Ctrl+Shift+C` `Ctrl+Shift+V` on Windows and Linux. `Ctrl+V` stays with Claude Code for pasting images |
| Resume on another account, hand off | `⇄` on the pane |
| Sign in, add or switch accounts | Account menu, top right |
| Theme, font size, font, language | Dashboard, Appearance |

Closing a pane ends the process. The session stays on disk and can be reopened from the list.

## Appearance

The terminal font defaults to what your OS terminal uses: SF Mono or Menlo on macOS, Cascadia Mono or Consolas on Windows, DejaVu Sans Mono on Linux, with CJK fallbacks.

Terminal colors default to Muted. In this mode the app does not advertise 24-bit color, so CLIs fall back to 256 colors, and the theme replaces that palette with a desaturated one. Claude Code's orange headings and red/green diff backgrounds come out muted as well. Pick Full color to keep the original colors. The change applies to panes opened or restarted afterwards.

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

## Development

```bash
npm test          # unit tests
npm run icons     # regenerate png, ico and icns from assets/icon.svg
npm run shortcut  # recreate the desktop shortcut
```

## License

MIT

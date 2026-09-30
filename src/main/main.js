'use strict';
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { execFile } = require('child_process');
const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');

const { Store } = require('./store');
const { PtyManager, commandFor, shellCommand } = require('./ptyManager');
const claudeSessions = require('./claudeSessions');
const codexSessions = require('./codexSessions');
const usage = require('./usage');
const profiles = require('./profiles');
const { createHandoff } = require('./handoff');
const { setAutostart } = require('./autostart');
const { Bridge } = require('./bridge');
const titles = require('./titles');
const { writeCodexBridgeConfig } = require('./codexConfig');

const MAX_PANES = 6;
const ICON = path.join(__dirname, '..', '..', 'assets', process.platform === 'win32' ? 'icon.ico' : 'icon.png');

// 固定 userData 位置（package.json 加了 productName 之後，Electron 預設路徑會改變）
app.setPath('userData', path.join(app.getPath('appData'), 'multi-agent-cli'));
if (process.platform === 'win32') app.setAppUserModelId('io.github.nelson0314.multi-agent-cli');

let win;
let store;
let ptys;
let bridge;
const rendererAsks = new Map(); // reqId -> resolve

// 主程式向介面查詢（窗格順序、畫面文字等只有介面知道的資訊）
function askRenderer(method, args) {
  return new Promise((resolve, reject) => {
    if (!win || win.isDestroyed()) return reject(new Error('window closed'));
    const id = crypto.randomUUID();
    const timer = setTimeout(() => {
      rendererAsks.delete(id);
      reject(new Error('renderer timeout'));
    }, 5000);
    rendererAsks.set(id, (v) => {
      clearTimeout(timer);
      resolve(v);
    });
    win.webContents.send('bridge:ask', id, method, args);
  });
}
const panes = new Map(); // paneId -> { kind, cwd, sessionId, profileId }

function send(channel, ...args) {
  if (channel === 'pty:exit') {
    panes.delete(args[0]);
    cleanupPaneFiles(args[0]);
  }
  if (win && !win.isDestroyed()) win.webContents.send(channel, ...args);
}

function claudeRoot(profile) {
  return path.join(profiles.claudeDirOf(profile), 'projects');
}

function codexHomeOf(profile) {
  return profile.codexHome || codexSessions.defaultCodexHome();
}

function profilesWithAccounts() {
  return store.data.profiles.map((p) => ({ ...p, account: profiles.readAccount(p) }));
}

// 在使用者 login shell 中執行一次性指令（不是互動 pane），例如 claude mcp add
function runInShell(cmd, args, env) {
  const c = commandFor(cmd, args, { interactive: process.platform !== 'win32' });
  return new Promise((resolve) => {
    execFile(c.file, c.args, { env: { ...process.env, ...env }, timeout: 60_000 }, (err, stdout, stderr) => {
      resolve({ ok: !err, output: `${stdout || ''}${stderr || ''}`.trim() || (err ? err.message : '') });
    });
  });
}

function createWindow() {
  win = new BrowserWindow({
    width: 1600,
    height: 1000,
    minWidth: 900,
    minHeight: 600,
    backgroundColor: store.data.settings.windowBg || '#161616',
    title: 'Multi-Agent CLI',
    icon: ICON,
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  win.removeMenu();
  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });
}

function spawnArgs({ kind, sessionId, name, prompt }) {
  if (kind === 'claude') {
    if (sessionId) return { cmd: 'claude', args: ['--resume', sessionId], sessionId };
    const id = crypto.randomUUID();
    const args = ['--session-id', id];
    if (name) args.push('-n', name);
    if (prompt) args.push(prompt);
    return { cmd: 'claude', args, sessionId: id };
  }
  if (kind === 'codex') {
    if (sessionId) return { cmd: 'codex', args: ['resume', sessionId], sessionId };
    return { cmd: 'codex', args: prompt ? [prompt] : [], sessionId: null };
  }
  if (kind === 'shell') return { ...shellCommand(), sessionId: null, raw: true };
  if (kind === 'login') return { cmd: 'claude', args: ['auth', 'login'], sessionId: null };
  if (kind === 'codex-login') return { cmd: 'codex', args: ['login'], sessionId: null };
  throw new Error(`unknown pane kind ${kind}`);
}

// ---------------------------------------------------------------- Claude 窗格的自動設定
// 每個 Claude 窗格啟動時自動帶上：
//   --mcp-config：multi-agent 工具（跟其他窗格對話），連線資訊直接寫在設定裡，不依賴環境變數傳遞
//   --append-system-prompt-file：告訴 Claude 它在多窗格環境裡、要用這些工具跟其他窗格溝通
//   --settings：statusline 指令，把 Claude 自己算的 context 與額度回報給這個程式
const BRIDGE_DIR = () => path.join(app.getPath('userData'), 'bridge');
const MCP_SCRIPT = path.join(__dirname, '..', 'bridge', 'mcp.js');
const STATUS_SCRIPT = path.join(__dirname, '..', 'bridge', 'statusline.js');

const SYSTEM_HINT = `You are running inside Multi-Agent CLI, a desktop app that shows several terminal panes side by side for the same project: Claude Code sessions, Codex CLI sessions and plain shells. The user can see all of them.

The multi-agent MCP tools let you work with the other panes:
- list_panes: see the open panes, their numbers, kinds and titles.
- send_to_pane: send a message or a task to another pane, for example ask the Codex pane to review a change.
- wait_for_reply: wait until that Claude or Codex pane finishes and get its answer.
- read_pane: read another pane's latest reply, or the last lines of a shell pane.

When the user refers to another pane, to "Codex", or asks you to coordinate with another agent, use these tools. Do not start a separate codex process with Bash or use a different Codex MCP server for this, because that would not be the session the user is looking at. When you send a task, include the goal, the relevant files and how to verify the result.
`;

function userStatusline(profile) {
  try {
    const f = path.join(profiles.claudeDirOf(profile), 'settings.json');
    const s = JSON.parse(fs.readFileSync(f, 'utf8'));
    const cmd = s.statusLine && s.statusLine.command;
    return cmd && !cmd.includes('statusline.js') ? cmd : null;
  } catch {
    return null;
  }
}

function claudePaneArgs(paneId) {
  const dir = BRIDGE_DIR();
  fs.mkdirSync(dir, { recursive: true });
  const mcp = path.join(dir, `${paneId}.mcp.json`);
  fs.writeFileSync(
    mcp,
    JSON.stringify({ mcpServers: { 'multi-agent': { type: 'stdio', command: 'node', args: [MCP_SCRIPT], env: bridge ? bridge.envFor(paneId) : {} } } }),
  );
  const hint = path.join(dir, 'system-hint.md');
  fs.writeFileSync(hint, SYSTEM_HINT);
  const settings = path.join(dir, 'claude-settings.json');
  fs.writeFileSync(settings, JSON.stringify({ statusLine: { type: 'command', command: `node ${JSON.stringify(STATUS_SCRIPT)}`, padding: 0 } }));
  // --mcp-config 可接多個值，放在最前面、後面緊接其他旗標，才不會吃掉後面的參數
  return ['--mcp-config', mcp, '--append-system-prompt-file', hint, '--settings', settings];
}

function cleanupPaneFiles(paneId) {
  try {
    fs.rmSync(path.join(BRIDGE_DIR(), `${paneId}.mcp.json`), { force: true });
  } catch {}
}

// statusline 回報：更新這個窗格目前的 session（/clear 之後會換新的）、context 與額度
const liveLimits = new Map(); // profileId -> { at, fiveHour, sevenDay }
function handleStatus(paneId, s) {
  const pane = panes.get(paneId);
  if (!pane || pane.kind !== 'claude') return;
  if (s.session_id && s.session_id !== pane.sessionId) {
    pane.sessionId = s.session_id;
    send('pane:session', paneId, s.session_id);
  }
  const cw = s.context_window;
  if (cw && cw.context_window_size) {
    const tokens = cw.total_input_tokens || 0;
    pane.live = {
      at: Date.now(),
      context: tokens
        ? { tokens, window: cw.context_window_size, pct: cw.used_percentage != null ? cw.used_percentage : (tokens / cw.context_window_size) * 100, model: s.model && s.model.id }
        : null,
    };
    if (s.model && s.model.id) {
      const known = store.data.contextWindows || (store.data.contextWindows = {});
      if (known[s.model.id] !== cw.context_window_size) {
        known[s.model.id] = cw.context_window_size;
        store.save();
      }
    }
  }
  const rl = s.rate_limits;
  if (rl && (rl.five_hour || rl.seven_day)) {
    const norm = (w) => (w ? { pct: w.used_percentage, resetsAt: w.resets_at ? (typeof w.resets_at === 'number' ? w.resets_at * 1000 : Date.parse(w.resets_at)) : null } : null);
    liveLimits.set(pane.profileId, { at: Date.now(), fiveHour: norm(rl.five_hour), sevenDay: norm(rl.seven_day) });
  }
}

// session 名稱寫回 Claude / Codex（等同 /rename）。Claude 的 transcript 要等第一則訊息後才會建立，
// 所以先排隊，每 3 秒重試直到寫入成功
const pendingTitles = new Map(); // `${kind}:${id}` -> { kind, cwd, sessionId, name, profileId }

function queueTitle(kind, cwd, sessionId, name, profileId) {
  if (!name || !sessionId || (kind !== 'claude' && kind !== 'codex')) return;
  pendingTitles.set(`${kind}:${sessionId}`, { kind, cwd, sessionId, name, profileId });
  flushTitles();
}

function flushTitles() {
  for (const [key, t] of pendingTitles) {
    try {
      const profile = store.profile(t.profileId || store.data.activeProfile);
      const done =
        t.kind === 'claude'
          ? titles.setClaudeTitle(claudeSessions.sessionFile(t.cwd, t.sessionId, claudeRoot(profile)), t.sessionId, t.name)
          : titles.setCodexTitle(codexHomeOf(profile), t.sessionId, t.name);
      if (done) pendingTitles.delete(key);
    } catch (e) {
      console.warn('title:', e.message);
    }
  }
}

// 新開的 Codex session 沒辦法事先指定 id，開啟後輪詢 rollout 目錄把 id 找回來
function discoverCodexSession(paneId, cwd, codexHome, since) {
  const known = new Set([...panes.values()].filter((p) => p.kind === 'codex' && p.sessionId).map((p) => p.sessionId));
  let tries = 0;
  const t = setInterval(() => {
    const pane = panes.get(paneId);
    if (!pane || pane.sessionId || ++tries > 120) return clearInterval(t);
    const id = codexSessions.findNewSession(cwd, since, known, codexHome);
    if (id) {
      pane.sessionId = id;
      send('pane:session', paneId, id);
      clearInterval(t);
    }
  }, 3000);
}

function registerIpc() {
  ipcMain.handle('app:init', () => ({
    platform: process.platform,
    maxPanes: MAX_PANES,
    activeProfile: store.data.activeProfile,
    profiles: profilesWithAccounts(),
    settings: store.data.settings,
    lastProject: store.data.lastProject,
    recentProjects: store.data.recentProjects,
  }));

  ipcMain.handle('projects:list', () => {
    const active = store.profile(store.data.activeProfile);
    const found = claudeSessions.listProjects(claudeRoot(active));
    const seen = new Set(found.map((p) => p.cwd));
    const extra = store.data.recentProjects.filter((c) => !seen.has(c)).map((cwd) => ({ cwd, sessionCount: 0, lastActive: 0 }));
    return [...found, ...extra].filter((p) => fs.existsSync(p.cwd));
  });

  ipcMain.handle('projects:pick', async () => {
    const r = await dialog.showOpenDialog(win, { properties: ['openDirectory'] });
    return r.canceled ? null : r.filePaths[0];
  });

  ipcMain.handle('projects:open', (_e, cwd) => {
    store.touchProject(cwd);
    const p = store.project(cwd);
    return { cwd, panes: p.panes, names: p.names, sizes: p.sizes || null };
  });

  ipcMain.handle('sessions:list', (_e, cwd) => {
    const active = store.profile(store.data.activeProfile);
    const names = store.project(cwd).names;
    const withName = (s) => ({ ...s, title: names[s.id] || s.title, file: undefined });
    let codexList = [];
    try {
      codexList = codexSessions.listSessions(cwd, codexHomeOf(active)).map(withName);
    } catch {}
    return { claude: claudeSessions.listSessions(cwd, claudeRoot(active)).map(withName), codex: codexList };
  });

  ipcMain.handle('pane:spawn', (_e, opts) => {
    // 上限以「每個專案」計算：不同專案的 workspace 可以同時在背景跑
    const inGrid = (k) => k === 'claude' || k === 'codex' || k === 'shell';
    const running = [...panes.values()].filter((p) => p.cwd === opts.cwd && inGrid(p.kind)).length;
    if (inGrid(opts.kind) && running >= MAX_PANES) throw new Error('E_MAX_PANES');
    const profile = store.profile(opts.profileId || store.data.activeProfile);
    const spec = spawnArgs(opts);
    const { cmd, sessionId, raw } = spec;
    const paneId = crypto.randomUUID();
    const args = opts.kind === 'claude' ? [...claudePaneArgs(paneId), ...spec.args] : spec.args;
    const cwd = opts.cwd;
    panes.set(paneId, { kind: opts.kind, cwd, sessionId, profileId: profile.id });
    if (opts.name && sessionId) {
      store.project(cwd).names[sessionId] = opts.name;
      store.save();
      queueTitle(opts.kind, cwd, sessionId, opts.name, profile.id);
    }
    const since = Date.now();
    // 子資料夾或 worktree 裡的 session 在它原本的資料夾續跑，claude --resume 才找得到
    const runCwd = opts.runCwd && fs.existsSync(opts.runCwd) ? opts.runCwd : cwd;
    const env = { ...profiles.envFor(profile), ...(bridge ? bridge.envFor(paneId) : {}) };
    const userSl = opts.kind === 'claude' ? userStatusline(profile) : null;
    if (userSl) env.MULTI_AGENT_USER_STATUSLINE = userSl;
    ptys.spawn(paneId, { cmd, args, cwd: runCwd, env, cols: opts.cols, rows: opts.rows, raw });
    if (opts.kind === 'codex' && !sessionId) discoverCodexSession(paneId, cwd, codexHomeOf(profile), since);
    return { paneId, sessionId, profileId: profile.id };
  });

  ipcMain.on('bridge:answer', (_e, id, value) => {
    const done = rendererAsks.get(id);
    if (done) {
      rendererAsks.delete(id);
      done(value);
    }
  });

  // 把窗格互通的 MCP server 裝到 Claude（claude mcp add）與 Codex（~/.codex/config.toml）
  // Claude 窗格會自動帶上 multi-agent 工具（見 claudePaneArgs），這裡只需要設定 Codex：
  // Codex 會過濾傳給 MCP server 的環境變數，所以要用 env_vars 明列要轉交的連線資訊
  ipcMain.handle('bridge:install', async (_e, profileId) => {
    const p = store.profile(profileId || store.data.activeProfile);
    const out = [];
    // 舊版裝在 Claude user scope 的同名 server 移除，避免和窗格自動帶上的重複
    const rm = await runInShell('claude', ['mcp', 'remove', '--scope', 'user', 'multi-agent'], profiles.envFor(p));
    out.push(`claude: ${rm.ok ? 'removed old user-scope entry; panes get the tools automatically' : 'panes get the tools automatically'}`);
    try {
      writeCodexBridgeConfig(codexHomeOf(p), MCP_SCRIPT);
      out.push('codex: ok');
      return { ok: true, output: out.join('\n') };
    } catch (e) {
      out.push(`codex: ${e.message}`);
      return { ok: false, output: out.join('\n') };
    }
  });

  ipcMain.on('pty:write', (_e, id, data) => ptys.write(id, data));
  ipcMain.on('pty:resize', (_e, id, cols, rows) => ptys.resize(id, cols, rows));
  ipcMain.on('pty:resetLimit', (_e, id) => ptys.resetLimit(id));
  ipcMain.handle('pty:kill', (_e, id) => {
    ptys.kill(id);
    panes.delete(id);
    cleanupPaneFiles(id);
  });

  ipcMain.handle('layout:save', (_e, cwd, list, sizes) => {
    if (sizes !== undefined) store.project(cwd).sizes = sizes;
    // PowerShell 窗格沒有 session id，只記下名稱，還原時開一個新的
    store.project(cwd).panes = list
      .filter((p) => (p.sessionId && (p.kind === 'claude' || p.kind === 'codex')) || p.kind === 'shell')
      .slice(0, MAX_PANES);
    store.save();
  });

  ipcMain.handle('names:set', (_e, cwd, sessionId, name, kind, profileId) => {
    const names = store.project(cwd).names;
    if (name) names[sessionId] = name;
    else delete names[sessionId];
    store.save();
    queueTitle(kind, cwd, sessionId, name, profileId);
  });

  ipcMain.handle('context:get', (_e, items) => {
    const out = {};
    for (const it of items) {
      if (!it.sessionId) continue;
      const profile = store.profile(it.profileId || store.data.activeProfile);
      // 優先用 Claude 自己透過 statusline 回報的數字（跟它畫面上的一致）
      const pane = it.paneId && panes.get(it.paneId);
      if (pane && pane.live && pane.sessionId === it.sessionId && pane.live.context) {
        out[it.sessionId] = pane.live.context;
        continue;
      }
      try {
        out[it.sessionId] =
          it.kind === 'claude'
            ? claudeSessions.getContext(it.cwd, it.sessionId, claudeRoot(profile))
            : codexSessions.getContext(it.sessionId, codexHomeOf(profile));
      } catch {
        out[it.sessionId] = null;
      }
    }
    return out;
  });

  ipcMain.handle('usage:get', async (_e, { force = false } = {}) => {
    const claude = {};
    await Promise.all(
      store.data.profiles.map(async (p) => {
        const u = await usage.fetchUsage(profiles.claudeDirOf(p), profiles.isDefault(p), { force });
        // 額度 API 讀不到時，改用 Claude statusline 回報的 5 小時／每週額度
        const live = liveLimits.get(p.id);
        claude[p.id] = !u.ok && live ? { ok: true, plan: null, fiveHour: live.fiveHour, sevenDay: live.sevenDay, source: 'statusline' } : u;
      }),
    );
    let codex = null;
    try {
      codex = codexSessions.getRateLimits(codexHomeOf(store.profile(store.data.activeProfile)));
    } catch {}
    return { claude, codex };
  });

  ipcMain.handle('profiles:list', () => ({ activeProfile: store.data.activeProfile, profiles: profilesWithAccounts() }));

  ipcMain.handle('profiles:add', (_e, name, opts) => {
    const p = profiles.createProfile(path.join(app.getPath('userData'), 'profiles'), name, opts);
    store.data.profiles.push(p);
    store.save();
    return p;
  });

  ipcMain.handle('profiles:remove', (_e, id) => {
    if (id === profiles.DEFAULT_ID) throw new Error('E_DEFAULT_PROFILE');
    store.data.profiles = store.data.profiles.filter((p) => p.id !== id);
    if (store.data.activeProfile === id) store.data.activeProfile = profiles.DEFAULT_ID;
    store.save();
  });

  ipcMain.handle('profiles:setActive', (_e, id) => {
    store.data.activeProfile = store.profile(id).id;
    store.save();
    return store.data.activeProfile;
  });

  ipcMain.handle('profiles:rename', (_e, id, name) => {
    store.profile(id).name = name;
    store.save();
  });

  // 讓 Claude 可以把 Codex 當子 agent 呼叫：註冊 `codex mcp-server` 為 user scope MCP server
  ipcMain.handle('codex:installMcp', async (_e, profileId) => {
    const p = store.profile(profileId || store.data.activeProfile);
    return runInShell('claude', ['mcp', 'add', '--scope', 'user', 'codex', '--', 'codex', 'mcp-server'], profiles.envFor(p));
  });

  ipcMain.handle('handoff:create', (_e, opts) => {
    const src = panes.get(opts.paneId) || {};
    const profile = store.profile(opts.profileId || src.profileId || store.data.activeProfile);
    return createHandoff({
      ...opts,
      claudeProjectsRoot: claudeRoot(profile),
      codexHome: codexHomeOf(profile),
    });
  });

  ipcMain.handle('settings:set', (_e, patch) => {
    Object.assign(store.data.settings, patch);
    if ('openAtLogin' in patch) applyAutostart();
    store.save();
    return store.data.settings;
  });

  ipcMain.handle('shell:openPath', (_e, p) => shell.openPath(p));
}

// 開機自動啟動：連同專案路徑一起登記。每次啟動都重新套用，路徑變動或舊版的錯誤登記都會被修正
function applyAutostart() {
  try {
    setAutostart(!!store.data.settings.openAtLogin, { app, electron: process.execPath, root: app.getAppPath() });
  } catch (e) {
    console.warn('autostart:', e.message);
  }
}

app.whenReady().then(() => {
  if (process.platform === 'darwin' && app.dock) app.dock.setIcon(path.join(__dirname, '..', '..', 'assets', 'icon.png'));
  store = new Store(app.getPath('userData'));
  claudeSessions.setKnownWindows(store.data.contextWindows || (store.data.contextWindows = {}));
  // 上次關閉時留下的窗格設定檔（token 已失效）清掉
  try {
    for (const f of fs.readdirSync(BRIDGE_DIR())) if (f.endsWith('.mcp.json')) fs.rmSync(path.join(BRIDGE_DIR(), f), { force: true });
  } catch {}
  // 舊版裝過的 Codex 設定缺 env_vars，啟動時補上
  for (const p of store.data.profiles) {
    try {
      writeCodexBridgeConfig(codexHomeOf(p), MCP_SCRIPT, { onlyIfPresent: true });
    } catch {}
  }
  if (store.data.settings.openAtLogin) applyAutostart();
  ptys = new PtyManager(send);
  bridge = new Bridge({
    ptys,
    panes,
    askRenderer,
    onStatus: handleStatus,
    settings: () => store.data.settings,
    transcriptFile: (pane) => {
      const profile = store.profile(pane.profileId);
      return pane.kind === 'codex'
        ? codexSessions.findSessionFile(pane.sessionId, codexHomeOf(profile))
        : claudeSessions.sessionFile(pane.cwd, pane.sessionId, claudeRoot(profile));
    },
  });
  bridge.start();
  setInterval(flushTitles, 3000);
  registerIpc();
  createWindow();
});

app.on('window-all-closed', () => {
  ptys.killAll();
  app.quit();
});

app.on('before-quit', () => ptys && ptys.killAll());

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

const MAX_PANES = 6;
const ICON = path.join(__dirname, '..', '..', 'assets', process.platform === 'win32' ? 'icon.ico' : 'icon.png');

// 固定 userData 位置（package.json 加了 productName 之後，Electron 預設路徑會改變）
app.setPath('userData', path.join(app.getPath('appData'), 'multi-agent-cli'));
if (process.platform === 'win32') app.setAppUserModelId('io.github.nelson0314.multi-agent-cli');

let win;
let store;
let ptys;
const panes = new Map(); // paneId -> { kind, cwd, sessionId, profileId }

function send(channel, ...args) {
  if (channel === 'pty:exit') panes.delete(args[0]);
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
    return { cwd, panes: p.panes, names: p.names };
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
    const { cmd, args, sessionId, raw } = spawnArgs(opts);
    const paneId = crypto.randomUUID();
    const cwd = opts.cwd;
    panes.set(paneId, { kind: opts.kind, cwd, sessionId, profileId: profile.id });
    if (opts.name && sessionId) {
      store.project(cwd).names[sessionId] = opts.name;
      store.save();
    }
    const since = Date.now();
    // 子資料夾或 worktree 裡的 session 在它原本的資料夾續跑，claude --resume 才找得到
    const runCwd = opts.runCwd && fs.existsSync(opts.runCwd) ? opts.runCwd : cwd;
    ptys.spawn(paneId, { cmd, args, cwd: runCwd, env: profiles.envFor(profile), cols: opts.cols, rows: opts.rows, raw });
    if (opts.kind === 'codex' && !sessionId) discoverCodexSession(paneId, cwd, codexHomeOf(profile), since);
    return { paneId, sessionId, profileId: profile.id };
  });

  ipcMain.on('pty:write', (_e, id, data) => ptys.write(id, data));
  ipcMain.on('pty:resize', (_e, id, cols, rows) => ptys.resize(id, cols, rows));
  ipcMain.on('pty:resetLimit', (_e, id) => ptys.resetLimit(id));
  ipcMain.handle('pty:kill', (_e, id) => {
    ptys.kill(id);
    panes.delete(id);
  });

  ipcMain.handle('layout:save', (_e, cwd, list) => {
    // PowerShell 窗格沒有 session id，只記下名稱，還原時開一個新的
    store.project(cwd).panes = list
      .filter((p) => (p.sessionId && (p.kind === 'claude' || p.kind === 'codex')) || p.kind === 'shell')
      .slice(0, MAX_PANES);
    store.save();
  });

  ipcMain.handle('names:set', (_e, cwd, sessionId, name) => {
    const names = store.project(cwd).names;
    if (name) names[sessionId] = name;
    else delete names[sessionId];
    store.save();
  });

  ipcMain.handle('context:get', (_e, items) => {
    const out = {};
    for (const it of items) {
      if (!it.sessionId) continue;
      const profile = store.profile(it.profileId || store.data.activeProfile);
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
        claude[p.id] = await usage.fetchUsage(profiles.claudeDirOf(p), profiles.isDefault(p), { force });
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
  if (store.data.settings.openAtLogin) applyAutostart();
  ptys = new PtyManager(send);
  registerIpc();
  createWindow();
});

app.on('window-all-closed', () => {
  ptys.killAll();
  app.quit();
});

app.on('before-quit', () => ptys && ptys.killAll());

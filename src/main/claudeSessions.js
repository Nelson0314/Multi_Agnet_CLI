'use strict';
// 讀取 Claude Code 的 session 歷史：<configDir>/projects/<encoded-cwd>/<sessionId>.jsonl
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');
const { readAll, readTail, readHead } = require('./jsonl');

const DEFAULT_WINDOW = 200_000;
const LARGE_WINDOW = 1_000_000;

function defaultConfigDir() {
  return process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
}

function projectsRoot(configDir = defaultConfigDir()) {
  return path.join(configDir, 'projects');
}

// Claude Code 把 cwd 中所有非英數字元換成 '-'
function encodeProjectPath(cwd) {
  return cwd.replace(/[^a-zA-Z0-9]/g, '-');
}

const CASE_INSENSITIVE = process.platform === 'win32' || process.platform === 'darwin';
const normPath = (p) => {
  const n = path.resolve(p).replace(/[\\/]+$/, '').replace(/\\/g, '/');
  return CASE_INSENSITIVE ? n.toLowerCase() : n;
};

function samePath(a, b) {
  return normPath(a) === normPath(b);
}

// child 等於 parent，或在 parent 底下
function isInside(child, parent) {
  const c = normPath(child);
  const p = normPath(parent);
  return c === p || c.startsWith(p.endsWith('/') ? p : p + '/');
}

const dirCwdCache = new Map(); // dir -> { mtimeMs, cwd }

function cwdOfDir(dir) {
  const st = fs.statSync(dir);
  const hit = dirCwdCache.get(dir);
  if (hit && hit.mtimeMs === st.mtimeMs) return hit.cwd;
  let cwd = null;
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl'));
  outer: for (const f of files) {
    for (const e of readHead(path.join(dir, f))) {
      if (e.cwd) {
        cwd = e.cwd;
        break outer;
      }
    }
  }
  dirCwdCache.set(dir, { mtimeMs: st.mtimeMs, cwd });
  return cwd;
}

// 同一個 git repo 的其他 worktree（claude -r 也會列出它們的 session）
const worktreeCache = new Map(); // cwd -> { at, list }
function gitWorktrees(cwd) {
  const hit = worktreeCache.get(cwd);
  if (hit && Date.now() - hit.at < 60_000) return hit.list;
  let list = [];
  try {
    const out = execFileSync('git', ['worktree', 'list', '--porcelain'], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000 });
    list = out
      .split('\n')
      .filter((l) => l.startsWith('worktree '))
      .map((l) => l.slice(9).trim());
  } catch {}
  worktreeCache.set(cwd, { at: Date.now(), list });
  return list;
}

/**
 * 這個專案相關的所有 session 資料夾，範圍比照 claude -r：
 * 專案本身（含 symlink 的真實路徑）、它的子資料夾（包括 claude -w 的 .claude/worktrees）、
 * 以及同一個 git repo 的其他 worktree。
 */
function relatedDirs(root, cwd) {
  if (!fs.existsSync(root)) return [];
  const bases = new Set([cwd]);
  try {
    bases.add(fs.realpathSync(cwd));
  } catch {}
  for (const w of gitWorktrees(cwd)) bases.add(w);
  const cmp = (s) => (CASE_INSENSITIVE ? s.toLowerCase() : s);
  const prefixes = [...bases].map((b) => cmp(encodeProjectPath(b).slice(0, 200)));
  const out = [];
  for (const name of fs.readdirSync(root)) {
    const n = cmp(name);
    if (!prefixes.some((pre) => n === pre || n.startsWith(pre + '-') || n.startsWith(pre))) continue;
    const dir = path.join(root, name);
    try {
      if (!fs.statSync(dir).isDirectory()) continue;
      const c = cwdOfDir(dir);
      if (c && [...bases].some((b) => isInside(c, b))) out.push(dir);
    } catch {}
  }
  // 編碼規則對不上時（例如舊版 Claude Code 的編碼），退回逐一比對
  if (!out.length) {
    const d = findProjectDir(root, cwd);
    if (d) out.push(d);
  }
  return out;
}

// 先用編碼規則找；找不到時（例如路徑含特殊字元、規則改變）逐一比對 jsonl 內的 cwd
function findProjectDir(root, cwd) {
  const direct = path.join(root, encodeProjectPath(cwd));
  if (fs.existsSync(direct)) return direct;
  if (!fs.existsSync(root)) return null;
  for (const name of fs.readdirSync(root)) {
    const dir = path.join(root, name);
    try {
      const c = cwdOfDir(dir);
      if (c && samePath(c, cwd)) return dir;
    } catch {}
  }
  return null;
}

function listProjects(root = projectsRoot()) {
  if (!fs.existsSync(root)) return [];
  const out = [];
  for (const name of fs.readdirSync(root)) {
    const dir = path.join(root, name);
    try {
      if (!fs.statSync(dir).isDirectory()) continue;
      const files = fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl'));
      if (!files.length) continue;
      const cwd = cwdOfDir(dir);
      if (!cwd) continue;
      const lastActive = Math.max(...files.map((f) => fs.statSync(path.join(dir, f)).mtimeMs));
      out.push({ cwd, sessionCount: files.length, lastActive });
    } catch {}
  }
  return out.sort((a, b) => b.lastActive - a.lastActive);
}

function textOf(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((c) => c && c.type === 'text' && typeof c.text === 'string')
    .map((c) => c.text)
    .join('\n');
}

// 過濾掉 slash command、hook 注入、系統提醒等非真實使用者輸入
function isRealPrompt(text) {
  if (!text || !text.trim()) return false;
  const t = text.trim();
  return !/^<(command-|local-command|system-reminder|bash-|user-prompt-submit-hook)/.test(t) && !t.startsWith('Caveat:');
}

// Claude 透過 statusline 回報過的 context window 大小（依模型），比猜測準確
let knownWindows = {};
function setKnownWindows(map) {
  knownWindows = map || {};
}

function contextWindowFor(model, tokens) {
  const known = model && knownWindows[model];
  if (known && known >= tokens) return known;
  if (model && /\[1m\]|-1m\b/i.test(model)) return LARGE_WINDOW;
  return tokens > DEFAULT_WINDOW ? LARGE_WINDOW : DEFAULT_WINDOW;
}

function usageTokens(u) {
  if (!u) return 0;
  return (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0) + (u.cache_read_input_tokens || 0);
}

// 從事件陣列（由後往前）找最後一個主線 assistant 回覆的 usage，當作目前 context 深度
function contextFromEntries(entries) {
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i];
    if (e.type === 'assistant' && !e.isSidechain && e.message && e.message.usage) {
      const tokens = usageTokens(e.message.usage);
      if (!tokens) continue;
      const model = e.message.model || null;
      const window = contextWindowFor(model, tokens);
      return { tokens, window, pct: Math.min(100, (tokens / window) * 100), model };
    }
    // /compact 或 /clear 之後 context 重置
    if (e.type === 'system' && e.subtype === 'compact_boundary') return { tokens: 0, window: DEFAULT_WINDOW, pct: 0, model: null };
  }
  return null;
}

function summarize(entries) {
  let customTitle = null;
  let aiTitle = null;
  let summary = null;
  let firstPrompt = null;
  let lastPrompt = null;
  let userCount = 0;
  let lastTimestamp = null;
  let hasMessages = false;
  let command = null;
  for (const e of entries) {
    if ((e.type === 'user' || e.type === 'assistant') && !e.isSidechain) hasMessages = true;
    if (e.timestamp) lastTimestamp = e.timestamp;
    switch (e.type) {
      case 'custom-title':
        if (e.customTitle) customTitle = e.customTitle;
        break;
      case 'ai-title':
        if (e.aiTitle) aiTitle = e.aiTitle;
        break;
      case 'summary':
        if (e.summary) summary = e.summary;
        break;
      case 'agent-name':
        if (e.agentName && !customTitle) customTitle = e.agentName;
        break;
      case 'last-prompt':
        if (e.lastPrompt) lastPrompt = e.lastPrompt;
        break;
      case 'user': {
        if (e.isSidechain || e.isMeta) break;
        const t = textOf(e.message && e.message.content);
        const cmd = !command && t.match(/<command-name>\s*(\/?[^<\s]+)\s*<\/command-name>/);
        if (cmd) command = cmd[1].startsWith('/') ? cmd[1] : `/${cmd[1]}`;
        if (isRealPrompt(t)) {
          userCount++;
          if (!firstPrompt) firstPrompt = t.trim();
          lastPrompt = t.trim();
        }
        break;
      }
    }
  }
  return { customTitle, aiTitle, summary, firstPrompt, lastPrompt, userCount, lastTimestamp, hasMessages, command };
}

const cache = new Map(); // file -> { mtimeMs, size, info }

function readSession(file) {
  const st = fs.statSync(file);
  const hit = cache.get(file);
  if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) return hit.info;
  const entries = readAll(file);
  const s = summarize(entries);
  const info = {
    kind: 'claude',
    id: path.basename(file, '.jsonl'),
    file,
    title: s.customTitle || s.aiTitle || s.summary || truncate(s.firstPrompt, 80) || s.command || null, // null：由介面顯示「未命名」
    cwd: (entries.find((e) => e.cwd) || {}).cwd || null,
    hasMessages: s.hasMessages,
    customTitle: s.customTitle,
    firstPrompt: truncate(s.firstPrompt, 300),
    lastPrompt: truncate(s.lastPrompt, 300),
    messageCount: s.userCount,
    mtime: st.mtimeMs,
    context: contextFromEntries(entries),
  };
  cache.set(file, { mtimeMs: st.mtimeMs, size: st.size, info });
  return info;
}

function truncate(s, n) {
  if (!s) return s;
  const one = s.replace(/\s+/g, ' ').trim();
  return one.length > n ? one.slice(0, n - 1) + '…' : one;
}

// 只要有任何主線對話（包括只下了 slash 指令的 session）就列出，跟 claude -r 一致
function listSessions(cwd, root = projectsRoot()) {
  const byId = new Map();
  for (const dir of relatedDirs(root, cwd)) {
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith('.jsonl')) continue;
      try {
        const info = readSession(path.join(dir, f));
        if (!info.hasMessages) continue;
        const prev = byId.get(info.id);
        if (!prev || info.mtime > prev.mtime) byId.set(info.id, info);
      } catch {}
    }
  }
  return [...byId.values()].sort((a, b) => b.mtime - a.mtime);
}

function sessionFile(cwd, sessionId, root = projectsRoot()) {
  for (const dir of relatedDirs(root, cwd)) {
    const f = path.join(dir, `${sessionId}.jsonl`);
    if (fs.existsSync(f)) return f;
  }
  const dir = findProjectDir(root, cwd) || path.join(root, encodeProjectPath(cwd));
  return path.join(dir, `${sessionId}.jsonl`);
}

// 即時輪詢用：只讀檔尾，找不到 usage 才整檔讀
function getContext(cwd, sessionId, root = projectsRoot()) {
  const file = sessionFile(cwd, sessionId, root);
  if (!fs.existsSync(file)) return null;
  return contextFromEntries(readTail(file)) || contextFromEntries(readAll(file));
}

module.exports = {
  defaultConfigDir,
  projectsRoot,
  encodeProjectPath,
  findProjectDir,
  setKnownWindows,
  relatedDirs,
  isInside,
  listProjects,
  listSessions,
  sessionFile,
  getContext,
  contextFromEntries,
  summarize,
  textOf,
  isRealPrompt,
  truncate,
};

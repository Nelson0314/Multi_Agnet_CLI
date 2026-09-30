'use strict';
// 讀取 Claude Code 的 session 歷史：<configDir>/projects/<encoded-cwd>/<sessionId>.jsonl
const fs = require('fs');
const path = require('path');
const os = require('os');
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

function samePath(a, b) {
  const norm = (p) => path.resolve(p).replace(/[\\/]+$/, '');
  return process.platform === 'win32' || process.platform === 'darwin'
    ? norm(a).toLowerCase() === norm(b).toLowerCase()
    : norm(a) === norm(b);
}

function cwdOfDir(dir) {
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl'));
  for (const f of files) {
    for (const e of readHead(path.join(dir, f))) if (e.cwd) return e.cwd;
  }
  return null;
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

function contextWindowFor(model, tokens) {
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
  for (const e of entries) {
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
        if (isRealPrompt(t)) {
          userCount++;
          if (!firstPrompt) firstPrompt = t.trim();
          lastPrompt = t.trim();
        }
        break;
      }
    }
  }
  return { customTitle, aiTitle, summary, firstPrompt, lastPrompt, userCount, lastTimestamp };
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
    title: s.customTitle || s.aiTitle || s.summary || truncate(s.firstPrompt, 80) || null, // null：由介面顯示「未命名」
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

function listSessions(cwd, root = projectsRoot()) {
  const dir = findProjectDir(root, cwd);
  if (!dir) return [];
  const out = [];
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith('.jsonl')) continue;
    try {
      const info = readSession(path.join(dir, f));
      if (info.messageCount > 0) out.push(info);
    } catch {}
  }
  return out.sort((a, b) => b.mtime - a.mtime);
}

function sessionFile(cwd, sessionId, root = projectsRoot()) {
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

'use strict';
// 讀取 Codex CLI 的 session 歷史與額度：$CODEX_HOME/sessions/YYYY/MM/DD/rollout-*.jsonl
const fs = require('fs');
const path = require('path');
const os = require('os');
const { readAll, readTail, readHead } = require('./jsonl');
const { truncate, isInside } = require('./claudeSessions');

function defaultCodexHome() {
  return process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
}

function walkRollouts(dir, out = []) {
  let items;
  try {
    items = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const it of items) {
    const p = path.join(dir, it.name);
    if (it.isDirectory()) walkRollouts(p, out);
    else if (it.name.startsWith('rollout-') && it.name.endsWith('.jsonl')) out.push(p);
  }
  return out;
}

function metaOf(entries) {
  const first = entries[0];
  if (!first) return null;
  // 新格式：{type:'session_meta', payload:{id,cwd,source,...}}；舊格式：第一行直接是 meta
  const m = first.type === 'session_meta' ? first.payload : first;
  if (!m || !m.id) return null;
  let cwd = m.cwd || null;
  if (!cwd) {
    for (const e of entries) {
      if (e.type === 'turn_context' && e.payload && e.payload.cwd) {
        cwd = e.payload.cwd;
        break;
      }
    }
  }
  return { id: m.id, cwd, source: m.source || null, originator: m.originator || null, timestamp: m.timestamp || first.timestamp };
}

function userMessageText(e) {
  const p = e.payload || {};
  if (e.type === 'event_msg' && p.type === 'user_message' && typeof p.message === 'string') return p.message;
  return null;
}

function isRealPrompt(t) {
  return t && t.trim() && !/^<(environment_context|user_instructions|user_shell_command)/.test(t.trim());
}

function tokenCountOf(e) {
  const p = e && e.payload;
  return e && e.type === 'event_msg' && p && p.type === 'token_count' ? p : null;
}

function contextFromEntries(entries) {
  for (let i = entries.length - 1; i >= 0; i--) {
    const tc = tokenCountOf(entries[i]);
    if (tc && tc.info && tc.info.last_token_usage) {
      const tokens = tc.info.last_token_usage.input_tokens || 0;
      const window = tc.info.model_context_window || 272_000;
      return { tokens, window, pct: Math.min(100, (tokens / window) * 100), model: null };
    }
  }
  return null;
}

function normalizeLimit(l, observedAt) {
  if (!l) return null;
  let resetsAt = null;
  if (l.resets_at) resetsAt = typeof l.resets_at === 'number' ? l.resets_at * 1000 : Date.parse(l.resets_at);
  else if (l.resets_in_seconds != null && observedAt) resetsAt = observedAt + l.resets_in_seconds * 1000;
  return { pct: l.used_percent ?? null, windowMinutes: l.window_minutes ?? null, resetsAt };
}

function rateLimitsFromEntries(entries) {
  for (let i = entries.length - 1; i >= 0; i--) {
    const tc = tokenCountOf(entries[i]);
    if (tc && tc.rate_limits) {
      const at = Date.parse(entries[i].timestamp) || null;
      return {
        observedAt: at,
        primary: normalizeLimit(tc.rate_limits.primary, at),
        secondary: normalizeLimit(tc.rate_limits.secondary, at),
      };
    }
  }
  return null;
}

const cache = new Map();

function readSession(file) {
  const st = fs.statSync(file);
  const hit = cache.get(file);
  if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) return hit.info;
  const entries = readAll(file);
  const meta = metaOf(entries);
  if (!meta) return null;
  let firstPrompt = null;
  let lastPrompt = null;
  let count = 0;
  for (const e of entries) {
    const t = userMessageText(e);
    if (isRealPrompt(t)) {
      count++;
      if (!firstPrompt) firstPrompt = t.trim();
      lastPrompt = t.trim();
    }
  }
  const info = {
    kind: 'codex',
    id: meta.id,
    file,
    cwd: meta.cwd,
    source: meta.source,
    // 由 Claude 透過 MCP / exec 呼叫出來的 Codex，在 UI 上標成「子 agent」
    spawnedByAgent: ['mcp', 'exec'].includes(String(meta.source).toLowerCase()),
    title: truncate(firstPrompt, 80) || null,
    firstPrompt: truncate(firstPrompt, 300),
    lastPrompt: truncate(lastPrompt, 300),
    messageCount: count,
    mtime: st.mtimeMs,
    context: contextFromEntries(entries),
  };
  cache.set(file, { mtimeMs: st.mtimeMs, size: st.size, info });
  return info;
}

function samePath(a, b) {
  if (!a || !b) return false;
  const norm = (p) => path.resolve(p).replace(/[\\/]+$/, '');
  return process.platform === 'linux' ? norm(a) === norm(b) : norm(a).toLowerCase() === norm(b).toLowerCase();
}

function listSessions(cwd, codexHome = defaultCodexHome()) {
  const out = [];
  for (const f of walkRollouts(path.join(codexHome, 'sessions'))) {
    try {
      // 先只讀檔頭判斷 cwd，避免把其他專案的大檔整個讀進來
      const meta = metaOf(readHead(f));
      if (!meta || !meta.cwd || !isInside(meta.cwd, cwd)) continue;
      const info = readSession(f);
      if (info && info.messageCount > 0) out.push(info);
    } catch {}
  }
  return out.sort((a, b) => b.mtime - a.mtime);
}

function findSessionFile(sessionId, codexHome = defaultCodexHome()) {
  const files = walkRollouts(path.join(codexHome, 'sessions'));
  // 檔名通常含 session id；不含時再讀檔頭比對
  return (
    files.find((f) => path.basename(f).includes(sessionId)) ||
    files.find((f) => {
      try {
        const m = metaOf(readHead(f, 16 * 1024));
        return m && m.id === sessionId;
      } catch {
        return false;
      }
    }) ||
    null
  );
}

function getContext(sessionId, codexHome = defaultCodexHome()) {
  const f = findSessionFile(sessionId, codexHome);
  return f ? contextFromEntries(readTail(f)) : null;
}

// Codex 把 5 小時 (primary) / 每週 (secondary) 額度寫在每個 token_count 事件裡，取最新的即可
function getRateLimits(codexHome = defaultCodexHome()) {
  const files = walkRollouts(path.join(codexHome, 'sessions'))
    .map((f) => ({ f, m: fs.statSync(f).mtimeMs }))
    .sort((a, b) => b.m - a.m)
    .slice(0, 10);
  for (const { f } of files) {
    try {
      const rl = rateLimitsFromEntries(readTail(f));
      if (rl) return rl;
    } catch {}
  }
  return null;
}

// 新開的 Codex session 事先不知道 id：找 since 之後在該 cwd 建立的 rollout
function findNewSession(cwd, since, exclude = new Set(), codexHome = defaultCodexHome()) {
  for (const f of walkRollouts(path.join(codexHome, 'sessions'))) {
    try {
      if (fs.statSync(f).birthtimeMs < since - 2000 && fs.statSync(f).mtimeMs < since) continue;
      const meta = metaOf(readHead(f));
      if (meta && samePath(meta.cwd, cwd) && !exclude.has(meta.id) && Date.parse(meta.timestamp) >= since - 5000) return meta.id;
    } catch {}
  }
  return null;
}

module.exports = {
  defaultCodexHome,
  listSessions,
  findSessionFile,
  getContext,
  getRateLimits,
  findNewSession,
  contextFromEntries,
  rateLimitsFromEntries,
  userMessageText,
  isRealPrompt,
};

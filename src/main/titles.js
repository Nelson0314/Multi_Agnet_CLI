'use strict';
// 把 session 名稱寫回 Claude Code / Codex 自己的紀錄，效果等同在裡面打 /rename：
//   Claude：在 transcript 末尾加一行 {"type":"custom-title","customTitle":...}（Claude 取最後一筆）
//   Codex：在 $CODEX_HOME/session_index.jsonl 加一行 {"id","thread_name","updated_at"}（取最新一筆）
// 這樣 claude -r、codex resume 看到的名稱就跟這個程式一致，也不用在終端機裡自動打字。
const fs = require('fs');
const path = require('path');
const { readTail } = require('./jsonl');

function claudeCurrentTitle(file) {
  const entries = readTail(file, 256 * 1024);
  for (let i = entries.length - 1; i >= 0; i--) if (entries[i].type === 'custom-title') return entries[i].customTitle || null;
  return null;
}

/** @returns {boolean} 是否已寫入（false 代表 transcript 還沒建立，稍後再試） */
function setClaudeTitle(file, sessionId, name) {
  if (!file || !fs.existsSync(file)) return false;
  if (claudeCurrentTitle(file) === name) return true;
  const cur = fs.readFileSync(file, 'utf8');
  const nl = cur.length && !cur.endsWith('\n') ? '\n' : '';
  fs.appendFileSync(file, `${nl}${JSON.stringify({ type: 'custom-title', customTitle: name, sessionId })}\n`);
  return true;
}

function codexIndexFile(codexHome) {
  return path.join(codexHome, 'session_index.jsonl');
}

const indexCache = new Map(); // file -> { mtimeMs, size, names }

/** id -> 最新的 thread_name */
function readCodexNames(codexHome) {
  const file = codexIndexFile(codexHome);
  let st;
  try {
    st = fs.statSync(file);
  } catch {
    return new Map();
  }
  const hit = indexCache.get(file);
  if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) return hit.names;
  const names = new Map();
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try {
      const e = JSON.parse(line);
      if (e.id && typeof e.thread_name === 'string') names.set(e.id, e.thread_name);
    } catch {}
  }
  indexCache.set(file, { mtimeMs: st.mtimeMs, size: st.size, names });
  return names;
}

function setCodexTitle(codexHome, sessionId, name) {
  if (readCodexNames(codexHome).get(sessionId) === name) return true;
  fs.mkdirSync(codexHome, { recursive: true });
  const file = codexIndexFile(codexHome);
  const cur = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  const nl = cur.length && !cur.endsWith('\n') ? '\n' : '';
  fs.appendFileSync(file, `${nl}${JSON.stringify({ id: sessionId, thread_name: name, updated_at: new Date().toISOString() })}\n`);
  return true;
}

module.exports = { setClaudeTitle, claudeCurrentTitle, setCodexTitle, readCodexNames, codexIndexFile };

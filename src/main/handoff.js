'use strict';
// 交接（handoff）：把一個 agent 的 session 濃縮成 markdown，讓另一個 agent（Claude ⇄ Codex，
// 或另一個 Claude 帳號的新 session）可以無縫接手。檔案寫在專案內 .multi-agent/handoffs/，
// 並自動加進 .git/info/exclude，不會污染 git status。
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { readAll } = require('./jsonl');
const claude = require('./claudeSessions');
const codex = require('./codexSessions');

const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);

function fromClaude(entries) {
  const turns = [];
  const files = new Set();
  let todos = null;
  for (const e of entries) {
    if (e.isSidechain) continue;
    const content = e.message && e.message.content;
    if (e.type === 'user') {
      const t = claude.textOf(content);
      if (claude.isRealPrompt(t)) turns.push({ role: 'user', text: t.trim() });
    } else if (e.type === 'assistant' && Array.isArray(content)) {
      const t = claude.textOf(content);
      if (t.trim()) turns.push({ role: 'assistant', text: t.trim() });
      for (const c of content) {
        if (c.type !== 'tool_use' || !c.input) continue;
        if (EDIT_TOOLS.has(c.name) && (c.input.file_path || c.input.notebook_path)) files.add(c.input.file_path || c.input.notebook_path);
        if (c.name === 'TodoWrite' && Array.isArray(c.input.todos)) todos = c.input.todos;
      }
    } else if (e.type === 'system' && e.subtype === 'compact_boundary') {
      turns.push({ role: 'system', text: '（此處之前的對話已被 /compact 壓縮）' });
    }
  }
  return { turns, files: [...files], todos };
}

function fromCodex(entries) {
  const turns = [];
  const files = new Set();
  for (const e of entries) {
    const p = e.payload || {};
    const u = codex.userMessageText(e);
    if (codex.isRealPrompt(u)) turns.push({ role: 'user', text: u.trim() });
    else if (e.type === 'event_msg' && p.type === 'agent_message' && p.message) turns.push({ role: 'assistant', text: p.message.trim() });
    else if (e.type === 'response_item' && /call$/.test(p.type || '')) {
      const body = String(p.input || p.arguments || '');
      for (const m of body.matchAll(/\*\*\* (?:Update|Add) File: ([^\n\\]+)/g)) files.add(m[1].trim());
    }
  }
  return { turns, files: [...files], todos: null };
}

function git(cwd, args) {
  try {
    return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 10_000 }).trim();
  } catch {
    return null;
  }
}

function clip(s, n) {
  return s.length > n ? s.slice(0, n) + '\n…（截斷）' : s;
}

function render({ fromKind, sessionName, sessionId, cwd, digest, reason, recentTurns = 12 }) {
  const first = digest.turns.find((t) => t.role === 'user');
  const recent = digest.turns.slice(-recentTurns);
  const lines = [];
  const who = fromKind === 'claude' ? 'Claude Code' : 'Codex';
  lines.push(`# 交接文件：${sessionName || sessionId}`);
  lines.push('');
  lines.push(`- 來源：${who} session \`${sessionId}\``);
  lines.push(`- 專案目錄：\`${cwd}\``);
  lines.push(`- 交接原因：${reason || '手動交接'}`);
  lines.push(`- 產生時間：${new Date().toISOString()}`);
  lines.push('');
  lines.push('## 原始目標（第一個使用者需求）');
  lines.push('');
  lines.push(first ? clip(first.text, 3000) : '（無）');
  lines.push('');
  if (digest.todos && digest.todos.length) {
    lines.push('## 待辦清單（最後狀態）');
    lines.push('');
    for (const t of digest.todos) lines.push(`- [${t.status === 'completed' ? 'x' : ' '}] ${t.content}${t.status === 'in_progress' ? '（進行中）' : ''}`);
    lines.push('');
  }
  if (digest.files.length) {
    lines.push('## 這個 session 修改過的檔案');
    lines.push('');
    for (const f of digest.files) lines.push(`- ${path.isAbsolute(f) ? path.relative(cwd, f) || f : f}`);
    lines.push('');
  }
  const status = git(cwd, ['status', '--short']);
  const stat = git(cwd, ['diff', '--stat']);
  const branch = git(cwd, ['branch', '--show-current']) || git(cwd, ['rev-parse', '--short', 'HEAD']) || '(detached / 無 commit)';
  if (status !== null) {
    lines.push('## Git 狀態');
    lines.push('');
    lines.push(`分支：\`${branch}\``);
    lines.push('');
    lines.push('```');
    lines.push(clip(status || '(工作目錄乾淨)', 4000));
    if (stat) lines.push('', clip(stat, 4000));
    lines.push('```');
    lines.push('');
  }
  lines.push(`## 最近 ${recent.length} 則對話`);
  lines.push('');
  for (const t of recent) {
    const label = t.role === 'user' ? '👤 使用者' : t.role === 'assistant' ? `🤖 ${who}` : 'ℹ️';
    lines.push(`### ${label}`);
    lines.push('');
    lines.push(clip(t.text, t.role === 'user' ? 3000 : 2000));
    lines.push('');
  }
  return lines.join('\n');
}

function ensureExcluded(cwd) {
  const gitDir = git(cwd, ['rev-parse', '--git-dir']);
  if (!gitDir) return;
  const f = path.resolve(cwd, gitDir, 'info', 'exclude');
  try {
    const cur = fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : '';
    if (!cur.split('\n').includes('.multi-agent/')) {
      fs.mkdirSync(path.dirname(f), { recursive: true });
      fs.appendFileSync(f, `${cur && !cur.endsWith('\n') ? '\n' : ''}.multi-agent/\n`);
    }
  } catch {}
}

/**
 * @param {{fromKind:'claude'|'codex', sessionId:string, cwd:string, sessionName?:string, reason?:string,
 *          claudeProjectsRoot?:string, codexHome?:string, toKind:'claude'|'codex'}} opts
 * @returns {{file:string, prompt:string}}
 */
function createHandoff(opts) {
  const file =
    opts.fromKind === 'claude'
      ? claude.sessionFile(opts.cwd, opts.sessionId, opts.claudeProjectsRoot)
      : codex.findSessionFile(opts.sessionId, opts.codexHome);
  if (!file || !fs.existsSync(file)) throw new Error('找不到來源 session 的紀錄檔');
  const entries = readAll(file);
  const digest = opts.fromKind === 'claude' ? fromClaude(entries) : fromCodex(entries);
  const md = render({ ...opts, digest });
  const dir = path.join(opts.cwd, '.multi-agent', 'handoffs');
  fs.mkdirSync(dir, { recursive: true });
  ensureExcluded(opts.cwd);
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const out = path.join(dir, `${stamp}-${opts.fromKind}-to-${opts.toKind}.md`);
  fs.writeFileSync(out, md);
  const rel = path.relative(opts.cwd, out).split(path.sep).join('/');
  const prompt =
    `你正在接手另一個 AI agent 未完成的工作。請先完整閱讀交接文件 ${rel}` +
    '，接著用 git status / git diff 確認目前程式碼狀態，然後簡短回報你理解的進度與下一步，再繼續完成原始目標。';
  return { file: out, prompt };
}

module.exports = { createHandoff, fromClaude, fromCodex, render };

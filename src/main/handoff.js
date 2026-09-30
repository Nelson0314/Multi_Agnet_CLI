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
      turns.push({ role: 'system', key: 'compacted' });
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

const STRINGS = {
  'zh-Hant': {
    title: (n) => `# 交接文件：${n}`,
    source: '來源',
    project: '專案目錄',
    reason: '交接原因',
    created: '產生時間',
    reasons: { manual: '手動交接', 'claude-limit': 'Claude 額度用完', 'codex-limit': 'Codex 額度用完', 'switch-profile': '切換帳號' },
    goal: '## 原始目標（第一個使用者需求）',
    none: '（無）',
    todos: '## 待辦清單（最後狀態）',
    inProgress: '（進行中）',
    files: '## 這個 session 改過的檔案',
    git: '## Git 狀態',
    branch: '分支',
    noCommit: '（沒有 commit 或 detached HEAD）',
    clean: '（工作目錄沒有變更）',
    recent: (n) => `## 最近 ${n} 則對話`,
    user: '使用者',
    compacted: '（這之前的對話已被 /compact 壓縮）',
    clipped: '…（已截斷）',
    prompt: (rel) =>
      `你要接手另一個 AI agent 沒做完的工作。先讀交接文件 ${rel}，再用 git status 和 git diff 確認程式碼現況，` +
      '簡短回報你理解的進度和下一步，然後繼續完成原始目標。',
  },
  en: {
    title: (n) => `# Handoff: ${n}`,
    source: 'Source',
    project: 'Project',
    reason: 'Reason',
    created: 'Created',
    reasons: { manual: 'Manual handoff', 'claude-limit': 'Claude usage limit reached', 'codex-limit': 'Codex usage limit reached', 'switch-profile': 'Account switch' },
    goal: '## Original goal (first user request)',
    none: '(none)',
    todos: '## Todo list (last known state)',
    inProgress: ' (in progress)',
    files: '## Files changed in this session',
    git: '## Git state',
    branch: 'Branch',
    noCommit: '(no commits or detached HEAD)',
    clean: '(working tree clean)',
    recent: (n) => `## Last ${n} messages`,
    user: 'User',
    compacted: '(Earlier conversation was compacted with /compact)',
    clipped: '… (truncated)',
    prompt: (rel) =>
      `You are taking over unfinished work from another AI agent. Read the handoff file ${rel} first, ` +
      'check the current code with git status and git diff, give a short summary of where things stand and what you will do next, then continue toward the original goal.',
  },
};

const stringsFor = (lang) => STRINGS[lang] || STRINGS['zh-Hant'];

function clip(s, n, L) {
  return s.length > n ? s.slice(0, n) + '\n' + L.clipped : s;
}

function render({ fromKind, sessionName, sessionId, cwd, digest, reason, lang, recentTurns = 12 }) {
  const L = stringsFor(lang);
  const first = digest.turns.find((t) => t.role === 'user');
  const recent = digest.turns.slice(-recentTurns);
  const lines = [];
  const who = fromKind === 'claude' ? 'Claude Code' : 'Codex';
  lines.push(L.title(sessionName || sessionId), '');
  lines.push(`- ${L.source}: ${who} session \`${sessionId}\``);
  lines.push(`- ${L.project}: \`${cwd}\``);
  lines.push(`- ${L.reason}: ${L.reasons[reason] || reason || L.reasons.manual}`);
  lines.push(`- ${L.created}: ${new Date().toISOString()}`, '');
  lines.push(L.goal, '', first ? clip(first.text, 3000, L) : L.none, '');
  if (digest.todos && digest.todos.length) {
    lines.push(L.todos, '');
    for (const t of digest.todos) lines.push(`- [${t.status === 'completed' ? 'x' : ' '}] ${t.content}${t.status === 'in_progress' ? L.inProgress : ''}`);
    lines.push('');
  }
  if (digest.files.length) {
    lines.push(L.files, '');
    for (const f of digest.files) lines.push(`- ${path.isAbsolute(f) ? path.relative(cwd, f) || f : f}`);
    lines.push('');
  }
  const status = git(cwd, ['status', '--short']);
  const stat = git(cwd, ['diff', '--stat']);
  const branch = git(cwd, ['branch', '--show-current']) || git(cwd, ['rev-parse', '--short', 'HEAD']) || L.noCommit;
  if (status !== null) {
    lines.push(L.git, '', `${L.branch}: \`${branch}\``, '', '```', clip(status || L.clean, 4000, L));
    if (stat) lines.push('', clip(stat, 4000, L));
    lines.push('```', '');
  }
  lines.push(L.recent(recent.length), '');
  for (const t of recent) {
    if (t.role === 'system') {
      lines.push(`_${L[t.key] || t.text}_`, '');
      continue;
    }
    lines.push(`### ${t.role === 'user' ? L.user : who}`, '', clip(t.text, t.role === 'user' ? 3000 : 2000, L), '');
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
 * @param {{fromKind:'claude'|'codex', sessionId:string, cwd:string, sessionName?:string, reason?:string, lang?:'en'|'zh-Hant',
 *          claudeProjectsRoot?:string, codexHome?:string, toKind:'claude'|'codex'}} opts
 * @returns {{file:string, prompt:string}}
 */
function createHandoff(opts) {
  const file =
    opts.fromKind === 'claude'
      ? claude.sessionFile(opts.cwd, opts.sessionId, opts.claudeProjectsRoot)
      : codex.findSessionFile(opts.sessionId, opts.codexHome);
  if (!file || !fs.existsSync(file)) throw new Error('E_NO_TRANSCRIPT');
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
  return { file: out, prompt: stringsFor(opts.lang).prompt(rel) };
}

module.exports = { createHandoff, fromClaude, fromCodex, render };

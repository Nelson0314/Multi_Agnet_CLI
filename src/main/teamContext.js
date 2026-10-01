'use strict';
// 讓 Claude 與 Codex 像同一個團隊：兩邊讀到同一套使用者設定。
//   Codex 窗格：帶上使用者寫給 Claude Code 的指示（全域與專案的 CLAUDE.md、@import、.claude/rules）、
//              Claude 的 skills 清單、Claude 設定好的 MCP server，以及窗格互通工具。
//   Claude 窗格：帶上寫給 Codex 的指示（專案的 AGENTS.md、全域的 $CODEX_HOME/AGENTS.md）。
// 對方自己本來就會讀的檔案不重複放；全部透過啟動參數傳入，不改使用者的 config.toml 或 .claude.json。
const fs = require('fs');
const path = require('path');
const os = require('os');

const MAX_FILE = 24 * 1024; // 單一檔案最多放這麼多
const MAX_TOTAL = 48 * 1024; // 整份指示最多放這麼多
const MAX_DEPTH = 5; // @import 最多幾層（跟 Claude Code 相同）

function readText(f) {
  try {
    return fs.readFileSync(f, 'utf8');
  } catch {
    return null;
  }
}

const isFile = (f) => {
  try {
    return fs.statSync(f).isFile();
  } catch {
    return false;
  }
};

const real = (f) => {
  try {
    return fs.realpathSync(f);
  } catch {
    return path.resolve(f);
  }
};

// 專案根目錄：往上找到 .git（資料夾或 worktree 的檔案）為止，找不到就用 cwd
function projectRoot(cwd) {
  let d = path.resolve(cwd);
  for (;;) {
    if (fs.existsSync(path.join(d, '.git'))) return d;
    const up = path.dirname(d);
    if (up === d) return path.resolve(cwd);
    d = up;
  }
}

// from 到 to（含）之間的每一層資料夾，由上而下
function dirsBetween(from, to) {
  const out = [];
  let d = path.resolve(to);
  const top = path.resolve(from);
  for (;;) {
    out.unshift(d);
    if (d === top) break;
    const up = path.dirname(d);
    if (up === d) break;
    d = up;
  }
  return out;
}

function frontmatter(text) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text || '');
  if (!m) return { meta: {}, body: text || '' };
  const meta = {};
  for (const line of m[1].split(/\r?\n/)) {
    const kv = /^([\w-]+):\s*(.*)$/.exec(line);
    if (kv) meta[kv[1]] = kv[2].replace(/^["']|["']$/g, '').trim();
  }
  return { meta, body: text.slice(m[0].length) };
}

// Claude Code 的 @import：行內的 @路徑（code block 與 `inline code` 裡的不算），相對於檔案所在資料夾，~/ 是家目錄
function importsOf(text, file) {
  const out = [];
  let fenced = false;
  for (const line of String(text).split(/\r?\n/)) {
    if (/^\s*(```|~~~)/.test(line)) fenced = !fenced;
    if (fenced) continue;
    const bare = line.replace(/`[^`]*`/g, '');
    for (const m of bare.matchAll(/(?:^|\s)@((?:~\/|\.{1,2}\/|\/|[\w.-])[^\s]*)/g)) {
      const raw = m[1].replace(/[),.;:]+$/, '');
      const p = raw.startsWith('~/') ? path.join(os.homedir(), raw.slice(2)) : path.resolve(path.dirname(file), raw);
      if (isFile(p)) out.push(p);
    }
  }
  return out;
}

/**
 * 讀一個指示檔，連同它 @import 的檔案（深度優先，依出現順序）。
 * seen：已經放過或對方本來就會讀的檔案（realpath），不重複
 */
function withImports(file, seen, depth = 0, out = []) {
  const key = real(file);
  if (seen.has(key) || depth > MAX_DEPTH) return out;
  seen.add(key);
  const text = readText(file);
  if (text == null) return out;
  out.push({ file, text, imported: depth > 0 });
  for (const f of importsOf(text, file)) withImports(f, seen, depth + 1, out);
  return out;
}

// .claude/rules/**/*.md：有 paths 的只在處理對應檔案時適用，其他的永遠適用
function rulesOf(root) {
  const out = [];
  const walk = (d) => {
    let items;
    try {
      items = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const it of items.sort((a, b) => a.name.localeCompare(b.name))) {
      const p = path.join(d, it.name);
      if (it.isDirectory()) walk(p);
      else if (it.name.endsWith('.md')) out.push(p);
    }
  };
  walk(path.join(root, '.claude', 'rules'));
  return out;
}

function skillsIn(dir) {
  const out = [];
  let items;
  try {
    items = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const it of items) {
    const f = path.join(dir, it.name, 'SKILL.md');
    if (!(it.isDirectory() || it.isSymbolicLink()) || !isFile(f)) continue;
    const { meta } = frontmatter(readText(f));
    out.push({ name: meta.name || it.name, description: meta.description || '', file: f });
  }
  return out;
}

// 顯示用的路徑：家目錄縮成 ~，專案內用相對路徑
function label(f, root) {
  const rel = path.relative(root, f);
  if (!rel.startsWith('..') && !path.isAbsolute(rel)) return rel.split(path.sep).join('/');
  const home = os.homedir();
  return f.startsWith(home + path.sep) ? `~/${path.relative(home, f).split(path.sep).join('/')}` : f;
}

function clip(text, max) {
  return text.length > max ? `${text.slice(0, max)}\n\n(truncated; read the file for the rest)` : text;
}

// 把多份檔案組成一段指示，總長超過上限時，後面的只留路徑
function renderFiles(entries, root, budget) {
  const parts = [];
  const skipped = [];
  for (const e of entries) {
    const head = `## ${label(e.file, root)}${e.note ? ` (${e.note})` : ''}`;
    const body = clip(frontmatter(e.text).body.trim(), MAX_FILE);
    if (!body) continue;
    const block = `${head}\n\n${body}\n`;
    if (budget.left - block.length < 0) {
      skipped.push(label(e.file, root));
      continue;
    }
    budget.left -= block.length;
    parts.push(block);
  }
  if (skipped.length) parts.push(`These files did not fit and were left out; read them when needed: ${skipped.join(', ')}\n`);
  return parts.join('\n');
}

// Codex 本來就會讀的指示檔：$CODEX_HOME/AGENTS(.override).md，以及專案根目錄到 cwd 每一層的 AGENTS(.override).md
function codexOwnFiles(codexHome, root, cwd) {
  const out = [path.join(codexHome, 'AGENTS.override.md'), path.join(codexHome, 'AGENTS.md')];
  for (const d of dirsBetween(root, cwd)) out.push(path.join(d, 'AGENTS.override.md'), path.join(d, 'AGENTS.md'));
  return out.filter(isFile);
}

// Claude 本來就會讀的指示檔：~/.claude/CLAUDE.md、cwd 往上每一層的 CLAUDE.md / .claude/CLAUDE.md / CLAUDE.local.md
function claudeOwnFiles(claudeDir, cwd) {
  const out = [path.join(claudeDir, 'CLAUDE.md')];
  for (const d of dirsBetween(path.parse(path.resolve(cwd)).root, cwd)) {
    out.push(path.join(d, 'CLAUDE.md'), path.join(d, '.claude', 'CLAUDE.md'), path.join(d, 'CLAUDE.local.md'));
  }
  return out.filter(isFile);
}

/**
 * Codex 窗格要帶上的 Claude 設定。
 * @returns {{ text: string, sources: string[], skills: string[] }}
 */
function claudeContextForCodex({ claudeDir, codexHome, cwd }) {
  const root = projectRoot(cwd);
  const seen = new Set(codexOwnFiles(codexHome, root, cwd).map(real));
  const budget = { left: MAX_TOTAL };
  const files = [];
  const own = claudeOwnFiles(claudeDir, cwd);
  for (const f of own) {
    const scope = f === path.join(claudeDir, 'CLAUDE.md') ? 'user instructions for every project' : path.basename(f) === 'CLAUDE.local.md' ? "user's private notes for this project" : 'project instructions';
    for (const e of withImports(f, seen)) files.push({ ...e, note: e.imported ? 'imported' : scope });
  }
  const conditional = [];
  for (const f of rulesOf(root)) {
    const text = readText(f);
    const { meta } = frontmatter(text);
    if (meta.paths) conditional.push(`- ${label(f, root)} applies to ${meta.paths}`);
    else for (const e of withImports(f, seen)) files.push({ ...e, note: e.imported ? 'imported' : 'project rule' });
  }
  const codexSkills = new Set(
    [path.join(codexHome, 'skills'), path.join(root, '.agents', 'skills'), path.join(os.homedir(), '.agents', 'skills')].flatMap((d) => skillsIn(d).map((s) => s.name)),
  );
  const skills = [...skillsIn(path.join(claudeDir, 'skills')), ...skillsIn(path.join(root, '.claude', 'skills'))].filter(
    (s, i, all) => !codexSkills.has(s.name) && all.findIndex((x) => x.name === s.name) === i,
  );

  const parts = [];
  if (files.length || conditional.length) {
    parts.push(
      '# Instructions the user wrote for Claude Code\n\nThe user works on this project with Claude Code and Codex together. These are their standing instructions from Claude Code. Follow them the same way you follow AGENTS.md. Where they mention Claude-only tools, slash commands or settings, use your own equivalent or skip that part.\n',
    );
    parts.push(renderFiles(files, root, budget));
    if (conditional.length) parts.push(`Rules for specific paths. Read the file before you work on matching files:\n${conditional.join('\n')}\n`);
  }
  if (skills.length) {
    parts.push(
      `# Claude Code skills you can use\n\nEach skill is a SKILL.md file with instructions. When a task matches a description, read that file and follow it.\n\n${skills
        .map((s) => `- ${s.name}: ${s.description || '(no description)'} (file: ${s.file})`)
        .join('\n')}\n`,
    );
  }
  return { text: parts.join('\n'), sources: [...new Set(files.filter((e) => !e.imported).map((e) => label(e.file, root)))], skills: skills.map((s) => s.name) };
}

/** Claude 窗格要帶上的 Codex 設定：專案的 AGENTS.md 與全域的 $CODEX_HOME/AGENTS.md，Claude 已經讀（或 @import）的不重複 */
function codexContextForClaude({ claudeDir, codexHome, cwd }) {
  const root = projectRoot(cwd);
  const seen = new Set();
  // Claude 自己的指示檔與它們 @import 的檔案都算已讀
  for (const f of claudeOwnFiles(claudeDir, cwd)) withImports(f, seen);
  const files = [];
  for (const f of codexOwnFiles(codexHome, root, cwd)) {
    const note = f.startsWith(path.resolve(codexHome)) ? 'user instructions for Codex in every project' : 'project instructions (AGENTS.md)';
    if (seen.has(real(f))) continue;
    seen.add(real(f));
    files.push({ file: f, text: readText(f) || '', note });
  }
  if (!files.length) return { text: '', sources: [] };
  const text = `# Instructions the user wrote for Codex\n\nThe user works on this project with Claude Code and Codex together. These instructions were written for Codex (AGENTS.md). Follow them as well; where they mention Codex-only tools or settings, use your own equivalent or skip that part.\n\n${renderFiles(
    files,
    root,
    { left: MAX_TOTAL },
  )}`;
  return { text, sources: files.map((e) => label(e.file, root)) };
}

// ---------------------------------------------------------------- MCP server

const SAFE_NAME = /^[A-Za-z0-9_-]+$/; // Codex 的 -c 不接受加引號的 server 名稱，含 . 之類的名稱會讓 Codex 無法啟動

function expandVars(s, env) {
  return String(s).replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g, (_, k, def) => (env[k] != null ? env[k] : def != null ? def : ''));
}

const norm = (p) => {
  const s = String(p).replace(/\\/g, '/').replace(/\/+$/, '');
  return process.platform === 'linux' ? s : s.toLowerCase();
};

function projectEntry(claudeJson, dirs) {
  const projects = (claudeJson && claudeJson.projects) || {};
  const keys = new Set(dirs.map(norm));
  return Object.entries(projects)
    .filter(([k]) => keys.has(norm(k)))
    .map(([, v]) => v || {});
}

/**
 * Claude 設定好的 MCP server（user、local、已核准的專案 .mcp.json），轉成 Codex 的設定。
 * 只轉得過去的才轉：stdio（command）與 HTTP（url）；SSE 等其他類型略過。
 * @returns {Record<string, object>} name -> Codex mcp_servers 表格
 */
function claudeMcpServers({ claudeJsonFile, claudeDir, cwd, env = process.env }) {
  let j = null;
  try {
    j = JSON.parse(fs.readFileSync(claudeJsonFile, 'utf8'));
  } catch {}
  const root = projectRoot(cwd);
  const entries = projectEntry(j, [cwd, root]);
  const settings = [path.join(claudeDir, 'settings.json'), path.join(root, '.claude', 'settings.json'), path.join(root, '.claude', 'settings.local.json')]
    .map((f) => {
      try {
        return JSON.parse(fs.readFileSync(f, 'utf8'));
      } catch {
        return {};
      }
    })
    .concat(entries);
  const allProject = settings.some((s) => s.enableAllProjectMcpServers);
  const enabled = new Set(settings.flatMap((s) => s.enabledMcpjsonServers || []));
  const disabled = new Set(settings.flatMap((s) => s.disabledMcpjsonServers || []));
  let projectJson = {};
  try {
    projectJson = JSON.parse(fs.readFileSync(path.join(root, '.mcp.json'), 'utf8')).mcpServers || {};
  } catch {}
  const approved = Object.fromEntries(Object.entries(projectJson).filter(([n]) => !disabled.has(n) && (allProject || enabled.has(n))));
  // 優先序跟 Claude 相同：local > project > user
  const merged = { ...((j && j.mcpServers) || {}), ...approved, ...Object.assign({}, ...entries.map((e) => e.mcpServers || {})) };
  const out = {};
  for (const [name, s] of Object.entries(merged)) {
    if (!SAFE_NAME.test(name) || !s || typeof s !== 'object') continue;
    const type = s.type || (s.url ? 'http' : 'stdio');
    if (type === 'stdio' && s.command) {
      const t = { command: expandVars(s.command, env) };
      if (Array.isArray(s.args) && s.args.length) t.args = s.args.map((a) => expandVars(a, env));
      if (s.env && Object.keys(s.env).length) t.env = Object.fromEntries(Object.entries(s.env).map(([k, v]) => [k, expandVars(v, env)]));
      out[name] = t;
    } else if (type === 'http' && s.url) {
      const t = { url: expandVars(s.url, env) };
      if (s.headers && Object.keys(s.headers).length) t.http_headers = Object.fromEntries(Object.entries(s.headers).map(([k, v]) => [k, expandVars(v, env)]));
      out[name] = t;
    }
  }
  return out;
}

// Codex config.toml 裡已經定義的 MCP server 名稱（使用者自己的設定優先，不覆蓋）
function codexMcpNames(codexHome) {
  const text = readText(path.join(codexHome, 'config.toml')) || '';
  const names = new Set();
  for (const m of text.matchAll(/^\s*\[mcp_servers\.(?:"([^"]+)"|'([^']+)'|([A-Za-z0-9_-]+))\]/gm)) names.add(m[1] || m[2] || m[3]);
  return names;
}

// ---------------------------------------------------------------- TOML（給 codex -c 用）

// 單引號的 TOML literal string 不需要跳脫，Windows 路徑的反斜線、cmd.exe 都比較安全；不行時才用雙引號
function tomlStr(s) {
  s = String(s);
  return !s.includes("'") && !/[\x00-\x1f\x7f]/.test(s) ? `'${s}'` : JSON.stringify(s);
}

function tomlValue(v) {
  if (Array.isArray(v)) return `[${v.map(tomlValue).join(', ')}]`;
  if (v && typeof v === 'object') return `{${Object.entries(v).map(([k, x]) => `${SAFE_NAME.test(k) ? k : tomlStr(k)} = ${tomlValue(x)}`).join(', ')}}`;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  return tomlStr(v);
}

/** config.toml 最上層（第一個 [table] 之前）的字串設定，例如使用者自己的 developer_instructions */
function topLevelString(text, key) {
  const head = String(text || '').split(/^\s*\[/m)[0];
  const k = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  let m = new RegExp(`^\\s*${k}\\s*=\\s*"""\\r?\\n?([\\s\\S]*?)"""`, 'm').exec(head);
  if (m) return m[1].replace(/\\\r?\n\s*/g, '').replace(/\\(["\\nt])/g, (_, c) => ({ n: '\n', t: '\t' })[c] || c);
  m = new RegExp(`^\\s*${k}\\s*=\\s*'''\\r?\\n?([\\s\\S]*?)'''`, 'm').exec(head);
  if (m) return m[1];
  m = new RegExp(`^\\s*${k}\\s*=\\s*("(?:[^"\\\\]|\\\\.)*")`, 'm').exec(head);
  if (m) {
    try {
      return JSON.parse(m[1]);
    } catch {
      return null;
    }
  }
  m = new RegExp(`^\\s*${k}\\s*=\\s*'([^'\\n]*)'`, 'm').exec(head);
  return m ? m[1] : null;
}

module.exports = {
  projectRoot,
  importsOf,
  withImports,
  claudeContextForCodex,
  codexContextForClaude,
  claudeMcpServers,
  codexMcpNames,
  tomlStr,
  tomlValue,
  topLevelString,
  SAFE_NAME,
};

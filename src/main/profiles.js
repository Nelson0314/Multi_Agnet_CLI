'use strict';
// 帳號 profile。Claude 與 Codex 的帳號分開管理，各自有一份清單和「目前帳號」：
//   Claude profile = 一個 CLAUDE_CONFIG_DIR；Codex profile = 一個 CODEX_HOME。
// 非預設 profile 的 session 歷史以 symlink 指回預設目錄，所以同一個工具的所有帳號共用同一份 session，
// 帳號 A 額度用完時可以直接用帳號 B `claude --resume` / `codex resume` 同一個 session。
const fs = require('fs');
const path = require('path');
const os = require('os');
const { defaultCodexHome } = require('./codexSessions');

const DEFAULT_ID = 'default';

// ---------------------------------------------------------------- Claude

function defaultClaudeDir() {
  return path.join(os.homedir(), '.claude');
}

function defaultProfile() {
  // name 為 null：由介面依語言顯示「預設帳號 / Default」
  return { id: DEFAULT_ID, name: null, claudeConfigDir: null, shareHistory: true };
}

function claudeDirOf(profile) {
  return profile.claudeConfigDir || defaultClaudeDir();
}

function isDefault(profile) {
  return !profile.claudeConfigDir;
}

function claudeEnv(profile) {
  return profile && profile.claudeConfigDir ? { CLAUDE_CONFIG_DIR: profile.claudeConfigDir } : {};
}

function linkShared(target, linkPath) {
  if (fs.existsSync(linkPath)) return;
  fs.mkdirSync(target, { recursive: true });
  fs.symlinkSync(target, linkPath, process.platform === 'win32' ? 'junction' : 'dir');
}

// 檔案 symlink 在 Windows 需要系統管理員或開發人員模式，失敗時改用 hard link，再不行才複製
function linkFile(src, dst) {
  if (!fs.existsSync(src) || fs.existsSync(dst)) return;
  try {
    fs.symlinkSync(src, dst, 'file');
  } catch {
    try {
      fs.linkSync(src, dst);
    } catch {
      fs.copyFileSync(src, dst);
    }
  }
}

function createProfile(baseDir, name, { shareHistory = true } = {}) {
  const id = `p${Date.now().toString(36)}`;
  const claudeConfigDir = path.join(baseDir, id, 'claude');
  fs.mkdirSync(claudeConfigDir, { recursive: true });
  if (shareHistory) {
    // 共用 session 歷史與 Claude 設定，讓切帳號後 --resume 仍然找得到同一個對話
    linkShared(path.join(defaultClaudeDir(), 'projects'), path.join(claudeConfigDir, 'projects'));
    for (const f of ['settings.json', 'CLAUDE.md']) linkFile(path.join(defaultClaudeDir(), f), path.join(claudeConfigDir, f));
    for (const d of ['commands', 'agents', 'skills']) {
      const src = path.join(defaultClaudeDir(), d);
      if (fs.existsSync(src)) linkShared(src, path.join(claudeConfigDir, d));
    }
  }
  return { id, name, claudeConfigDir, shareHistory };
}

function claudeJsonOf(profile) {
  return profile.claudeConfigDir ? path.join(profile.claudeConfigDir, '.claude.json') : path.join(os.homedir(), '.claude.json');
}

function readJson(f) {
  try {
    return JSON.parse(fs.readFileSync(f, 'utf8'));
  } catch {
    return null;
  }
}

// 帳號 email：CLAUDE_CONFIG_DIR 模式下存在 <dir>/.claude.json，預設則在 ~/.claude.json
function readAccount(profile) {
  const j = readJson(claudeJsonOf(profile)) || {};
  const a = j.oauthAccount || {};
  return { email: a.emailAddress || null, org: a.organizationName || null };
}

// ---------------------------------------------------------------- Claude 狀態同步
// .claude.json 不能整個共用（裡面有登入身分），但有幾項不同步的話，換帳號續跑會卡住或少東西：
//   - 首次使用的設定流程（主題、說明頁）：沒做過會擋在 session 前面
//   - 資料夾信任（projects[路徑].hasTrustDialogAccepted）：沒有的話會先跳「信任這個資料夾嗎？」
//   - user / local scope 的 MCP server 與已允許的工具：存在 .claude.json，不同步就少了這些工具
// 所以開 Claude 窗格前，把預設帳號的這幾項補進目標帳號（只補缺的，不覆蓋目標帳號自己的設定）。
const GLOBAL_KEYS = ['hasCompletedOnboarding', 'lastOnboardingVersion', 'theme'];
const PROJECT_KEYS = [
  'hasTrustDialogAccepted',
  'hasCompletedProjectOnboarding',
  'allowedTools',
  'enabledMcpjsonServers',
  'disabledMcpjsonServers',
  'enableAllProjectMcpServers',
  'hasClaudeMdExternalIncludesApproved',
  'hasClaudeMdExternalIncludesWarningShown',
];

const normKey = (p) => {
  const s = String(p).replace(/\\/g, '/').replace(/\/+$/, '');
  return process.platform === 'linux' ? s : s.toLowerCase();
};

// child 等於 parent 或在 parent 底下（信任會繼承自上層資料夾）
function within(child, parent) {
  const c = normKey(child);
  const p = normKey(parent);
  return c === p || c.startsWith(p + '/');
}

function mergeMissing(dst, src) {
  let changed = false;
  for (const [k, v] of Object.entries(src || {})) {
    if (!(k in dst)) {
      dst[k] = v;
      changed = true;
    }
  }
  return changed;
}

/**
 * 把來源 .claude.json 的共用狀態補進目標。cwds：要同步信任與專案設定的資料夾（含上層）。
 * @returns {boolean} 是否有寫入
 */
function syncClaudeState(srcFile, dstFile, cwds = []) {
  const src = readJson(srcFile);
  if (!src) return false;
  const dst = readJson(dstFile) || {};
  let changed = false;
  for (const k of GLOBAL_KEYS) {
    if (src[k] !== undefined && dst[k] === undefined) {
      dst[k] = src[k];
      changed = true;
    }
  }
  if (src.mcpServers && typeof src.mcpServers === 'object') {
    dst.mcpServers = dst.mcpServers || {};
    changed = mergeMissing(dst.mcpServers, src.mcpServers) || changed;
  }
  const targets = cwds.filter(Boolean);
  for (const [key, proj] of Object.entries(src.projects || {})) {
    if (!proj || typeof proj !== 'object' || !targets.some((c) => within(c, key))) continue;
    dst.projects = dst.projects || {};
    const mine = Object.keys(dst.projects).find((k) => normKey(k) === normKey(key));
    const d = mine ? dst.projects[mine] : (dst.projects[key] = {});
    for (const k of PROJECT_KEYS) {
      if (proj[k] !== undefined && d[k] === undefined) {
        d[k] = proj[k];
        changed = true;
      }
    }
    if (proj.mcpServers && typeof proj.mcpServers === 'object') {
      d.mcpServers = d.mcpServers || {};
      changed = mergeMissing(d.mcpServers, proj.mcpServers) || changed;
    }
  }
  if (changed) {
    fs.mkdirSync(path.dirname(dstFile), { recursive: true });
    const tmp = `${dstFile}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(dst, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, dstFile);
  }
  return changed;
}

/** 開 Claude 窗格前呼叫：共用歷史的非預設帳號，從預設帳號補上信任、MCP 與首次設定 */
function syncSharedClaudeState(profile, cwds) {
  if (isDefault(profile) || !profile.shareHistory) return false;
  return syncClaudeState(claudeJsonOf(defaultProfile()), claudeJsonOf(profile), cwds);
}

// ---------------------------------------------------------------- Codex

function defaultCodexProfile() {
  return { id: DEFAULT_ID, name: null, codexHome: null, shareHistory: true };
}

function codexHomeOf(profile) {
  return (profile && profile.codexHome) || defaultCodexHome();
}

function codexEnv(profile) {
  return profile && profile.codexHome ? { CODEX_HOME: profile.codexHome } : {};
}

// 共用歷史時連回預設 CODEX_HOME 的項目。auth.json（登入身分）刻意不共用。
const CODEX_SHARED_DIRS = ['sessions', 'archived_sessions', 'prompts', 'skills'];
const CODEX_SHARED_FILES = ['config.toml', 'AGENTS.md', 'history.jsonl', 'session_index.jsonl'];

function createCodexProfile(baseDir, name, { shareHistory = true } = {}) {
  const id = `c${Date.now().toString(36)}`;
  const codexHome = path.join(baseDir, id, 'codex');
  fs.mkdirSync(codexHome, { recursive: true });
  if (shareHistory) {
    const base = defaultCodexHome();
    for (const d of CODEX_SHARED_DIRS) {
      // sessions 一定要連（續跑靠它），其他資料夾有才連
      if (d === 'sessions' || fs.existsSync(path.join(base, d))) linkShared(path.join(base, d), path.join(codexHome, d));
    }
    // session 名稱存在 session_index.jsonl，先建立空檔才連得過去，名稱才會兩邊一致
    const idx = path.join(base, 'session_index.jsonl');
    if (!fs.existsSync(idx)) {
      try {
        fs.mkdirSync(base, { recursive: true });
        fs.writeFileSync(idx, '', { flag: 'a' });
      } catch {}
    }
    for (const f of CODEX_SHARED_FILES) linkFile(path.join(base, f), path.join(codexHome, f));
  }
  return { id, name, codexHome, shareHistory };
}

function decodeJwt(token) {
  try {
    const part = String(token).split('.')[1];
    return JSON.parse(Buffer.from(part.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'));
  } catch {
    return null;
  }
}

// Codex 登入資訊在 $CODEX_HOME/auth.json：ChatGPT 登入時 id_token 裡有 email 與方案；也可能只有 API key
function readCodexAccount(profile) {
  const j = readJson(path.join(codexHomeOf(profile), 'auth.json'));
  if (!j) return { email: null, plan: null, apiKey: false };
  const claims = j.tokens && j.tokens.id_token ? decodeJwt(typeof j.tokens.id_token === 'string' ? j.tokens.id_token : j.tokens.id_token.raw_jwt) : null;
  const auth = (claims && claims['https://api.openai.com/auth']) || {};
  return { email: (claims && claims.email) || null, plan: auth.chatgpt_plan_type || null, apiKey: !!j.OPENAI_API_KEY && !claims };
}

module.exports = {
  DEFAULT_ID,
  defaultProfile,
  claudeDirOf,
  isDefault,
  claudeEnv,
  createProfile,
  readAccount,
  claudeJsonOf,
  syncClaudeState,
  syncSharedClaudeState,
  defaultCodexProfile,
  codexHomeOf,
  codexEnv,
  createCodexProfile,
  readCodexAccount,
};

'use strict';
// 帳號 profile：每個 profile = 一組 CLAUDE_CONFIG_DIR（+ 可選 CODEX_HOME）。
// 非預設 profile 的 projects/ 以 symlink 指回預設目錄，所以所有帳號共用同一份 session 歷史，
// 帳號 A 額度用完時可以直接用帳號 B `claude --resume` 同一個 session。
const fs = require('fs');
const path = require('path');
const os = require('os');

const DEFAULT_ID = 'default';

function defaultClaudeDir() {
  return path.join(os.homedir(), '.claude');
}

function defaultProfile() {
  // name 為 null：由介面依語言顯示「預設帳號 / Default」
  return { id: DEFAULT_ID, name: null, claudeConfigDir: null, codexHome: null, shareHistory: true };
}

function claudeDirOf(profile) {
  return profile.claudeConfigDir || defaultClaudeDir();
}

function isDefault(profile) {
  return !profile.claudeConfigDir;
}

function envFor(profile) {
  const env = {};
  if (profile.claudeConfigDir) env.CLAUDE_CONFIG_DIR = profile.claudeConfigDir;
  if (profile.codexHome) env.CODEX_HOME = profile.codexHome;
  return env;
}

function linkShared(target, linkPath) {
  if (fs.existsSync(linkPath)) return;
  fs.mkdirSync(target, { recursive: true });
  fs.symlinkSync(target, linkPath, process.platform === 'win32' ? 'junction' : 'dir');
}

function createProfile(baseDir, name, { shareHistory = true, separateCodex = false } = {}) {
  const id = `p${Date.now().toString(36)}`;
  const dir = path.join(baseDir, id);
  const claudeConfigDir = path.join(dir, 'claude');
  fs.mkdirSync(claudeConfigDir, { recursive: true });
  if (shareHistory) {
    // 共用 session 歷史與 Claude 設定，讓切帳號後 --resume 仍然找得到同一個對話
    linkShared(path.join(defaultClaudeDir(), 'projects'), path.join(claudeConfigDir, 'projects'));
    for (const f of ['settings.json', 'CLAUDE.md']) {
      const src = path.join(defaultClaudeDir(), f);
      const dst = path.join(claudeConfigDir, f);
      if (fs.existsSync(src) && !fs.existsSync(dst)) {
        try {
          fs.symlinkSync(src, dst, 'file');
        } catch {
          fs.copyFileSync(src, dst);
        }
      }
    }
    for (const d of ['commands', 'agents', 'skills']) {
      const src = path.join(defaultClaudeDir(), d);
      if (fs.existsSync(src)) linkShared(src, path.join(claudeConfigDir, d));
    }
  }
  let codexHome = null;
  if (separateCodex) {
    codexHome = path.join(dir, 'codex');
    fs.mkdirSync(codexHome, { recursive: true });
  }
  return { id, name, claudeConfigDir, codexHome, shareHistory };
}

// 帳號 email：CLAUDE_CONFIG_DIR 模式下存在 <dir>/.claude.json，預設則在 ~/.claude.json
function readAccount(profile) {
  const f = profile.claudeConfigDir ? path.join(profile.claudeConfigDir, '.claude.json') : path.join(os.homedir(), '.claude.json');
  try {
    const j = JSON.parse(fs.readFileSync(f, 'utf8'));
    const a = j.oauthAccount || {};
    return { email: a.emailAddress || null, org: a.organizationName || null };
  } catch {
    return { email: null, org: null };
  }
}

module.exports = { DEFAULT_ID, defaultProfile, claudeDirOf, isDefault, envFor, createProfile, readAccount };

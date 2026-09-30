'use strict';
// 應用程式狀態：帳號 profiles、每個專案開著哪些 pane、自訂名稱、設定。存在 userData/state.json
const fs = require('fs');
const path = require('path');
const { defaultProfile } = require('./profiles');

const DEFAULTS = {
  activeProfile: 'default',
  profiles: [defaultProfile()],
  lastProject: null,
  recentProjects: [],
  // projects[cwd] = { panes: [{kind, sessionId, profileId}], names: {sessionId: name} }
  projects: {},
  settings: {
    autoRestore: true, // 開機後自動還原上次開著的 session
    openAtLogin: false, // 登入電腦時自動開啟本程式
    fallback: 'ask', // 'off' | 'ask' | 'auto'：額度用完時的處理方式
    fallbackOrder: ['other-profile', 'codex'], // 先換 Claude 帳號，再交給 Codex
    usageRefreshSec: 120,
    theme: 'terminal', // 見 src/renderer/themes.js
    lang: null, // null：依系統語言
    fontSize: 13,
    fontFamily: '', // 空字串：用系統終端機預設字型
    sidebarPinned: false, // false：側欄不用時收成窄條，滑鼠移上來才展開
    bridgeConfirm: false, // 窗格互通：true 時訊息先停在對方輸入框，等使用者按 Enter
  },
};

class Store {
  constructor(dir) {
    this.file = path.join(dir, 'state.json');
    fs.mkdirSync(dir, { recursive: true });
    let data = {};
    try {
      data = JSON.parse(fs.readFileSync(this.file, 'utf8'));
    } catch {}
    this.data = { ...structuredClone(DEFAULTS), ...data, settings: { ...DEFAULTS.settings, ...(data.settings || {}) } };
    if (!this.data.profiles.some((p) => p.id === 'default')) this.data.profiles.unshift(defaultProfile());
    this.migrate();
  }

  // 設定格式升級：預設值改變時，舊檔裡存著的舊預設值也一起更新（只做一次）
  migrate() {
    const v = this.data.settingsVersion || 1;
    if (v < 2) this.data.settings.bridgeConfirm = false; // 窗格訊息改成預設不用確認
    this.data.settingsVersion = 2;
  }

  save() {
    const tmp = this.file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2));
    fs.renameSync(tmp, this.file);
  }

  project(cwd) {
    if (!this.data.projects[cwd]) this.data.projects[cwd] = { panes: [], names: {} };
    return this.data.projects[cwd];
  }

  profile(id) {
    return this.data.profiles.find((p) => p.id === id) || this.data.profiles[0];
  }

  touchProject(cwd) {
    this.data.lastProject = cwd;
    this.data.recentProjects = [cwd, ...this.data.recentProjects.filter((p) => p !== cwd)].slice(0, 20);
    this.project(cwd);
    this.save();
  }
}

module.exports = { Store, DEFAULTS };

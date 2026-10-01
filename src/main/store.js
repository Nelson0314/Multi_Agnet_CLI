'use strict';
// 應用程式狀態：Claude 與 Codex 帳號、每個專案開著哪些 pane、自訂名稱、設定。存在 userData/state.json
const fs = require('fs');
const path = require('path');
const { defaultProfile, defaultCodexProfile } = require('./profiles');

const DEFAULTS = {
  // Claude 帳號（CLAUDE_CONFIG_DIR）與 Codex 帳號（CODEX_HOME）分開管理，各有自己的目前帳號
  activeProfile: 'default',
  profiles: [defaultProfile()],
  activeCodexProfile: 'default',
  codexProfiles: [defaultCodexProfile()],
  codexLimits: {}, // codex profile id -> 最後一次看到的額度（共用 session 歷史時無法從檔案分辨是哪個帳號）
  lastProject: null,
  recentProjects: [],
  // projects[cwd] = { panes: [{kind, sessionId, profileId, codexProfileId?}], names: {sessionId: name} }
  // profileId 指的是該窗格工具的帳號：Claude 窗格是 Claude 帳號，Codex 窗格是 Codex 帳號
  projects: {},
  settings: {
    autoRestore: true, // 開機後自動還原上次開著的 session
    openAtLogin: false, // 登入電腦時自動開啟本程式
    fallback: 'ask', // 'off' | 'ask' | 'auto'：帳號額度用完時，把用這個帳號的窗格換到另一個帳號
    limitContinue: true, // 換帳號後，對因額度中斷的窗格送出「繼續」
    shareInstructions: true, // Codex 窗格帶上 Claude 的指示、skills、MCP；Claude 窗格帶上 AGENTS.md
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
    if (!this.data.codexProfiles.some((p) => p.id === 'default')) this.data.codexProfiles.unshift(defaultCodexProfile());
    this.migrate();
  }

  // 設定格式升級：預設值改變時，舊檔裡存著的舊預設值也一起更新（只做一次）
  migrate() {
    const v = this.data.settingsVersion || 1;
    if (v < 2) this.data.settings.bridgeConfirm = false; // 窗格訊息改成預設不用確認
    // 額度用完不再交給 Codex，只換同一個工具的另一個帳號
    delete this.data.settings.fallbackOrder;
    // 舊版的 Codex 登入掛在 Claude 帳號底下（profile.codexHome），搬成獨立的 Codex 帳號，沿用同一個 id，
    // 所以舊的 Codex 窗格紀錄（profileId 是那個 Claude 帳號）還原時會用到同一個 CODEX_HOME
    for (const p of this.data.profiles) {
      if (!p.codexHome) {
        delete p.codexHome;
        continue;
      }
      if (!this.data.codexProfiles.some((c) => c.id === p.id)) {
        this.data.codexProfiles.push({ id: p.id, name: p.name, codexHome: p.codexHome, shareHistory: false });
        if (this.data.activeProfile === p.id && this.data.activeCodexProfile === 'default') this.data.activeCodexProfile = p.id;
      }
      delete p.codexHome;
    }
    this.data.settingsVersion = 3;
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

  codexProfile(id) {
    return this.data.codexProfiles.find((p) => p.id === id) || this.data.codexProfiles[0];
  }

  touchProject(cwd) {
    this.data.lastProject = cwd;
    this.data.recentProjects = [cwd, ...this.data.recentProjects.filter((p) => p !== cwd)].slice(0, 20);
    this.project(cwd);
    this.save();
  }
}

module.exports = { Store, DEFAULTS };

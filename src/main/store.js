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

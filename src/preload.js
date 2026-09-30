'use strict';
const { contextBridge, ipcRenderer, clipboard } = require('electron');

const on = (channel) => (cb) => {
  const h = (_e, ...args) => cb(...args);
  ipcRenderer.on(channel, h);
  return () => ipcRenderer.removeListener(channel, h);
};

contextBridge.exposeInMainWorld('api', {
  init: () => ipcRenderer.invoke('app:init'),
  listProjects: () => ipcRenderer.invoke('projects:list'),
  pickProject: () => ipcRenderer.invoke('projects:pick'),
  openProject: (cwd) => ipcRenderer.invoke('projects:open', cwd),
  listSessions: (cwd) => ipcRenderer.invoke('sessions:list', cwd),
  spawnPane: (opts) => ipcRenderer.invoke('pane:spawn', opts),
  write: (id, data) => ipcRenderer.send('pty:write', id, data),
  resize: (id, cols, rows) => ipcRenderer.send('pty:resize', id, cols, rows),
  resetLimit: (id) => ipcRenderer.send('pty:resetLimit', id),
  kill: (id) => ipcRenderer.invoke('pty:kill', id),
  saveLayout: (cwd, panes) => ipcRenderer.invoke('layout:save', cwd, panes),
  setName: (cwd, sessionId, name, kind, profileId) => ipcRenderer.invoke('names:set', cwd, sessionId, name, kind, profileId),
  getContext: (items) => ipcRenderer.invoke('context:get', items),
  getUsage: (opts) => ipcRenderer.invoke('usage:get', opts),
  listProfiles: () => ipcRenderer.invoke('profiles:list'),
  addProfile: (name, opts) => ipcRenderer.invoke('profiles:add', name, opts),
  removeProfile: (id) => ipcRenderer.invoke('profiles:remove', id),
  renameProfile: (id, name) => ipcRenderer.invoke('profiles:rename', id, name),
  setActiveProfile: (id) => ipcRenderer.invoke('profiles:setActive', id),
  installCodexMcp: (profileId) => ipcRenderer.invoke('codex:installMcp', profileId),
  installBridge: (profileId) => ipcRenderer.invoke('bridge:install', profileId),
  onBridgeAsk: on('bridge:ask'),
  bridgeAnswer: (id, value) => ipcRenderer.send('bridge:answer', id, value),
  createHandoff: (opts) => ipcRenderer.invoke('handoff:create', opts),
  setSettings: (patch) => ipcRenderer.invoke('settings:set', patch),
  openPath: (p) => ipcRenderer.invoke('shell:openPath', p),
  clipboardRead: () => clipboard.readText(),
  clipboardWrite: (t) => clipboard.writeText(t),
  onData: on('pty:data'),
  onExit: on('pty:exit'),
  onLimit: on('pane:limit'),
  onSession: on('pane:session'),
});

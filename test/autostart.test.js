'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { tmpdir } = require('./helpers');
const { setAutostart, filePath } = require('../src/main/autostart');

test('Windows 登記開機項目時帶上 Electron 路徑與專案路徑', () => {
  let got;
  const app = { setLoginItemSettings: (o) => (got = o) };
  setAutostart(true, { app, electron: 'C:\\x\\electron.exe', root: 'C:\\Users\\me\\Multi_Agnet_CLI', platform: 'win32' });
  assert.deepStrictEqual(got, { openAtLogin: true, path: 'C:\\x\\electron.exe', args: ['C:\\Users\\me\\Multi_Agnet_CLI'] });
});

test('macOS 寫入與移除 LaunchAgent，並清掉舊版登記', () => {
  const home = tmpdir();
  const calls = [];
  const app = { setLoginItemSettings: (o) => calls.push(o) };
  setAutostart(true, { app, electron: '/a/Electron & Co', root: '/r', platform: 'darwin', home });
  const f = filePath('darwin', home);
  const plist = fs.readFileSync(f, 'utf8');
  assert.match(plist, /<string>\/a\/Electron &amp; Co<\/string>\s*<string>\/r<\/string>/);
  assert.match(plist, /<key>RunAtLoad<\/key><true\/>/);
  assert.deepStrictEqual(calls[0], { openAtLogin: false });
  setAutostart(false, { app, electron: '/a', root: '/r', platform: 'darwin', home });
  assert.ok(!fs.existsSync(f));
});

test('Linux 寫入 ~/.config/autostart', () => {
  const home = tmpdir();
  const saved = process.env.XDG_CONFIG_HOME;
  delete process.env.XDG_CONFIG_HOME;
  setAutostart(true, { electron: '/e/electron', root: '/r', platform: 'linux', home });
  const f = path.join(home, '.config', 'autostart', 'multi-agent-cli.desktop');
  assert.match(fs.readFileSync(f, 'utf8'), /^Exec="\/e\/electron" "\/r" --no-sandbox$/m);
  if (saved) process.env.XDG_CONFIG_HOME = saved;
});

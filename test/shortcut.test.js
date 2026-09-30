'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { tmpdir } = require('./helpers');

const script = path.join(__dirname, '..', 'scripts', 'create-shortcut.js');
const run = (home, extra = {}) =>
  spawnSync(process.execPath, [script], { env: { ...process.env, HOME: home, CI: '', MULTI_AGENT_NO_SHORTCUT: '', ...extra }, encoding: 'utf8' });

test('Linux 桌面捷徑指向 Electron 與專案目錄，並帶圖示', { skip: process.platform !== 'linux' }, () => {
  const home = tmpdir();
  fs.mkdirSync(path.join(home, 'Desktop'));
  run(home);
  const file = path.join(home, 'Desktop', 'multi-agent-cli.desktop');
  const entry = fs.readFileSync(file, 'utf8');
  assert.match(entry, /^Exec=".*electron" ".*" --no-sandbox$/m);
  assert.match(entry, /^Icon=.*assets[\\/]icon\.png$/m);
  assert.ok(fs.statSync(file).mode & 0o100);
});

test('設定 MULTI_AGENT_NO_SHORTCUT 時不建立捷徑', () => {
  const home = tmpdir();
  fs.mkdirSync(path.join(home, 'Desktop'));
  run(home, { MULTI_AGENT_NO_SHORTCUT: '1' });
  assert.deepStrictEqual(fs.readdirSync(path.join(home, 'Desktop')), []);
});

test('沒有桌面資料夾時不報錯', () => {
  const r = run(tmpdir());
  assert.strictEqual(r.status, 0);
});

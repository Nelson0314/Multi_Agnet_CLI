'use strict';
// node-pty 1.1+ 在 macOS / Windows 附有 N-API prebuild，Electron 可直接載入，不需重新編譯。
// 只有沒有 prebuild 的平台（例如 Linux）才用 electron-rebuild 編譯；失敗也不讓 npm install 中斷。
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ptyDir = path.dirname(require.resolve('node-pty/package.json'));
const prebuild = path.join(ptyDir, 'prebuilds', `${process.platform}-${process.arch}`);
if (fs.existsSync(prebuild) || fs.existsSync(path.join(ptyDir, 'build', 'Release', 'pty.node'))) {
  console.log('[postinstall] node-pty 已有可用的原生模組，略過編譯');
} else {
  const r = spawnSync('npx', ['electron-rebuild', '-f', '-w', 'node-pty'], { stdio: 'inherit', shell: process.platform === 'win32' });
  if (r.status !== 0) {
    console.warn('[postinstall] electron-rebuild 失敗，改用 node-gyp 以 Node headers 編譯（N-API 相容 Electron）');
    spawnSync('npx', ['node-gyp', 'rebuild'], { cwd: ptyDir, stdio: 'inherit', shell: process.platform === 'win32' });
  }
}

// 在桌面建立捷徑（失敗只會印警告）
try {
  require('./create-shortcut').main();
} catch (e) {
  console.warn(`[shortcut] 無法建立桌面捷徑：${e.message}`);
}

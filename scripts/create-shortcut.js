'use strict';
// 在桌面建立捷徑：Windows .lnk、macOS .app、Linux .desktop。
// npm install 時由 postinstall 自動執行；也可以手動 `npm run shortcut`。
// 設定環境變數 MULTI_AGENT_NO_SHORTCUT=1 可以跳過。
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const NAME = 'Multi-Agent CLI';
const ROOT = path.resolve(__dirname, '..');
const ASSETS = path.join(ROOT, 'assets');

function electronBinary() {
  // 從 Node 執行時，require('electron') 回傳 Electron 執行檔路徑
  const p = require('electron');
  if (typeof p !== 'string' || !fs.existsSync(p)) throw new Error('找不到 Electron 執行檔，請先完成 npm install');
  return p;
}

function desktopDir() {
  if (process.platform === 'win32') {
    // 處理被 OneDrive 重新導向的桌面
    try {
      const out = execFileSync('powershell.exe', ['-NoProfile', '-Command', "[Environment]::GetFolderPath('Desktop')"], { encoding: 'utf8' }).trim();
      if (out) return out;
    } catch {}
  }
  if (process.platform === 'linux') {
    try {
      const out = execFileSync('xdg-user-dir', ['DESKTOP'], { encoding: 'utf8' }).trim();
      if (out) return out;
    } catch {}
  }
  return path.join(os.homedir(), 'Desktop');
}

function windows(desktop, electron) {
  const lnk = path.join(desktop, `${NAME}.lnk`);
  const ps = [
    '$s = (New-Object -ComObject WScript.Shell).CreateShortcut($env:MA_LNK)',
    '$s.TargetPath = $env:MA_TARGET',
    '$s.Arguments = \'"\' + $env:MA_ROOT + \'"\'',
    '$s.WorkingDirectory = $env:MA_ROOT',
    '$s.IconLocation = $env:MA_ICON + ",0"',
    `$s.Description = '${NAME}'`,
    '$s.Save()',
  ].join('; ');
  execFileSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', ps], {
    env: { ...process.env, MA_LNK: lnk, MA_TARGET: electron, MA_ROOT: ROOT, MA_ICON: path.join(ASSETS, 'icon.ico') },
    stdio: 'inherit',
  });
  return lnk;
}

function macos(desktop, electron) {
  const app = path.join(desktop, `${NAME}.app`);
  const contents = path.join(app, 'Contents');
  fs.mkdirSync(path.join(contents, 'MacOS'), { recursive: true });
  fs.mkdirSync(path.join(contents, 'Resources'), { recursive: true });
  fs.writeFileSync(
    path.join(contents, 'Info.plist'),
    `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key><string>${NAME}</string>
  <key>CFBundleDisplayName</key><string>${NAME}</string>
  <key>CFBundleIdentifier</key><string>io.github.nelson0314.multi-agent-cli.launcher</string>
  <key>CFBundleExecutable</key><string>launcher</string>
  <key>CFBundleIconFile</key><string>icon.icns</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>${require('../package.json').version}</string>
  <key>LSMinimumSystemVersion</key><string>11.0</string>
</dict>
</plist>
`,
  );
  const launcher = path.join(contents, 'MacOS', 'launcher');
  fs.writeFileSync(launcher, `#!/bin/bash\nexec ${JSON.stringify(electron)} ${JSON.stringify(ROOT)}\n`);
  fs.chmodSync(launcher, 0o755);
  fs.copyFileSync(path.join(ASSETS, 'icon.icns'), path.join(contents, 'Resources', 'icon.icns'));
  // 讓 Finder 重新讀取圖示
  try {
    execFileSync('touch', [app]);
  } catch {}
  return app;
}

function linux(desktop, electron) {
  const entry = `[Desktop Entry]
Type=Application
Name=${NAME}
Comment=Claude Code and Codex sessions in one window
Exec="${electron}" "${ROOT}" --no-sandbox
Path=${ROOT}
Icon=${path.join(ASSETS, 'icon.png')}
Terminal=false
Categories=Development;
`;
  const file = path.join(desktop, 'multi-agent-cli.desktop');
  fs.writeFileSync(file, entry);
  fs.chmodSync(file, 0o755);
  // 也放進應用程式選單
  const apps = path.join(os.homedir(), '.local', 'share', 'applications');
  try {
    fs.mkdirSync(apps, { recursive: true });
    fs.writeFileSync(path.join(apps, 'multi-agent-cli.desktop'), entry);
  } catch {}
  // GNOME 需要標記為可信任才會顯示成可執行的捷徑
  try {
    execFileSync('gio', ['set', file, 'metadata::trusted', 'true'], { stdio: 'ignore' });
  } catch {}
  return file;
}

function main() {
  if (process.env.MULTI_AGENT_NO_SHORTCUT || process.env.CI) return;
  const desktop = desktopDir();
  if (!fs.existsSync(desktop)) {
    console.log(`[shortcut] 找不到桌面資料夾 ${desktop}，略過`);
    return;
  }
  const electron = electronBinary();
  const made =
    process.platform === 'win32' ? windows(desktop, electron) : process.platform === 'darwin' ? macos(desktop, electron) : linux(desktop, electron);
  console.log(`[shortcut] 已建立 ${made}`);
}

if (require.main === module) {
  try {
    main();
  } catch (e) {
    // 捷徑失敗不應讓 npm install 失敗
    console.warn(`[shortcut] 無法建立桌面捷徑：${e.message}`);
  }
}

module.exports = { main, desktopDir };

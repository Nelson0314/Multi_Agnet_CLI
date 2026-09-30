'use strict';
// 登入電腦時自動開啟本程式。
// 從原始碼執行（electron .）時，只登記 Electron 執行檔會開出空白的 Electron，
// 必須連同專案路徑一起登記，所以三個平台各用自己的機制：
//   Windows：登錄檔 Run 機碼（app.setLoginItemSettings，帶 path + args）
//   macOS：~/Library/LaunchAgents 的 LaunchAgent plist
//   Linux：~/.config/autostart 的 .desktop
const fs = require('fs');
const os = require('os');
const path = require('path');

const LABEL = 'io.github.nelson0314.multi-agent-cli';

const xmlEsc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function macPlist(electron, root) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${xmlEsc(electron)}</string>
    <string>${xmlEsc(root)}</string>
  </array>
  <key>WorkingDirectory</key><string>${xmlEsc(root)}</string>
  <key>RunAtLoad</key><true/>
</dict>
</plist>
`;
}

function linuxDesktop(electron, root) {
  return `[Desktop Entry]
Type=Application
Name=Multi-Agent CLI
Exec="${electron}" "${root}" --no-sandbox
Path=${root}
Icon=${path.join(root, 'assets', 'icon.png')}
X-GNOME-Autostart-enabled=true
`;
}

function filePath(platform, home) {
  if (platform === 'darwin') return path.join(home, 'Library', 'LaunchAgents', `${LABEL}.plist`);
  if (platform === 'linux') return path.join(process.env.XDG_CONFIG_HOME || path.join(home, '.config'), 'autostart', 'multi-agent-cli.desktop');
  return null;
}

/**
 * @param {boolean} enabled
 * @param {{ app?: Electron.App, electron: string, root: string, platform?: string, home?: string }} o
 */
function setAutostart(enabled, { app, electron, root, platform = process.platform, home = os.homedir() }) {
  if (platform === 'win32') {
    app.setLoginItemSettings({ openAtLogin: enabled, path: electron, args: [root] });
    return;
  }
  // 清掉舊版用 setLoginItemSettings 登記、沒有帶專案路徑的項目
  if (platform === 'darwin' && app) {
    try {
      app.setLoginItemSettings({ openAtLogin: false });
    } catch {}
  }
  const file = filePath(platform, home);
  if (!enabled) {
    fs.rmSync(file, { force: true });
    return;
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, platform === 'darwin' ? macPlist(electron, root) : linuxDesktop(electron, root));
}

module.exports = { setAutostart, macPlist, linuxDesktop, filePath, LABEL };

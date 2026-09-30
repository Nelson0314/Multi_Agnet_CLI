'use strict';
// 介面主題：只決定背景、文字、分隔線這些介面色。
// Claude / Codex 標籤用它們原生的品牌色；終端機的 ANSI 色盤沿用各作業系統原生終端機，
// 程式（Claude Code、Codex、git…）輸出的顏色完全不改動。
/* exported THEMES, terminalFont, nativeAnsi */

const CLAUDE = '#d97757'; // Claude 品牌橘
const CODEX = '#10a37f'; // OpenAI / ChatGPT 綠

const THEMES = {
  terminal: {
    label: { en: 'Terminal', 'zh-Hant': '終端機' },
    ui: {
      bg: '#161616', panel: '#1c1c1c', panel2: '#232323', line: '#2d2d2d', lineStrong: '#444444',
      text: '#d4d4d4', muted: '#8c8c8c', faint: '#5e5e5e',
      claude: CLAUDE, codex: CODEX, ok: '#6aa56a', warn: '#c9a44a', bad: '#c96a6a', sel: '#3a3d41',
    },
  },
  graphite: {
    label: { en: 'Graphite', 'zh-Hant': '石墨' },
    ui: {
      bg: '#1a1c20', panel: '#1f2226', panel2: '#262a2f', line: '#30343a', lineStrong: '#4a5058',
      text: '#d3d6da', muted: '#8a9099', faint: '#5d636b',
      claude: CLAUDE, codex: CODEX, ok: '#6aa56a', warn: '#c9a44a', bad: '#c96a6a', sel: '#343942',
    },
  },
  sand: {
    label: { en: 'Sand', 'zh-Hant': '砂岩' },
    ui: {
      bg: '#1b1917', panel: '#211e1b', panel2: '#282421', line: '#332f2a', lineStrong: '#4f4942',
      text: '#e0dad0', muted: '#958d82', faint: '#655f57',
      claude: CLAUDE, codex: CODEX, ok: '#7aa56a', warn: '#c9a44a', bad: '#c9705f', sel: '#3a352f',
    },
  },
  mono: {
    label: { en: 'Mono', 'zh-Hant': '單色' },
    ui: {
      bg: '#141414', panel: '#1a1a1a', panel2: '#212121', line: '#2b2b2b', lineStrong: '#4a4a4a',
      text: '#d0d0d0', muted: '#888888', faint: '#5a5a5a',
      claude: '#c8c8c8', codex: '#9a9a9a', ok: '#a8a8a8', warn: '#bdbdbd', bad: '#d6d6d6', sel: '#3a3a3a',
    },
  },
  paper: {
    label: { en: 'Paper', 'zh-Hant': '紙白' },
    ui: {
      bg: '#f6f5f1', panel: '#efede8', panel2: '#e7e4de', line: '#dcd9d2', lineStrong: '#b9b5ad',
      text: '#2b2a28', muted: '#6e6b66', faint: '#9d9993',
      claude: '#c15f3c', codex: '#0e8c6d', ok: '#4f8a4f', warn: '#a47a1c', bad: '#b04a4a', sel: '#d6dbe3',
    },
  },
};

// 各系統原生終端機的預設 16 色
const NATIVE_ANSI = {
  // Windows Terminal「Campbell」
  win32: {
    black: '#0c0c0c', red: '#c50f1f', green: '#13a10e', yellow: '#c19c00', blue: '#0037da', magenta: '#881798', cyan: '#3a96dd', white: '#cccccc',
    brightBlack: '#767676', brightRed: '#e74856', brightGreen: '#16c60c', brightYellow: '#f9f1a5', brightBlue: '#3b78ff', brightMagenta: '#b4009e', brightCyan: '#61d6d6', brightWhite: '#f2f2f2',
  },
  // macOS Terminal.app
  darwin: {
    black: '#000000', red: '#990000', green: '#00a600', yellow: '#999900', blue: '#0000b2', magenta: '#b200b2', cyan: '#00a6b2', white: '#bfbfbf',
    brightBlack: '#666666', brightRed: '#e50000', brightGreen: '#00d900', brightYellow: '#e5e500', brightBlue: '#0000ff', brightMagenta: '#e500e5', brightCyan: '#00e5e5', brightWhite: '#e5e5e5',
  },
  // GNOME Terminal「Tango」
  linux: {
    black: '#2e3436', red: '#cc0000', green: '#4e9a06', yellow: '#c4a000', blue: '#3465a4', magenta: '#75507b', cyan: '#06989a', white: '#d3d7cf',
    brightBlack: '#555753', brightRed: '#ef2929', brightGreen: '#8ae234', brightYellow: '#fce94f', brightBlue: '#729fcf', brightMagenta: '#ad7fa8', brightCyan: '#34e2e2', brightWhite: '#eeeeec',
  },
};

function nativeAnsi(platform) {
  return NATIVE_ANSI[platform] || NATIVE_ANSI.linux;
}

// 預設跟系統終端機一樣的等寬字型；中文 fallback 到各平台的中文字型
function terminalFont(platform, custom) {
  const byPlatform = {
    darwin: ['"SF Mono"', 'Menlo', 'Monaco'],
    win32: ['"Cascadia Mono"', 'Consolas', '"Courier New"'],
    linux: ['"DejaVu Sans Mono"', '"Ubuntu Mono"', '"Liberation Mono"'],
  }[platform] || ['Menlo', 'Consolas', '"DejaVu Sans Mono"'];
  const cjk = ['"PingFang TC"', '"Microsoft JhengHei"', '"Noto Sans Mono CJK TC"', '"Noto Sans CJK TC"', 'monospace'];
  return [custom && custom.trim() ? `"${custom.trim().replace(/"/g, '')}"` : null, 'ui-monospace', ...byPlatform, ...cjk].filter(Boolean).join(', ');
}

'use strict';
// 介面主題。全部使用低飽和度色彩，終端機配色也同步調成柔和的 ANSI 色盤，
// 讓整體看起來接近系統原生終端機。
/* exported THEMES, terminalFont, muted256 */

const ansi = (o) => ({
  black: o.black,
  red: o.red,
  green: o.green,
  yellow: o.yellow,
  blue: o.blue,
  magenta: o.magenta,
  cyan: o.cyan,
  white: o.white,
  brightBlack: o.brightBlack,
  brightRed: o.brightRed || o.red,
  brightGreen: o.brightGreen || o.green,
  brightYellow: o.brightYellow || o.yellow,
  brightBlue: o.brightBlue || o.blue,
  brightMagenta: o.brightMagenta || o.magenta,
  brightCyan: o.brightCyan || o.cyan,
  brightWhite: o.brightWhite,
});

const THEMES = {
  terminal: {
    mutedAmount: 0.25,
    label: { en: 'Terminal', 'zh-Hant': '終端機' },
    ui: {
      bg: '#161616', panel: '#1c1c1c', panel2: '#232323', line: '#2d2d2d', lineStrong: '#444444',
      text: '#d4d4d4', muted: '#8c8c8c', faint: '#5e5e5e',
      claude: '#b59d8d', codex: '#9aab9c', ok: '#8fa58c', warn: '#b7a67e', bad: '#b48686', sel: '#383838',
    },
    term: ansi({
      black: '#2b2b2b', red: '#b07c7c', green: '#8fa58c', yellow: '#b9a882', blue: '#8198b0', magenta: '#a38fad', cyan: '#86a6a6', white: '#c9c9c9',
      brightBlack: '#6a6a6a', brightRed: '#c48f8f', brightGreen: '#a2b79f', brightYellow: '#c9b994', brightBlue: '#95abc2', brightMagenta: '#b5a2bf', brightCyan: '#9ab8b8', brightWhite: '#ececec',
    }),
  },
  graphite: {
    mutedAmount: 0.25,
    label: { en: 'Graphite', 'zh-Hant': '石墨' },
    ui: {
      bg: '#1a1c20', panel: '#1f2226', panel2: '#262a2f', line: '#30343a', lineStrong: '#4a5058',
      text: '#d3d6da', muted: '#8a9099', faint: '#5d636b',
      claude: '#b19f94', codex: '#98aaa2', ok: '#8fa596', warn: '#b3a684', bad: '#b08a8c', sel: '#343942',
    },
    term: ansi({
      black: '#2a2e34', red: '#ad8083', green: '#8fa596', yellow: '#b4a886', blue: '#8499b3', magenta: '#a092ad', cyan: '#88a6ab', white: '#c8ccd2',
      brightBlack: '#666c75', brightRed: '#c09396', brightGreen: '#a2b7a9', brightYellow: '#c6ba99', brightBlue: '#98acc4', brightMagenta: '#b2a5bf', brightCyan: '#9bb8bd', brightWhite: '#eceef1',
    }),
  },
  sand: {
    mutedAmount: 0.28,
    label: { en: 'Sand', 'zh-Hant': '砂岩' },
    ui: {
      bg: '#1b1917', panel: '#211e1b', panel2: '#282421', line: '#332f2a', lineStrong: '#4f4942',
      text: '#e0dad0', muted: '#958d82', faint: '#655f57',
      claude: '#c0a08b', codex: '#a1ab99', ok: '#9ba68a', warn: '#bba77f', bad: '#b88a80', sel: '#3a352f',
    },
    term: ansi({
      black: '#2c2824', red: '#b3827a', green: '#9ba68a', yellow: '#bea97f', blue: '#8a98a8', magenta: '#a8919f', cyan: '#8fa6a0', white: '#d2cbc0',
      brightBlack: '#6f685f', brightRed: '#c5958d', brightGreen: '#adb89c', brightYellow: '#cfbb92', brightBlue: '#9eabba', brightMagenta: '#baa4b1', brightCyan: '#a2b8b2', brightWhite: '#f0ebe3',
    }),
  },
  mono: {
    mutedAmount: 0,
    label: { en: 'Mono', 'zh-Hant': '單色' },
    ui: {
      bg: '#141414', panel: '#1a1a1a', panel2: '#212121', line: '#2b2b2b', lineStrong: '#4a4a4a',
      text: '#d0d0d0', muted: '#888888', faint: '#5a5a5a',
      claude: '#c8c8c8', codex: '#9a9a9a', ok: '#a8a8a8', warn: '#bdbdbd', bad: '#d6d6d6', sel: '#3a3a3a',
    },
    term: ansi({
      black: '#2a2a2a', red: '#b0b0b0', green: '#a0a0a0', yellow: '#c0c0c0', blue: '#909090', magenta: '#a8a8a8', cyan: '#989898', white: '#cccccc',
      brightBlack: '#666666', brightWhite: '#eeeeee',
    }),
  },
  paper: {
    mutedAmount: 0.3,
    label: { en: 'Paper', 'zh-Hant': '紙白' },
    ui: {
      bg: '#f6f5f1', panel: '#efede8', panel2: '#e7e4de', line: '#dcd9d2', lineStrong: '#b9b5ad',
      text: '#2b2a28', muted: '#6e6b66', faint: '#9d9993',
      claude: '#8a6c5a', codex: '#5f7263', ok: '#607a5c', warn: '#8a7a4f', bad: '#8f5d5d', sel: '#dcd8cf',
    },
    term: ansi({
      black: '#2b2a28', red: '#94605e', green: '#5f7a5b', yellow: '#86764c', blue: '#566d88', magenta: '#7b6788', cyan: '#557a7a', white: '#d9d6cf',
      brightBlack: '#8d8984', brightRed: '#a8716f', brightGreen: '#718c6d', brightYellow: '#98885e', brightBlue: '#687f9a', brightMagenta: '#8d799a', brightCyan: '#678c8c', brightWhite: '#f6f5f1',
    }),
  },
};

// xterm 256 色（16–255）的柔和版本：保留亮度、把彩度降到 amount 倍。
// CLI 不使用 truecolor 時，它們輸出的彩色（例如 diff 的紅綠底色）都會經過這張表。
function muted256(amount) {
  const lv = [0, 95, 135, 175, 215, 255];
  const hex = (v) => Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, '0');
  const out = [];
  for (let i = 16; i < 256; i++) {
    let r, g, b;
    if (i < 232) {
      const n = i - 16;
      r = lv[Math.floor(n / 36)];
      g = lv[Math.floor(n / 6) % 6];
      b = lv[n % 6];
    } else {
      r = g = b = 8 + 10 * (i - 232);
    }
    const y = 0.299 * r + 0.587 * g + 0.114 * b;
    out.push(`#${hex(y + (r - y) * amount)}${hex(y + (g - y) * amount)}${hex(y + (b - y) * amount)}`);
  }
  return out;
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

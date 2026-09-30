'use strict';
// 以真正的 pseudo-terminal 跑 claude / codex CLI，互動體驗與在終端機裡完全相同。
const os = require('os');

let pty; // 延遲載入原生模組，讓純邏輯部分可以在沒編譯 node-pty 的環境下測試

// 額度用完時 CLI 會印出的訊息（Claude / Codex），偵測到就通知 UI 提供 fallback
const LIMIT_PATTERNS = [
  /usage limit reached/i,
  /(5-hour|five-hour|weekly|session) limit (reached|hit)/i,
  /you(?:'|’)ve (hit|reached) your (usage )?limit/i,
  /limit will reset at/i,
  /rate_limit_error/i,
];

const ANSI = /\x1b\[[0-9;?]*[ -\/]*[@-~]|\x1b\][^\x07]*(\x07|\x1b\\)|\x1b[@-_]/g;

function shQuote(s) {
  return `'${String(s).replace(/'/g, `'\\''`)}'`;
}

function winQuote(s) {
  return /^[\w\-.:/\\]+$/.test(s) ? s : `"${String(s).replace(/"/g, '""')}"`;
}

// 從 Dock / 開始選單啟動的 GUI app PATH 很陽春，所以透過使用者的 login shell 執行，
// 讓 nvm / homebrew / npm global 安裝的 claude、codex 都找得到
function commandFor(cmd, args, { interactive = true } = {}) {
  if (process.platform === 'win32') {
    const line = [cmd, ...args].map(winQuote).join(' ');
    return { file: process.env.COMSPEC || 'cmd.exe', args: ['/d', '/s', '/c', line] };
  }
  const shell = process.env.SHELL || '/bin/bash';
  const line = ['exec', cmd, ...args.map(shQuote)].join(' ');
  return { file: shell, args: interactive ? ['-l', '-i', '-c', line] : ['-l', '-c', line] };
}

class PtyManager {
  constructor(send) {
    this.send = send; // (channel, ...args) => void
    this.ptys = new Map();
  }

  spawn(id, { cmd, args, cwd, env, cols = 100, rows = 30 }) {
    pty = pty || require('node-pty');
    const c = commandFor(cmd, args);
    const p = pty.spawn(c.file, c.args, {
      name: 'xterm-256color',
      cols,
      rows,
      cwd: cwd || os.homedir(),
      env: { ...process.env, ...env, TERM: 'xterm-256color', COLORTERM: 'truecolor' },
    });
    const rec = { pty: p, buf: '', timer: null, tail: '', limitNotified: false };
    this.ptys.set(id, rec);

    p.onData((d) => {
      // 合併小塊輸出後再送 IPC，減少 6 個 pane 同時輸出時的負擔
      rec.buf += d;
      if (!rec.timer) {
        rec.timer = setTimeout(() => {
          this.send('pty:data', id, rec.buf);
          rec.buf = '';
          rec.timer = null;
        }, 8);
      }
      rec.tail = (rec.tail + d.replace(ANSI, '')).slice(-4000);
      if (!rec.limitNotified && LIMIT_PATTERNS.some((re) => re.test(rec.tail))) {
        rec.limitNotified = true;
        this.send('pane:limit', id, rec.tail.slice(-400));
      }
    });
    p.onExit(({ exitCode }) => {
      if (rec.timer) {
        clearTimeout(rec.timer);
        this.send('pty:data', id, rec.buf);
      }
      this.ptys.delete(id);
      this.send('pty:exit', id, exitCode);
    });
    return p.pid;
  }

  write(id, data) {
    const r = this.ptys.get(id);
    if (r) r.pty.write(data);
  }

  resize(id, cols, rows) {
    const r = this.ptys.get(id);
    if (r && cols > 0 && rows > 0) {
      try {
        r.pty.resize(cols, rows);
      } catch {}
    }
  }

  resetLimit(id) {
    const r = this.ptys.get(id);
    if (r) {
      r.limitNotified = false;
      r.tail = '';
    }
  }

  kill(id) {
    const r = this.ptys.get(id);
    if (!r) return;
    this.ptys.delete(id);
    try {
      r.pty.kill();
    } catch {}
  }

  killAll() {
    for (const id of [...this.ptys.keys()]) this.kill(id);
  }
}

module.exports = { PtyManager, LIMIT_PATTERNS, ANSI, commandFor };

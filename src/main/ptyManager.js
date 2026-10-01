'use strict';
// 以真正的 pseudo-terminal 跑 claude / codex CLI，互動體驗與在終端機裡完全相同。
const os = require('os');

let pty; // 延遲載入原生模組，讓純邏輯部分可以在沒編譯 node-pty 的環境下測試

// 額度用完時 CLI 會印出的訊息（Claude / Codex），偵測到就通知 UI 換帳號。
// Claude Code 目前的寫法是「You've hit your session limit · resets 3pm」（session = 5 小時、weekly、
// Opus、Sonnet 等），舊版是「Claude AI usage limit reached」；Codex 是「You've hit your usage limit」。
// fast mode 的「fast limit」只是暫時改回一般速度，不算額度用完。
// 只靠文字會誤判（例如畫面上正好在看這段程式碼），所以介面會再用額度資料確認後才自動換帳號。
const LIMIT_PATTERNS = [
  /usage limit reached/i,
  /(5-hour|five-hour|weekly|session) limit (reached|hit)/i,
  /(?:you(?:'|’)ve|you have) (?:hit|reached) your (?:(?:usage|session|weekly|5-hour|opus|sonnet|fable|monthly|spend|credit)\s+){0,3}limit/i,
  /limit will reset at/i,
  /rate_limit_error/i,
];

const ANSI = /\x1b\[[0-9;?]*[ -\/]*[@-~]|\x1b\][^\x07]*(\x07|\x1b\\)|\x1b[@-_]/g;

function shQuote(s) {
  return `'${String(s).replace(/'/g, `'\\''`)}'`;
}

// Windows：用雙引號包住，裡面的 " 寫成 ""（cmd.exe 與 MSVCRT 都把它當成一個 "）；
// 結尾的反斜線要加倍，否則會跟後面的引號變成 \"
function winQuote(s) {
  s = String(s);
  return /^[\w\-.:/\\]+$/.test(s) ? s : `"${s.replace(/"/g, '""').replace(/(\\+)$/, '$1$1')}"`;
}

// 從 Dock / 開始選單啟動的 GUI app PATH 很陽春，所以透過使用者的 login shell 執行，
// 讓 nvm / homebrew / npm global 安裝的 claude、codex 都找得到。
// Windows 透過 cmd.exe（npm 安裝的 claude / codex 是 .cmd）。命令列要自己組好整串交出去（verbatim）：
// node-pty 與 child_process 預設會把參數裡的 " 寫成 \"，cmd.exe 不認得這種寫法，含空白的參數會被拆開
function commandFor(cmd, args, { interactive = true, platform = process.platform, env = process.env } = {}) {
  if (platform === 'win32') {
    const line = [cmd, ...args].map(winQuote).join(' ');
    // /s：cmd 只去掉最外層那對引號，裡面原封不動執行
    return { file: env.COMSPEC || 'cmd.exe', args: ['/d', '/s', '/c', `"${line}"`], verbatim: true };
  }
  const shell = env.SHELL || '/bin/bash';
  const line = ['exec', cmd, ...args.map(shQuote)].join(' ');
  return { file: shell, args: interactive ? ['-l', '-i', '-c', line] : ['-l', '-c', line] };
}

// 純終端機窗格：Windows 優先用 PowerShell 7（pwsh），沒有就用內建的 Windows PowerShell；
// macOS / Linux 用使用者的預設 shell
function shellCommand(platform = process.platform, env = process.env, exists = require('fs').existsSync) {
  if (platform === 'win32') {
    const pf = env.ProgramFiles || 'C:\\Program Files';
    const pwsh = require('path').win32.join(pf, 'PowerShell', '7', 'pwsh.exe');
    return { cmd: exists(pwsh) ? pwsh : 'powershell.exe', args: ['-NoLogo'] };
  }
  return { cmd: env.SHELL || '/bin/bash', args: ['-l'] };
}

// 預設宣告 truecolor，讓 CLI 用原本的全彩輸出；值為 null 的變數會被移除
function buildEnv(extra) {
  const env = { ...process.env, TERM: 'xterm-256color', COLORTERM: 'truecolor', ...extra };
  for (const k of Object.keys(env)) if (env[k] == null) delete env[k];
  return env;
}

class PtyManager {
  constructor(send) {
    this.send = send; // (channel, ...args) => void
    this.ptys = new Map();
  }

  spawn(id, { cmd, args, cwd, env, cols = 100, rows = 30, raw = false }) {
    pty = pty || require('node-pty');
    // raw：直接執行（例如 PowerShell 本身），不再包一層 cmd.exe / login shell
    const c = raw ? { file: cmd, args } : commandFor(cmd, args);
    // verbatim：Windows 上把組好的命令列當成字串交給 node-pty，它就不會再加引號、跳脫
    const p = pty.spawn(c.file, c.verbatim ? c.args.join(' ') : c.args, {
      name: 'xterm-256color',
      cols,
      rows,
      cwd: cwd || os.homedir(),
      env: buildEnv(env),
    });
    let exited;
    const rec = { pty: p, buf: '', timer: null, tail: '', limitNotified: false, lastOutput: Date.now(), exited: new Promise((r) => (exited = r)) };
    this.ptys.set(id, rec);

    p.onData((d) => {
      // 合併小塊輸出後再送 IPC，減少 6 個 pane 同時輸出時的負擔
      rec.lastOutput = Date.now();
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
      exited();
      this.send('pty:exit', id, exitCode);
    });
    return p.pid;
  }

  write(id, data) {
    const r = this.ptys.get(id);
    if (r) r.pty.write(data);
  }

  // 等到窗格安靜 quietMs 沒有輸出（最多等 maxMs），用來避免在 agent 忙碌時插話
  async waitQuiet(id, quietMs, maxMs) {
    const end = Date.now() + maxMs;
    while (Date.now() < end) {
      const r = this.ptys.get(id);
      if (!r || Date.now() - r.lastOutput >= quietMs) return;
      await new Promise((ok) => setTimeout(ok, 250));
    }
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

  // 結束窗格程式，等它真的結束（最多 timeoutMs）。換帳號續跑同一個 session 前要先等舊的程式寫完紀錄、離開，
  // 否則兩個程序會同時寫同一份對話紀錄
  kill(id, timeoutMs = 3000) {
    const r = this.ptys.get(id);
    if (!r) return Promise.resolve();
    this.ptys.delete(id);
    try {
      r.pty.kill();
    } catch {}
    return Promise.race([r.exited, new Promise((ok) => setTimeout(ok, timeoutMs))]);
  }

  killAll() {
    for (const id of [...this.ptys.keys()]) this.kill(id);
  }
}

module.exports = { PtyManager, LIMIT_PATTERNS, ANSI, commandFor, winQuote, buildEnv, shellCommand };

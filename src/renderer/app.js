'use strict';
/* global Terminal, FitAddon, api, I18N, THEMES, terminalFont, nativeAnsi -- api 由 preload 注入；I18N、THEMES 來自 i18n.js、themes.js */
const $ = (sel, root = document) => root.querySelector(sel);

const S = {
  maxPanes: 6,
  platform: 'darwin',
  // Claude 與 Codex 的帳號分開管理，各有自己的清單和目前帳號
  accounts: { claude: { profiles: [], active: 'default' }, codex: { profiles: [], active: 'default' } },
  settings: {},
  cwd: null,
  workspaces: new Map(), // cwd -> { el, panes: [] }
  sessions: { claude: [], codex: [] },
  tab: 'claude',
  search: '',
  usage: null,
  focused: null,
  handledOut: new Set(), // 已處理過的「帳號用完」（tool:id:重置時間），避免每次更新額度都再問一次
  lang: 'en',
};
const paneByPty = new Map();
const pendingData = new Map();

// ---------------------------------------------------------------- helpers
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const basename = (p) => (p || '').split(/[\\/]/).filter(Boolean).pop() || p;
const shellLabel = () => (S.platform === 'win32' ? 'PowerShell' : 'Shell');
const kindLabel = (k) => (k === 'codex' ? 'Codex' : k === 'shell' ? shellLabel() : 'Claude');
// 窗格用哪個工具的帳號：Codex 窗格用 Codex 帳號，其他（Claude、shell）的 profileId 是 Claude 帳號
const toolOf = (kind) => (kind === 'codex' ? 'codex' : 'claude');
const toolLabel = (tool) => (tool === 'codex' ? 'Codex' : 'Claude');
const accountsOf = (tool) => S.accounts[tool].profiles;
const activeOf = (tool) => S.accounts[tool].active;
const accountOf = (tool, id) => accountsOf(tool).find((p) => p.id === id) || accountsOf(tool)[0];

// ---------------------------------------------------------------- i18n / theme
function t(key, vars = {}) {
  const dict = I18N[S.lang] || I18N.en;
  const str = dict[key] ?? I18N.en[key] ?? key;
  return str.replace(/\{(\w+)\}/g, (_, k) => (vars[k] ?? `{${k}}`));
}

function detectLang() {
  return /^zh/i.test(navigator.language || '') ? 'zh-Hant' : 'en';
}

// 預設帳號在舊版存成「預設帳號」，新版存 null，兩者都依目前語言顯示
function profileName(p) {
  if (!p) return '';
  return p.id === 'default' && (!p.name || p.name === '預設帳號') ? t('profile.default') : p.name;
}

function sessionTitle(s) {
  return s.title || t('session.untitled');
}

// IPC 錯誤訊息會被包成 "Error invoking remote method ...: Error: E_CODE"
function errMsg(e) {
  const m = String((e && e.message) || e).match(/E_[A-Z_]+/);
  return m ? t(`err.${m[0]}`, { max: S.maxPanes }) : String((e && e.message) || e);
}

function currentTheme() {
  return THEMES[S.settings.theme] || THEMES.terminal;
}

function termOptions() {
  const th = currentTheme();
  return {
    fontFamily: terminalFont(S.platform, S.settings.fontFamily),
    fontSize: S.settings.fontSize || 13,
    theme: {
      background: th.ui.bg,
      foreground: th.ui.text,
      cursor: th.ui.text,
      cursorAccent: th.ui.bg,
      selectionBackground: th.ui.sel,
      ...nativeAnsi(S.platform), // 沿用系統原生終端機的 16 色，程式輸出的顏色不做任何改動
    },
  };
}

function applyTheme() {
  const ui = currentTheme().ui;
  const root = document.documentElement.style;
  const map = { bg: '--bg', panel: '--panel', panel2: '--panel-2', line: '--line', lineStrong: '--line-strong', text: '--text', muted: '--muted', faint: '--faint', claude: '--claude', codex: '--codex', ok: '--ok', warn: '--warn', bad: '--bad', sel: '--sel' };
  for (const [k, v] of Object.entries(map)) root.setProperty(v, ui[k]);
  root.setProperty('--font', terminalFont(S.platform, S.settings.fontFamily));
  document.documentElement.dataset.theme = S.settings.theme || 'terminal';
  const opts = termOptions();
  for (const p of allPanes()) {
    p.term.options.fontFamily = opts.fontFamily;
    p.term.options.fontSize = opts.fontSize;
    p.term.options.theme = opts.theme;
    try {
      p.fit.fit();
    } catch {}
  }
}

function applyLang() {
  document.documentElement.lang = S.lang;
  document.querySelectorAll('[data-i18n]').forEach((el) => (el.textContent = t(el.dataset.i18n)));
  document.querySelectorAll('[data-i18n-placeholder]').forEach((el) => (el.placeholder = t(el.dataset.i18nPlaceholder)));
  document.querySelectorAll('[data-i18n-title]').forEach((el) => (el.title = t(el.dataset.i18nTitle)));
  $('#newShell').textContent = `+ ${shellLabel()}`;
  $('#newShell').title = t('side.newShellTip', { kind: shellLabel() });
  renderAccount();
  for (const p of allPanes()) {
    renderPaneHead(p);
    renderPaneCtx(p);
    localizePaneButtons(p);
  }
  if (!S.cwd) $('#projectName').textContent = t('top.project');
  layoutGridIfAny();
  renderSessionList();
  renderDashboard();
}

function allPanes() {
  return [...S.workspaces.values()].flatMap((w) => w.panes);
}

function layoutGridIfAny() {
  const w = ws();
  if (w) layoutGrid(w);
  else $('#paneCount').textContent = t('side.open', { n: 0, max: S.maxPanes });
}
const ws = () => S.workspaces.get(S.cwd);

function fmtAgo(ms) {
  const s = (Date.now() - ms) / 1000;
  if (s < 60) return t('time.now');
  if (s < 3600) return t('time.min', { n: Math.floor(s / 60) });
  if (s < 86400) return t('time.hour', { n: Math.floor(s / 3600) });
  return t('time.day', { n: Math.floor(s / 86400) });
}
function fmtTokens(n) {
  if (n == null) return '–';
  return n >= 1e6 ? `${(n / 1e6).toFixed(2)}M` : n >= 1000 ? `${Math.round(n / 1000)}k` : String(n);
}
function fmtReset(ts) {
  if (!ts || ts <= Date.now()) return ''; // 已過重置時間的舊資料不顯示倒數
  const s = (ts - Date.now()) / 1000;
  if (s < 3600) return t('reset.min', { m: Math.ceil(s / 60) });
  if (s < 86400) return t('reset.hour', { h: Math.floor(s / 3600), m: Math.floor((s % 3600) / 60) });
  return t('reset.day', { d: Math.floor(s / 86400), h: Math.floor((s % 86400) / 3600) });
}
const barClass = (pct) => (pct >= 90 ? 'bad' : pct >= 70 ? 'warn' : '');
function bar(pct) {
  const v = pct == null ? 0 : Math.max(0, Math.min(100, pct));
  return `<div class="bar ${barClass(v)}"><i style="width:${v}%"></i></div>`;
}
function initials(p) {
  const s = (p && ((p.account && p.account.email) || profileName(p))) || '?';
  return s.trim()[0].toUpperCase();
}

function toast(msg, type = '', ms = 5000) {
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.textContent = msg;
  $('#toasts').appendChild(el);
  setTimeout(() => el.remove(), ms);
}

// ---------------------------------------------------------------- popover / modal
function showPopover(anchor, items) {
  const pop = $('#popover');
  pop.innerHTML = '';
  for (const it of items) {
    if (it === '-') {
      pop.appendChild(document.createElement('hr'));
      continue;
    }
    const d = document.createElement('div');
    d.className = `item ${it.active ? 'active' : ''}`;
    d.innerHTML = it.html || esc(it.label);
    d.onclick = (e) => {
      e.stopPropagation();
      hidePopover();
      it.onClick && it.onClick();
    };
    pop.appendChild(d);
  }
  const r = anchor.getBoundingClientRect();
  pop.hidden = false;
  const w = pop.offsetWidth;
  pop.style.top = `${r.bottom + 4}px`;
  pop.style.left = `${Math.max(8, Math.min(window.innerWidth - w - 8, r.left))}px`;
}
function hidePopover() {
  $('#popover').hidden = true;
}
document.addEventListener('click', (e) => {
  if (!$('#popover').contains(e.target)) hidePopover();
});

function modal(html, onMount) {
  return new Promise((resolve) => {
    const m = $('#modal');
    $('#modalCard').innerHTML = html;
    m.hidden = false;
    const close = (v) => {
      m.hidden = true;
      $('#modalCard').innerHTML = '';
      resolve(v);
    };
    onMount && onMount($('#modalCard'), close);
  });
}

function promptModal(title, { value = '', placeholder = '', hint = '' } = {}) {
  return modal(
    `<h3>${esc(title)}</h3><div class="field"><input id="mInput" value="${esc(value)}" placeholder="${esc(placeholder)}" /></div>
     ${hint ? `<div class="hint">${esc(hint)}</div>` : ''}
     <div class="actions"><button id="mCancel">${t('modal.cancel')}</button><button id="mOk" class="primary">${t('modal.ok')}</button></div>`,
    (card, close) => {
      const input = $('#mInput', card);
      input.focus();
      input.select();
      $('#mCancel', card).onclick = () => close(null);
      $('#mOk', card).onclick = () => close(input.value.trim());
      input.onkeydown = (e) => {
        if (e.key === 'Enter') close(input.value.trim());
        if (e.key === 'Escape') close(null);
      };
    },
  );
}

// ---------------------------------------------------------------- terminals
// plainPaste：Ctrl+V 直接貼上文字（登入視窗用，不需要保留給 Claude Code 貼圖片）
function makeTerminal(container, getPtyId, { plainPaste = false } = {}) {
  const term = new Terminal({
    ...termOptions(),
    cursorBlink: true,
    scrollback: 10000,
    allowProposedApi: true,
  });
  const fit = new FitAddon.FitAddon();
  term.loadAddon(fit);
  term.open(container);
  term.onData((d) => getPtyId() && api.write(getPtyId(), d));
  // 回答 OSC 10/11 前景、背景色查詢，Claude Code 的「Auto (match terminal)」主題才能判斷要用深色或淺色
  const xColor = (hex) => `rgb:${[1, 3, 5].map((i) => hex.slice(i, i + 2).repeat(2)).join('/')}`;
  for (const [code, key] of [
    [10, 'text'],
    [11, 'bg'],
  ]) {
    term.parser.registerOscHandler(code, (data) => {
      if (data !== '?' || !getPtyId()) return false;
      api.write(getPtyId(), `\x1b]${code};${xColor(currentTheme().ui[key])}\x1b\\`);
      return true;
    });
  }
  // 複製貼上：macOS 用 ⌘C/⌘V；Windows/Linux 用 Ctrl+Shift+C/V。
  // 純 Ctrl+V 保留給 Claude Code（它會自己讀剪貼簿裡的圖片）
  term.attachCustomKeyEventHandler((e) => {
    if (e.type !== 'keydown') return true;
    const mod = S.platform === 'darwin' ? e.metaKey : e.ctrlKey && e.shiftKey;
    const k = e.key.toLowerCase();
    if (mod && k === 'c' && term.hasSelection()) {
      api.clipboardWrite(term.getSelection());
      return false;
    }
    if ((mod || (plainPaste && (e.ctrlKey || e.metaKey))) && k === 'v') {
      term.paste(api.clipboardRead());
      return false;
    }
    if ((e.metaKey || e.ctrlKey) && /^[1-6]$/.test(e.key)) {
      focusPaneIndex(Number(e.key) - 1);
      return false;
    }
    return true;
  });
  let t;
  const ro = new ResizeObserver(() => {
    clearTimeout(t);
    t = setTimeout(() => {
      if (!container.offsetWidth) return;
      try {
        fit.fit();
      } catch {}
      if (getPtyId()) api.resize(getPtyId(), term.cols, term.rows);
    }, 60);
  });
  ro.observe(container);
  return { term, fit, ro };
}

api.onData((id, data) => {
  const p = paneByPty.get(id);
  if (p) {
    p.lastData = Date.now(); // 用來判斷窗格是否閒置（agent 工作中會一直有輸出）
    p.term.write(data);
    if (p.onData) p.onData(data);
  } else pendingData.set(id, (pendingData.get(id) || '') + data);
});
api.onExit((id, code) => {
  const p = paneByPty.get(id);
  if (!p) return;
  if (p.onExit) return p.onExit(code);
  p.exited = true;
  p.el.classList.add('exited');
  p.term.write(`\r\n\x1b[90m${t('pane.exited', { code })}\x1b[0m\r\n`);
});
api.onLimit((id) => {
  const p = paneByPty.get(id);
  if (p && p.kind) onLimitText(p);
});
// 窗格互通：主程式來問窗格順序、畫面文字，或通知有訊息進來
api.onBridgeAsk(async (reqId, method, args) => {
  let value = null;
  try {
    if (method === 'listPanes') {
      const w = S.workspaces.get(args.cwd);
      value = (w ? w.panes : []).filter((p) => p.id).map((p, i) => ({ index: i + 1, paneId: p.id, kind: kindLabel(p.kind), title: paneTitle(p) }));
    } else if (method === 'readScreen') {
      const p = paneByPty.get(args.paneId);
      if (p) {
        const b = p.term.buffer.active;
        const lines = [];
        for (let i = Math.max(0, b.length - args.lines); i < b.length; i++) lines.push(b.getLine(i).translateToString(true));
        value = lines.join('\n').replace(/\n+$/, '');
      }
    } else if (method === 'incoming') {
      const p = paneByPty.get(args.paneId);
      if (p) {
        const w = S.workspaces.get(p.cwd);
        const to = w ? w.panes.indexOf(p) + 1 : '?';
        toast(t(args.confirm ? 'bridge.incomingConfirm' : 'bridge.incoming', { from: args.fromIndex, title: args.fromTitle, to }));
        if (args.confirm) setFocus(p);
      }
    }
  } catch {}
  api.bridgeAnswer(reqId, value);
});

api.onSession((id, sessionId) => {
  const p = paneByPty.get(id);
  if (!p) return;
  p.sessionId = sessionId;
  if (p.name) api.setName(p.cwd, sessionId, p.name, p.kind, p.profileId);
  saveLayout(p.cwd);
  refreshSessions();
});

// ---------------------------------------------------------------- panes
function workspaceFor(cwd) {
  let w = S.workspaces.get(cwd);
  if (!w) {
    const el = document.createElement('div');
    el.className = 'workspace';
    $('#workspaces').appendChild(el);
    w = { el, panes: [] };
    S.workspaces.set(cwd, w);
  }
  return w;
}

// 自適應版面：依工作區長寬比挑欄數，讓每格接近終端機舒適的比例（寬:高 ≈ 1.4）。
// 最後一列若不滿，該列窗格自動加寬，所以不管開幾個都會填滿整個區域、不留空格。
const TARGET_ASPECT = 1.4;
const gcd = (a, b) => (b ? gcd(b, a % b) : a);

function bestGrid(n, W, H) {
  let best = null;
  for (let cols = 1; cols <= n; cols++) {
    const rows = Math.ceil(n / cols);
    const last = n - cols * (rows - 1);
    const h = H / rows;
    const off = (w) => Math.abs(Math.log(w / h / TARGET_ASPECT));
    const cost = ((n - last) * off(W / cols) + last * off(W / last)) / n;
    if (!best || cost < best.cost - 1e-9) best = { cols, rows, last, cost };
  }
  return best;
}

// 版面由「列」組成，每列有幾個窗格（由 bestGrid 決定）。大小以比例記錄：
//   w.rowW[r]：第 r 列的高度比例；w.colW[r][c]：第 r 列第 c 格的寬度比例
// 用 flex-grow 套用比例，所以縮放視窗時永遠填滿、比例不變。
const MIN_W = 160; // 窗格最小寬度（px）
const MIN_H = 90; // 窗格最小高度（px）
const equal = (n) => Array.from({ length: n }, () => 1 / n);

function layoutGrid(w) {
  const n = w.panes.length;
  const host = $('#workspaces');
  if (n) {
    const { cols, rows, last } = bestGrid(n, host.clientWidth || 1600, host.clientHeight || 900);
    const counts = Array.from({ length: rows }, (_, r) => (r < rows - 1 ? cols : last));
    const sig = counts.join(',');
    const order = w.panes.map((p) => p.el.dataset.uid).join(',');
    // 窗格數量或排法改變：重建列結構；有存過同樣排法的大小就沿用，否則平均分配
    if (w.sig !== sig) {
      w.sig = sig;
      const saved = w.savedSizes && w.savedSizes.sig === sig ? w.savedSizes : null;
      w.rowW = saved ? saved.rowW.slice() : equal(rows);
      w.colW = saved ? saved.colW.map((r) => r.slice()) : counts.map((k) => equal(k));
    }
    if (w.builtSig !== sig || w.builtOrder !== order) buildRows(w, counts);
    applySizes(w);
  } else {
    w.el.innerHTML = '';
    w.sig = w.builtSig = w.builtOrder = null;
  }
  w.panes.forEach((p, i) => ($('.pane-idx', p.el).textContent = `${i + 1}`));
  $('#empty').hidden = !!S.cwd;
  $('#paneCount').textContent = t('side.open', { n, max: S.maxPanes });
}

function buildRows(w, counts) {
  const frag = document.createDocumentFragment();
  w.rowEls = [];
  let i = 0;
  counts.forEach((k, r) => {
    if (r > 0) frag.appendChild(makeSplitter(w, 'h', r - 1));
    const row = document.createElement('div');
    row.className = 'ws-row';
    for (let c = 0; c < k; c++) {
      if (c > 0) row.appendChild(makeSplitter(w, 'v', r, c - 1));
      row.appendChild(w.panes[i++].el); // 移動既有的窗格元素，終端機不會重建
    }
    w.rowEls.push(row);
    frag.appendChild(row);
  });
  w.el.innerHTML = '';
  w.el.appendChild(frag);
  w.builtSig = counts.join(',');
  w.builtOrder = w.panes.map((p) => p.el.dataset.uid).join(',');
}

// 視窗縮小時，把低於最小尺寸的窗格補回最小值，從其他較大的窗格扣
function enforceMin(weights, totalPx, minPx) {
  const sum = weights.reduce((a, b) => a + b, 0);
  const min = Math.min((minPx / Math.max(1, totalPx)) * sum, sum / weights.length);
  let deficit = 0;
  for (let k = 0; k < weights.length; k++) {
    if (weights[k] < min) {
      deficit += min - weights[k];
      weights[k] = min;
    }
  }
  while (deficit > 1e-9) {
    const extra = weights.map((x) => Math.max(0, x - min));
    const room = extra.reduce((a, b) => a + b, 0);
    if (room <= 1e-9) break;
    const take = Math.min(deficit, room);
    for (let k = 0; k < weights.length; k++) weights[k] -= (extra[k] / room) * take;
    deficit -= take;
  }
}

function applySizes(w) {
  const W = w.el.clientWidth;
  const H = w.el.clientHeight;
  if (W && H) {
    enforceMin(w.rowW, H, MIN_H);
    w.colW.forEach((row) => enforceMin(row, W, MIN_W));
  }
  let i = 0;
  w.rowEls.forEach((row, r) => {
    row.style.flex = `${w.rowW[r]} 1 0px`;
    w.colW[r].forEach((cw) => (w.panes[i++].el.style.flex = `${cw} 1 0px`));
  });
}

// 分隔線：'v' 調整同一列左右兩格，'h' 調整上下兩列；雙擊回到平均
function makeSplitter(w, dir, r, c) {
  const el = document.createElement('div');
  el.className = `splitter ${dir}`;
  el.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    el.setPointerCapture(e.pointerId);
    const weights = dir === 'v' ? w.colW[r] : w.rowW;
    const idx = dir === 'v' ? c : r;
    const total = dir === 'v' ? w.rowEls[r].clientWidth : w.el.clientHeight;
    const sum = weights.reduce((a, b) => a + b, 0);
    const start = dir === 'v' ? e.clientX : e.clientY;
    const a0 = weights[idx];
    const b0 = weights[idx + 1];
    const min = ((dir === 'v' ? MIN_W : MIN_H) / Math.max(1, total)) * sum;
    document.body.classList.add(`resizing-${dir}`);
    el.classList.add('active');
    const move = (ev) => {
      const d = (((dir === 'v' ? ev.clientX : ev.clientY) - start) / Math.max(1, total)) * sum;
      const nd = Math.max(min - a0, Math.min(b0 - min, d));
      weights[idx] = a0 + nd;
      weights[idx + 1] = b0 - nd;
      applySizes(w);
    };
    const up = () => {
      el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerup', up);
      el.removeEventListener('pointercancel', up);
      document.body.classList.remove(`resizing-${dir}`);
      el.classList.remove('active');
      saveSizes(w);
    };
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', up);
  });
  el.addEventListener('dblclick', () => {
    if (dir === 'v') w.colW[r] = equal(w.colW[r].length);
    else w.rowW = equal(w.rowW.length);
    applySizes(w);
    saveSizes(w);
  });
  return el;
}

function saveSizes(w) {
  w.savedSizes = { sig: w.sig, rowW: w.rowW.slice(), colW: w.colW.map((r) => r.slice()) };
  const cwd = [...S.workspaces].find(([, x]) => x === w)?.[0];
  if (cwd) saveLayout(cwd);
}

function paneTitle(p) {
  if (p.kind === 'shell') return p.name || shellLabel();
  return p.name || t('session.new', { kind: kindLabel(p.kind) });
}

function renderPaneHead(p) {
  const prof = p.kind === 'shell' ? null : accountOf(toolOf(p.kind), p.profileId);
  const head = $('.pane-head', p.el);
  $('.tag.kind', head).className = `tag kind ${p.kind}`;
  $('.tag.kind', head).textContent = kindLabel(p.kind);
  const titleEl = $('.pane-title', head);
  if (!titleEl.querySelector('input')) {
    titleEl.textContent = paneTitle(p);
    titleEl.title = `${paneTitle(p)}\n${p.kind === 'shell' ? p.cwd : p.sessionId || t('session.waitingId')}\n${t('session.renameHint')}`;
  }
  const pt = $('.tag.profile', head);
  pt.textContent = prof ? profileName(prof) : '';
  pt.hidden = !prof || accountsOf(toolOf(p.kind)).length < 2;
  p.el.className = `pane ${p.kind} ${S.focused === p ? 'focused' : ''} ${p.max ? 'max' : ''} ${p.exited ? 'exited' : ''}`;
}

// context 用量：標題列右側一個小百分比，加上標題列底部一條 2px 進度線；詳細數字放在提示文字
function renderPaneCtx(p) {
  const pctEl = $('.ctx', p.el);
  const line = $('.ctx-line', p.el);
  const c = p.kind === 'shell' ? null : p.context;
  pctEl.textContent = c ? `${c.pct.toFixed(0)}%` : '';
  pctEl.title = c ? t('pane.contextTip', { used: c.tokens.toLocaleString(), total: c.window.toLocaleString() }) : '';
  line.className = `ctx-line ${c ? barClass(c.pct) : ''}`;
  line.hidden = !c;
  $('i', line).style.width = `${c ? Math.min(100, c.pct) : 0}%`;
}

let paneUid = 0;
function createPaneEl(p) {
  const el = document.createElement('div');
  el.dataset.uid = String(++paneUid);
  el.innerHTML = `
    <div class="pane-head">
      <span class="pane-idx"></span>
      <span class="tag kind"></span>
      <span class="pane-title"></span>
      <span class="tag profile"></span>
      <span class="ctx"></span>
      <button class="icon" data-act="menu">⇄</button>
      <button class="icon" data-act="max">⤢</button>
      <button class="icon" data-act="close">✕</button>
      <div class="ctx-line"><i></i></div>
    </div>
    <div class="pane-banner" hidden></div>
    <div class="term"></div>`;
  p.el = el;
  localizePaneButtons(p);
  el.addEventListener('mousedown', () => setFocus(p));
  $('.pane-title', el).addEventListener('dblclick', () => startRename(p));
  el.querySelector('[data-act=close]').onclick = () => closePane(p);
  el.querySelector('[data-act=max]').onclick = () => toggleMax(p);
  el.querySelector('[data-act=menu]').onclick = (e) => {
    e.stopPropagation();
    showPopover(e.currentTarget, paneMenu(p));
  };
  return el;
}

function localizePaneButtons(p) {
  p.el.querySelector('[data-act=menu]').title = t('pane.menu');
  p.el.querySelector('[data-act=max]').title = t('pane.max');
  p.el.querySelector('[data-act=close]').title = t('pane.close');
}

function startRename(p) {
  const titleEl = $('.pane-title', p.el);
  const input = document.createElement('input');
  input.value = paneTitle(p);
  titleEl.innerHTML = '';
  titleEl.appendChild(input);
  input.focus();
  input.select();
  const done = (save) => {
    if (save && input.value.trim()) {
      p.name = input.value.trim();
      if (p.sessionId) api.setName(p.cwd, p.sessionId, p.name, p.kind, p.profileId).then(refreshSessions);
      else if (p.kind === 'shell') saveLayout(p.cwd);
    }
    titleEl.innerHTML = '';
    renderPaneHead(p);
  };
  input.onkeydown = (e) => {
    if (e.key === 'Enter') done(true);
    if (e.key === 'Escape') done(false);
  };
  input.onblur = () => done(true);
}

function setFocus(p) {
  const prev = S.focused;
  S.focused = p;
  if (prev && prev !== p && prev.el) renderPaneHead(prev);
  if (p) {
    renderPaneHead(p);
    p.term.focus();
  }
}

function focusPaneIndex(i) {
  const w = ws();
  if (w && w.panes[i]) setFocus(w.panes[i]);
}

function toggleMax(p) {
  const w = S.workspaces.get(p.cwd);
  const on = !p.max;
  w.panes.forEach((x) => (x.max = false));
  p.max = on;
  w.el.classList.toggle('has-max', on);
  w.panes.forEach(renderPaneHead);
  setFocus(p);
}

async function startPty(p, { prompt } = {}) {
  try {
    p.fit.fit();
  } catch {}
  const r = await api.spawnPane({
    kind: p.kind,
    cwd: p.cwd,
    runCwd: p.runCwd || null,
    sessionId: p.sessionId,
    profileId: p.profileId,
    // shell 記住開啟時的 Codex 帳號；Claude 窗格每次啟動都用目前的 Codex 帳號
    codexProfileId: p.kind === 'shell' ? p.codexProfileId || null : null,
    name: p.sessionId ? undefined : p.name,
    prompt,
    cols: p.term.cols,
    rows: p.term.rows,
  });
  p.id = r.paneId;
  p.sessionId = r.sessionId || p.sessionId;
  p.profileId = r.profileId;
  p.codexProfileId = r.codexProfileId || null;
  p.startedAt = p.lastData = Date.now();
  paneByPty.set(p.id, p);
  const buffered = pendingData.get(p.id);
  if (buffered) {
    p.term.write(buffered);
    pendingData.delete(p.id);
  }
}

// cwd：窗格屬於哪個專案；runCwd：程式實際執行的資料夾（子資料夾或 worktree 裡的 session 要在原本的位置續跑）
async function spawnPane({ kind, sessionId = null, name = null, prompt = null, profileId = null, codexProfileId = null, cwd = S.cwd, runCwd = null }) {
  const w = workspaceFor(cwd);
  if (w.panes.length >= S.maxPanes) {
    toast(t('err.E_MAX_PANES', { max: S.maxPanes }), 'bad');
    return null;
  }
  const p = { id: null, kind, cwd, runCwd, sessionId, name, profileId: profileId || activeOf(toolOf(kind)), codexProfileId, context: null, exited: false, max: false };
  w.el.appendChild(createPaneEl(p));
  w.panes.push(p);
  layoutGrid(w);
  Object.assign(p, makeTerminal($('.term', p.el), () => p.id));
  renderPaneHead(p);
  renderPaneCtx(p);
  try {
    await startPty(p, { prompt });
  } catch (e) {
    toast(t('spawn.failed', { kind: kindLabel(kind), msg: errMsg(e) }), 'bad');
    removePane(p);
    return null;
  }
  setFocus(p);
  saveLayout(cwd);
  renderSessionList();
  return p;
}

// 就地換掉窗格裡跑的程式（換帳號續跑、交給另一個 agent 接手、重新開啟）
async function restartPane(p, { kind = p.kind, sessionId = p.sessionId, profileId = p.profileId, prompt = null, name = p.name } = {}) {
  if (p.id) {
    paneByPty.delete(p.id);
    await api.kill(p.id);
  }
  Object.assign(p, { id: null, kind, sessionId, profileId, name, exited: false, context: null, limitHit: false, pendingMove: null });
  hideBanner(p);
  p.term.reset();
  renderPaneHead(p);
  renderPaneCtx(p);
  try {
    await startPty(p, { prompt });
  } catch (e) {
    toast(t('spawn.failed', { kind: kindLabel(p.kind), msg: errMsg(e) }), 'bad');
  }
  saveLayout(p.cwd);
  renderSessionList();
}

function removePane(p) {
  const w = S.workspaces.get(p.cwd);
  w.panes = w.panes.filter((x) => x !== p);
  if (p.max) w.el.classList.remove('has-max');
  p.ro && p.ro.disconnect();
  p.term && p.term.dispose();
  p.el.remove();
  if (S.focused === p) S.focused = null;
  w.builtOrder = null; // 強制重建列結構
  layoutGrid(w);
}

async function closePane(p) {
  if (p.id) {
    paneByPty.delete(p.id);
    await api.kill(p.id);
  }
  removePane(p);
  saveLayout(p.cwd);
  renderSessionList();
}

function saveLayout(cwd) {
  const w = S.workspaces.get(cwd);
  if (!w) return;
  api.saveLayout(
    cwd,
    w.panes.map((p) => ({
      kind: p.kind,
      sessionId: p.sessionId,
      profileId: p.profileId,
      ...(p.runCwd ? { runCwd: p.runCwd } : {}),
      ...(p.kind === 'shell' ? { name: p.name, codexProfileId: p.codexProfileId } : {}),
    })),
    w.savedSizes || null,
  );
}

// ---------------------------------------------------------------- 換帳號接力
// 一個帳號的額度用完時，把所有用這個帳號的窗格（不分專案）一次換到另一個還有額度的帳號：
// 結束舊程式、用新帳號 --resume 同一個 session，對話完整保留，不用在每個視窗裡打 /login。
// Claude Code 在啟動時決定帳號，執行中的程式換不了，所以「換帳號」一定是重新開啟同一個 session。

const OUT_PCT = 99; // 用量到這裡就當成用完
const FRESH_MS = 15 * 60_000; // 額度資料超過這個時間就不拿來判斷「還有額度」
const IDLE_MS = 3000; // 窗格這麼久沒有輸出就當成閒置（agent 工作中，畫面會一直更新）
const GRACE_MS = 20_000; // 換帳號剛開的窗格會重播舊對話（含舊的額度訊息），這段時間內只認額度資料

// 這個帳號目前的額度視窗（5 小時、每週…），讀不到時回傳 null。
// 判斷用完與否只用最近的資料；anyAge：顯示用，較舊的資料也可以
function quotaWindows(tool, id, { model = false, anyAge = false } = {}) {
  const u = S.usage && S.usage[tool] && S.usage[tool][id];
  if (!u) return null;
  const fresh = (at) => anyAge || (at && Date.now() - at < FRESH_MS);
  const wins = [];
  if (tool === 'codex') {
    if (fresh(u.observedAt)) wins.push(u.primary, u.secondary);
  } else {
    if (u.ok && fresh(u.fetchedAt)) wins.push(u.fiveHour, u.sevenDay, ...(model ? [u.sevenDayOpus, u.sevenDaySonnet] : []));
    if (u.live && fresh(u.live.at)) wins.push(u.live.fiveHour, u.live.sevenDay);
  }
  const known = wins.filter((w) => w && w.pct != null && !(w.resetsAt && w.resetsAt <= Date.now()));
  return known.length ? known : null;
}

// 'out'：確定用完；'ok'：確定還有；'unknown'：沒有最近的額度資料
function quotaState(tool, id, opts) {
  const wins = quotaWindows(tool, id, opts);
  if (!wins) return 'unknown';
  return wins.some((w) => w.pct >= OUT_PCT) ? 'out' : 'ok';
}

function quotaLeft(tool, id) {
  const wins = quotaWindows(tool, id);
  return wins ? Math.max(0, 100 - Math.max(...wins.map((w) => w.pct))) : null;
}

// 最早什麼時候恢復（用完的視窗裡最晚重置的那個）
function quotaReset(tool, id) {
  const wins = (quotaWindows(tool, id, { model: true }) || []).filter((w) => w.pct >= OUT_PCT && w.resetsAt);
  return wins.length ? Math.max(...wins.map((w) => w.resetsAt)) : null;
}

function signedIn(tool, p) {
  const a = p.account || {};
  if (tool === 'codex') return !!(a.email || a.apiKey || (S.usage && S.usage.codex && S.usage.codex[p.id]));
  const u = S.usage && S.usage.claude[p.id];
  return !!(a.email || (u && u.ok));
}

// 其他帳號：還有額度、已登入的排前面，剩最多的優先
function otherAccounts(tool, excludeId) {
  return accountsOf(tool)
    .filter((p) => p.id !== excludeId)
    .map((p) => {
      const st = quotaState(tool, p.id);
      return { profile: p, state: st, left: quotaLeft(tool, p.id), viable: st !== 'out' && signedIn(tool, p), note: usageNote(tool, p.id) };
    })
    .sort((a, b) => b.viable - a.viable || (b.left ?? -1) - (a.left ?? -1));
}

function bestAccount(tool, excludeId) {
  const o = otherAccounts(tool, excludeId)[0];
  return o && o.viable ? o.profile : null;
}

function usageNote(tool, id) {
  const wins = quotaWindows(tool, id, { anyAge: true });
  if (!wins) return t('limit.unknown');
  const u = S.usage[tool][id];
  const left = (w) => (w && w.pct != null ? Math.round(Math.max(0, 100 - w.pct)) : '–');
  const [five, week] = tool === 'codex' ? [u.primary, u.secondary] : [u.ok ? u.fiveHour : u.live && u.live.fiveHour, u.ok ? u.sevenDay : u.live && u.live.sevenDay];
  return t('usage.note', { a: left(five), b: left(week) });
}

// 用這個帳號、還在跑的窗格（所有專案）
function panesOn(tool, id) {
  return allPanes().filter((p) => p.kind === tool && p.profileId === id && !p.exited);
}

const isIdle = (p) => Date.now() - (p.lastData || 0) >= IDLE_MS;

function hideBanner(p) {
  const b = $('.pane-banner', p.el);
  b.hidden = true;
  b.innerHTML = '';
}

function paneBanner(p, msg, buttons = []) {
  const b = $('.pane-banner', p.el);
  b.innerHTML = `<span class="msg">${esc(msg)}</span>`;
  for (const btn of buttons) {
    const el = document.createElement('button');
    el.textContent = btn.label;
    if (btn.ghost) el.className = 'ghost';
    el.onclick = () => {
      hideBanner(p);
      btn.run();
    };
    b.appendChild(el);
  }
  b.hidden = false;
}

// 窗格輸出出現額度用完的訊息：先用額度資料確認，避免把畫面上剛好出現的文字當真
async function onLimitText(p) {
  if (p.kind !== 'claude' && p.kind !== 'codex') return;
  const tool = toolOf(p.kind);
  const ptyId = p.id;
  const account = p.profileId;
  const young = Date.now() - (p.startedAt || 0) < GRACE_MS;
  // 先標記：確認額度的這段時間裡，如果別的窗格已經把整個帳號換掉，這格換過去後要接著「繼續」
  if (!young) p.limitHit = true;
  await refreshUsage(true, { check: false });
  if (p.id !== ptyId) return; // 等待期間已經換帳號重開了
  const st = quotaState(tool, account, { model: true });
  // 資料顯示還有額度，或剛開啟時重播的舊訊息：不是真的用完，重新開始偵測
  if (st === 'ok' || (young && st !== 'out')) {
    p.limitHit = false;
    if (p.id) api.resetLimit(p.id);
    return;
  }
  p.limitHit = true; // 這格的回覆被額度打斷，換帳號後要叫它繼續
  if (p.pendingMove) return movePane(p, p.pendingMove);
  if (S.settings.fallback === 'off') return;
  accountOut(tool, account, { confirmed: st === 'out' });
}

// 帳號用完：自動模式直接換；詢問模式顯示提示列；讀不到額度時一律先問
function accountOut(tool, id, { confirmed }) {
  const target = bestAccount(tool, id);
  if (confirmed && S.settings.fallback === 'auto' && target) {
    toast(t('relay.auto', { tool: toolLabel(tool), from: profileName(accountOf(tool, id)), to: profileName(target) }));
    return moveAccount(tool, id, target.id);
  }
  showRelayBar(tool, id, { confirmed });
}

// 定期檢查（每次更新額度後）：有窗格在用、而且確定用完的帳號
function checkAccounts() {
  if (!S.usage || S.settings.fallback === 'off') return;
  for (const tool of ['claude', 'codex']) {
    for (const a of accountsOf(tool)) {
      if (quotaState(tool, a.id) !== 'out') continue;
      const key = `${tool}:${a.id}:${quotaReset(tool, a.id) || ''}`;
      if (S.handledOut.has(key)) continue;
      const open = panesOn(tool, a.id);
      if (open.length) {
        S.handledOut.add(key);
        accountOut(tool, a.id, { confirmed: true });
      } else if (a.id === activeOf(tool)) {
        // 沒有窗格在用，但它是新 session 會用的帳號：自動模式直接改用別的帳號，否則提醒一次
        S.handledOut.add(key);
        const alt = bestAccount(tool, a.id);
        const reset = fmtReset(quotaReset(tool, a.id));
        if (alt && S.settings.fallback === 'auto') {
          setActiveAccount(tool, alt.id).then(() => toast(t('relay.activeSwitched', { tool: toolLabel(tool), from: profileName(a), to: profileName(alt), t: reset }), 'ok', 9000));
        } else {
          toast(t('limit.toast', { name: `${toolLabel(tool)} · ${profileName(a)}`, t: reset || '–' }) + (alt ? `\n${t('limit.toastAlt', { alt: profileName(alt) })}` : ''), 'bad', 12000);
        }
      }
    }
  }
}

// 畫面上方的提示列：每個用完的帳號一列，一個按鈕把所有用它的窗格換到另一個帳號
function showRelayBar(tool, id, { confirmed }) {
  const holder = $('#relayBars');
  const barId = `relay-${tool}-${id}`;
  let bar = document.getElementById(barId);
  if (!bar) {
    bar = document.createElement('div');
    bar.id = barId;
    bar.className = 'relay-bar';
    holder.appendChild(bar);
  }
  const from = accountOf(tool, id);
  const n = panesOn(tool, id).length;
  const reset = fmtReset(quotaReset(tool, id));
  const msg = confirmed
    ? t('relay.out', { tool: toolLabel(tool), name: profileName(from), n, reset: reset ? t('relay.reset', { t: reset }) : '' })
    : t('relay.maybe', { tool: toolLabel(tool), name: profileName(from), n });
  bar.innerHTML = `<span class="msg">${esc(msg)}</span>`;
  const add = (label, run, cls = '') => {
    const b = document.createElement('button');
    b.textContent = label;
    b.className = cls;
    b.onclick = () => {
      bar.remove();
      run();
    };
    bar.appendChild(b);
  };
  const viable = otherAccounts(tool, id).filter((o) => o.viable);
  if (viable.length) {
    viable.slice(0, 3).forEach((o, i) => add(t('relay.move', { n, name: profileName(o.profile), note: o.note }), () => moveAccount(tool, id, o.profile.id), i === 0 ? 'primary' : ''));
  } else {
    bar.insertAdjacentHTML('beforeend', `<span class="sub">${esc(t('relay.none', { tool: toolLabel(tool) }))}</span>`);
    add(t('profile.add'), () => addProfileFlow(tool));
  }
  add(t('limit.ignore'), () => {
    for (const p of panesOn(tool, id)) if (p.id) api.resetLimit(p.id);
  }, 'ghost');
}

function hideRelayBar(tool, id) {
  const bar = document.getElementById(`relay-${tool}-${id}`);
  if (bar) bar.remove();
}

// 提示列佔用的高度，工作區往下讓出這麼多（窗格各自的 ResizeObserver 會重新 fit 終端機）
new ResizeObserver(() => document.documentElement.style.setProperty('--relay-h', `${$('#relayBars').offsetHeight}px`)).observe($('#relayBars'));

// 帳號已經沒有窗格在用（例如從窗格選單一個個換掉了）就收起它的提示列
function pruneRelayBars() {
  for (const tool of TOOLS) for (const a of accountsOf(tool)) if (!panesOn(tool, a.id).length) hideRelayBar(tool, a.id);
}

// 把一個帳號的所有窗格換到另一個帳號；新 session 也改用它
async function moveAccount(tool, fromId, toId) {
  hideRelayBar(tool, fromId);
  if (activeOf(tool) === fromId) await setActiveAccount(tool, toId);
  return movePanes(panesOn(tool, fromId), toId);
}

// 閒置或已經被額度打斷的窗格馬上換；還在工作的等它停下來（做完或也撞到額度）再換，不打斷進行中的工作
async function movePanes(list, toId) {
  let now = 0;
  let later = 0;
  const moving = [];
  for (const p of list) {
    if (!p.sessionId) continue; // Codex 新 session 還沒找到 id，沒辦法續跑
    if (p.limitHit || isIdle(p)) {
      now++;
      moving.push(movePane(p, toId));
    } else {
      later++;
      p.pendingMove = toId;
      const target = accountOf(toolOf(p.kind), toId);
      paneBanner(p, t('relay.pending', { name: profileName(target) }), [
        { label: t('relay.now'), run: () => movePane(p, toId) },
        { label: t('modal.cancel'), ghost: true, run: () => (p.pendingMove = null) },
      ]);
    }
  }
  if (now || later) {
    const to = profileName(accountOf(toolOf(list[0].kind), toId));
    toast(t('relay.done', { n: now, name: to }) + (later ? `\n${t('relay.later', { n: later })}` : ''), 'ok', 8000);
  }
  await Promise.all(moving);
  pruneRelayBars();
}

setInterval(() => {
  for (const p of allPanes()) {
    if (!p.pendingMove || p.exited || !(p.limitHit || isIdle(p))) continue;
    // 等待期間目標帳號也用完了：改選另一個，沒有就留在原帳號（提示列會說明）
    if (quotaState(toolOf(p.kind), p.pendingMove) === 'out') {
      const alt = bestAccount(toolOf(p.kind), p.profileId);
      if (!alt) {
        p.pendingMove = null;
        hideBanner(p);
        continue;
      }
      p.pendingMove = alt.id;
    }
    movePane(p, p.pendingMove).then(pruneRelayBars);
  }
}, 1000);

function continuePrompt() {
  return t('relay.continue');
}

// 換帳號續跑同一個 session。被額度打斷的窗格（設定開啟時）會附上「繼續」，接著做完被打斷的回覆
async function movePane(p, profileId) {
  if (p.moving) return; // 提示列、自動模式、等待中的窗格可能同時觸發，只換一次
  const tool = toolOf(p.kind);
  const target = accountOf(tool, profileId);
  const prompt = p.limitHit && S.settings.limitContinue !== false ? continuePrompt() : null;
  p.pendingMove = null;
  hideBanner(p);
  if (!p.sessionId) return toast(t('handoff.noId'), 'bad');
  p.moving = true;
  try {
    if (target.id !== 'default' && !target.shareHistory) {
      toast(t('switch.noHistory', { name: profileName(target) }));
      await handoff(p, p.kind, { inPlace: true, profileId, reason: 'switch-profile' });
    } else {
      await restartPane(p, { profileId, prompt });
    }
  } finally {
    p.moving = false;
  }
}

async function switchProfile(p, profileId) {
  toast(t('switch.started', { name: profileName(accountOf(toolOf(p.kind), profileId)), title: paneTitle(p) }), 'ok');
  await movePane(p, profileId);
}

async function handoff(p, toKind, { inPlace = false, profileId = null, reason = 'manual' } = {}) {
  if (!p.sessionId) return toast(t('handoff.noId'), 'bad');
  let r;
  try {
    r = await api.createHandoff({ paneId: p.id, fromKind: p.kind, toKind, sessionId: p.sessionId, cwd: p.cwd, sessionName: paneTitle(p), reason, lang: S.lang });
  } catch (e) {
    return toast(t('handoff.failed', { msg: errMsg(e) }), 'bad');
  }
  const name = toKind === p.kind ? paneTitle(p) : `${paneTitle(p).replace(/ → (Claude|Codex)$/, '')} → ${kindLabel(toKind)}`;
  // 換到另一個工具時，用那個工具目前的帳號
  const account = profileId || (toolOf(toKind) === toolOf(p.kind) ? p.profileId : activeOf(toolOf(toKind)));
  toast(t('handoff.started', { kind: kindLabel(toKind) }), 'ok');
  if (inPlace) await restartPane(p, { kind: toKind, sessionId: null, prompt: r.prompt, name, profileId: account });
  else await spawnPane({ kind: toKind, prompt: r.prompt, name, cwd: p.cwd, profileId: account });
}

function paneMenu(p) {
  const items = [];
  if (p.kind === 'claude' || p.kind === 'codex') {
    for (const o of otherAccounts(p.kind, p.profileId)) {
      items.push({
        html: `${esc(t('pane.continueWith', { name: profileName(o.profile) }))} <span class="sub">${esc(o.note)}</span>`,
        onClick: () => switchProfile(p, o.profile.id),
      });
    }
  }
  if (p.kind === 'claude') {
    items.push({ label: t('pane.toCodexNew'), onClick: () => handoff(p, 'codex') });
    items.push({ label: t('pane.toCodexHere'), onClick: () => handoff(p, 'codex', { inPlace: true }) });
  } else if (p.kind === 'codex') {
    items.push({ label: t('pane.toClaudeNew'), onClick: () => handoff(p, 'claude') });
    items.push({ label: t('pane.toClaudeHere'), onClick: () => handoff(p, 'claude', { inPlace: true }) });
  }
  if (items.length) items.push('-');
  items.push({ label: t('pane.restart'), onClick: () => restartPane(p) });
  items.push({ label: t('pane.rename'), onClick: () => startRename(p) });
  return items;
}

// ---------------------------------------------------------------- projects & sessions
async function openProject(cwd, { restore = true } = {}) {
  const info = await api.openProject(cwd);
  S.cwd = cwd;
  $('#projectName').textContent = basename(cwd);
  $('#projectBtn').title = cwd;
  document.title = `${basename(cwd)} — Multi-Agent CLI`;
  const existed = S.workspaces.has(cwd);
  const w = workspaceFor(cwd);
  if (!existed && info.sizes) w.savedSizes = info.sizes;
  for (const [k, x] of S.workspaces) x.el.hidden = k !== cwd;
  layoutGrid(w);
  await refreshSessions();
  if (!existed && restore && S.settings.autoRestore && info.panes.length) {
    for (const saved of info.panes) {
      if (saved.kind === 'shell') {
        await spawnPane({ kind: 'shell', name: saved.name || null, profileId: saved.profileId, codexProfileId: saved.codexProfileId || null, cwd });
        continue;
      }
      const s = findSession(saved.kind, saved.sessionId);
      await spawnPane({
        kind: saved.kind,
        sessionId: saved.sessionId,
        profileId: saved.profileId,
        name: s ? s.title : info.names[saved.sessionId],
        cwd,
        runCwd: saved.runCwd || (s && s.cwd) || null,
      });
    }
    toast(t('restore.done', { n: info.panes.length }), 'ok');
  }
  w.panes.forEach((p) => requestAnimationFrame(() => p.fit.fit()));
}

function findSession(kind, id) {
  return (S.sessions[kind] || []).find((s) => s.id === id);
}

async function refreshSessions() {
  if (!S.cwd) return;
  S.sessions = await api.listSessions(S.cwd);
  // 讓窗格標題跟上 session 名稱（例如 Claude 之後自動產生的標題或你在別處改的名字）
  for (const w of S.workspaces.values()) {
    for (const p of w.panes) {
      const s = p.cwd === S.cwd && p.sessionId && findSession(p.kind, p.sessionId);
      if (s && s.title && s.title !== p.name) {
        p.name = s.title;
        renderPaneHead(p);
      }
    }
  }
  renderSessionList();
}

function renderSessionList() {
  const list = $('#sessionList');
  const openIds = new Set((ws() ? ws().panes : []).map((p) => p.sessionId));
  $('#countClaude').textContent = S.sessions.claude.length || '';
  $('#countCodex').textContent = S.sessions.codex.length || '';
  const q = S.search.toLowerCase();
  const items = (S.sessions[S.tab] || []).filter(
    (s) => !q || `${s.title || ''} ${s.firstPrompt || ''} ${s.lastPrompt || ''} ${s.id}`.toLowerCase().includes(q),
  );
  list.innerHTML = items.length
    ? ''
    : `<li class="s-empty">${S.cwd ? t('side.noSessions') : t('side.noProject')}</li>`;
  for (const s of items) {
    const li = document.createElement('li');
    const open = openIds.has(s.id);
    li.className = open ? 'open' : '';
    li.title = `${sessionTitle(s)}\n${t('unit.messages', { n: s.messageCount })}${s.context ? ` · context ${s.context.pct.toFixed(0)}%` : ''}\n\n${t('session.first')}: ${
      s.firstPrompt || ''
    }\n${t('session.last')}: ${s.lastPrompt || ''}\n\n${s.cwd && S.cwd && s.cwd !== S.cwd ? `${s.cwd}\n` : ''}${s.id}`;
    li.innerHTML = `
      <div class="s-title"><span>${esc(sessionTitle(s))}</span>${open ? `<i class="dot" title="${esc(t('session.openNow'))}"></i>` : ''}${
        s.spawnedByAgent ? `<span class="tag sub" title="${esc(t('session.subagentTip'))}">${esc(t('session.subagent'))}</span>` : ''
      }</div>
      <div class="s-meta"><span>${fmtAgo(s.mtime)}</span>${s.context ? `<span class="sep">·</span>${bar(s.context.pct)}` : ''}</div>`;
    li.onclick = () => openSession(s);
    li.oncontextmenu = (e) => {
      e.preventDefault();
      showPopover(li, [
        { label: t('list.open'), onClick: () => openSession(s) },
        {
          label: t('list.rename'),
          onClick: async () => {
            const n = await promptModal(t('rename.session'), { value: sessionTitle(s) });
            if (n) {
              await api.setName(S.cwd, s.id, n, s.kind, activeOf(toolOf(s.kind)));
              refreshSessions();
            }
          },
        },
        { label: t('list.copyId'), onClick: () => api.clipboardWrite(s.id) },
      ]);
    };
    list.appendChild(li);
  }
}

// 側欄收起／展開。收起時滑鼠移上來會暫時浮出完整側欄（peek），移開後收回
function applySidebar() {
  const pinned = !!S.settings.sidebarPinned;
  $('#sidebar').classList.toggle('collapsed', !pinned);
  if (pinned) $('#sidebar').classList.remove('peek');
}

async function setSidebarPinned(pinned) {
  await saveSettings({ sidebarPinned: pinned });
  applySidebar();
}

function setupSidebarPeek() {
  const sb = $('#sidebar');
  let timer;
  const busy = () => document.activeElement === $('#search') || S.search || !$('#popover').hidden || !$('#modal').hidden;
  sb.addEventListener('mouseenter', () => {
    clearTimeout(timer);
    if (sb.classList.contains('collapsed')) timer = setTimeout(() => sb.classList.add('peek'), 120);
  });
  sb.addEventListener('mouseleave', () => {
    clearTimeout(timer);
    const close = () => {
      if (busy()) timer = setTimeout(close, 600);
      else sb.classList.remove('peek');
    };
    timer = setTimeout(close, 350);
  });
}

function openSession(s) {
  $('#sidebar').classList.remove('peek');
  const w = ws();
  const existing = w && w.panes.find((p) => p.sessionId === s.id);
  if (existing) return setFocus(existing);
  spawnPane({ kind: s.kind, sessionId: s.id, name: s.title || null, runCwd: s.cwd || null });
}

async function newSession(kind) {
  if (!S.cwd) return pickProject();
  const shell = kind === 'shell';
  const name = await promptModal(t(shell ? 'new.shellTitle' : 'new.title', { kind: kindLabel(kind) }), {
    placeholder: t(shell ? 'new.shellPlaceholder' : 'new.placeholder'),
    hint: t('new.hint'),
  });
  if (name === null) return;
  spawnPane({ kind, name: name || null });
}

async function pickProject() {
  const dir = await api.pickProject();
  if (dir) openProject(dir);
}

async function showProjectMenu(anchor) {
  const projects = await api.listProjects();
  const items = projects.slice(0, 15).map((p) => ({
    active: p.cwd === S.cwd,
    html: `<div><div>${esc(basename(p.cwd))}</div><div class="sub">${esc(p.cwd)}${p.sessionCount ? ` · ${esc(t('project.sessions', { n: p.sessionCount }))}` : ''}</div></div>`,
    onClick: () => openProject(p.cwd),
  }));
  items.push('-', { label: t('project.other'), onClick: pickProject });
  showPopover(anchor, items);
}

async function renderRecent() {
  const projects = await api.listProjects();
  $('#recentList').innerHTML = '';
  for (const p of projects.slice(0, 8)) {
    const li = document.createElement('li');
    li.innerHTML = `<span class="r-name">${esc(basename(p.cwd))}</span><span class="sub">${esc(p.cwd)}</span>`;
    li.onclick = () => openProject(p.cwd);
    $('#recentList').appendChild(li);
  }
}

// ---------------------------------------------------------------- accounts
// Claude 與 Codex 的帳號分開：上方兩個帳號按鈕各管各的清單、登入和目前帳號
const TOOLS = ['claude', 'codex'];

async function reloadProfiles() {
  S.accounts = await api.listProfiles();
  renderAccount();
  for (const w of S.workspaces.values()) w.panes.forEach(renderPaneHead);
}

function renderAccount() {
  for (const tool of TOOLS) {
    const btn = $(`#${tool}AccountBtn`);
    const p = accountOf(tool, activeOf(tool));
    const email = p && p.account && p.account.email;
    $('.avatar', btn).textContent = initials(p);
    $('.acc-name', btn).textContent = email ? `${profileName(p)} · ${email}` : profileName(p);
    btn.title = t('profile.menuTip', { tool: toolLabel(tool) });
  }
}

async function setActiveAccount(tool, id) {
  S.accounts = await api.setActiveProfile(tool, id);
  renderAccount();
  for (const w of S.workspaces.values()) w.panes.forEach(renderPaneHead);
  refreshSessions();
  renderDashboard();
}

// 開著、可以換帳號續跑的窗格（不分專案）
function movablePanes(tool, exceptId) {
  return allPanes().filter((p) => p.kind === tool && p.profileId !== exceptId && !p.exited && p.sessionId);
}

// 從帳號選單選了另一個帳號：之後新開的 session 用它；有窗格在用別的帳號時，問要不要一起換過去
async function chooseAccount(tool, id) {
  await setActiveAccount(tool, id);
  const name = profileName(accountOf(tool, id));
  const others = movablePanes(tool, id);
  if (!others.length) return toast(t('profile.switched', { name }), 'ok');
  const move = await modal(
    `<h3>${esc(t('move.title', { tool: toolLabel(tool), name }))}</h3><div class="hint">${esc(t('move.hint', { n: others.length, name }))}</div>
     <div class="actions"><button id="mCancel">${esc(t('move.onlyNew'))}</button><button id="mOk" class="primary">${esc(t('move.submit', { n: others.length }))}</button></div>`,
    (card, close) => {
      $('#mCancel', card).onclick = () => close(false);
      $('#mOk', card).onclick = () => close(true);
    },
  );
  if (move) movePanes(others, id);
  else toast(t('profile.switched', { name }), 'ok');
}

function accountNote(tool, p) {
  if (!signedIn(tool, p)) return '';
  const u = S.usage && S.usage[tool] && S.usage[tool][p.id];
  if (tool === 'claude' && u && !u.ok && u.reason !== 'no-credentials' && !quotaWindows(tool, p.id)) return t(`usage.reason.${u.reason}`);
  return usageNote(tool, p.id);
}

function showAccountMenu(tool, anchor) {
  const active = activeOf(tool);
  const items = accountsOf(tool).map((p) => {
    const note = accountNote(tool, p);
    return {
      active: p.id === active,
      html: `<span class="avatar">${esc(initials(p))}</span><div style="flex:1"><div>${esc(profileName(p))}${p.id === active ? ' ✓' : ''}</div><div class="sub">${esc(
        (p.account && (p.account.email || (p.account.apiKey && 'API key'))) || t('profile.notLoggedIn'),
      )}${note ? ` · ${esc(note)}` : ''}</div></div>`,
      onClick: () => chooseAccount(tool, p.id),
    };
  });
  const cur = accountOf(tool, active);
  items.push(
    '-',
    { label: t('profile.login', { name: profileName(cur) }), onClick: () => loginModal(tool, cur) },
    { label: t('profile.add'), onClick: () => addProfileFlow(tool) },
    { label: t('profile.rename', { name: profileName(cur) }), onClick: () => renameProfileFlow(tool) },
  );
  if (cur.id !== 'default') items.push({ label: t('profile.remove', { name: profileName(cur) }), onClick: () => removeProfileFlow(tool) });
  const others = movablePanes(tool, cur.id);
  if (others.length) items.push({ label: t('profile.moveHere', { n: others.length, name: profileName(cur) }), onClick: () => movePanes(others, cur.id) });
  items.push('-', tool === 'claude' ? { label: t('profile.installMcp'), onClick: installMcp } : { label: t('profile.installBridge'), onClick: installBridge });
  showPopover(anchor, items);
}

const ANSI_RE = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07]*(\x07|\x1b\\)|\x1b[@-_]/g;

// 在 modal 裡開一個小終端機跑 `claude auth login`（或 `codex login`），完成後自動關閉
function loginModal(tool, profile) {
  const claude = tool === 'claude';
  return modal(
    `<h3>${esc(t(claude ? 'login.claude' : 'login.codex', { name: profileName(profile) }))}</h3>
     <div class="hint">${esc(t(claude ? 'login.hint' : 'login.hintCodex'))}</div>
     <div id="loginTerm" class="login-term"></div>
     ${
       claude
         ? `<div class="login-code"><input id="loginCode" placeholder="${esc(t('login.codePlaceholder'))}" /><button id="loginSend">${esc(t('login.codeSubmit'))}</button></div>`
         : ''
     }
     <div class="actions"><button id="mClose">${esc(t('modal.close'))}</button></div>`,
    async (card, close) => {
      const holder = { id: null, onExit: null };
      // 變數不要取名 t：會蓋掉翻譯函式 t()，登入結束時呼叫 t('login.done') 就會出錯、視窗關不掉
      const tm = makeTerminal($('#loginTerm', card), () => holder.id, { plainPaste: true });
      let finished = false;
      let enterTimer = null;
      // 從瀏覽器授權完回來時，鍵盤焦點常常不在這個小終端機上
      const refocus = () => tm.term.focus();
      const finish = async () => {
        if (finished) return;
        finished = true;
        window.removeEventListener('focus', refocus);
        clearTimeout(enterTimer);
        if (holder.id) {
          paneByPty.delete(holder.id);
          api.kill(holder.id);
        }
        tm.ro.disconnect();
        tm.term.dispose();
        close();
        await reloadProfiles();
        refreshUsage(true);
      };
      window.addEventListener('focus', refocus);
      $('#mClose', card).onclick = finish;
      // 瀏覽器沒有自動導回、而是顯示一串授權碼時：貼在這裡送出（等同在終端機的 Paste code here 輸入）
      const code = $('#loginCode', card);
      if (code) {
        const submit = () => {
          const v = code.value.trim();
          if (!v || !holder.id) return;
          api.write(holder.id, v);
          setTimeout(() => holder.id && api.write(holder.id, '\r'), 150);
          code.value = '';
          tm.term.focus();
        };
        $('#loginSend', card).onclick = submit;
        code.onkeydown = (e) => {
          if (e.key === 'Enter') submit();
        };
      }
      let tail = '';
      Object.assign(holder, tm, {
        // 登入成功後如果停在「Press Enter to continue」，替使用者按一下；程式自己結束的話就不會用到
        onData: (d) => {
          tail = (tail + d.replace(ANSI_RE, '')).slice(-2000);
          if (!enterTimer && /Login successful|Successfully logged in/i.test(tail)) enterTimer = setTimeout(() => holder.id && api.write(holder.id, '\r'), 1500);
        },
        onExit: (exitCode) => {
          toast(exitCode === 0 ? t('login.done') : t('login.exit', { code: exitCode }), exitCode === 0 ? 'ok' : 'bad');
          finish();
        },
      });
      try {
        tm.fit.fit();
        const r = await api.spawnPane({ kind: claude ? 'login' : 'codex-login', cwd: S.cwd || undefined, profileId: profile.id, cols: tm.term.cols, rows: tm.term.rows });
        holder.id = r.paneId;
        paneByPty.set(r.paneId, holder);
        const buffered = pendingData.get(r.paneId);
        if (buffered) {
          pendingData.delete(r.paneId);
          tm.term.write(buffered);
          holder.onData(buffered);
        }
        tm.term.focus();
      } catch (e) {
        toast(t('login.failed', { msg: errMsg(e) }), 'bad');
      }
    },
  );
}

async function addProfileFlow(tool = 'claude') {
  const res = await modal(
    `<h3>${esc(t('add.title', { tool: toolLabel(tool) }))}</h3>
     <div class="field"><label>${esc(t('add.name'))}</label><input id="pName" placeholder="${esc(t('add.namePlaceholder'))}" /></div>
     <label class="field check"><input type="checkbox" id="pShare" checked /> ${esc(t(tool === 'codex' ? 'add.shareCodex' : 'add.share'))}</label>
     <div class="hint">${esc(t(tool === 'codex' ? 'add.hintCodex' : 'add.hintClaude'))}</div>
     <div class="actions"><button id="mCancel">${esc(t('modal.cancel'))}</button><button id="mOk" class="primary">${esc(t('add.submit'))}</button></div>`,
    (card, close) => {
      $('#pName', card).focus();
      $('#mCancel', card).onclick = () => close(null);
      $('#mOk', card).onclick = () => close({ name: $('#pName', card).value.trim() || t('add.defaultName'), shareHistory: $('#pShare', card).checked });
    },
  );
  if (!res) return;
  const p = await api.addProfile(tool, res.name, { shareHistory: res.shareHistory });
  await reloadProfiles();
  loginModal(tool, { ...p, account: {} });
}

async function renameProfileFlow(tool) {
  const cur = accountOf(tool, activeOf(tool));
  const n = await promptModal(t('rename.profile'), { value: profileName(cur) });
  if (n) {
    await api.renameProfile(tool, cur.id, n);
    reloadProfiles();
  }
}

async function removeProfileFlow(tool) {
  const cur = accountOf(tool, activeOf(tool));
  const ok = await modal(
    `<h3>${esc(t('remove.title', { name: `${toolLabel(tool)} · ${profileName(cur)}` }))}</h3><div class="hint">${esc(t('remove.hint'))}</div>
     <div class="actions"><button id="mCancel">${esc(t('modal.cancel'))}</button><button id="mOk" class="primary">${esc(t('remove.submit'))}</button></div>`,
    (card, close) => {
      $('#mCancel', card).onclick = () => close(false);
      $('#mOk', card).onclick = () => close(true);
    },
  );
  if (!ok) return;
  await api.removeProfile(tool, cur.id);
  reloadProfiles();
}

async function installBridge() {
  toast(t('bridge.installing'));
  const r = await api.installBridge(activeOf('codex'));
  toast(r.ok ? t('bridge.installed', { out: r.output }) : t('mcp.failed', { out: r.output }), r.ok ? 'ok' : 'bad', 9000);
}

async function installMcp() {
  toast(t('mcp.running'));
  const r = await api.installCodexMcp(activeOf('claude'));
  toast(r.ok ? t('mcp.ok', { out: r.output }) : t('mcp.failed', { out: r.output }), r.ok ? 'ok' : 'bad', 9000);
}

// ---------------------------------------------------------------- usage & context dashboard
// check：更新完後檢查有沒有帳號用完（onLimitText 自己會判斷，不需要再檢查一次）
async function refreshUsage(force = false, { check = true } = {}) {
  try {
    S.usage = await api.getUsage({ force });
  } catch {
    return;
  }
  renderDashboard();
  if (check) checkAccounts();
}

function codexWindows(rl) {
  if (!rl) return [];
  return [rl.primary, rl.secondary].filter(Boolean).map((w) => ({
    week: !!(w.windowMinutes && w.windowMinutes > 1440),
    label: w.windowMinutes && w.windowMinutes > 1440 ? t('usage.week') : w.windowMinutes ? `${Math.round(w.windowMinutes / 60)}h` : '?',
    ...w,
  }));
}

// 剩餘額度的顏色：剩 50% 以上綠、20–50% 黃、20% 以下紅（跟是哪個工具無關）
const leftClass = (left) => (left < 20 ? 'bad' : left < 50 ? 'warn' : '');

// 一列額度（顯示剩餘）：標籤、進度條、剩餘百分比；重置倒數在下一行，對齊進度條
function usageRow(label, w) {
  if (!w || w.pct == null) return '';
  const left = Math.max(0, Math.min(100, 100 - w.pct));
  const reset = fmtReset(w.resetsAt);
  return `<div class="urow"><span class="label">${esc(label)}</span><div class="bar ${leftClass(left)}"><i style="width:${left}%"></i></div><span class="val">${esc(
    t('usage.left', { n: Math.round(left) }),
  )}</span>${reset ? `<span class="reset">${esc(t('reset.in', { t: reset }))}</span>` : ''}</div>`;
}

function renderDashboard() {
  if ($('#dashboard').hidden) return;
  let html = '';
  for (const p of accountsOf('claude')) {
    const u = S.usage && S.usage.claude[p.id];
    html += `<div class="dsec"><div class="head"><span class="name">Claude · ${esc(profileName(p))}</span>${p.id === activeOf('claude') ? '<span class="sub">✓</span>' : ''}</div>
      <div class="sub">${esc((p.account && p.account.email) || t('profile.notLoggedIn'))}${u && u.plan ? ` · ${esc(u.plan)}` : ''}</div>`;
    if (u && u.ok)
      html +=
        usageRow(t('usage.5hLong'), u.fiveHour) + usageRow(t('usage.weekLong'), u.sevenDay) + usageRow(t('usage.weekOpus'), u.sevenDayOpus) + usageRow(t('usage.weekSonnet'), u.sevenDaySonnet);
    else if (!u || u.reason !== 'no-credentials') html += `<div class="sub">${esc(u ? t(`usage.reason.${u.reason}`) : t('usage.loading'))}</div>`;
    html += '</div>';
  }
  for (const p of accountsOf('codex')) {
    const rl = S.usage && S.usage.codex && S.usage.codex[p.id];
    const cw = codexWindows(rl);
    const a = p.account || {};
    const who = a.email || (a.apiKey ? 'API key' : t('profile.notLoggedIn'));
    html += `<div class="dsec"><div class="head"><span class="name">Codex · ${esc(profileName(p))}</span>${p.id === activeOf('codex') ? '<span class="sub">✓</span>' : ''}</div>
      <div class="sub">${esc(who)}${a.plan ? ` · ${esc(a.plan)}` : ''}</div>`;
    html += cw.length
      ? cw.map((w) => usageRow(w.week ? t('usage.weekLong') : w.label === '5h' ? t('usage.5hLong') : w.label, w)).join('') +
        `<div class="sub">${esc(t('usage.codexAt', { t: rl.observedAt ? fmtAgo(rl.observedAt) : '–' }))}</div>`
      : `<div class="sub">${esc(t('usage.codexEmpty'))}</div>`;
    html += '</div>';
  }
  html += `<button id="refreshUsage" class="ghost">${esc(t('usage.refresh'))}</button>`;
  $('#dashUsage').innerHTML = html;
  $('#refreshUsage').onclick = () => refreshUsage(true);

  let ctx = '';
  for (const [cwd, w] of S.workspaces) {
    if (!w.panes.some((x) => x.kind !== 'shell')) continue;
    ctx += `<div class="sub group">${esc(basename(cwd))}</div>`;
    for (const p of w.panes.filter((x) => x.kind !== 'shell')) {
      const c = p.context;
      ctx += `<div class="dsec ctx-item"><div class="head"><span class="name ellipsis">${esc(paneTitle(p))}</span><span class="val">${
        c ? Math.round(c.pct) + '%' : '–'
      }</span></div>${bar(c ? c.pct : 0)}<div class="reset">${c ? `${fmtTokens(c.tokens)} / ${fmtTokens(c.window)}` : ''}</div></div>`;
    }
  }
  $('#dashContext').innerHTML = ctx || `<div class="sub">${esc(t('dash.noOpen'))}</div>`;

  renderSettings();
}

function opt(value, label, current) {
  return `<option value="${esc(value)}" ${String(current) === String(value) ? 'selected' : ''}>${esc(label)}</option>`;
}

function renderSettings() {
  const st = S.settings;
  $('#dashAppearance').innerHTML = `
    <label>${esc(t('set.theme'))}<select id="setTheme">${Object.entries(THEMES)
      .map(([id, th]) => opt(id, th.label[S.lang] || th.label.en, st.theme || 'terminal'))
      .join('')}</select></label>
    <label>${esc(t('set.lang'))}<select id="setLang">${opt('en', I18N.en['lang.name'], S.lang)}${opt('zh-Hant', I18N['zh-Hant']['lang.name'], S.lang)}</select></label>
    <label>${esc(t('set.fontSize'))}<select id="setFontSize">${[11, 12, 13, 14, 15, 16].map((n) => opt(n, `${n}px`, st.fontSize || 13)).join('')}</select></label>
    <label>${esc(t('set.font'))}<input id="setFont" value="${esc(st.fontFamily || '')}" placeholder="${esc(t('set.fontPlaceholder'))}" /></label>`;
  $('#dashSettings').innerHTML = `
    <label>${esc(t('set.openAtLogin'))}<input type="checkbox" id="setLogin" ${st.openAtLogin ? 'checked' : ''}></label>
    <label>${esc(t('set.restore'))}<input type="checkbox" id="setRestore" ${st.autoRestore ? 'checked' : ''}></label>
    <label title="${esc(t('set.bridgeConfirmHint'))}">${esc(t('set.bridgeConfirm'))}<input type="checkbox" id="setBridgeConfirm" ${st.bridgeConfirm !== false ? 'checked' : ''}></label>
    <label title="${esc(t('set.fallbackHint'))}">${esc(t('set.fallback'))}<select id="setFallback">${opt('ask', t('set.fallback.ask'), st.fallback)}${opt(
      'auto',
      t('set.fallback.auto'),
      st.fallback,
    )}${opt('off', t('set.fallback.off'), st.fallback)}</select></label>
    <label title="${esc(t('set.limitContinueHint'))}">${esc(t('set.limitContinue'))}<input type="checkbox" id="setLimitContinue" ${st.limitContinue !== false ? 'checked' : ''}></label>`;
  $('#setTheme').onchange = async (e) => {
    await saveSettings({ theme: e.target.value, windowBg: THEMES[e.target.value].ui.bg });
    applyTheme();
  };
  $('#setLang').onchange = (e) => setLang(e.target.value);
  $('#setFontSize').onchange = async (e) => {
    await saveSettings({ fontSize: Number(e.target.value) });
    applyTheme();
  };
  $('#setFont').onchange = async (e) => {
    await saveSettings({ fontFamily: e.target.value.trim() });
    applyTheme();
  };
  $('#setLogin').onchange = (e) => saveSettings({ openAtLogin: e.target.checked });
  $('#setRestore').onchange = (e) => saveSettings({ autoRestore: e.target.checked });
  $('#setBridgeConfirm').onchange = (e) => saveSettings({ bridgeConfirm: e.target.checked });
  $('#setFallback').onchange = (e) => saveSettings({ fallback: e.target.value });
  $('#setLimitContinue').onchange = (e) => saveSettings({ limitContinue: e.target.checked });
}

async function setLang(lang) {
  S.lang = lang;
  await saveSettings({ lang });
  applyLang();
}

async function saveSettings(patch) {
  S.settings = await api.setSettings(patch);
}

async function pollContext() {
  const all = [...S.workspaces.values()].flatMap((w) => w.panes).filter((p) => p.sessionId);
  if (!all.length) return;
  const res = await api.getContext(all.map((p) => ({ kind: p.kind, sessionId: p.sessionId, cwd: p.cwd, profileId: p.profileId, paneId: p.id })));
  for (const p of all) {
    if (res[p.sessionId] !== undefined) {
      p.context = res[p.sessionId];
      renderPaneCtx(p);
    }
  }
  renderDashboard();
}

// ---------------------------------------------------------------- boot
async function boot() {
  const init = await api.init();
  Object.assign(S, {
    platform: init.platform,
    maxPanes: init.maxPanes,
    accounts: init.accounts,
    settings: init.settings,
  });
  S.lang = init.settings.lang || detectLang();
  applyTheme();
  applyLang();

  $('#projectBtn').onclick = (e) => {
    e.stopPropagation();
    showProjectMenu(e.currentTarget);
  };
  for (const tool of TOOLS) {
    $(`#${tool}AccountBtn`).onclick = (e) => {
      e.stopPropagation();
      showAccountMenu(tool, e.currentTarget);
    };
  }
  $('#dashBtn').onclick = () => {
    $('#dashboard').hidden = !$('#dashboard').hidden;
    renderDashboard();
  };
  $('#emptyPick').onclick = pickProject;
  // 視窗縮放、開關儀表板時重新計算版面（各終端機再由自己的 ResizeObserver 重新 fit）
  let relayoutTimer;
  new ResizeObserver(() => {
    clearTimeout(relayoutTimer);
    relayoutTimer = setTimeout(() => {
      const w = ws();
      if (w) layoutGrid(w);
    }, 50);
  }).observe($('#workspaces'));
  $('#newClaude').onclick = () => newSession('claude');
  $('#newCodex').onclick = () => newSession('codex');
  $('#newShell').onclick = () => newSession('shell');
  $('#railExpand').onclick = () => setSidebarPinned(true);
  $('#sideCollapse').onclick = () => setSidebarPinned(false);
  setupSidebarPeek();
  applySidebar();
  $('#refreshList').onclick = async () => {
    const btn = $('#refreshList');
    btn.classList.add('spinning');
    await refreshSessions();
    setTimeout(() => btn.classList.remove('spinning'), 400);
  };
  $('#search').oninput = (e) => {
    S.search = e.target.value;
    renderSessionList();
  };
  document.querySelectorAll('.tab').forEach((t) => {
    t.onclick = () => {
      S.tab = t.dataset.tab;
      document.querySelectorAll('.tab').forEach((x) => x.classList.toggle('active', x === t));
      renderSessionList();
    };
  });
  window.addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && /^[1-6]$/.test(e.key)) focusPaneIndex(Number(e.key) - 1);
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'b') {
      e.preventDefault();
      setSidebarPinned(!S.settings.sidebarPinned);
    }
  });
  window.addEventListener('focus', refreshSessions);

  renderRecent();
  if (init.lastProject) await openProject(init.lastProject);
  else layoutGrid({ el: document.createElement('div'), panes: [] });

  refreshUsage();
  setInterval(pollContext, 4000);
  setInterval(refreshSessions, 30_000);
  setInterval(() => refreshUsage(), (S.settings.usageRefreshSec || 120) * 1000);
  setInterval(renderDashboard, 60_000); // 更新重置倒數
}

boot();

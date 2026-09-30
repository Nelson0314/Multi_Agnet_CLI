'use strict';
/* global Terminal, FitAddon, api, I18N, THEMES, terminalFont, nativeAnsi -- api 由 preload 注入；I18N、THEMES 來自 i18n.js、themes.js */
const $ = (sel, root = document) => root.querySelector(sel);

const S = {
  maxPanes: 6,
  platform: 'darwin',
  profiles: [],
  activeProfile: 'default',
  settings: {},
  cwd: null,
  workspaces: new Map(), // cwd -> { el, panes: [] }
  sessions: { claude: [], codex: [] },
  tab: 'claude',
  search: '',
  usage: null,
  focused: null,
  warnedLimit: new Set(),
  lang: 'en',
};
const paneByPty = new Map();
const pendingData = new Map();

// ---------------------------------------------------------------- helpers
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const basename = (p) => (p || '').split(/[\\/]/).filter(Boolean).pop() || p;
const shellLabel = () => (S.platform === 'win32' ? 'PowerShell' : 'Shell');
const kindLabel = (k) => (k === 'codex' ? 'Codex' : k === 'shell' ? shellLabel() : 'Claude');
const profileOf = (id) => S.profiles.find((p) => p.id === id) || S.profiles[0];

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
  const s = (p.account && p.account.email) || profileName(p) || '?';
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
function makeTerminal(container, getPtyId) {
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
    if (mod && k === 'v') {
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
  if (p) p.term.write(data);
  else pendingData.set(id, (pendingData.get(id) || '') + data);
});
api.onExit((id, code) => {
  const p = paneByPty.get(id);
  if (!p) return;
  if (p.onExit) return p.onExit(code);
  p.exited = true;
  p.el.classList.add('exited');
  p.term.write(`\r\n\x1b[90m${t('pane.exited', { code })}\x1b[0m\r\n`);
});
api.onLimit((id, text) => {
  const p = paneByPty.get(id);
  if (p) handleLimit(p, text);
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

function layoutGrid(w) {
  const n = w.panes.length;
  const host = $('#workspaces');
  if (n) {
    const { cols, rows, last } = bestGrid(n, host.clientWidth || 1600, host.clientHeight || 900);
    const L = (cols * last) / gcd(cols, last); // 欄數取最小公倍數，讓整列與最後一列都能平均分
    w.el.style.gridTemplateColumns = `repeat(${L}, minmax(0, 1fr))`;
    w.el.style.gridTemplateRows = `repeat(${rows}, minmax(0, 1fr))`;
    w.panes.forEach((p, i) => {
      p.el.style.gridColumn = `span ${i < n - last ? L / cols : L / last}`;
    });
  }
  w.panes.forEach((p, i) => ($('.pane-idx', p.el).textContent = `${i + 1}`));
  $('#empty').hidden = !!S.cwd;
  $('#paneCount').textContent = t('side.open', { n, max: S.maxPanes });
}

function paneTitle(p) {
  if (p.kind === 'shell') return p.name || shellLabel();
  return p.name || t('session.new', { kind: kindLabel(p.kind) });
}

function renderPaneHead(p) {
  const prof = profileOf(p.profileId);
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
  pt.hidden = p.kind !== 'claude' || S.profiles.length < 2;
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

function createPaneEl(p) {
  const el = document.createElement('div');
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
    name: p.sessionId ? undefined : p.name,
    prompt,
    cols: p.term.cols,
    rows: p.term.rows,
  });
  p.id = r.paneId;
  p.sessionId = r.sessionId || p.sessionId;
  p.profileId = r.profileId;
  paneByPty.set(p.id, p);
  const buffered = pendingData.get(p.id);
  if (buffered) {
    p.term.write(buffered);
    pendingData.delete(p.id);
  }
}

// cwd：窗格屬於哪個專案；runCwd：程式實際執行的資料夾（子資料夾或 worktree 裡的 session 要在原本的位置續跑）
async function spawnPane({ kind, sessionId = null, name = null, prompt = null, profileId = null, cwd = S.cwd, runCwd = null }) {
  const w = workspaceFor(cwd);
  if (w.panes.length >= S.maxPanes) {
    toast(t('err.E_MAX_PANES', { max: S.maxPanes }), 'bad');
    return null;
  }
  const p = { id: null, kind, cwd, runCwd, sessionId, name, profileId: profileId || S.activeProfile, context: null, exited: false, max: false };
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
  Object.assign(p, { id: null, kind, sessionId, profileId, name, exited: false, context: null });
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
      ...(p.kind === 'shell' ? { name: p.name } : {}),
    })),
  );
}

// ---------------------------------------------------------------- fallback / handoff
function otherProfileOptions(p) {
  return S.profiles
    .filter((x) => x.id !== p.profileId)
    .map((x) => {
      const u = S.usage && S.usage.claude[x.id];
      const ok = u && u.ok;
      const exhausted = ok && ((u.fiveHour && u.fiveHour.pct >= 100) || (u.sevenDay && u.sevenDay.pct >= 100));
      const note = ok ? usageNote(u) : t('limit.unknown');
      return { profile: x, viable: !exhausted && (ok || (x.account && x.account.email)), note };
    });
}

function usageNote(u) {
  return `${t('usage.5h')} ${Math.round(u.fiveHour ? u.fiveHour.pct : 0)}% · ${t('usage.week')} ${Math.round(u.sevenDay ? u.sevenDay.pct : 0)}%`;
}

function fallbackActions(p) {
  const acts = [];
  if (p.kind === 'claude') {
    for (const o of otherProfileOptions(p)) {
      if (!o.viable) continue;
      acts.push({
        type: 'other-profile',
        label: t('limit.otherProfile', { name: profileName(o.profile), note: o.note }),
        run: () => switchProfile(p, o.profile.id),
      });
    }
    acts.push({ type: 'codex', label: t('limit.toCodex'), run: () => handoff(p, 'codex', { inPlace: true, reason: 'claude-limit' }) });
  } else if (p.kind === 'codex') {
    acts.push({ type: 'claude', label: t('limit.toClaude'), run: () => handoff(p, 'claude', { inPlace: true, reason: 'codex-limit' }) });
  }
  const order = S.settings.fallbackOrder || ['other-profile', 'codex'];
  return acts.sort((a, b) => order.indexOf(a.type) - order.indexOf(b.type));
}

function hideBanner(p) {
  const b = $('.pane-banner', p.el);
  b.hidden = true;
  b.innerHTML = '';
}

function handleLimit(p, text) {
  if (p.kind === 'shell') return;
  refreshUsage(true);
  if (S.settings.fallback === 'off') return;
  const acts = fallbackActions(p);
  if (S.settings.fallback === 'auto' && acts.length) {
    toast(t('limit.auto', { name: paneTitle(p), action: acts[0].label }));
    acts[0].run();
    return;
  }
  const b = $('.pane-banner', p.el);
  b.innerHTML = `<span class="msg">${esc(t('limit.banner', { kind: kindLabel(p.kind) }))}</span>`;
  for (const a of acts) {
    const btn = document.createElement('button');
    btn.textContent = a.label;
    btn.onclick = () => {
      hideBanner(p);
      a.run();
    };
    b.appendChild(btn);
  }
  const ig = document.createElement('button');
  ig.className = 'ghost';
  ig.textContent = t('limit.ignore');
  ig.onclick = () => {
    hideBanner(p);
    if (p.id) api.resetLimit(p.id);
  };
  b.appendChild(ig);
  b.hidden = false;
}

async function switchProfile(p, profileId) {
  const target = profileOf(profileId);
  if (!p.sessionId) return toast(t('handoff.noId'), 'bad');
  if (target.id !== 'default' && !target.shareHistory) {
    toast(t('switch.noHistory', { name: profileName(target) }));
    return handoff(p, 'claude', { inPlace: true, profileId, reason: 'switch-profile' });
  }
  toast(t('switch.started', { name: profileName(target), title: paneTitle(p) }), 'ok');
  await restartPane(p, { profileId });
}

async function handoff(p, toKind, { inPlace = false, profileId = null, reason = 'manual' } = {}) {
  if (!p.sessionId) return toast(t('handoff.noId'), 'bad');
  let r;
  try {
    r = await api.createHandoff({ paneId: p.id, fromKind: p.kind, toKind, sessionId: p.sessionId, cwd: p.cwd, sessionName: paneTitle(p), reason, lang: S.lang });
  } catch (e) {
    return toast(t('handoff.failed', { msg: errMsg(e) }), 'bad');
  }
  const name = `${paneTitle(p).replace(/ → (Claude|Codex)$/, '')} → ${kindLabel(toKind)}`;
  toast(t('handoff.started', { kind: kindLabel(toKind) }), 'ok');
  if (inPlace) await restartPane(p, { kind: toKind, sessionId: null, prompt: r.prompt, name, profileId: profileId || p.profileId });
  else await spawnPane({ kind: toKind, prompt: r.prompt, name, cwd: p.cwd, profileId });
}

function paneMenu(p) {
  const items = [];
  if (p.kind === 'claude') {
    for (const o of otherProfileOptions(p)) {
      items.push({
        html: `${esc(t('pane.continueWith', { name: profileName(o.profile) }))} <span class="sub">${esc(o.note)}</span>`,
        onClick: () => switchProfile(p, o.profile.id),
      });
    }
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
  for (const [k, x] of S.workspaces) x.el.hidden = k !== cwd;
  layoutGrid(w);
  await refreshSessions();
  if (!existed && restore && S.settings.autoRestore && info.panes.length) {
    for (const saved of info.panes) {
      if (saved.kind === 'shell') {
        await spawnPane({ kind: 'shell', name: saved.name || null, profileId: saved.profileId, cwd });
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
              await api.setName(S.cwd, s.id, n, s.kind, S.activeProfile);
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

function openSession(s) {
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
async function reloadProfiles() {
  const r = await api.listProfiles();
  S.profiles = r.profiles;
  S.activeProfile = r.activeProfile;
  renderAccount();
  for (const w of S.workspaces.values()) w.panes.forEach(renderPaneHead);
}

function renderAccount() {
  const p = profileOf(S.activeProfile);
  $('#accountAvatar').textContent = initials(p);
  $('#accountName').textContent = p.account && p.account.email ? `${profileName(p)} · ${p.account.email}` : profileName(p);
}

function showAccountMenu(anchor) {
  const items = S.profiles.map((p) => {
    const u = S.usage && S.usage.claude[p.id];
    const note = u && u.ok ? usageNote(u) : u && u.reason !== 'no-credentials' ? t(`usage.reason.${u.reason}`) : '';
    return {
      active: p.id === S.activeProfile,
      html: `<span class="avatar">${esc(initials(p))}</span><div style="flex:1"><div>${esc(profileName(p))}${p.id === S.activeProfile ? ' ✓' : ''}</div><div class="sub">${esc(
        (p.account && p.account.email) || t('profile.notLoggedIn'),
      )}${note ? ` · ${esc(note)}` : ''}</div></div>`,
      onClick: async () => {
        await api.setActiveProfile(p.id);
        await reloadProfiles();
        refreshSessions();
        renderDashboard();
        toast(t('profile.switched', { name: profileName(p) }), 'ok');
      },
    };
  });
  const cur = profileOf(S.activeProfile);
  items.push(
    '-',
    { label: t('profile.login', { name: profileName(cur) }), onClick: () => loginModal(cur) },
    { label: t('profile.add'), onClick: addProfileFlow },
    { label: t('profile.rename', { name: profileName(cur) }), onClick: renameProfileFlow },
  );
  if (cur.id !== 'default') items.push({ label: t('profile.remove', { name: profileName(cur) }), onClick: removeProfileFlow });
  items.push(
    '-',
    { label: t('profile.installMcp'), onClick: installMcp },
    { label: t('profile.installBridge'), onClick: installBridge },
    { label: t('profile.codexLogin'), onClick: () => loginModal(cur, 'codex-login') },
  );
  showPopover(anchor, items);
}

// 在 modal 裡開一個小終端機跑 `claude auth login`（或 `codex login`），完成後自動關閉
function loginModal(profile, kind = 'login') {
  return modal(
    `<h3>${esc(t(kind === 'login' ? 'login.claude' : 'login.codex', { name: profileName(profile) }))}</h3>
     <div class="hint">${esc(t('login.hint'))}</div>
     <div id="loginTerm" class="login-term"></div>
     <div class="actions"><button id="mClose">${esc(t('modal.close'))}</button></div>`,
    async (card, close) => {
      const holder = { id: null, onExit: null };
      const t = makeTerminal($('#loginTerm', card), () => holder.id);
      const finish = async () => {
        if (holder.id) {
          paneByPty.delete(holder.id);
          api.kill(holder.id);
        }
        t.ro.disconnect();
        t.term.dispose();
        close();
        await reloadProfiles();
        refreshUsage(true);
      };
      $('#mClose', card).onclick = finish;
      Object.assign(holder, t, {
        onExit: (code) => {
          toast(code === 0 ? t('login.done') : t('login.exit', { code }), code === 0 ? 'ok' : 'bad');
          finish();
        },
      });
      try {
        t.fit.fit();
        const r = await api.spawnPane({ kind, cwd: S.cwd || undefined, profileId: profile.id, cols: t.term.cols, rows: t.term.rows });
        holder.id = r.paneId;
        paneByPty.set(r.paneId, holder);
        t.term.focus();
      } catch (e) {
        toast(t('login.failed', { msg: errMsg(e) }), 'bad');
      }
    },
  );
}

async function addProfileFlow() {
  const res = await modal(
    `<h3>${esc(t('add.title'))}</h3>
     <div class="field"><label>${esc(t('add.name'))}</label><input id="pName" placeholder="${esc(t('add.namePlaceholder'))}" /></div>
     <label class="field check"><input type="checkbox" id="pShare" checked /> ${esc(t('add.share'))}</label>
     <label class="field check"><input type="checkbox" id="pCodex" /> ${esc(t('add.codex'))}</label>
     <div class="actions"><button id="mCancel">${esc(t('modal.cancel'))}</button><button id="mOk" class="primary">${esc(t('add.submit'))}</button></div>`,
    (card, close) => {
      $('#pName', card).focus();
      $('#mCancel', card).onclick = () => close(null);
      $('#mOk', card).onclick = () =>
        close({ name: $('#pName', card).value.trim() || t('add.defaultName'), shareHistory: $('#pShare', card).checked, separateCodex: $('#pCodex', card).checked });
    },
  );
  if (!res) return;
  const p = await api.addProfile(res.name, { shareHistory: res.shareHistory, separateCodex: res.separateCodex });
  await reloadProfiles();
  loginModal({ ...p, account: {} });
}

async function renameProfileFlow() {
  const cur = profileOf(S.activeProfile);
  const n = await promptModal(t('rename.profile'), { value: profileName(cur) });
  if (n) {
    await api.renameProfile(cur.id, n);
    reloadProfiles();
  }
}

async function removeProfileFlow() {
  const cur = profileOf(S.activeProfile);
  const ok = await modal(
    `<h3>${esc(t('remove.title', { name: profileName(cur) }))}</h3><div class="hint">${esc(t('remove.hint'))}</div>
     <div class="actions"><button id="mCancel">${esc(t('modal.cancel'))}</button><button id="mOk" class="primary">${esc(t('remove.submit'))}</button></div>`,
    (card, close) => {
      $('#mCancel', card).onclick = () => close(false);
      $('#mOk', card).onclick = () => close(true);
    },
  );
  if (!ok) return;
  await api.removeProfile(cur.id);
  reloadProfiles();
}

async function installBridge() {
  toast(t('bridge.installing'));
  const r = await api.installBridge(S.activeProfile);
  toast(r.ok ? t('bridge.installed', { out: r.output }) : t('mcp.failed', { out: r.output }), r.ok ? 'ok' : 'bad', 9000);
}

async function installMcp() {
  toast(t('mcp.running'));
  const r = await api.installCodexMcp(S.activeProfile);
  toast(r.ok ? t('mcp.ok', { out: r.output }) : t('mcp.failed', { out: r.output }), r.ok ? 'ok' : 'bad', 9000);
}

// ---------------------------------------------------------------- usage & context dashboard
async function refreshUsage(force = false) {
  try {
    S.usage = await api.getUsage({ force });
  } catch {
    return;
  }
  renderDashboard();
  const u = S.usage.claude[S.activeProfile];
  if (u && u.ok && u.fiveHour && u.fiveHour.pct >= 100) {
    const key = `${S.activeProfile}:${u.fiveHour.resetsAt}`;
    if (!S.warnedLimit.has(key)) {
      S.warnedLimit.add(key);
      const alt = S.profiles.find((p) => {
        const x = S.usage.claude[p.id];
        return p.id !== S.activeProfile && x && x.ok && (!x.fiveHour || x.fiveHour.pct < 100);
      });
      toast(
        t('limit.toast', { name: profileName(profileOf(S.activeProfile)), t: fmtReset(u.fiveHour.resetsAt) }) +
          '\n' +
          (alt ? t('limit.toastAlt', { alt: profileName(alt) }) : t('limit.toastCodex')),
        'bad',
        12000,
      );
    }
  }
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
  for (const p of S.profiles) {
    const u = S.usage && S.usage.claude[p.id];
    html += `<div class="dsec"><div class="head"><span class="name">Claude · ${esc(profileName(p))}</span>${p.id === S.activeProfile ? '<span class="sub">✓</span>' : ''}</div>
      <div class="sub">${esc((p.account && p.account.email) || t('profile.notLoggedIn'))}${u && u.plan ? ` · ${esc(u.plan)}` : ''}</div>`;
    if (u && u.ok)
      html +=
        usageRow(t('usage.5hLong'), u.fiveHour) + usageRow(t('usage.weekLong'), u.sevenDay) + usageRow(t('usage.weekOpus'), u.sevenDayOpus) + usageRow(t('usage.weekSonnet'), u.sevenDaySonnet);
    else if (!u || u.reason !== 'no-credentials') html += `<div class="sub">${esc(u ? t(`usage.reason.${u.reason}`) : t('usage.loading'))}</div>`;
    html += '</div>';
  }
  const cw = codexWindows(S.usage && S.usage.codex);
  html += `<div class="dsec"><div class="head"><span class="name">Codex · ${esc(t('usage.codexPlan'))}</span></div>`;
  html += cw.length
    ? cw.map((w) => usageRow(w.week ? t('usage.weekLong') : w.label === '5h' ? t('usage.5hLong') : w.label, w)).join('') +
      `<div class="sub">${esc(t('usage.codexAt', { t: S.usage.codex.observedAt ? fmtAgo(S.usage.codex.observedAt) : '–' }))}</div>`
    : `<div class="sub">${esc(t('usage.codexEmpty'))}</div>`;
  html += `</div><button id="refreshUsage" class="ghost">${esc(t('usage.refresh'))}</button>`;
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
    <label>${esc(t('set.fallback'))}<select id="setFallback">${opt('ask', t('set.fallback.ask'), st.fallback)}${opt('auto', t('set.fallback.auto'), st.fallback)}${opt(
      'off',
      t('set.fallback.off'),
      st.fallback,
    )}</select></label>
    <label>${esc(t('set.order'))}<select id="setOrder">${opt('other-profile,codex', t('set.order.profileFirst'), st.fallbackOrder)}${opt(
      'codex,other-profile',
      t('set.order.codexFirst'),
      st.fallbackOrder,
    )}</select></label>`;
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
  $('#setOrder').onchange = (e) => saveSettings({ fallbackOrder: e.target.value.split(',') });
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
  const res = await api.getContext(all.map((p) => ({ kind: p.kind, sessionId: p.sessionId, cwd: p.cwd, profileId: p.profileId })));
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
    profiles: init.profiles,
    activeProfile: init.activeProfile,
    settings: init.settings,
  });
  S.lang = init.settings.lang || detectLang();
  applyTheme();
  applyLang();

  $('#projectBtn').onclick = (e) => {
    e.stopPropagation();
    showProjectMenu(e.currentTarget);
  };
  $('#accountBtn').onclick = (e) => {
    e.stopPropagation();
    showAccountMenu(e.currentTarget);
  };
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

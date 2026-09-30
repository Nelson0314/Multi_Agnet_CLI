'use strict';
/* global Terminal, FitAddon, api -- api 由 preload 透過 contextBridge 注入 */
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
};
const paneByPty = new Map();
const pendingData = new Map();

// ---------------------------------------------------------------- helpers
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const basename = (p) => (p || '').split(/[\\/]/).filter(Boolean).pop() || p;
const kindLabel = (k) => (k === 'codex' ? 'Codex' : 'Claude');
const profileOf = (id) => S.profiles.find((p) => p.id === id) || S.profiles[0];
const ws = () => S.workspaces.get(S.cwd);

function fmtAgo(ms) {
  const s = (Date.now() - ms) / 1000;
  if (s < 60) return '剛剛';
  if (s < 3600) return `${Math.floor(s / 60)} 分鐘前`;
  if (s < 86400) return `${Math.floor(s / 3600)} 小時前`;
  return `${Math.floor(s / 86400)} 天前`;
}
function fmtTokens(n) {
  if (n == null) return '–';
  return n >= 1e6 ? `${(n / 1e6).toFixed(2)}M` : n >= 1000 ? `${Math.round(n / 1000)}k` : String(n);
}
function fmtReset(ts) {
  if (!ts) return '';
  const s = Math.max(0, (ts - Date.now()) / 1000);
  if (s < 3600) return `${Math.ceil(s / 60)} 分`;
  if (s < 86400) return `${Math.floor(s / 3600)} 時 ${Math.floor((s % 3600) / 60)} 分`;
  return `${Math.floor(s / 86400)} 天 ${Math.floor((s % 86400) / 3600)} 時`;
}
const barClass = (pct) => (pct >= 90 ? 'bad' : pct >= 70 ? 'warn' : '');
function bar(pct) {
  const v = pct == null ? 0 : Math.max(0, Math.min(100, pct));
  return `<div class="bar ${barClass(v)}"><i style="width:${v}%"></i></div>`;
}
function initials(p) {
  const s = (p.account && p.account.email) || p.name || '?';
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
     <div class="actions"><button id="mCancel">取消</button><button id="mOk" class="primary">確定</button></div>`,
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
    fontFamily: 'Menlo, Consolas, "Cascadia Mono", "Noto Sans Mono CJK TC", "Sarasa Mono TC", monospace',
    fontSize: 13,
    cursorBlink: true,
    scrollback: 10000,
    allowProposedApi: true,
    theme: { background: '#000000' },
  });
  const fit = new FitAddon.FitAddon();
  term.loadAddon(fit);
  term.open(container);
  term.onData((d) => getPtyId() && api.write(getPtyId(), d));
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
  p.term.write(`\r\n\x1b[90m── 程式已結束 (exit ${code})。按「↻」重新開啟，或關閉此窗格 ──\x1b[0m\r\n`);
});
api.onLimit((id, text) => {
  const p = paneByPty.get(id);
  if (p) handleLimit(p, text);
});
api.onSession((id, sessionId) => {
  const p = paneByPty.get(id);
  if (!p) return;
  p.sessionId = sessionId;
  if (p.name) api.setName(p.cwd, sessionId, p.name);
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

// 1→1×1、2→2×1、3→3×1、4→2×2、5→上 3 下 2、6→3×2，所有窗格平均分配空間
function layoutGrid(w) {
  const n = w.panes.length;
  const spec = { 0: [1, 1], 1: [1, 1], 2: [2, 1], 3: [3, 1], 4: [2, 2], 5: [6, 2], 6: [3, 2] }[n];
  w.el.style.gridTemplateColumns = `repeat(${spec[0]}, minmax(0, 1fr))`;
  w.el.style.gridTemplateRows = `repeat(${spec[1]}, minmax(0, 1fr))`;
  w.panes.forEach((p, i) => {
    p.el.style.gridColumn = n === 5 ? `span ${i < 3 ? 2 : 3}` : '';
    $('.pane-idx', p.el).textContent = `${i + 1}`;
  });
  $('#empty').hidden = !!S.cwd;
  $('#paneCount').textContent = `${n} / ${S.maxPanes}`;
}

function paneTitle(p) {
  return p.name || `新 ${kindLabel(p.kind)} session`;
}

function renderPaneHead(p) {
  const prof = profileOf(p.profileId);
  const head = $('.pane-head', p.el);
  $('.tag.kind', head).className = `tag kind ${p.kind}`;
  $('.tag.kind', head).textContent = kindLabel(p.kind);
  const t = $('.pane-title', head);
  if (!t.querySelector('input')) {
    t.textContent = paneTitle(p);
    t.title = `${paneTitle(p)}\n${p.sessionId || '(等待 session id…)'}\n雙擊可重新命名`;
  }
  const pt = $('.tag.profile', head);
  pt.textContent = prof ? prof.name : '';
  pt.hidden = p.kind !== 'claude' || S.profiles.length < 2;
  p.el.className = `pane ${p.kind} ${S.focused === p ? 'focused' : ''} ${p.max ? 'max' : ''} ${p.exited ? 'exited' : ''}`;
}

function renderPaneCtx(p) {
  const c = p.context;
  $('.ctx', p.el).innerHTML = c
    ? `<span>context</span>${bar(c.pct)}<span title="context 深度：${c.tokens.toLocaleString()} / ${c.window.toLocaleString()} tokens">${c.pct.toFixed(0)}% · ${fmtTokens(c.tokens)} / ${fmtTokens(c.window)}</span>`
    : `<span>context –</span>`;
}

function createPaneEl(p) {
  const el = document.createElement('div');
  el.innerHTML = `
    <div class="pane-head">
      <div class="pane-row">
        <span class="pane-idx"></span>
        <span class="tag kind"></span>
        <span class="pane-title"></span>
        <button class="icon" data-act="menu" title="交接 / 換帳號 / 重新開啟">⇄</button>
        <button class="icon" data-act="max" title="最大化 / 還原">⤢</button>
        <button class="icon" data-act="close" title="關閉（session 紀錄會保留，可隨時再開）">✕</button>
      </div>
      <div class="pane-row meta">
        <div class="ctx"></div>
        <span class="tag profile"></span>
      </div>
    </div>
    <div class="pane-banner" hidden></div>
    <div class="term"></div>`;
  p.el = el;
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

function startRename(p) {
  const t = $('.pane-title', p.el);
  const input = document.createElement('input');
  input.value = paneTitle(p);
  t.innerHTML = '';
  t.appendChild(input);
  input.focus();
  input.select();
  const done = (save) => {
    if (save && input.value.trim()) {
      p.name = input.value.trim();
      if (p.sessionId) api.setName(p.cwd, p.sessionId, p.name).then(refreshSessions);
    }
    t.innerHTML = '';
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

async function spawnPane({ kind, sessionId = null, name = null, prompt = null, profileId = null, cwd = S.cwd }) {
  const w = workspaceFor(cwd);
  if (w.panes.length >= S.maxPanes) {
    toast(`最多同時開 ${S.maxPanes} 個 session，請先關閉一個`, 'bad');
    return null;
  }
  const p = { id: null, kind, cwd, sessionId, name, profileId: profileId || S.activeProfile, context: null, exited: false, max: false };
  w.el.appendChild(createPaneEl(p));
  w.panes.push(p);
  layoutGrid(w);
  Object.assign(p, makeTerminal($('.term', p.el), () => p.id));
  renderPaneHead(p);
  renderPaneCtx(p);
  try {
    await startPty(p, { prompt });
  } catch (e) {
    toast(`無法啟動 ${kindLabel(kind)}：${e.message}`, 'bad');
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
    toast(`無法啟動：${e.message}`, 'bad');
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
    w.panes.map((p) => ({ kind: p.kind, sessionId: p.sessionId, profileId: p.profileId })),
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
      const note = ok ? `5h ${Math.round(u.fiveHour ? u.fiveHour.pct : 0)}% · 週 ${Math.round(u.sevenDay ? u.sevenDay.pct : 0)}%` : '額度未知';
      return { profile: x, viable: !exhausted && (ok || (x.account && x.account.email)), note };
    });
}

function fallbackActions(p) {
  const acts = [];
  if (p.kind === 'claude') {
    for (const o of otherProfileOptions(p)) {
      if (!o.viable) continue;
      acts.push({
        type: 'other-profile',
        label: `改用「${o.profile.name}」續跑同一個 session（${o.note}）`,
        run: () => switchProfile(p, o.profile.id),
      });
    }
    acts.push({ type: 'codex', label: '交給 Codex 接手（自動產生交接文件）', run: () => handoff(p, 'codex', { inPlace: true, reason: 'Claude 額度用完' }) });
  } else if (p.kind === 'codex') {
    acts.push({ type: 'claude', label: '交給 Claude 接手', run: () => handoff(p, 'claude', { inPlace: true, reason: 'Codex 額度用完' }) });
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
  refreshUsage(true);
  if (S.settings.fallback === 'off') return;
  const acts = fallbackActions(p);
  if (S.settings.fallback === 'auto' && acts.length) {
    toast(`「${paneTitle(p)}」額度用完，自動執行：${acts[0].label}`);
    acts[0].run();
    return;
  }
  const b = $('.pane-banner', p.el);
  b.innerHTML = `<span class="msg">⚠️ ${kindLabel(p.kind)} 額度似乎已用完。要怎麼接續？</span>`;
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
  ig.textContent = '忽略';
  ig.onclick = () => {
    hideBanner(p);
    if (p.id) api.resetLimit(p.id);
  };
  b.appendChild(ig);
  b.hidden = false;
}

async function switchProfile(p, profileId) {
  const target = profileOf(profileId);
  if (!p.sessionId) return toast('這個窗格還沒有 session id，無法續跑', 'bad');
  if (target.id !== 'default' && !target.shareHistory) {
    toast(`「${target.name}」沒有共用 session 歷史，改用交接文件開新 session`);
    return handoff(p, 'claude', { inPlace: true, profileId, reason: '切換帳號' });
  }
  toast(`以「${target.name}」繼續 ${paneTitle(p)}`, 'ok');
  await restartPane(p, { profileId });
}

async function handoff(p, toKind, { inPlace = false, profileId = null, reason = '' } = {}) {
  if (!p.sessionId) return toast('這個窗格還沒有 session id，無法交接', 'bad');
  let r;
  try {
    r = await api.createHandoff({ paneId: p.id, fromKind: p.kind, toKind, sessionId: p.sessionId, cwd: p.cwd, sessionName: paneTitle(p), reason });
  } catch (e) {
    return toast(`交接失敗：${e.message}`, 'bad');
  }
  const name = `${paneTitle(p).replace(/ → (Claude|Codex)$/, '')} → ${kindLabel(toKind)}`;
  toast(`已產生交接文件，${kindLabel(toKind)} 接手中…`, 'ok');
  if (inPlace) await restartPane(p, { kind: toKind, sessionId: null, prompt: r.prompt, name, profileId: profileId || p.profileId });
  else await spawnPane({ kind: toKind, prompt: r.prompt, name, cwd: p.cwd, profileId });
}

function paneMenu(p) {
  const items = [];
  if (p.kind === 'claude') {
    for (const o of otherProfileOptions(p)) {
      items.push({
        html: `以「${esc(o.profile.name)}」續跑 <span class="sub">${esc(o.note)}</span>`,
        onClick: () => switchProfile(p, o.profile.id),
      });
    }
    items.push({ label: '交給 Codex 接手（新窗格）', onClick: () => handoff(p, 'codex', { reason: '手動交接' }) });
    items.push({ label: '交給 Codex 接手（取代此窗格）', onClick: () => handoff(p, 'codex', { inPlace: true, reason: '手動交接' }) });
  } else {
    items.push({ label: '交給 Claude 接手（新窗格）', onClick: () => handoff(p, 'claude', { reason: '手動交接' }) });
    items.push({ label: '交給 Claude 接手（取代此窗格）', onClick: () => handoff(p, 'claude', { inPlace: true, reason: '手動交接' }) });
  }
  items.push('-');
  items.push({ label: '↻ 重新開啟（resume）', onClick: () => restartPane(p) });
  items.push({ label: '✎ 重新命名', onClick: () => startRename(p) });
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
      const s = findSession(saved.kind, saved.sessionId);
      await spawnPane({ kind: saved.kind, sessionId: saved.sessionId, profileId: saved.profileId, name: s ? s.title : info.names[saved.sessionId], cwd });
    }
    toast(`已還原 ${info.panes.length} 個 session`, 'ok');
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
      if (s && s.title !== p.name) {
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
    (s) => !q || `${s.title} ${s.firstPrompt || ''} ${s.lastPrompt || ''} ${s.id}`.toLowerCase().includes(q),
  );
  list.innerHTML = items.length
    ? ''
    : `<li class="s-meta" style="cursor:default">${S.cwd ? '這個專案還沒有 session' : '尚未選擇專案'}</li>`;
  for (const s of items) {
    const li = document.createElement('li');
    const open = openIds.has(s.id);
    li.className = open ? 'open' : '';
    li.title = `${s.title}\n\n第一句：${s.firstPrompt || ''}\n最後：${s.lastPrompt || ''}\n\n${s.id}`;
    li.innerHTML = `
      <div class="s-title"><span>${esc(s.title)}</span>${open ? '<i class="dot" title="開啟中"></i>' : ''}${s.spawnedByAgent ? '<span class="tag sub" title="由 Claude 透過 MCP 呼叫的 Codex 子 agent">子 agent</span>' : ''}</div>
      <div class="s-meta"><span>${fmtAgo(s.mtime)}</span><span>· ${s.messageCount} 則</span>${
        s.context ? `<span>· ctx ${s.context.pct.toFixed(0)}%</span>` : ''
      }</div>
      <div class="s-prompt">${esc(s.lastPrompt || '')}</div>`;
    li.onclick = () => openSession(s);
    li.oncontextmenu = (e) => {
      e.preventDefault();
      showPopover(li, [
        { label: '開啟', onClick: () => openSession(s) },
        {
          label: '重新命名',
          onClick: async () => {
            const n = await promptModal('重新命名 session', { value: s.title });
            if (n) {
              await api.setName(S.cwd, s.id, n);
              refreshSessions();
            }
          },
        },
        { label: '複製 session id', onClick: () => api.clipboardWrite(s.id) },
      ]);
    };
    list.appendChild(li);
  }
}

function openSession(s) {
  const w = ws();
  const existing = w && w.panes.find((p) => p.sessionId === s.id);
  if (existing) return setFocus(existing);
  spawnPane({ kind: s.kind, sessionId: s.id, name: s.title });
}

async function newSession(kind) {
  if (!S.cwd) return pickProject();
  const name = await promptModal(`新增 ${kindLabel(kind)} session`, {
    placeholder: '例如：API 重構、登入頁 bug…',
    hint: '名稱會顯示在窗格上方，之後可雙擊標題修改。可留空。',
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
    html: `<div><div>${esc(basename(p.cwd))}</div><div class="sub">${esc(p.cwd)}${p.sessionCount ? ` · ${p.sessionCount} sessions` : ''}</div></div>`,
    onClick: () => openProject(p.cwd),
  }));
  items.push('-', { label: '📁 開啟其他資料夾…', onClick: pickProject });
  showPopover(anchor, items);
}

async function renderRecent() {
  const projects = await api.listProjects();
  $('#recentList').innerHTML = '';
  for (const p of projects.slice(0, 8)) {
    const li = document.createElement('li');
    li.innerHTML = `<b>${esc(basename(p.cwd))}</b> <span class="sub">${esc(p.cwd)}</span>`;
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
  $('#accountName').textContent = p.account && p.account.email ? `${p.name} · ${p.account.email}` : p.name;
}

function showAccountMenu(anchor) {
  const items = S.profiles.map((p) => {
    const u = S.usage && S.usage.claude[p.id];
    const note = u && u.ok ? `5h ${Math.round(u.fiveHour ? u.fiveHour.pct : 0)}% · 週 ${Math.round(u.sevenDay ? u.sevenDay.pct : 0)}%` : u ? u.reason : '';
    return {
      active: p.id === S.activeProfile,
      html: `<span class="avatar">${esc(initials(p))}</span><div style="flex:1"><div>${esc(p.name)}${p.id === S.activeProfile ? ' ✓' : ''}</div><div class="sub">${esc(
        (p.account && p.account.email) || '未登入',
      )}${note ? ` · ${esc(note)}` : ''}</div></div>`,
      onClick: async () => {
        await api.setActiveProfile(p.id);
        await reloadProfiles();
        refreshSessions();
        renderMeters();
        toast(`之後新開的 session 會使用「${p.name}」`, 'ok');
      },
    };
  });
  const cur = profileOf(S.activeProfile);
  items.push(
    '-',
    { label: `🔑 登入 / 重新登入「${cur.name}」`, onClick: () => loginModal(cur) },
    { label: '＋ 新增帳號', onClick: addProfileFlow },
    { label: `✎ 重新命名「${cur.name}」`, onClick: renameProfileFlow },
  );
  if (cur.id !== 'default') items.push({ label: `🗑 移除「${cur.name}」`, onClick: removeProfileFlow });
  items.push(
    '-',
    { label: '🧩 讓 Claude 可以呼叫 Codex（安裝 Codex MCP）', onClick: installMcp },
    { label: '🔑 Codex 登入', onClick: () => loginModal(cur, 'codex-login') },
  );
  showPopover(anchor, items);
}

// 在 modal 裡開一個小終端機跑 `claude auth login`（或 `codex login`），完成後自動關閉
function loginModal(profile, kind = 'login') {
  return modal(
    `<h3>${kind === 'login' ? '登入 Claude' : '登入 Codex'}：${esc(profile.name)}</h3>
     <div class="hint">瀏覽器會開啟授權頁面，完成後這裡會自動關閉。</div>
     <div id="loginTerm" style="height:260px;margin-top:10px;background:#000;border-radius:6px;padding:4px"></div>
     <div class="actions"><button id="mClose">關閉</button></div>`,
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
          toast(code === 0 ? '登入完成' : `登入程序結束 (exit ${code})`, code === 0 ? 'ok' : 'bad');
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
        toast(`無法啟動登入：${e.message}`, 'bad');
      }
    },
  );
}

async function addProfileFlow() {
  const res = await modal(
    `<h3>新增帳號</h3>
     <div class="field"><label>名稱</label><input id="pName" placeholder="例如：公司帳號 / 備用 Max" /></div>
     <label class="field check"><input type="checkbox" id="pShare" checked /> 共用 session 歷史與設定（建議：才能用另一個帳號 resume 同一個 session）</label>
     <label class="field check"><input type="checkbox" id="pCodex" /> 這個帳號也使用獨立的 Codex 登入（CODEX_HOME）</label>
     <div class="actions"><button id="mCancel">取消</button><button id="mOk" class="primary">建立並登入</button></div>`,
    (card, close) => {
      $('#pName', card).focus();
      $('#mCancel', card).onclick = () => close(null);
      $('#mOk', card).onclick = () =>
        close({ name: $('#pName', card).value.trim() || '新帳號', shareHistory: $('#pShare', card).checked, separateCodex: $('#pCodex', card).checked });
    },
  );
  if (!res) return;
  const p = await api.addProfile(res.name, { shareHistory: res.shareHistory, separateCodex: res.separateCodex });
  await reloadProfiles();
  loginModal({ ...p, account: {} });
}

async function renameProfileFlow() {
  const cur = profileOf(S.activeProfile);
  const n = await promptModal('重新命名帳號', { value: cur.name });
  if (n) {
    await api.renameProfile(cur.id, n);
    reloadProfiles();
  }
}

async function removeProfileFlow() {
  const cur = profileOf(S.activeProfile);
  const ok = await modal(
    `<h3>移除「${esc(cur.name)}」？</h3><div class="hint">只會從清單移除，不會刪除該帳號的設定目錄。</div>
     <div class="actions"><button id="mCancel">取消</button><button id="mOk" class="primary">移除</button></div>`,
    (card, close) => {
      $('#mCancel', card).onclick = () => close(false);
      $('#mOk', card).onclick = () => close(true);
    },
  );
  if (!ok) return;
  await api.removeProfile(cur.id);
  reloadProfiles();
}

async function installMcp() {
  toast('正在註冊 codex mcp-server…');
  const r = await api.installCodexMcp(S.activeProfile);
  toast(r.ok ? `已安裝：之後新開的 Claude session 可以直接呼叫 Codex 工具。\n${r.output}` : `安裝失敗：\n${r.output}`, r.ok ? 'ok' : 'bad', 9000);
}

// ---------------------------------------------------------------- usage & context dashboard
async function refreshUsage(force = false) {
  try {
    S.usage = await api.getUsage({ force });
  } catch {
    return;
  }
  renderMeters();
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
        `「${profileOf(S.activeProfile).name}」5 小時額度已用完，${fmtReset(u.fiveHour.resetsAt)}後重置。` +
          (alt ? `\n可從右上帳號選單切到「${alt.name}」，或在窗格 ⇄ 選單換帳號續跑。` : '\n可在窗格 ⇄ 選單把工作交給 Codex。'),
        'bad',
        12000,
      );
    }
  }
}

function meter(label, w) {
  if (!w || w.pct == null) return '';
  return `<div class="meter" title="${label}：${w.pct.toFixed(1)}%${w.resetsAt ? `，${fmtReset(w.resetsAt)}後重置` : ''}">${label} ${bar(w.pct)}<b>${Math.round(
    w.pct,
  )}%</b></div>`;
}

function codexWindows(rl) {
  if (!rl) return [];
  return [rl.primary, rl.secondary].filter(Boolean).map((w) => ({
    label: w.windowMinutes && w.windowMinutes > 1440 ? '週' : w.windowMinutes ? `${Math.round(w.windowMinutes / 60)}h` : '?',
    ...w,
  }));
}

function renderMeters() {
  if (!S.usage) return;
  const u = S.usage.claude[S.activeProfile];
  let html = '<div class="meter-group"><span class="tag claude">Claude</span>';
  html += u && u.ok ? meter('5h', u.fiveHour) + meter('週', u.sevenDay) : `<span class="meter">${esc(u ? u.reason : '載入中…')}</span>`;
  html += '</div><div class="meter-group"><span class="tag codex">Codex</span>';
  const cw = codexWindows(S.usage.codex);
  html += cw.length ? cw.map((w) => meter(w.label, w)).join('') : '<span class="meter">尚無資料</span>';
  html += '</div>';
  $('#meters').innerHTML = html;
}

function usageRow(label, w) {
  if (!w || w.pct == null) return '';
  return `<div class="row"><span class="label">${label}</span>${bar(w.pct)}<span class="val">${Math.round(w.pct)}%</span><span class="reset">${
    w.resetsAt ? `${fmtReset(w.resetsAt)}後重置` : ''
  }</span></div>`;
}

function renderDashboard() {
  if ($('#dashboard').hidden) return;
  let html = '';
  for (const p of S.profiles) {
    const u = S.usage && S.usage.claude[p.id];
    html += `<div class="card"><div class="head"><span class="tag claude">Claude</span>${esc(p.name)}${p.id === S.activeProfile ? ' ✓' : ''}</div>
      <div class="sub">${esc((p.account && p.account.email) || '未登入')}${u && u.plan ? ` · ${esc(u.plan)}` : ''}</div>`;
    if (u && u.ok) html += usageRow('5 小時', u.fiveHour) + usageRow('每週', u.sevenDay) + usageRow('週 Opus', u.sevenDayOpus) + usageRow('週 Sonnet', u.sevenDaySonnet);
    else html += `<div class="sub">${esc(u ? u.reason : '載入中…')}</div>`;
    html += '</div>';
  }
  const cw = codexWindows(S.usage && S.usage.codex);
  html += `<div class="card"><div class="head"><span class="tag codex">Codex</span>ChatGPT 訂閱</div>`;
  html += cw.length
    ? cw.map((w) => usageRow(w.label === '週' ? '每週' : w.label === '5h' ? '5 小時' : w.label, w)).join('') +
      `<div class="sub">資料時間：${S.usage.codex.observedAt ? fmtAgo(S.usage.codex.observedAt) : '–'}（Codex 每次回覆時更新）</div>`
    : '<div class="sub">尚無資料：使用過 Codex 後就會出現</div>';
  html += `</div><button id="refreshUsage">↻ 重新整理額度</button>`;
  $('#dashUsage').innerHTML = html;
  $('#refreshUsage').onclick = () => refreshUsage(true);

  let ctx = '';
  for (const [cwd, w] of S.workspaces) {
    if (!w.panes.length) continue;
    ctx += `<div class="sub" style="margin:6px 0">${esc(basename(cwd))}</div>`;
    for (const p of w.panes) {
      const c = p.context;
      ctx += `<div class="card"><div class="head"><span class="tag ${p.kind}">${kindLabel(p.kind)}</span><span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(
        paneTitle(p),
      )}</span></div>
        <div class="row">${bar(c ? c.pct : 0)}<span class="val">${c ? Math.round(c.pct) + '%' : '–'}</span><span class="reset">${
        c ? `${fmtTokens(c.tokens)} / ${fmtTokens(c.window)}` : ''
      }</span></div></div>`;
    }
  }
  $('#dashContext').innerHTML = ctx || '<div class="sub">沒有開啟中的 session</div>';

  const st = S.settings;
  $('#dashSettings').innerHTML = `
    <label>登入電腦時自動開啟本程式 <input type="checkbox" id="setLogin" ${st.openAtLogin ? 'checked' : ''} ${S.platform === 'linux' ? 'disabled' : ''}></label>
    <label>啟動後自動還原上次的 session <input type="checkbox" id="setRestore" ${st.autoRestore ? 'checked' : ''}></label>
    <label>額度用完時
      <select id="setFallback">
        <option value="ask" ${st.fallback === 'ask' ? 'selected' : ''}>詢問我</option>
        <option value="auto" ${st.fallback === 'auto' ? 'selected' : ''}>自動接手</option>
        <option value="off" ${st.fallback === 'off' ? 'selected' : ''}>不處理</option>
      </select></label>
    <label>優先順序
      <select id="setOrder">
        <option value="other-profile,codex" ${String(st.fallbackOrder) === 'other-profile,codex' ? 'selected' : ''}>先換 Claude 帳號，再交給 Codex</option>
        <option value="codex,other-profile" ${String(st.fallbackOrder) === 'codex,other-profile' ? 'selected' : ''}>先交給 Codex</option>
      </select></label>`;
  $('#setLogin').onchange = (e) => saveSettings({ openAtLogin: e.target.checked });
  $('#setRestore').onchange = (e) => saveSettings({ autoRestore: e.target.checked });
  $('#setFallback').onchange = (e) => saveSettings({ fallback: e.target.value });
  $('#setOrder').onchange = (e) => saveSettings({ fallbackOrder: e.target.value.split(',') });
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
  renderAccount();

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
  $('#newClaude').onclick = () => newSession('claude');
  $('#newCodex').onclick = () => newSession('codex');
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
  setInterval(renderMeters, 60_000); // 更新重置倒數
}

boot();

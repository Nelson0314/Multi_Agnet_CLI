'use strict';
// 窗格互通（bridge）：讓一個窗格裡的 agent 可以把訊息送進另一個窗格、讀它的回覆。
// 本機 HTTP 伺服器只綁 127.0.0.1，並用隨機 token 驗證；port 與 token 以環境變數
// 傳給每個窗格，所以只有這個程式開的窗格（和它們的子程序，例如 MCP server）連得上。
const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const { readTail } = require('./jsonl');
const claude = require('./claudeSessions');
const codex = require('./codexSessions');

const HOP_WINDOW_MS = 10 * 60_000;
const HOP_LIMIT = 12;

// ---------------------------------------------------------------- 讀回覆
function isRealPromptEntry(e) {
  return e.type === 'user' && !e.isSidechain && !e.isMeta && claude.isRealPrompt(claude.textOf(e.message && e.message.content));
}

/** Claude：最後一個使用者訊息之後的 assistant 文字；stop_reason 為 end_turn 代表這輪結束 */
function claudeLastReply(entries) {
  let i = entries.length - 1;
  while (i >= 0 && !isRealPromptEntry(entries[i])) i--;
  const promptAt = i >= 0 ? Date.parse(entries[i].timestamp) || 0 : 0;
  const texts = [];
  let done = false;
  for (let j = i + 1; j < entries.length; j++) {
    const e = entries[j];
    if (e.type !== 'assistant' || e.isSidechain || !e.message) continue;
    const t = claude.textOf(e.message.content).trim();
    if (t) texts.push(t);
    done = e.message.stop_reason === 'end_turn';
  }
  return { promptAt, text: texts.join('\n\n'), done };
}

/** Codex：最後一個 user_message 之後的 agent_message；task_complete 代表這輪結束 */
function codexLastReply(entries) {
  let i = entries.length - 1;
  while (i >= 0 && !codex.isRealPrompt(codex.userMessageText(entries[i]))) i--;
  const promptAt = i >= 0 ? Date.parse(entries[i].timestamp) || 0 : 0;
  const texts = [];
  let done = false;
  for (let j = i + 1; j < entries.length; j++) {
    const p = entries[j].payload || {};
    if (entries[j].type !== 'event_msg') continue;
    if (p.type === 'agent_message' && p.message) texts.push(p.message.trim());
    if (p.type === 'task_complete') {
      done = true;
      if (!texts.length && p.last_agent_message) texts.push(String(p.last_agent_message).trim());
    }
  }
  return { promptAt, text: texts.join('\n\n'), done };
}

// ---------------------------------------------------------------- 伺服器
class Bridge {
  /**
   * @param {{ ptys, panes: Map, askRenderer: (method:string, args:any)=>Promise<any>,
   *           transcriptFile: (pane)=>string|null, settings: ()=>object }} deps
   */
  constructor(deps) {
    Object.assign(this, deps);
    this.token = crypto.randomBytes(24).toString('hex');
    this.hops = new Map(); // "from>to" -> [timestamps]
    this.port = null;
  }

  start() {
    return new Promise((resolve) => {
      this.server = http.createServer((req, res) => this.handle(req, res));
      this.server.listen(0, '127.0.0.1', () => {
        this.port = this.server.address().port;
        resolve(this.port);
      });
    });
  }

  stop() {
    if (this.server) this.server.close();
  }

  // 注入到每個窗格的環境變數
  envFor(paneId) {
    if (!this.port) return {};
    return { MULTI_AGENT_BRIDGE: `http://127.0.0.1:${this.port}`, MULTI_AGENT_TOKEN: this.token, MULTI_AGENT_PANE_ID: paneId };
  }

  handle(req, res) {
    const reply = (status, body) => {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    if (req.method !== 'POST' || req.url !== '/rpc') return reply(404, { error: 'not found' });
    let raw = '';
    req.on('data', (c) => {
      raw += c;
      if (raw.length > 1_000_000) req.destroy();
    });
    req.on('end', async () => {
      let body;
      try {
        body = JSON.parse(raw);
      } catch {
        return reply(400, { error: 'bad json' });
      }
      const given = Buffer.from(String(body.token || ''));
      const want = Buffer.from(this.token);
      if (given.length !== want.length || !crypto.timingSafeEqual(given, want)) return reply(403, { error: 'bad token' });
      try {
        reply(200, { result: await this.call(body.method, body.params || {}, body.from) });
      } catch (e) {
        reply(200, { error: e.message });
      }
    });
  }

  async call(method, params, fromId) {
    const from = this.panes.get(fromId);
    if (!from) throw new Error('This tool only works inside a Multi-Agent CLI pane.');
    // Claude 的 statusline 回報（session id、context、額度），不需要窗格清單
    if (method === 'status') {
      if (this.onStatus) this.onStatus(fromId, params);
      return 'ok';
    }
    const list = await this.askRenderer('listPanes', { cwd: from.cwd });
    const resolve = (ref) => {
      const hit = list.find((p) => String(p.index) === String(ref) || p.paneId === ref);
      if (!hit) throw new Error(`No pane "${ref}". Call list_panes to see the open panes.`);
      if (hit.paneId === fromId) throw new Error('That is your own pane.');
      return hit;
    };
    const me = list.find((p) => p.paneId === fromId);
    switch (method) {
      case 'list_panes':
        return list.map((p) => ({ pane: p.index, kind: p.kind, title: p.title, you: p.paneId === fromId }));
      case 'send_to_pane':
        return this.send(me, resolve(params.pane), String(params.message || ''));
      case 'read_pane':
        return this.read(resolve(params.pane), params);
      case 'wait_for_reply':
        return this.wait(resolve(params.pane), params);
      default:
        throw new Error(`unknown method ${method}`);
    }
  }

  checkHops(from, to) {
    const key = `${from}>${to}`;
    const now = Date.now();
    const list = (this.hops.get(key) || []).filter((t) => now - t < HOP_WINDOW_MS);
    if (list.length >= HOP_LIMIT) throw new Error(`Limit reached: at most ${HOP_LIMIT} messages to the same pane in 10 minutes. Ask the user before continuing.`);
    list.push(now);
    this.hops.set(key, list);
  }

  async send(me, target, message) {
    if (!message.trim()) throw new Error('message is empty');
    this.checkHops(me.paneId, target.paneId);
    const header = `[from pane ${me.index} · ${me.kind} · ${me.title}] (reply with the multi-agent send_to_pane tool, pane ${me.index})`;
    // bracketed paste：多行內容會完整放進輸入框，不會被逐行送出
    const paste = `\x1b[200~${header}\n${message}\x1b[201~`;
    const confirm = this.settings().bridgeConfirm !== false;
    if (!confirm) await this.ptys.waitQuiet(target.paneId, 2000, 30_000);
    this.ptys.write(target.paneId, paste);
    if (!confirm) setTimeout(() => this.ptys.write(target.paneId, '\r'), 150);
    this.askRenderer('incoming', { paneId: target.paneId, fromIndex: me.index, fromTitle: me.title, confirm }).catch(() => {});
    return confirm
      ? `Placed in pane ${target.index}'s input box. The user will press Enter to send it. Use wait_for_reply to get the answer.`
      : `Sent to pane ${target.index}. Use wait_for_reply to get the answer.`;
  }

  lastReply(target) {
    const pane = this.panes.get(target.paneId);
    const file = pane && pane.sessionId ? this.transcriptFile(pane) : null;
    if (!file || !fs.existsSync(file)) return null;
    const entries = readTail(file, 1024 * 1024);
    return pane.kind === 'codex' ? codexLastReply(entries) : claudeLastReply(entries);
  }

  async read(target, { lines = 60 } = {}) {
    const r = target.kind === 'shell' ? null : this.lastReply(target);
    if (r && r.text) return `${r.done ? '' : '(still working) '}${r.text}`;
    const screen = await this.askRenderer('readScreen', { paneId: target.paneId, lines: Math.min(400, Number(lines) || 60) });
    return screen || '(empty)';
  }

  async wait(target, { timeout_sec = 300 } = {}) {
    if (target.kind === 'shell') throw new Error('wait_for_reply works for Claude and Codex panes; use read_pane for a shell.');
    const deadline = Date.now() + Math.min(1800, Number(timeout_sec) || 300) * 1000;
    const since = Date.now() - 5000;
    while (Date.now() < deadline) {
      const r = this.lastReply(target);
      if (r && r.promptAt >= since && r.done && r.text) return r.text;
      await new Promise((ok) => setTimeout(ok, 1500));
    }
    const r = this.lastReply(target);
    return `Timed out. Latest output so far:\n${(r && r.text) || '(none)'}`;
  }
}

module.exports = { Bridge, claudeLastReply, codexLastReply, HOP_LIMIT };

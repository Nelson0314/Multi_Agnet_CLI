'use strict';
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const { spawn } = require('child_process');
const { tmpdir, writeJsonl, user, assistant } = require('./helpers');
const { Bridge, claudeLastReply, codexLastReply, HOP_LIMIT } = require('../src/main/bridge');

const MCP = path.join(__dirname, '..', 'src', 'bridge', 'mcp.js');

// 用 stdio 跟 MCP server 對話
function mcpClient(env) {
  const child = spawn(process.execPath, [MCP], { env: { ...process.env, ...env }, stdio: ['pipe', 'pipe', 'inherit'] });
  let buf = '';
  const waiting = new Map();
  child.stdout.on('data', (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const msg = JSON.parse(buf.slice(0, i));
      buf = buf.slice(i + 1);
      waiting.get(msg.id)?.(msg);
    }
  });
  let n = 0;
  const call = (method, params) =>
    new Promise((resolve) => {
      const id = ++n;
      waiting.set(id, resolve);
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });
  return { call, close: () => child.kill() };
}

test('MCP server：initialize、tools/list，不在窗格裡時回報錯誤', async () => {
  const c = mcpClient({ MULTI_AGENT_BRIDGE: '' });
  const init = await c.call('initialize', { protocolVersion: '2025-06-18' });
  assert.strictEqual(init.result.serverInfo.name, 'multi-agent');
  const list = await c.call('tools/list', {});
  assert.deepStrictEqual(list.result.tools.map((t) => t.name), ['list_panes', 'send_to_pane', 'read_pane', 'wait_for_reply']);
  const r = await c.call('tools/call', { name: 'list_panes', arguments: {} });
  assert.strictEqual(r.result.isError, true);
  assert.match(r.result.content[0].text, /Not running inside/);
  c.close();
});

test('claudeLastReply / codexLastReply 取最後一輪的回覆與是否完成', () => {
  const c = claudeLastReply([
    user('第一題', { timestamp: '2026-09-30T10:00:00Z' }),
    assistant('舊答案', {}),
    user('第二題', { timestamp: '2026-09-30T11:00:00Z' }),
    { type: 'assistant', message: { content: [{ type: 'text', text: '看一下' }], stop_reason: 'tool_use' } },
    { type: 'user', message: { content: [{ type: 'tool_result', content: 'x' }] } },
    { type: 'assistant', message: { content: [{ type: 'text', text: '新答案' }], stop_reason: 'end_turn' } },
  ]);
  assert.strictEqual(c.text, '看一下\n\n新答案');
  assert.strictEqual(c.done, true);
  assert.strictEqual(c.promptAt, Date.parse('2026-09-30T11:00:00Z'));
  const x = codexLastReply([
    { timestamp: '2026-09-30T11:00:00Z', type: 'event_msg', payload: { type: 'user_message', message: 'review' } },
    { type: 'event_msg', payload: { type: 'agent_message', message: 'LGTM' } },
  ]);
  assert.deepStrictEqual([x.text, x.done], ['LGTM', false]);
});

test('bridge 端對端：list、送訊息（bracketed paste）、讀回覆、次數上限', async () => {
  const dir = tmpdir();
  const transcript = path.join(dir, 't.jsonl');
  const writes = [];
  const panes = new Map([
    ['A', { kind: 'claude', cwd: '/p', sessionId: 'sa', profileId: 'default' }],
    ['B', { kind: 'codex', cwd: '/p', sessionId: 'sb', profileId: 'default' }],
  ]);
  let confirm = true;
  const bridge = new Bridge({
    ptys: { write: (id, d) => writes.push([id, d]), waitQuiet: async () => {} },
    panes,
    askRenderer: async (method) =>
      method === 'listPanes'
        ? [
            { index: 1, paneId: 'A', kind: 'Claude', title: 'API 重構' },
            { index: 2, paneId: 'B', kind: 'Codex', title: 'Review' },
          ]
        : null,
    settings: () => ({ bridgeConfirm: confirm }),
    transcriptFile: () => transcript,
  });
  await bridge.start();
  const c = mcpClient(bridge.envFor('A'));
  const text = async (name, args) => (await c.call('tools/call', { name, arguments: args })).result.content[0].text;

  assert.match(await text('list_panes', {}), /"you": true/);
  assert.match(await text('send_to_pane', { pane: 2, message: 'review src/api.ts\n第二行' }), /input box/);
  assert.strictEqual(writes.length, 1);
  assert.strictEqual(writes[0][0], 'B');
  assert.match(writes[0][1], /^\x1b\[200~\[from pane 1 · Claude · API 重構\].*\nreview src\/api\.ts\n第二行\x1b\[201~$/s);
  assert.match(await text('send_to_pane', { pane: 1, message: 'x' }), /your own pane/);

  confirm = false;
  await text('send_to_pane', { pane: 2, message: 'go' });
  await new Promise((r) => setTimeout(r, 300));
  assert.deepStrictEqual(writes.at(-1), ['B', '\r']);

  writeJsonl(transcript, [
    { timestamp: new Date().toISOString(), type: 'event_msg', payload: { type: 'user_message', message: 'go' } },
    { type: 'event_msg', payload: { type: 'agent_message', message: '看起來沒問題' } },
    { type: 'event_msg', payload: { type: 'task_complete' } },
  ]);
  assert.strictEqual(await text('read_pane', { pane: 2 }), '看起來沒問題');
  assert.strictEqual(await text('wait_for_reply', { pane: 2, timeout_sec: 5 }), '看起來沒問題');

  for (let i = 2; i < HOP_LIMIT; i++) await text('send_to_pane', { pane: 2, message: `m${i}` });
  assert.match(await text('send_to_pane', { pane: 2, message: 'too many' }), /Limit reached/);

  // token 錯誤會被拒絕
  const bad = mcpClient({ ...bridge.envFor('A'), MULTI_AGENT_TOKEN: 'nope' });
  assert.match((await bad.call('tools/call', { name: 'list_panes', arguments: {} })).result.content[0].text, /bad token/);
  bad.close();
  c.close();
  bridge.stop();
});

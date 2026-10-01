'use strict';
const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { tmpdir } = require('./helpers');
const { Bridge } = require('../src/main/bridge');
const { removeCodexBridgeConfig } = require('../src/main/codexConfig');
const { Store } = require('../src/main/store');
const cs = require('../src/main/claudeSessions');

const SCRIPT = path.join(__dirname, '..', 'src', 'bridge', 'statusline.js');

function runStatusline(env, input) {
  return new Promise((resolve) => {
    const c = spawn(process.execPath, [SCRIPT], { env: { ...process.env, ...env } });
    let out = '';
    c.stdout.on('data', (d) => (out += d));
    c.on('exit', () => resolve(out));
    c.stdin.end(JSON.stringify(input));
  });
}

const SAMPLE = {
  session_id: 'new-session',
  transcript_path: '/x/new-session.jsonl',
  model: { id: 'claude-opus-5-5', display_name: 'Opus' },
  context_window: { total_input_tokens: 412000, context_window_size: 1000000, used_percentage: 41.2 },
  rate_limits: { five_hour: { used_percentage: 30, resets_at: 1790000000 } },
};

test('statusline 把 Claude 的狀態回報給 bridge，並照樣輸出使用者原本的 statusline', async () => {
  const got = [];
  const panes = new Map([['P1', { kind: 'claude', cwd: '/p', sessionId: 'old', profileId: 'default' }]]);
  const bridge = new Bridge({ ptys: {}, panes, askRenderer: async () => [], settings: () => ({}), transcriptFile: () => null, onStatus: (id, s) => got.push([id, s]) });
  await bridge.start();
  const out = await runStatusline({ ...bridge.envFor('P1'), MULTI_AGENT_USER_STATUSLINE: 'echo my-status' }, SAMPLE);
  assert.strictEqual(out.trim(), 'my-status');
  assert.strictEqual(got.length, 1);
  assert.strictEqual(got[0][0], 'P1');
  assert.strictEqual(got[0][1].session_id, 'new-session');
  assert.strictEqual(got[0][1].context_window.total_input_tokens, 412000);
  bridge.stop();
});

test('statusline 在窗格外執行時什麼都不做', async () => {
  const out = await runStatusline({ MULTI_AGENT_BRIDGE: '', MULTI_AGENT_USER_STATUSLINE: '' }, SAMPLE);
  assert.strictEqual(out, '');
});

test('移除舊版寫進 Codex config.toml 的窗格互通區塊，其他設定不動', () => {
  const home = tmpdir();
  const cfg = path.join(home, 'config.toml');
  fs.writeFileSync(cfg, 'model = "gpt-5"\n\n[mcp_servers.multi-agent]\ncommand = "node"\nargs = ["/old/mcp.js"]\nenv_vars = ["MULTI_AGENT_BRIDGE"]\n\n[mcp_servers.other]\ncommand = "x"\n');
  assert.strictEqual(removeCodexBridgeConfig(home), true);
  const s = fs.readFileSync(cfg, 'utf8');
  assert.doesNotMatch(s, /multi-agent|old/);
  assert.match(s, /^model = "gpt-5"/);
  assert.match(s, /\[mcp_servers\.other\]\ncommand = "x"/);
  assert.strictEqual(removeCodexBridgeConfig(home), false);
  assert.strictEqual(removeCodexBridgeConfig(tmpdir()), false);
});

test('設定遷移：舊檔的 bridgeConfirm=true 改成預設不用確認，只做一次', () => {
  const dir = tmpdir();
  fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify({ settings: { bridgeConfirm: true } }));
  const s = new Store(dir);
  assert.strictEqual(s.data.settings.bridgeConfirm, false);
  s.data.settings.bridgeConfirm = true;
  s.save();
  assert.strictEqual(new Store(dir).data.settings.bridgeConfirm, true);
});

test('context window：優先用 Claude 回報過的模型大小', () => {
  cs.setKnownWindows({ 'claude-opus-5-5': 1000000 });
  const c = cs.contextFromEntries([{ type: 'assistant', message: { model: 'claude-opus-5-5', usage: { input_tokens: 5, cache_read_input_tokens: 20000 } } }]);
  assert.strictEqual(c.window, 1000000);
  assert.strictEqual(Math.round(c.pct * 10) / 10, 2);
  cs.setKnownWindows({});
});

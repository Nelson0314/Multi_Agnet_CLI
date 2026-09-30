'use strict';
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const { tmpdir, writeJsonl } = require('./helpers');
const cx = require('../src/main/codexSessions');

function rollout(home, id, cwd, { source = 'cli', ts = '2026-09-30T10:00:00Z', limits = true } = {}) {
  const f = path.join(home, 'sessions', '2026', '09', '30', `rollout-2026-09-30T10-00-00-${id}.jsonl`);
  writeJsonl(f, [
    { timestamp: ts, type: 'session_meta', payload: { id, cwd, source, originator: 'codex_cli_rs', timestamp: ts } },
    { timestamp: ts, type: 'event_msg', payload: { type: 'user_message', message: '<environment_context>x</environment_context>' } },
    { timestamp: ts, type: 'event_msg', payload: { type: 'user_message', message: '修好登入 bug' } },
    { timestamp: ts, type: 'event_msg', payload: { type: 'agent_message', message: '已修正' } },
    {
      timestamp: ts,
      type: 'response_item',
      payload: { type: 'custom_tool_call', name: 'apply_patch', input: '*** Begin Patch\n*** Update File: src/login.ts\n@@' },
    },
    {
      timestamp: ts,
      type: 'event_msg',
      payload: {
        type: 'token_count',
        info: { last_token_usage: { input_tokens: 54400 }, model_context_window: 272000 },
        rate_limits: limits
          ? { primary: { used_percent: 42, window_minutes: 300, resets_in_seconds: 3600 }, secondary: { used_percent: 10, window_minutes: 10080, resets_at: 1790000000 } }
          : null,
      },
    },
  ]);
  return f;
}

test('listSessions 只列出同一個 cwd，並標記子 agent', () => {
  const home = tmpdir();
  rollout(home, 'aaa', '/proj');
  rollout(home, 'bbb', '/proj', { source: 'mcp' });
  rollout(home, 'ccc', '/other');
  const list = cx.listSessions('/proj', home);
  assert.deepStrictEqual(list.map((s) => s.id).sort(), ['aaa', 'bbb']);
  const a = list.find((s) => s.id === 'aaa');
  assert.strictEqual(a.title, '修好登入 bug');
  assert.strictEqual(a.messageCount, 1);
  assert.strictEqual(a.spawnedByAgent, false);
  assert.strictEqual(list.find((s) => s.id === 'bbb').spawnedByAgent, true);
  assert.strictEqual(Math.round(a.context.pct), 20);
});

test('getRateLimits 讀出 5 小時 / 每週額度', () => {
  const home = tmpdir();
  rollout(home, 'aaa', '/proj');
  const rl = cx.getRateLimits(home);
  assert.strictEqual(rl.primary.pct, 42);
  assert.strictEqual(rl.primary.windowMinutes, 300);
  assert.strictEqual(rl.primary.resetsAt, Date.parse('2026-09-30T10:00:00Z') + 3600 * 1000);
  assert.strictEqual(rl.secondary.resetsAt, 1790000000 * 1000);
});

test('findNewSession 找出新開的 session', () => {
  const home = tmpdir();
  const since = Date.now();
  rollout(home, 'new1', '/proj', { ts: new Date(since + 1000).toISOString() });
  assert.strictEqual(cx.findNewSession('/proj', since, new Set(), home), 'new1');
  assert.strictEqual(cx.findNewSession('/proj', since, new Set(['new1']), home), null);
});

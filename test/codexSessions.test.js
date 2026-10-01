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

// Codex 0.159 的實際格式：對話訊息改成 item_completed（UserMessage / AgentMessage），不再寫 user_message / agent_message
function newFormatRollout(home, id, cwd, { dup = false } = {}) {
  const ts = '2026-10-01T17:35:53.580Z';
  const f = path.join(home, 'sessions', '2026', '10', '01', `rollout-2026-10-01T17-35-53-${id}.jsonl`);
  const entries = [
    { timestamp: ts, ordinal: 0, type: 'session_meta', payload: { session_id: id, id, timestamp: ts, cwd, originator: 'codex-tui', cli_version: '0.159.3', source: 'cli' } },
    { timestamp: ts, ordinal: 1, type: 'event_msg', payload: { type: 'task_started', turn_id: 't1', model_context_window: 258400 } },
    { timestamp: ts, ordinal: 2, type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '<environment_context>\n  <cwd>/p</cwd>\n</environment_context>' }] } },
    { timestamp: ts, ordinal: 3, type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '請幫我看一下登入流程' }] } },
    { timestamp: ts, ordinal: 4, type: 'event_msg', payload: { type: 'item_completed', thread_id: id, turn_id: 't1', item: { type: 'UserMessage', id: 'u1', content: [{ type: 'text', text: '請幫我看一下登入流程', text_elements: [] }] } } },
    ...(dup ? [{ timestamp: ts, type: 'event_msg', payload: { type: 'user_message', message: '請幫我看一下登入流程' } }] : []),
    { timestamp: ts, ordinal: 5, type: 'event_msg', payload: { type: 'item_completed', thread_id: id, turn_id: 't1', item: { type: 'AgentMessage', id: 'm1', content: [{ type: 'Text', text: '登入流程在 src/auth。' }] } } },
    { timestamp: ts, ordinal: 6, type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '登入流程在 src/auth。' }] } },
    {
      timestamp: ts,
      ordinal: 7,
      type: 'event_msg',
      payload: {
        type: 'token_count',
        info: { last_token_usage: { input_tokens: 1200, output_tokens: 30, reasoning_output_tokens: 0, total_tokens: 1230 }, model_context_window: 258400 },
        rate_limits: { limit_id: 'codex', primary: { used_percent: 37.5, window_minutes: 300, resets_at: null }, secondary: { used_percent: 12, window_minutes: 10080, resets_at: null } },
      },
    },
    { timestamp: ts, ordinal: 8, type: 'event_msg', payload: { type: 'task_complete', turn_id: 't1', last_agent_message: '登入流程在 src/auth。' } },
  ];
  writeJsonl(f, entries);
  return { f, entries };
}

test('新版 Codex（item_completed）的 session 也會列出，標題、則數、context、額度都讀得到', () => {
  const home = tmpdir();
  newFormatRollout(home, '01a0f889-7688-7b30-89f8-11575bb0a33e', '/proj');
  const [s] = cx.listSessions('/proj', home);
  assert.ok(s, 'session 應該出現在清單');
  assert.strictEqual(s.title, '請幫我看一下登入流程');
  assert.strictEqual(s.messageCount, 1);
  assert.strictEqual(s.spawnedByAgent, false);
  assert.strictEqual(s.context.tokens, 1230);
  assert.strictEqual(cx.getSessionRateLimits(s.id, home).primary.pct, 37.5);
});

test('同一則訊息新舊兩種寫法都出現時只算一次', () => {
  const home = tmpdir();
  newFormatRollout(home, 'dup-1', '/proj', { dup: true });
  assert.strictEqual(cx.listSessions('/proj', home)[0].messageCount, 1);
});

test('窗格互通讀 Codex 回覆：新版的 AgentMessage 與 task_complete', () => {
  const { codexLastReply } = require('../src/main/bridge');
  const { entries } = newFormatRollout(tmpdir(), 'r1', '/proj');
  assert.deepStrictEqual(codexLastReply(entries), { promptAt: Date.parse('2026-10-01T17:35:53.580Z'), text: '登入流程在 src/auth。', done: true });
});

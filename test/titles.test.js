'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { tmpdir, writeJsonl, user } = require('./helpers');
const titles = require('../src/main/titles');
const cs = require('../src/main/claudeSessions');
const cx = require('../src/main/codexSessions');

test('Claude：transcript 還沒建立時回傳 false；建立後寫入 custom-title，listSessions 讀得到', () => {
  const root = path.join(tmpdir(), 'projects');
  const cwd = '/p';
  const file = path.join(root, cs.encodeProjectPath(cwd), 'sid.jsonl');
  assert.strictEqual(titles.setClaudeTitle(file, 'sid', 'API 重構'), false);
  writeJsonl(file, [user('hi', { cwd })]);
  assert.strictEqual(titles.setClaudeTitle(file, 'sid', 'API 重構'), true);
  assert.strictEqual(titles.setClaudeTitle(file, 'sid', 'API 重構'), true); // 不重複寫
  const lines = fs.readFileSync(file, 'utf8').trim().split('\n');
  assert.strictEqual(lines.length, 2);
  assert.deepStrictEqual(JSON.parse(lines[1]), { type: 'custom-title', customTitle: 'API 重構', sessionId: 'sid' });
  assert.strictEqual(cs.listSessions(cwd, root)[0].title, 'API 重構');
});

test('Codex：寫入 session_index.jsonl，最新一筆優先，列表顯示名稱', () => {
  const home = tmpdir();
  const f = path.join(home, 'sessions', '2026', '09', '30', 'rollout-2026-09-30T10-00-00-abc.jsonl');
  writeJsonl(f, [
    { timestamp: '2026-09-30T10:00:00Z', type: 'session_meta', payload: { id: 'abc', cwd: '/p' } },
    { type: 'event_msg', payload: { type: 'user_message', message: '第一句' } },
  ]);
  titles.setCodexTitle(home, 'abc', '舊名');
  titles.setCodexTitle(home, 'abc', 'Review 中介層');
  const rows = fs.readFileSync(path.join(home, 'session_index.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.deepStrictEqual(rows.map((r) => [r.id, r.thread_name]), [['abc', '舊名'], ['abc', 'Review 中介層']]);
  assert.ok(rows[1].updated_at);
  assert.strictEqual(cx.listSessions('/p', home)[0].title, 'Review 中介層');
});

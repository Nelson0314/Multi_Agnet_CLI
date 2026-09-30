'use strict';
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const { tmpdir, writeJsonl, user, assistant } = require('./helpers');
const cs = require('../src/main/claudeSessions');

function setup() {
  const root = path.join(tmpdir(), 'projects');
  const cwd = '/home/me/my_proj.v2';
  const dir = path.join(root, cs.encodeProjectPath(cwd));
  const base = { cwd, sessionId: 's1' };
  writeJsonl(path.join(dir, 's1.jsonl'), [
    { type: 'queue-operation', operation: 'enqueue' },
    user('<command-name>/clear</command-name>', base),
    user('幫我重構 API 層', base),
    assistant('好的', { input_tokens: 2, cache_creation_input_tokens: 1000, cache_read_input_tokens: 49000, output_tokens: 10 }, base),
    { type: 'assistant', isSidechain: true, message: { usage: { input_tokens: 999999 } }, ...base },
    { type: 'ai-title', aiTitle: 'API 重構', sessionId: 's1' },
    user('再加上測試', base),
  ]);
  writeJsonl(path.join(dir, 's2.jsonl'), [
    user('第一個問題', { cwd, sessionId: 's2' }),
    assistant('答', { input_tokens: 250000 }, { cwd }),
    { type: 'custom-title', customTitle: '我的名字', sessionId: 's2' },
    { type: 'ai-title', aiTitle: '自動標題', sessionId: 's2' },
  ]);
  // 沒有任何真實使用者輸入的 session 不列出
  writeJsonl(path.join(dir, 's3.jsonl'), [{ type: 'queue-operation', cwd }]);
  return { root, cwd, dir };
}

test('encodeProjectPath 把非英數字元換成 -', () => {
  assert.strictEqual(cs.encodeProjectPath('/home/user/Multi_Agnet_CLI'), '-home-user-Multi-Agnet-CLI');
  assert.strictEqual(cs.encodeProjectPath('C:\\Users\\me\\proj'), 'C--Users-me-proj');
});

test('listSessions：標題優先序、過濾 slash command、忽略 sidechain', () => {
  const { root, cwd } = setup();
  const list = cs.listSessions(cwd, root);
  assert.strictEqual(list.length, 2);
  const s1 = list.find((s) => s.id === 's1');
  const s2 = list.find((s) => s.id === 's2');
  assert.strictEqual(s1.title, 'API 重構');
  assert.strictEqual(s1.firstPrompt, '幫我重構 API 層');
  assert.strictEqual(s1.lastPrompt, '再加上測試');
  assert.strictEqual(s1.messageCount, 2);
  assert.strictEqual(s1.context.tokens, 50002);
  assert.strictEqual(s1.context.window, 200000);
  assert.strictEqual(s2.title, '我的名字');
  // 超過 200k 自動視為 1M context
  assert.strictEqual(s2.context.window, 1000000);
});

test('findProjectDir 在編碼不符時用 jsonl 內的 cwd 比對', () => {
  const root = path.join(tmpdir(), 'projects');
  writeJsonl(path.join(root, 'weird-name', 'x.jsonl'), [user('hi', { cwd: '/a/b' })]);
  assert.strictEqual(cs.findProjectDir(root, '/a/b'), path.join(root, 'weird-name'));
  assert.strictEqual(cs.listProjects(root)[0].cwd, '/a/b');
});

test('getContext：compact 之後歸零', () => {
  const { root, cwd, dir } = setup();
  writeJsonl(path.join(dir, 's4.jsonl'), [
    user('x', { cwd }),
    assistant('y', { input_tokens: 150000 }),
    { type: 'system', subtype: 'compact_boundary' },
  ]);
  assert.strictEqual(cs.getContext(cwd, 's4', root).tokens, 0);
  assert.strictEqual(cs.getContext(cwd, 's1', root).tokens, 50002);
  assert.strictEqual(cs.getContext(cwd, 'nope', root), null);
});

test('listSessions 比照 claude -r：包含子資料夾、claude -w worktree、只有 slash 指令的 session', () => {
  const root = path.join(tmpdir(), 'projects');
  const cwd = '/home/me/proj';
  const put = (dirCwd, id, entries) => writeJsonl(path.join(root, cs.encodeProjectPath(dirCwd), `${id}.jsonl`), entries);
  put(cwd, 'main', [user('主專案', { cwd })]);
  put(`${cwd}/src`, 'sub', [user('在子資料夾', { cwd: `${cwd}/src` })]);
  put(`${cwd}/.claude/worktrees/feat`, 'wt', [user('worktree', { cwd: `${cwd}/.claude/worktrees/feat` })]);
  put(cwd, 'cmd', [user('<command-name>/review</command-name>', { cwd }), assistant('ok', { input_tokens: 1 }, { cwd })]);
  put('/home/me/proj-other', 'other', [user('別的專案', { cwd: '/home/me/proj-other' })]);
  put(cwd, 'empty', [{ type: 'file-history-snapshot', cwd }]);
  const list = cs.listSessions(cwd, root);
  assert.deepStrictEqual(list.map((s) => s.id).sort(), ['cmd', 'main', 'sub', 'wt']);
  assert.strictEqual(list.find((s) => s.id === 'cmd').title, '/review');
  assert.strictEqual(list.find((s) => s.id === 'sub').cwd, `${cwd}/src`);
  assert.ok(cs.sessionFile(cwd, 'sub', root).endsWith(path.join(cs.encodeProjectPath(`${cwd}/src`), 'sub.jsonl')));
});

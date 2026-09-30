'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { tmpdir, writeJsonl, user, assistant } = require('./helpers');
const cs = require('../src/main/claudeSessions');
const { createHandoff } = require('../src/main/handoff');

test('Claude → Codex 交接文件包含目標、待辦、修改檔案與 git 狀態', () => {
  const cwd = tmpdir();
  execFileSync('git', ['init', '-q'], { cwd });
  fs.writeFileSync(path.join(cwd, 'a.txt'), 'x');
  const root = path.join(tmpdir(), 'projects');
  writeJsonl(path.join(root, cs.encodeProjectPath(cwd), 'sid.jsonl'), [
    user('做一個登入頁', { cwd }),
    {
      type: 'assistant',
      message: {
        content: [
          { type: 'text', text: '開始' },
          { type: 'tool_use', name: 'Write', input: { file_path: path.join(cwd, 'a.txt') } },
          { type: 'tool_use', name: 'TodoWrite', input: { todos: [{ content: '寫表單', status: 'completed' }, { content: '接 API', status: 'in_progress' }] } },
        ],
        usage: { input_tokens: 10 },
      },
    },
    assistant('表單完成', { input_tokens: 20 }),
  ]);
  const r = createHandoff({ fromKind: 'claude', toKind: 'codex', sessionId: 'sid', cwd, sessionName: '登入頁', claudeProjectsRoot: root });
  const md = fs.readFileSync(r.file, 'utf8');
  assert.match(md, /做一個登入頁/);
  assert.match(md, /- \[x\] 寫表單/);
  assert.match(md, /- \[ \] 接 API（進行中）/);
  assert.match(md, /^- a\.txt$/m);
  assert.match(md, /\?\? a\.txt/);
  assert.match(r.prompt, /\.multi-agent\/handoffs\//);
  // 交接目錄被排除在 git 之外
  assert.match(fs.readFileSync(path.join(cwd, '.git', 'info', 'exclude'), 'utf8'), /^\.multi-agent\/$/m);
  assert.doesNotMatch(execFileSync('git', ['status', '--short'], { cwd, encoding: 'utf8' }), /multi-agent/);
});

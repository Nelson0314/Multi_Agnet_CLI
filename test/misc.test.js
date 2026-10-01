'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { LIMIT_PATTERNS, ANSI, commandFor } = require('../src/main/ptyManager');
const { normalizeUsage } = require('../src/main/usage');
const { Store } = require('../src/main/store');
const { tmpdir } = require('./helpers');

const hit = (s) => LIMIT_PATTERNS.some((re) => re.test(s.replace(ANSI, '')));

test('額度用完訊息偵測', () => {
  assert.ok(hit('\x1b[31mClaude usage limit reached.\x1b[0m Your limit will reset at 3pm'));
  assert.ok(hit("You've hit your usage limit. Upgrade to Pro"));
  assert.ok(hit('You have hit your usage limit'));
  assert.ok(hit('5-hour limit reached ∙ resets 3pm'));
  // Claude Code 目前的寫法：session = 5 小時額度，另有 weekly、Opus 等
  assert.ok(hit("You've hit your session limit · resets 3pm (Asia/Taipei)"));
  assert.ok(hit('You’ve hit your weekly limit · resets Mon 9am'));
  assert.ok(hit("You've hit your Opus limit · resets Oct 3"));
  assert.ok(hit("You've hit your limit · resets 3am"));
  assert.ok(hit('Usage limit reached · continuing automatically at 3pm · esc to cancel'));
  // fast mode 的限制只是改回一般速度，不算額度用完
  assert.ok(!hit("You've hit your fast limit"));
  assert.ok(!hit('Fast limit reached and temporarily disabled · resets in 5m'));
  assert.ok(!hit('I will limit the number of retries'));
});

test('commandFor 正確跳脫參數', () => {
  if (process.platform === 'win32') return;
  const c = commandFor('claude', ['-n', "it's 名字"]);
  assert.deepStrictEqual(c.args.slice(0, 3), ['-l', '-i', '-c']);
  assert.strictEqual(c.args[3], `exec claude '-n' 'it'\\''s 名字'`);
});

test('normalizeUsage 解析 OAuth usage 回應', () => {
  const u = normalizeUsage({ five_hour: { utilization: 37.5, resets_at: '2026-09-30T15:00:00Z' }, seven_day: { utilization: 12, resets_at: null }, seven_day_opus: null });
  assert.strictEqual(u.fiveHour.pct, 37.5);
  assert.strictEqual(u.fiveHour.resetsAt, Date.parse('2026-09-30T15:00:00Z'));
  assert.strictEqual(u.sevenDay.resetsAt, null);
  assert.strictEqual(u.sevenDayOpus, null);
});

test('Store 保留預設值並持久化', () => {
  const dir = tmpdir();
  const s = new Store(dir);
  assert.strictEqual(s.data.profiles[0].id, 'default');
  assert.strictEqual(s.data.codexProfiles[0].id, 'default');
  assert.strictEqual(s.data.activeCodexProfile, 'default');
  s.touchProject('/p');
  s.project('/p').panes.push({ kind: 'claude', sessionId: 'x' });
  s.save();
  const s2 = new Store(dir);
  assert.strictEqual(s2.data.lastProject, '/p');
  assert.strictEqual(s2.data.projects['/p'].panes[0].sessionId, 'x');
  assert.strictEqual(s2.data.settings.fallback, 'ask');
});

test('buildEnv：null 會移除變數，預設宣告 truecolor', () => {
  const { buildEnv } = require('../src/main/ptyManager');
  assert.strictEqual(buildEnv({}).COLORTERM, 'truecolor');
  assert.ok(!('COLORTERM' in buildEnv({ COLORTERM: null })));
  assert.strictEqual(buildEnv({ CLAUDE_CONFIG_DIR: '/x' }).CLAUDE_CONFIG_DIR, '/x');
});

test('shellCommand：Windows 優先 pwsh，其次 powershell.exe；其他平台用 $SHELL', () => {
  const { shellCommand } = require('../src/main/ptyManager');
  const env = { ProgramFiles: 'C:\\Program Files' };
  assert.deepStrictEqual(shellCommand('win32', env, () => true), { cmd: 'C:\\Program Files\\PowerShell\\7\\pwsh.exe', args: ['-NoLogo'] });
  assert.deepStrictEqual(shellCommand('win32', env, () => false), { cmd: 'powershell.exe', args: ['-NoLogo'] });
  assert.deepStrictEqual(shellCommand('darwin', { SHELL: '/bin/zsh' }), { cmd: '/bin/zsh', args: ['-l'] });
});

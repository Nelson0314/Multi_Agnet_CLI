'use strict';
// Claude / Codex 帳號分開：設定遷移、換帳號時的 .claude.json 同步、Codex 帳號共用 session 歷史
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { tmpdir, writeJsonl } = require('./helpers');

// 預設的 ~/.claude 與 ~/.codex 指到暫存資料夾
const HOME = tmpdir();
process.env.HOME = HOME;
process.env.USERPROFILE = HOME;
process.env.CODEX_HOME = path.join(HOME, '.codex');

const profiles = require('../src/main/profiles');
const { Store } = require('../src/main/store');
const codexSessions = require('../src/main/codexSessions');

test('設定遷移：舊版掛在 Claude 帳號底下的 CODEX_HOME 變成獨立的 Codex 帳號，移除 Codex 交接順序', () => {
  const dir = tmpdir();
  fs.writeFileSync(
    path.join(dir, 'state.json'),
    JSON.stringify({
      settingsVersion: 2,
      activeProfile: 'p1',
      profiles: [
        { id: 'default', name: null, claudeConfigDir: null, codexHome: null, shareHistory: true },
        { id: 'p1', name: 'Work', claudeConfigDir: '/x/claude', codexHome: '/x/codex', shareHistory: true },
      ],
      settings: { fallback: 'auto', fallbackOrder: ['codex', 'other-profile'] },
    }),
  );
  const s = new Store(dir);
  assert.deepStrictEqual(
    s.data.codexProfiles.map((p) => [p.id, p.codexHome]),
    [
      ['default', null],
      ['p1', '/x/codex'],
    ],
  );
  assert.strictEqual(s.data.activeCodexProfile, 'p1');
  assert.ok(s.data.profiles.every((p) => !('codexHome' in p)));
  assert.ok(!('fallbackOrder' in s.data.settings));
  assert.strictEqual(s.data.settings.fallback, 'auto');
  assert.strictEqual(s.data.settings.limitContinue, true);
  // 舊的 Codex 窗格紀錄 profileId 是 p1，對應到同一個 CODEX_HOME；找不到的 id 回到預設
  assert.strictEqual(s.codexProfile('p1').codexHome, '/x/codex');
  assert.strictEqual(s.codexProfile('nope').id, 'default');
  s.save();
  assert.strictEqual(new Store(dir).data.codexProfiles.length, 2); // 只遷移一次
});

test('換到另一個 Claude 帳號前，補上預設帳號的信任、MCP server 與首次設定，不覆蓋目標帳號自己的設定', () => {
  const dir = tmpdir();
  const src = path.join(dir, 'src.json');
  const dst = path.join(dir, 'dst.json');
  fs.writeFileSync(
    src,
    JSON.stringify({
      oauthAccount: { emailAddress: 'a@example.com' },
      hasCompletedOnboarding: true,
      theme: 'light',
      mcpServers: { shared: { command: 'a' }, mine: { command: 'from-default' } },
      projects: {
        '/work': { hasTrustDialogAccepted: true, allowedTools: ['Bash(ls)'], mcpServers: { local: { command: 'l' } } },
        '/work/app': { hasCompletedProjectOnboarding: true },
        '/other': { hasTrustDialogAccepted: true },
      },
    }),
  );
  fs.writeFileSync(dst, JSON.stringify({ oauthAccount: { emailAddress: 'b@example.com' }, theme: 'dark', mcpServers: { mine: { command: 'b' } } }));
  assert.strictEqual(profiles.syncClaudeState(src, dst, ['/work/app']), true);
  const d = JSON.parse(fs.readFileSync(dst, 'utf8'));
  assert.strictEqual(d.oauthAccount.emailAddress, 'b@example.com'); // 登入身分不動
  assert.strictEqual(d.hasCompletedOnboarding, true);
  assert.strictEqual(d.theme, 'dark'); // 目標自己的設定優先
  assert.deepStrictEqual(d.mcpServers, { mine: { command: 'b' }, shared: { command: 'a' } });
  assert.strictEqual(d.projects['/work'].hasTrustDialogAccepted, true); // 上層資料夾的信任
  assert.deepStrictEqual(d.projects['/work'].mcpServers, { local: { command: 'l' } });
  assert.strictEqual(d.projects['/work/app'].hasCompletedProjectOnboarding, true);
  assert.ok(!d.projects['/other']); // 無關的專案不複製
  // 再跑一次沒有變化，不重寫檔案
  assert.strictEqual(profiles.syncClaudeState(src, dst, ['/work/app']), false);
  // 來源不存在時什麼都不做
  assert.strictEqual(profiles.syncClaudeState(path.join(dir, 'missing.json'), dst, ['/work']), false);
});

test('預設帳號與不共用歷史的帳號不做同步', () => {
  assert.strictEqual(profiles.syncSharedClaudeState(profiles.defaultProfile(), ['/x']), false);
  assert.strictEqual(profiles.syncSharedClaudeState({ id: 'p', claudeConfigDir: path.join(tmpdir(), 'c'), shareHistory: false }, ['/x']), false);
});

test('新的 Claude 帳號共用 session 歷史；新的 Codex 帳號共用 sessions、名稱與設定，但登入資訊分開', () => {
  const base = tmpdir();
  fs.mkdirSync(path.join(HOME, '.claude', 'projects'), { recursive: true });
  fs.writeFileSync(path.join(HOME, '.claude', 'settings.json'), '{}');
  const c = profiles.createProfile(base, 'Work', { shareHistory: true });
  assert.strictEqual(fs.realpathSync(path.join(c.claudeConfigDir, 'projects')), fs.realpathSync(path.join(HOME, '.claude', 'projects')));
  assert.ok(fs.existsSync(path.join(c.claudeConfigDir, 'settings.json')));
  assert.deepStrictEqual(profiles.claudeEnv(c), { CLAUDE_CONFIG_DIR: c.claudeConfigDir });
  assert.deepStrictEqual(profiles.claudeEnv(profiles.defaultProfile()), {});

  const codexHome = process.env.CODEX_HOME;
  fs.mkdirSync(codexHome, { recursive: true });
  fs.writeFileSync(path.join(codexHome, 'config.toml'), 'model = "gpt-5"\n');
  fs.writeFileSync(path.join(codexHome, 'auth.json'), '{"OPENAI_API_KEY":"sk-default"}');
  const x = profiles.createCodexProfile(base, 'Personal', { shareHistory: true });
  assert.ok(x.id.startsWith('c'));
  assert.deepStrictEqual(profiles.codexEnv(x), { CODEX_HOME: x.codexHome });
  assert.strictEqual(fs.realpathSync(path.join(x.codexHome, 'sessions')), fs.realpathSync(path.join(codexHome, 'sessions')));
  assert.strictEqual(fs.readFileSync(path.join(x.codexHome, 'config.toml'), 'utf8'), 'model = "gpt-5"\n');
  assert.ok(fs.existsSync(path.join(codexHome, 'session_index.jsonl'))); // 建立後才連得過去
  assert.ok(!fs.existsSync(path.join(x.codexHome, 'auth.json'))); // 登入身分不共用
  // 共用 sessions：在新帳號寫的 session，預設帳號也找得到
  const f = path.join(x.codexHome, 'sessions', '2026', '10', '01', 'rollout-2026-10-01T10-00-00-abc.jsonl');
  writeJsonl(f, [{ type: 'session_meta', payload: { id: 'abc', cwd: '/p' } }]);
  assert.ok(codexSessions.findSessionFile('abc', codexHome));

  const solo = profiles.createCodexProfile(base, 'Solo', { shareHistory: false });
  assert.ok(!fs.existsSync(path.join(solo.codexHome, 'sessions')));
});

test('Codex 帳號資訊：從 auth.json 的 id_token 讀 email 與方案；只有 API key 時標示出來', () => {
  const home = tmpdir();
  const claims = { email: 'me@example.com', 'https://api.openai.com/auth': { chatgpt_plan_type: 'pro' } };
  const jwt = `h.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.s`;
  fs.writeFileSync(path.join(home, 'auth.json'), JSON.stringify({ tokens: { id_token: jwt, access_token: 'a' } }));
  assert.deepStrictEqual(profiles.readCodexAccount({ codexHome: home }), { email: 'me@example.com', plan: 'pro', apiKey: false });
  fs.writeFileSync(path.join(home, 'auth.json'), JSON.stringify({ OPENAI_API_KEY: 'sk-x' }));
  assert.deepStrictEqual(profiles.readCodexAccount({ codexHome: home }), { email: null, plan: null, apiKey: true });
  assert.deepStrictEqual(profiles.readCodexAccount({ codexHome: tmpdir() }), { email: null, plan: null, apiKey: false });
});

test('單一 Codex session 的額度：取這個 session 最新的 token_count', () => {
  const home = tmpdir();
  writeJsonl(path.join(home, 'sessions', '2026', '10', '01', 'rollout-x-sid1.jsonl'), [
    { type: 'session_meta', payload: { id: 'sid1', cwd: '/p' } },
    { type: 'event_msg', timestamp: '2026-10-01T10:00:00Z', payload: { type: 'token_count', rate_limits: { primary: { used_percent: 40, window_minutes: 300 } } } },
    { type: 'event_msg', timestamp: '2026-10-01T11:00:00Z', payload: { type: 'token_count', rate_limits: { primary: { used_percent: 100, window_minutes: 300 }, secondary: { used_percent: 70 } } } },
  ]);
  const rl = codexSessions.getSessionRateLimits('sid1', home);
  assert.strictEqual(rl.primary.pct, 100);
  assert.strictEqual(rl.secondary.pct, 70);
  assert.strictEqual(rl.observedAt, Date.parse('2026-10-01T11:00:00Z'));
  assert.strictEqual(codexSessions.getSessionRateLimits('missing', home), null);
});

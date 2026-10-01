'use strict';
// Claude 與 Codex 共用指示：Codex 窗格帶上 CLAUDE.md、@import、rules、skills、MCP；Claude 窗格帶上 AGENTS.md
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { tmpdir } = require('./helpers');

const HOME = tmpdir();
process.env.HOME = HOME;
process.env.USERPROFILE = HOME;
const team = require('../src/main/teamContext');

function write(f, text) {
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, text);
}

// 一個專案：根目錄有 .git、CLAUDE.md（@import 了 docs/style.md 和 AGENTS.md）、AGENTS.md、規則、skills
function fixture() {
  const claudeDir = path.join(HOME, `.claude-${Math.random().toString(36).slice(2)}`);
  const codexHome = path.join(HOME, `.codex-${Math.random().toString(36).slice(2)}`);
  const root = path.join(tmpdir(), 'proj');
  fs.mkdirSync(path.join(root, '.git'), { recursive: true });
  write(path.join(claudeDir, 'CLAUDE.md'), 'Global: answer in Traditional Chinese. G_MARK');
  write(path.join(root, 'CLAUDE.md'), '# Rules\nUse pnpm. P_MARK\nSee @docs/style.md and @AGENTS.md\n\n```\n@not/a/real/import.md\n```\nAlso `@code/span.md`.\n');
  write(path.join(root, 'docs', 'style.md'), 'Style: 2 spaces. S_MARK');
  write(path.join(root, 'AGENTS.md'), 'Shared rules for every agent. A_MARK');
  write(path.join(root, 'CLAUDE.local.md'), 'My sandbox URL is local. L_MARK');
  write(path.join(root, '.claude', 'rules', 'testing.md'), 'Always run npm test. R_MARK');
  write(path.join(root, '.claude', 'rules', 'api.md'), '---\npaths: src/api/**\n---\nAPI rule. API_MARK');
  write(path.join(claudeDir, 'skills', 'deploy', 'SKILL.md'), '---\nname: deploy\ndescription: Deploy to staging\n---\nsteps');
  write(path.join(root, '.claude', 'skills', 'lint', 'SKILL.md'), '---\nname: lint\ndescription: Run the linters\n---\nx');
  write(path.join(root, '.agents', 'skills', 'lint', 'SKILL.md'), '---\nname: lint\ndescription: Codex already has this\n---\nx');
  write(path.join(codexHome, 'AGENTS.md'), 'Codex global: prefer small commits. CG_MARK');
  const cwd = path.join(root, 'src');
  fs.mkdirSync(cwd, { recursive: true });
  return { claudeDir, codexHome, root, cwd };
}

test('@import：相對路徑、~/，略過 code block 與 inline code', () => {
  const { root } = fixture();
  write(path.join(HOME, 'notes', 'n.md'), 'n');
  const f = path.join(root, 'x.md');
  write(f, 'See @docs/style.md and @~/notes/n.md.\n```\n@AGENTS.md\n```\n`@AGENTS.md` and @missing.md');
  assert.deepStrictEqual(team.importsOf(fs.readFileSync(f, 'utf8'), f), [path.join(root, 'docs', 'style.md'), path.join(HOME, 'notes', 'n.md')]);
});

test('Codex 窗格：帶上全域與專案的 CLAUDE.md、import、無條件的規則與 skills；Codex 自己會讀的 AGENTS.md 不重複', () => {
  const fx = fixture();
  const ctx = team.claudeContextForCodex({ claudeDir: fx.claudeDir, codexHome: fx.codexHome, cwd: fx.cwd });
  for (const m of ['G_MARK', 'P_MARK', 'S_MARK', 'L_MARK', 'R_MARK']) assert.match(ctx.text, new RegExp(m));
  assert.doesNotMatch(ctx.text, /A_MARK/); // AGENTS.md：Codex 本來就讀
  assert.doesNotMatch(ctx.text, /API_MARK/); // 有 paths 的規則只列出路徑
  assert.match(ctx.text, /\.claude\/rules\/api\.md applies to src\/api\/\*\*/);
  assert.match(ctx.text, /- deploy: Deploy to staging/);
  assert.doesNotMatch(ctx.text, /- lint:/); // Codex 已經有同名 skill
  assert.ok(ctx.text.indexOf('G_MARK') < ctx.text.indexOf('P_MARK')); // 全域在前，專案在後
  assert.deepStrictEqual(ctx.sources, [`~/${path.relative(HOME, path.join(fx.claudeDir, 'CLAUDE.md'))}`, 'CLAUDE.md', 'CLAUDE.local.md', '.claude/rules/testing.md']);
  assert.deepStrictEqual(ctx.skills, ['deploy']);
});

test('Claude 窗格：帶上 Codex 的全域 AGENTS.md；專案 AGENTS.md 已被 CLAUDE.md import 時不重複', () => {
  const fx = fixture();
  let ctx = team.codexContextForClaude({ claudeDir: fx.claudeDir, codexHome: fx.codexHome, cwd: fx.cwd });
  assert.match(ctx.text, /CG_MARK/);
  assert.doesNotMatch(ctx.text, /A_MARK/);
  // CLAUDE.md 沒有 import AGENTS.md 時就帶上
  write(path.join(fx.root, 'CLAUDE.md'), 'Use pnpm.');
  ctx = team.codexContextForClaude({ claudeDir: fx.claudeDir, codexHome: fx.codexHome, cwd: fx.cwd });
  assert.match(ctx.text, /A_MARK/);
  assert.deepStrictEqual(ctx.sources.slice(-1), ['AGENTS.md']);
  // 什麼都沒有時是空的
  const empty = tmpdir();
  assert.strictEqual(team.codexContextForClaude({ claudeDir: path.join(empty, 'c'), codexHome: path.join(empty, 'x'), cwd: empty }).text, '');
});

test('Claude 的 MCP server 轉成 Codex 設定：stdio 與 HTTP、展開 ${VAR}、只帶已核准的 .mcp.json、略過不支援的', () => {
  const fx = fixture();
  const claudeJsonFile = path.join(tmpdir(), 'claude.json');
  write(
    claudeJsonFile,
    JSON.stringify({
      mcpServers: {
        github: { type: 'stdio', command: 'npx', args: ['-y', '@x/github'], env: { TOKEN: '${GH_TOKEN}', MODE: '${MODE:-ro}' } },
        docs: { type: 'http', url: 'https://example.com/mcp', headers: { Authorization: 'Bearer ${API_KEY}' } },
        old: { type: 'sse', url: 'https://example.com/sse' },
        'my.server': { command: 'x' },
        shadowed: { command: 'user-level' },
      },
      projects: { [fx.root]: { enabledMcpjsonServers: ['db'], mcpServers: { shadowed: { command: 'local-level' } } } },
    }),
  );
  write(path.join(fx.root, '.mcp.json'), JSON.stringify({ mcpServers: { db: { command: 'db-mcp' }, unapproved: { command: 'nope' } } }));
  const out = team.claudeMcpServers({ claudeJsonFile, claudeDir: fx.claudeDir, cwd: fx.cwd, env: { GH_TOKEN: 'ghp_1', API_KEY: 'k' } });
  assert.deepStrictEqual(Object.keys(out).sort(), ['db', 'docs', 'github', 'shadowed']);
  assert.deepStrictEqual(out.github, { command: 'npx', args: ['-y', '@x/github'], env: { TOKEN: 'ghp_1', MODE: 'ro' } });
  assert.deepStrictEqual(out.docs, { url: 'https://example.com/mcp', http_headers: { Authorization: 'Bearer k' } });
  assert.strictEqual(out.shadowed.command, 'local-level'); // local 優先於 user
  // 每個表格只有 command 或 url 其中之一（兩個都有 Codex 會無法啟動）
  for (const t of Object.values(out)) assert.ok(!!t.command !== !!t.url);
});

test('Codex config.toml：已定義的 MCP 名稱、最上層的 developer_instructions', () => {
  const home = tmpdir();
  write(
    path.join(home, 'config.toml'),
    'model = "gpt-5"\ndeveloper_instructions = """\nBe brief.\nUse "tabs".\n"""\n\n[mcp_servers.github]\ncommand = "x"\n[mcp_servers."my.srv"]\nurl = "y"\n[profiles.p]\ndeveloper_instructions = "not top level"\n',
  );
  assert.deepStrictEqual([...team.codexMcpNames(home)].sort(), ['github', 'my.srv']);
  const text = fs.readFileSync(path.join(home, 'config.toml'), 'utf8');
  assert.strictEqual(team.topLevelString(text, 'developer_instructions'), 'Be brief.\nUse "tabs".\n');
  assert.strictEqual(team.topLevelString('developer_instructions = "a\\nb"', 'developer_instructions'), 'a\nb');
  assert.strictEqual(team.topLevelString("developer_instructions = 'C:\\x'", 'developer_instructions'), 'C:\\x');
  assert.strictEqual(team.topLevelString('[x]\ndeveloper_instructions = "no"', 'developer_instructions'), null);
});

test('TOML 值：路徑用單引號字串，含單引號或換行時改用雙引號；鍵名需要時加引號', () => {
  assert.strictEqual(team.tomlStr('C:\\Users\\me\\mcp.js'), "'C:\\Users\\me\\mcp.js'");
  assert.strictEqual(team.tomlStr("it's\nok"), '"it\'s\\nok"');
  assert.strictEqual(team.tomlValue({ command: 'node', args: ['/a.js'], env: { 'X.Key': 'v', 'A-B': '1' } }), "{command = 'node', args = ['/a.js'], env = {'X.Key' = 'v', A-B = '1'}}");
});

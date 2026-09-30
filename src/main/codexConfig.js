'use strict';
// 在 Codex 的 config.toml 寫入 [mcp_servers.multi-agent]。
// Codex 會過濾傳給 MCP server 的環境變數，所以用 env_vars 明列窗格的連線資訊。
const fs = require('fs');
const path = require('path');

const ENV_VARS = ['MULTI_AGENT_BRIDGE', 'MULTI_AGENT_TOKEN', 'MULTI_AGENT_PANE_ID'];
// 區塊到下一個以 [ 開頭的行（下一個 table）為止；args = [...] 這種行內陣列不會被當成結尾
const BLOCK_RE = /^\[mcp_servers\.multi-agent\][^\n]*\n(?:(?!\[)[^\n]*(?:\n|$))*/m;

function block(script) {
  return `[mcp_servers.multi-agent]\ncommand = "node"\nargs = [${JSON.stringify(script)}]\nenv_vars = [${ENV_VARS.map((v) => JSON.stringify(v)).join(', ')}]\n`;
}

/** 寫入或更新區塊，其他設定原封不動。onlyIfPresent：只更新已存在的區塊（啟動時修正舊版設定用） */
function writeCodexBridgeConfig(home, script, { onlyIfPresent = false } = {}) {
  const cfg = path.join(home, 'config.toml');
  const cur = fs.existsSync(cfg) ? fs.readFileSync(cfg, 'utf8') : '';
  const has = BLOCK_RE.test(cur);
  if (onlyIfPresent && !has) return false;
  const next = has ? cur.replace(BLOCK_RE, block(script) + '\n') : `${cur}${cur && !cur.endsWith('\n') ? '\n' : ''}${cur ? '\n' : ''}${block(script)}`;
  if (next !== cur) {
    fs.mkdirSync(home, { recursive: true });
    fs.writeFileSync(cfg, next);
  }
  return true;
}

module.exports = { writeCodexBridgeConfig, ENV_VARS };

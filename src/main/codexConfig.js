'use strict';
// 舊版用「讓 Codex 窗格也能跟其他窗格對話」把 [mcp_servers.multi-agent] 寫進 Codex 的 config.toml。
// 現在每個 Codex 窗格啟動時用 -c 自動帶上，不再需要那個區塊；在窗格外執行的 codex 讀到它反而會連不上而報錯，
// 所以啟動時把它移除。其他設定原封不動。
const fs = require('fs');
const path = require('path');

const ENV_VARS = ['MULTI_AGENT_BRIDGE', 'MULTI_AGENT_TOKEN', 'MULTI_AGENT_PANE_ID'];
// 區塊到下一個以 [ 開頭的行（下一個 table）為止；args = [...] 這種行內陣列不會被當成結尾
const BLOCK_RE = /^\[mcp_servers\.multi-agent\][^\n]*\n(?:(?!\[)[^\n]*(?:\n|$))*/m;

/** @returns {boolean} 是否有移除 */
function removeCodexBridgeConfig(home) {
  const cfg = path.join(home, 'config.toml');
  let cur;
  try {
    cur = fs.readFileSync(cfg, 'utf8');
  } catch {
    return false;
  }
  if (!BLOCK_RE.test(cur)) return false;
  fs.writeFileSync(cfg, cur.replace(BLOCK_RE, '').replace(/\n{3,}/g, '\n\n'));
  return true;
}

module.exports = { removeCodexBridgeConfig, ENV_VARS };

#!/usr/bin/env node
'use strict';
// Claude Code 的 statusline 指令。Claude 每次更新畫面時會把目前狀態（session id、context 用量、
// context window 大小、5 小時／每週額度）以 JSON 從 stdin 傳進來。這裡把它回報給 Multi-Agent CLI，
// 讓儀表板的數字跟 Claude 自己算的完全一致。
// 使用者原本若有自己的 statusline，會照樣執行並輸出它的結果。
const http = require('http');
const { spawn } = require('child_process');

let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (c) => (input += c));
process.stdin.on('end', async () => {
  await Promise.all([report(input), runUserStatusline(input)]);
});

function report(raw) {
  const base = process.env.MULTI_AGENT_BRIDGE;
  if (!base) return Promise.resolve();
  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    return Promise.resolve();
  }
  const body = JSON.stringify({
    token: process.env.MULTI_AGENT_TOKEN,
    from: process.env.MULTI_AGENT_PANE_ID,
    method: 'status',
    params: {
      session_id: data.session_id,
      transcript_path: data.transcript_path,
      model: data.model,
      context_window: data.context_window,
      rate_limits: data.rate_limits,
    },
  });
  return new Promise((resolve) => {
    const req = http.request(`${base}/rpc`, { method: 'POST', timeout: 800, headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } }, (res) => {
      res.resume();
      res.on('end', resolve);
    });
    req.on('error', resolve);
    req.on('timeout', () => {
      req.destroy();
      resolve();
    });
    req.end(body);
  });
}

// 使用者原本的 statusline（從 ~/.claude/settings.json 讀出，啟動窗格時以環境變數傳入）
function runUserStatusline(raw) {
  const cmd = process.env.MULTI_AGENT_USER_STATUSLINE;
  if (!cmd) return Promise.resolve();
  return new Promise((resolve) => {
    const child = spawn(cmd, { shell: true, stdio: ['pipe', 'inherit', 'ignore'] });
    child.on('error', resolve);
    child.on('exit', resolve);
    child.stdin.end(raw);
  });
}

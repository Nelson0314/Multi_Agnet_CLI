#!/usr/bin/env node
'use strict';
// Multi-Agent CLI 的 MCP server（stdio，JSON-RPC 2.0，一行一則訊息）。
// Claude Code 與 Codex 都可以掛上它，用來跟同一個視窗裡的其他窗格對話。
// 它透過窗格注入的環境變數（MULTI_AGENT_BRIDGE / TOKEN / PANE_ID）連回主程式。
// 環境變數過期時（例如由 Codex 的共用背景服務啟動，拿到的是舊的連線資訊），
// 改讀主程式寫在固定位置的 endpoint.json。
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const readline = require('readline');

// 跟 main.js 的 app.getPath('userData') 對應
function endpointFile(env = process.env, platform = process.platform) {
  if (env.MULTI_AGENT_ENDPOINT_FILE) return env.MULTI_AGENT_ENDPOINT_FILE;
  const home = os.homedir();
  const base =
    platform === 'win32'
      ? env.APPDATA || path.join(home, 'AppData', 'Roaming')
      : platform === 'darwin'
        ? path.join(home, 'Library', 'Application Support')
        : env.XDG_CONFIG_HOME || path.join(home, '.config');
  return path.join(base, 'multi-agent-cli', 'bridge', 'endpoint.json');
}

function readEndpoint() {
  try {
    const j = JSON.parse(fs.readFileSync(endpointFile(), 'utf8'));
    return j && j.url && j.token ? j : null;
  } catch {
    return null;
  }
}

let clientName = '';

const VERSION = require('../../package.json').version;

const TOOLS = [
  {
    name: 'list_panes',
    description: 'List the panes open in this Multi-Agent CLI window (Claude, Codex or shell), with their numbers and titles. Your own pane is marked you=true.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'send_to_pane',
    description:
      'Send a message to another pane, for example to ask the Codex pane for a review. The message is typed into that pane\'s input; depending on the user\'s setting it waits for the user to press Enter. Use wait_for_reply afterwards to get the answer.',
    inputSchema: {
      type: 'object',
      properties: {
        pane: { type: ['integer', 'string'], description: 'Pane number from list_panes' },
        message: { type: 'string', description: 'What to send. Include the context the other agent needs: goal, files, how to verify.' },
      },
      required: ['pane', 'message'],
    },
  },
  {
    name: 'read_pane',
    description: "Read another pane's latest reply (for Claude/Codex panes) or the last lines of its screen (for shells).",
    inputSchema: {
      type: 'object',
      properties: {
        pane: { type: ['integer', 'string'] },
        lines: { type: 'integer', description: 'Screen lines for shell panes (default 60)' },
      },
      required: ['pane'],
    },
  },
  {
    name: 'wait_for_reply',
    description: 'Wait until a Claude or Codex pane finishes answering the latest message, then return its reply.',
    inputSchema: {
      type: 'object',
      properties: {
        pane: { type: ['integer', 'string'] },
        timeout_sec: { type: 'integer', description: 'Default 300, max 1800' },
      },
      required: ['pane'],
    },
  },
];

const UNREACHABLE = 'Multi-Agent CLI is not reachable. Is the app still open?';

function post(base, token, method, params) {
  const body = JSON.stringify({ token, from: process.env.MULTI_AGENT_PANE_ID, client: clientName, method, params });
  return new Promise((resolve, reject) => {
    const req = http.request(`${base}/rpc`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } }, (res) => {
      let raw = '';
      res.on('data', (c) => (raw += c));
      res.on('end', () => {
        try {
          const j = JSON.parse(raw);
          j.error ? reject(Object.assign(new Error(j.error), { status: res.statusCode })) : resolve(j.result);
        } catch (e) {
          reject(e);
        }
      });
    });
    req.on('error', () => reject(Object.assign(new Error(UNREACHABLE), { unreachable: true })));
    req.end(body);
  });
}

async function rpc(method, params) {
  const base = process.env.MULTI_AGENT_BRIDGE;
  const token = process.env.MULTI_AGENT_TOKEN;
  if (base) {
    try {
      return await post(base, token, method, params);
    } catch (e) {
      // 連不到或 token 不對：可能是舊的連線資訊，改用 endpoint.json 再試一次
      if (!e.unreachable && e.status !== 403) throw e;
      const ep = readEndpoint();
      if (!ep || (ep.url === base && ep.token === token)) throw e;
      return post(ep.url, ep.token, method, params);
    }
  }
  const ep = readEndpoint();
  if (!ep) throw new Error('Not running inside a Multi-Agent CLI pane, so there are no other panes to talk to.');
  return post(ep.url, ep.token, method, params);
}

function send(msg) {
  process.stdout.write(JSON.stringify(msg) + '\n');
}

async function handle(msg) {
  const { id, method, params } = msg;
  if (id === undefined) return; // notification
  try {
    let result;
    if (method === 'initialize') {
      clientName = String((params && params.clientInfo && params.clientInfo.name) || '');
      result = {
        protocolVersion: (params && params.protocolVersion) || '2025-06-18',
        capabilities: { tools: {} },
        serverInfo: { name: 'multi-agent', version: VERSION },
      };
    } else if (method === 'ping') {
      result = {};
    } else if (method === 'tools/list') {
      result = { tools: TOOLS };
    } else if (method === 'tools/call') {
      try {
        const out = await rpc(params.name, params.arguments || {});
        result = { content: [{ type: 'text', text: typeof out === 'string' ? out : JSON.stringify(out, null, 2) }] };
      } catch (e) {
        result = { content: [{ type: 'text', text: e.message }], isError: true };
      }
    } else {
      return send({ jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${method}` } });
    }
    send({ jsonrpc: '2.0', id, result });
  } catch (e) {
    send({ jsonrpc: '2.0', id, error: { code: -32603, message: e.message } });
  }
}

if (require.main === module) {
  const rl = readline.createInterface({ input: process.stdin });
  rl.on('line', (line) => {
    if (!line.trim()) return;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      return;
    }
    handle(msg);
  });
}

module.exports = { TOOLS, handle, endpointFile };

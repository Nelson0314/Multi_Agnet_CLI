#!/usr/bin/env node
'use strict';
// Multi-Agent CLI 的 MCP server（stdio，JSON-RPC 2.0，一行一則訊息）。
// Claude Code 與 Codex 都可以掛上它，用來跟同一個視窗裡的其他窗格對話。
// 它透過窗格注入的環境變數（MULTI_AGENT_BRIDGE / TOKEN / PANE_ID）連回主程式。
const http = require('http');
const readline = require('readline');

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

function rpc(method, params) {
  const base = process.env.MULTI_AGENT_BRIDGE;
  if (!base) return Promise.reject(new Error('Not running inside a Multi-Agent CLI pane, so there are no other panes to talk to.'));
  const body = JSON.stringify({ token: process.env.MULTI_AGENT_TOKEN, from: process.env.MULTI_AGENT_PANE_ID, method, params });
  return new Promise((resolve, reject) => {
    const req = http.request(`${base}/rpc`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } }, (res) => {
      let raw = '';
      res.on('data', (c) => (raw += c));
      res.on('end', () => {
        try {
          const j = JSON.parse(raw);
          j.error ? reject(new Error(j.error)) : resolve(j.result);
        } catch (e) {
          reject(e);
        }
      });
    });
    req.on('error', () => reject(new Error('Multi-Agent CLI is not reachable. Is the app still open?')));
    req.end(body);
  });
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

module.exports = { TOOLS, handle };

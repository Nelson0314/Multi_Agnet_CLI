'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'mac-test-'));
}

function writeJsonl(file, entries) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, entries.map((e) => JSON.stringify(e)).join('\n') + '\n');
}

const user = (text, extra = {}) => ({ type: 'user', message: { role: 'user', content: text }, timestamp: '2026-09-30T10:00:00Z', ...extra });
const assistant = (text, usage, extra = {}) => ({
  type: 'assistant',
  message: { role: 'assistant', model: 'claude-opus-5-5', content: [{ type: 'text', text }], usage },
  timestamp: '2026-09-30T10:00:05Z',
  ...extra,
});

module.exports = { tmpdir, writeJsonl, user, assistant };

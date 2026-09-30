'use strict';
// JSONL 讀取工具：完整逐行解析，以及只讀檔尾（給即時 context 輪詢用）。
const fs = require('fs');

function parseLines(text) {
  const out = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line));
    } catch {
      // 寫入中的最後一行可能不完整，直接略過
    }
  }
  return out;
}

function readAll(file) {
  return parseLines(fs.readFileSync(file, 'utf8'));
}

// 讀取檔案最後 bytes 個位元組；第一行可能被截斷，所以丟掉
function readTail(file, bytes = 512 * 1024) {
  const { size } = fs.statSync(file);
  const start = Math.max(0, size - bytes);
  const fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.alloc(size - start);
    fs.readSync(fd, buf, 0, buf.length, start);
    let text = buf.toString('utf8');
    if (start > 0) text = text.slice(text.indexOf('\n') + 1);
    return parseLines(text);
  } finally {
    fs.closeSync(fd);
  }
}

function readHead(file, bytes = 64 * 1024) {
  const fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.alloc(bytes);
    const n = fs.readSync(fd, buf, 0, bytes, 0);
    let text = buf.subarray(0, n).toString('utf8');
    if (n === bytes) text = text.slice(0, text.lastIndexOf('\n'));
    return parseLines(text);
  } finally {
    fs.closeSync(fd);
  }
}

module.exports = { parseLines, readAll, readTail, readHead };

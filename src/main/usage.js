'use strict';
// Claude 訂閱額度（5 小時 / 每週）：與 Claude Code 內 /usage 使用同一個 OAuth usage 端點。
// 這不是公開文件化的 API，格式可能變動，所以所有欄位都做寬鬆解析並在失敗時回報原因。
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const https = require('https');
const { execFileSync } = require('child_process');

const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage';

function readCredentialsFile(configDir) {
  const f = path.join(configDir, '.credentials.json');
  if (!fs.existsSync(f)) return null;
  try {
    return JSON.parse(fs.readFileSync(f, 'utf8'));
  } catch {
    return null;
  }
}

// macOS 把 token 存在 Keychain；自訂 CLAUDE_CONFIG_DIR 時服務名稱會加上路徑 hash 後綴
function readKeychain(configDir, isDefault) {
  if (process.platform !== 'darwin') return null;
  const services = ['Claude Code-credentials'];
  if (!isDefault) {
    const h = crypto.createHash('sha256').update(configDir).digest('hex').slice(0, 8);
    services.unshift(`Claude Code-credentials-${h}`);
  }
  for (const s of services) {
    try {
      const raw = execFileSync('security', ['find-generic-password', '-a', os.userInfo().username, '-s', s, '-w'], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      });
      return JSON.parse(raw.trim());
    } catch {}
    if (!isDefault) break; // 非預設 profile 不要誤讀到預設帳號的 token
  }
  return null;
}

function getOAuth(configDir, isDefault) {
  const creds = readCredentialsFile(configDir) || readKeychain(configDir, isDefault);
  return creds && creds.claudeAiOauth ? creds.claudeAiOauth : null;
}

function getJson(url, headers, timeoutMs = 10_000) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers, timeout: timeoutMs }, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => {
        if (res.statusCode >= 400) return reject(Object.assign(new Error(`HTTP ${res.statusCode}`), { status: res.statusCode }));
        try {
          resolve(JSON.parse(body));
        } catch (e) {
          reject(e);
        }
      });
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
  });
}

function normalizeWindow(w) {
  if (!w || w.utilization == null) return null;
  return { pct: Number(w.utilization), resetsAt: w.resets_at ? Date.parse(w.resets_at) : null };
}

function normalizeUsage(raw) {
  return {
    fiveHour: normalizeWindow(raw.five_hour),
    sevenDay: normalizeWindow(raw.seven_day),
    sevenDayOpus: normalizeWindow(raw.seven_day_opus),
    sevenDaySonnet: normalizeWindow(raw.seven_day_sonnet),
  };
}

const cache = new Map(); // configDir -> { at, value }
const TTL = 60_000;

async function fetchUsage(configDir, isDefault, { force = false } = {}) {
  const hit = cache.get(configDir);
  if (!force && hit && Date.now() - hit.at < TTL) return hit.value;
  const oauth = getOAuth(configDir, isDefault);
  let value;
  if (!oauth || !oauth.accessToken) {
    value = { ok: false, reason: '尚未登入（找不到 OAuth 憑證）' };
  } else if (oauth.expiresAt && oauth.expiresAt < Date.now()) {
    value = { ok: false, reason: 'Token 已過期：在此帳號開任一個 session 即會自動更新' };
  } else {
    try {
      const raw = await getJson(USAGE_URL, {
        Authorization: `Bearer ${oauth.accessToken}`,
        'anthropic-beta': 'oauth-2025-04-20',
        'Content-Type': 'application/json',
        'User-Agent': 'multi-agent-cli',
      });
      value = { ok: true, plan: oauth.subscriptionType || null, ...normalizeUsage(raw) };
    } catch (e) {
      value = { ok: false, reason: e.status === 401 ? 'Token 失效，請重新登入' : `無法取得額度：${e.message}` };
    }
  }
  value.fetchedAt = Date.now();
  cache.set(configDir, { at: Date.now(), value });
  return value;
}

module.exports = { fetchUsage, normalizeUsage, getOAuth };

#!/usr/bin/env node
'use strict';

/**
 * runner.js — self-contained hook runtime for claude-session-monitor.
 *
 * Account-lock across machines using a PINNED Telegram message as the shared
 * state store. Uses Node built-ins ONLY (https, fs, os, path, crypto) so it can
 * be copied to ~/.claude/session-monitor/runner.js and run standalone WITHOUT
 * node_modules.
 *
 * Usage (called by thin bash hook wrappers, hook JSON on stdin):
 *   node runner.js sessionstart   # acquire lock or mark blocked; notify group
 *   node runner.js pretooluse     # enforce: exit 2 if this session is blocked
 *   node runner.js sessionend     # release lock if we own it
 *
 * Design guarantees:
 *   - FAIL-OPEN: any config/network/parse error → exit 0 (never break Claude),
 *     except the deliberate exit 2 when a session is known-blocked.
 *   - Time-boxed: a hard watchdog guarantees the process never hangs Claude.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const https = require('https');
const crypto = require('crypto');

const HOME = os.homedir();
const CONFIG_DIR = path.join(HOME, '.claude', 'session-monitor');
const CONFIG_PATH = path.join(CONFIG_DIR, 'config.json');
const SECRET_PATH = path.join(CONFIG_DIR, '.secret');
const CLAUDE_JSON = path.join(HOME, '.claude.json');

const STATE_HEADER = '🔒 Claude session locks (auto — do not edit)';
const HEARTBEAT_SEC = 120; // refresh remote ts at most this often (from PreToolUse)
const TTL_FLOOR_SEC = 600; // a lock is "active" for at least 10 min of inactivity
const NET_TIMEOUT_MS = 6000;
const WATCHDOG_MS = 9000; // absolute cap so Claude is never blocked by a hang

// Public-IP lookups are cached on disk to avoid hammering (and being banned by)
// the IP services when many sessions start in a short window.
const IP_CACHE_PATH = path.join(CONFIG_DIR, '.ipcache');
const IP_CACHE_TTL_SEC = 900; // 15 minutes

// --------------------------------------------------------------------------
// small utils
// --------------------------------------------------------------------------
const nowSec = () => Math.floor(Date.now() / 1000);

function markerPath(sessionId) {
  const safe = String(sessionId || 'unknown').replace(/[^a-zA-Z0-9_-]/g, '_');
  return path.join(os.tmpdir(), `claude-csm-${safe}.marker`);
}

function esc(s) {
  return String(s === undefined || s === null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

// --------------------------------------------------------------------------
// config (read + AES-256-GCM decrypt, matching src/services/config.js)
// --------------------------------------------------------------------------
function readRawConfig() {
  return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
}

function decryptToken(payload) {
  const key = fs.readFileSync(SECRET_PATH); // raw 32 bytes
  const decipher = crypto.createDecipheriv(
    'aes-256-gcm',
    key,
    Buffer.from(payload.iv, 'base64')
  );
  decipher.setAuthTag(Buffer.from(payload.tag, 'base64'));
  return Buffer.concat([
    decipher.update(Buffer.from(payload.data, 'base64')),
    decipher.final(),
  ]).toString('utf8');
}

function loadConfig() {
  const parsed = readRawConfig();
  const timeout = Number(parsed.timeout) || TTL_FLOOR_SEC;
  return {
    botToken: decryptToken(parsed.botToken),
    groupId: String(parsed.groupId),
    ttl: Math.max(timeout, TTL_FLOOR_SEC),
    stateMessageId: parsed.stateMessageId || null,
  };
}

// Persist ONLY stateMessageId, preserving the encrypted token object untouched.
function saveStateMessageId(id) {
  try {
    const parsed = readRawConfig();
    parsed.stateMessageId = id;
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(parsed, null, 2), { mode: 0o600 });
  } catch (_e) {
    /* best-effort */
  }
}

// --------------------------------------------------------------------------
// identity
// --------------------------------------------------------------------------
function getAccount() {
  try {
    const j = JSON.parse(fs.readFileSync(CLAUDE_JSON, 'utf8'));
    const oa = j.oauthAccount || {};
    return oa.emailAddress || oa.accountUuid || 'unknown-account';
  } catch (_e) {
    return 'unknown-account';
  }
}

const getMachine = () => os.hostname();

// --------------------------------------------------------------------------
// network (best-effort; never throws)
// --------------------------------------------------------------------------
function httpsGetText(url) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => {
      if (!done) {
        done = true;
        resolve(v);
      }
    };
    try {
      const req = https.get(url, (res) => {
        let body = '';
        res.on('data', (c) => (body += c));
        res.on('end', () => finish(body.trim()));
      });
      req.on('error', () => finish(null));
      req.setTimeout(NET_TIMEOUT_MS, () => {
        req.destroy();
        finish(null);
      });
    } catch (_e) {
      finish(null);
    }
  });
}

function tgApi(token, method, params) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => {
      if (!done) {
        done = true;
        resolve(v);
      }
    };
    let payload;
    try {
      payload = JSON.stringify(params);
    } catch (_e) {
      return finish({ ok: false });
    }
    const options = {
      hostname: 'api.telegram.org',
      path: `/bot${token}/${method}`,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
      },
    };
    try {
      const req = https.request(options, (res) => {
        let body = '';
        res.on('data', (c) => (body += c));
        res.on('end', () => {
          try {
            finish(JSON.parse(body));
          } catch (_e) {
            finish({ ok: false });
          }
        });
      });
      req.on('error', () => finish({ ok: false }));
      req.setTimeout(NET_TIMEOUT_MS, () => {
        req.destroy();
        finish({ ok: false });
      });
      req.write(payload);
      req.end();
    } catch (_e) {
      finish({ ok: false });
    }
  });
}

async function getPublicIp() {
  const ip = await httpsGetText('https://api.ipify.org');
  if (ip && /^[0-9a-fA-F.:]+$/.test(ip)) return ip;
  const alt = await httpsGetText('https://checkip.amazonaws.com');
  return alt && /^[0-9a-fA-F.:]+$/.test(alt) ? alt : '';
}

async function getGeo(ip) {
  if (!ip) return '';
  const raw = await httpsGetText(`https://ipinfo.io/${ip}/json`);
  if (!raw) return '';
  try {
    const j = JSON.parse(raw);
    const org = (j.org || '').replace(/^AS\d+\s*/, '');
    return [j.city, org].filter(Boolean).join(' · ');
  } catch (_e) {
    return '';
  }
}

// --------------------------------------------------------------------------
// public-IP resolution with a 15-minute on-disk cache (avoids rate-limit bans)
// --------------------------------------------------------------------------
function readIpCache() {
  try {
    const j = JSON.parse(fs.readFileSync(IP_CACHE_PATH, 'utf8'));
    if (j && typeof j.ip === 'string') {
      return { ip: j.ip, loc: j.loc || '', ts: Number(j.ts) || 0 };
    }
  } catch (_e) {
    /* no/invalid cache */
  }
  return null;
}

function writeIpCache(ip, loc) {
  try {
    fs.mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
    fs.writeFileSync(
      IP_CACHE_PATH,
      JSON.stringify({ ip, loc: loc || '', ts: nowSec() }),
      { mode: 0o600 }
    );
  } catch (_e) {
    /* best-effort */
  }
}

/**
 * Resolve { ip, loc }, hitting the network at most once per IP_CACHE_TTL_SEC.
 * Falls back to a stale cache entry if a fresh lookup fails.
 */
async function resolveNetInfo() {
  const cached = readIpCache();
  if (cached && nowSec() - cached.ts < IP_CACHE_TTL_SEC) {
    return { ip: cached.ip, loc: cached.loc };
  }
  const ip = await getPublicIp();
  if (ip) {
    const loc = await getGeo(ip);
    writeIpCache(ip, loc);
    return { ip, loc };
  }
  // Fresh lookup failed → reuse the last known IP rather than dropping it.
  if (cached) return { ip: cached.ip, loc: cached.loc };
  return { ip: '', loc: '' };
}

async function notify(cfg, text) {
  await tgApi(cfg.botToken, 'sendMessage', {
    chat_id: cfg.groupId,
    text,
    parse_mode: 'HTML',
  });
}

// --------------------------------------------------------------------------
// shared state via a pinned message
// --------------------------------------------------------------------------
function parseStateText(text) {
  if (!text) return null;
  const i = text.indexOf('{');
  if (i < 0) return null;
  try {
    const o = JSON.parse(text.slice(i));
    if (o && typeof o === 'object' && o.accounts) return o;
  } catch (_e) {
    /* not our message */
  }
  return null;
}

function stateText(state) {
  return `${STATE_HEADER}\n${JSON.stringify(state)}`;
}

async function readState(cfg) {
  const chat = await tgApi(cfg.botToken, 'getChat', { chat_id: cfg.groupId });
  const pinned = chat && chat.ok && chat.result && chat.result.pinned_message;
  if (pinned && pinned.text) {
    const parsed = parseStateText(pinned.text);
    if (parsed) return { state: parsed, messageId: pinned.message_id };
  }
  return { state: { v: 1, accounts: {} }, messageId: cfg.stateMessageId || null };
}

async function writeState(cfg, state, messageId) {
  const text = stateText(state);
  if (messageId) {
    const r = await tgApi(cfg.botToken, 'editMessageText', {
      chat_id: cfg.groupId,
      message_id: messageId,
      text,
    });
    // "message is not modified" is still a success for our purposes.
    if (r && (r.ok || (r.description || '').includes('not modified'))) return messageId;
  }
  // Create + pin a fresh state message.
  const sent = await tgApi(cfg.botToken, 'sendMessage', {
    chat_id: cfg.groupId,
    text,
    disable_notification: true,
  });
  if (sent && sent.ok && sent.result) {
    const id = sent.result.message_id;
    await tgApi(cfg.botToken, 'pinChatMessage', {
      chat_id: cfg.groupId,
      message_id: id,
      disable_notification: true,
    });
    saveStateMessageId(id);
    return id;
  }
  return messageId;
}

// --------------------------------------------------------------------------
// per-session marker (local, fast — read by PreToolUse on every tool call)
//   line 1: role  = "owner" | "blocked"
//   line 2: ts    = last heartbeat epoch (owner only)
// --------------------------------------------------------------------------
function writeMarker(sessionId, role) {
  try {
    fs.writeFileSync(markerPath(sessionId), `${role}\n${nowSec()}\n`);
  } catch (_e) {
    /* best-effort */
  }
}

function readMarker(sessionId) {
  try {
    const [role, ts] = fs.readFileSync(markerPath(sessionId), 'utf8').split('\n');
    return { role: role || '', ts: parseInt(ts || '0', 10) || 0 };
  } catch (_e) {
    return null;
  }
}

function removeMarker(sessionId) {
  try {
    fs.unlinkSync(markerPath(sessionId));
  } catch (_e) {
    /* best-effort */
  }
}

// --------------------------------------------------------------------------
// stdin (hook JSON payload)
// --------------------------------------------------------------------------
function readStdin() {
  return new Promise((resolve) => {
    let data = '';
    let settled = false;
    const done = () => {
      if (settled) return;
      settled = true;
      try {
        resolve(data.trim() ? JSON.parse(data) : {});
      } catch (_e) {
        resolve({});
      }
    };
    if (process.stdin.isTTY) return resolve({});
    process.stdin.on('data', (c) => (data += c));
    process.stdin.on('end', done);
    process.stdin.on('error', () => resolve({}));
    setTimeout(done, 1500); // stdin may stay open; don't wait forever
  });
}

// --------------------------------------------------------------------------
// event handlers
// --------------------------------------------------------------------------
async function onSessionStart(cfg, input) {
  const account = getAccount();
  const machine = getMachine();
  const sessionId = input.session_id || 'unknown';

  const { state, messageId } = await readState(cfg);
  const cur = state.accounts[account];
  const active = cur && nowSec() - (Number(cur.ts) || 0) < cfg.ttl;

  // Conflict: same account, held by a DIFFERENT machine, still active.
  if (active && cur.machine !== machine) {
    writeMarker(sessionId, 'blocked');
    await notify(
      cfg,
      `⚠️ <b>Session bị chặn</b>\n` +
        `Account <b>${esc(account)}</b> đang được dùng ở <b>${esc(cur.machine)}</b>` +
        ` (${esc(cur.ip || '?')}${cur.loc ? ' · ' + esc(cur.loc) : ''}).\n` +
        `Máy <b>${esc(machine)}</b> vừa mở Claude → <b>không được vào</b> (mọi tool bị chặn).`
    );
    // Tell Claude (context) so it can explain to the user.
    process.stdout.write(
      JSON.stringify({
        hookSpecificOutput: {
          hookEventName: 'SessionStart',
          additionalContext:
            `claude-session-monitor: account ${account} is already active on ${cur.machine}. ` +
            `This session is BLOCKED — every tool call will be denied until the other session ends.`,
        },
      })
    );
    return 0; // SessionStart cannot hard-block; PreToolUse enforces via the marker.
  }

  // Free (or same machine) → acquire the lock.
  const { ip, loc } = await resolveNetInfo();
  state.accounts[account] = {
    machine,
    ip: ip || '',
    loc: loc || '',
    session: sessionId,
    ts: nowSec(),
  };
  await writeState(cfg, state, messageId);
  writeMarker(sessionId, 'owner');
  await notify(
    cfg,
    `✅ <b>${esc(account)}</b> mở session @ <b>${esc(machine)}</b>` +
      ` (${esc(ip || '?')}${loc ? ' · ' + esc(loc) : ''}).`
  );
  return 0;
}

async function onPreToolUse(cfg, input) {
  const sessionId = input.session_id || 'unknown';
  const m = readMarker(sessionId);

  if (m && m.role === 'blocked') {
    process.stderr.write(
      'claude-session-monitor: BỊ CHẶN — account của bạn đang được dùng ở máy khác. ' +
        'Hãy đóng phiên Claude bên đó trước khi tiếp tục ở máy này.'
    );
    return 2; // block the tool call
  }

  // Owner → throttled remote heartbeat to keep the lock alive during long work.
  if (m && m.role === 'owner' && nowSec() - m.ts >= HEARTBEAT_SEC) {
    writeMarker(sessionId, 'owner'); // refresh local ts first (fast)
    try {
      const account = getAccount();
      const { state, messageId } = await readState(cfg);
      const cur = state.accounts[account];
      if (cur && cur.session === sessionId) {
        cur.ts = nowSec();
        await writeState(cfg, state, messageId);
      }
    } catch (_e) {
      /* heartbeat is best-effort */
    }
  }
  // No marker (hook installed mid-session) → fail-open (allow).
  return 0;
}

async function onSessionEnd(cfg, input) {
  const sessionId = input.session_id || 'unknown';
  const m = readMarker(sessionId);
  removeMarker(sessionId);

  // Only release if we actually held the lock (a blocked session owns nothing).
  if (!m || m.role !== 'owner') return 0;

  try {
    const account = getAccount();
    const machine = getMachine();
    const { state, messageId } = await readState(cfg);
    const cur = state.accounts[account];
    if (cur && cur.session === sessionId) {
      delete state.accounts[account];
      await writeState(cfg, state, messageId);
      await notify(cfg, `👋 <b>${esc(account)}</b> đóng session @ <b>${esc(machine)}</b>.`);
    }
  } catch (_e) {
    /* best-effort cleanup */
  }
  return 0;
}

// --------------------------------------------------------------------------
// main
// --------------------------------------------------------------------------
async function main() {
  const event = String(process.argv[2] || '').toLowerCase();

  // Watchdog: never let a hang block Claude. Fail-open on timeout.
  const watchdog = setTimeout(() => process.exit(0), WATCHDOG_MS);
  watchdog.unref();

  let cfg;
  try {
    cfg = loadConfig();
  } catch (_e) {
    process.exit(0); // not configured / unreadable → do nothing
  }

  let code = 0;
  try {
    const input = await readStdin();
    if (event === 'sessionstart') code = await onSessionStart(cfg, input);
    else if (event === 'pretooluse') code = await onPreToolUse(cfg, input);
    else if (event === 'sessionend') code = await onSessionEnd(cfg, input);
  } catch (_e) {
    code = 0; // fail-open on any unexpected error
  }

  clearTimeout(watchdog);
  process.exit(code);
}

// Run only when executed directly; export internals for unit tests.
if (require.main === module) {
  main();
}

module.exports = {
  CONFIG_PATH,
  SECRET_PATH,
  STATE_HEADER,
  HEARTBEAT_SEC,
  TTL_FLOOR_SEC,
  IP_CACHE_PATH,
  IP_CACHE_TTL_SEC,
  esc,
  markerPath,
  decryptToken,
  loadConfig,
  saveStateMessageId,
  getAccount,
  getMachine,
  parseStateText,
  stateText,
  writeMarker,
  readMarker,
  removeMarker,
  readIpCache,
  writeIpCache,
  resolveNetInfo,
  main,
};

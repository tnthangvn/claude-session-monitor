#!/usr/bin/env node
'use strict';

/**
 * runner.js — self-contained hook runtime for claude-session-monitor.
 *
 * Account-lock across machines using a PINNED Telegram message as the shared
 * state store. Uses Node built-ins ONLY (https, fs, os, path, crypto,
 * child_process) so it can be copied to ~/.claude/session-monitor/runner.js
 * and run standalone WITHOUT node_modules.
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
const { execSync } = require('child_process');

const HOME = os.homedir();
const CONFIG_DIR = path.join(HOME, '.claude', 'session-monitor');
const CONFIG_PATH = path.join(CONFIG_DIR, 'config.json');
const SECRET_PATH = path.join(CONFIG_DIR, '.secret');
const HISTORY_PATH = path.join(CONFIG_DIR, 'history.log');
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

/**
 * Whether the lock entry `cur` belongs to THIS machine: the hostname AND the
 * public IP must both match. Hostnames collide in practice (two PCs both named
 * "pc"), so a matching hostname with a DIFFERENT public IP is a different
 * machine → conflict. The IP is only compared when BOTH sides know it: a
 * failed/offline lookup on either side falls back to the hostname comparison
 * rather than manufacturing a false conflict.
 */
function sameHolder(cur, machine, ip) {
  if (!cur) return false;
  if (cur.machine !== machine) return false;
  if (cur.ip && ip && cur.ip !== ip) return false;
  return true;
}

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

/**
 * Live (non-stale) sessions held by an account entry, as {sessionId: ts}.
 * Migrates the legacy single `session` field and drops sessions whose last
 * heartbeat is older than the ttl (crashed sessions that never sent SessionEnd).
 */
function liveSessions(cur, ttl) {
  const out = {};
  if (!cur) return out;
  const src =
    cur.sessions && typeof cur.sessions === 'object'
      ? cur.sessions
      : cur.session
        ? { [cur.session]: Number(cur.ts) || 0 }
        : {};
  for (const id of Object.keys(src)) {
    const ts = Number(src[id]) || 0;
    if (nowSec() - ts < ttl) out[id] = ts;
  }
  return out;
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
// local history (tab-separated, same format as src/services/config.js so the
// `logs` CLI command can read entries written by this standalone runner)
// --------------------------------------------------------------------------
function appendHistory(event, detail) {
  try {
    fs.mkdirSync(CONFIG_DIR, { recursive: true });
    const safe = (v) =>
      String(v === undefined || v === null ? '' : v).replace(/[\t\n\r]/g, ' ');
    const line = `${new Date().toISOString()}\t${safe(event)}\t${safe(getMachine())}\t${safe(detail)}\n`;
    fs.appendFileSync(HISTORY_PATH, line);
  } catch (_e) {
    /* best-effort */
  }
}

// --------------------------------------------------------------------------
// local Claude processes (conflict enforcement — kill the intruding machine's
// own Claude sessions; the lock holder's machine is never touched)
// --------------------------------------------------------------------------

/**
 * Parse `tasklist /FO CSV /NH` output into claude.exe PIDs, excluding this
 * hook. Lines look like: "claude.exe","1234","Console","1","45,678 K".
 * The no-match case is an INFO: sentence, which simply matches nothing.
 * @param {string} csvText
 * @returns {number[]}
 */
function parseTasklistPids(csvText) {
  return String(csvText || '')
    .split(/\r?\n/)
    .map((line) => {
      const m = /^"claude\.exe","(\d+)"/i.exec(line.trim());
      return m ? parseInt(m[1], 10) : NaN;
    })
    .filter((n) => Number.isFinite(n) && n > 0 && n !== process.pid);
}

/**
 * PIDs of every `claude` process owned by this user, excluding this hook.
 * Per platform:
 *   - win32:  `tasklist` filtered on IMAGENAME claude.exe (no /proc, no pgrep;
 *             other users' processes just land in `failed` on EPERM at kill)
 *   - linux:  /proc scan — /proc/<pid>/comm matched EXACTLY (a substring match
 *             on cmdline would catch this very hook, its path contains
 *             ".claude/"), filtered to this UID
 *   - darwin/other unix (or unreadable /proc): `pgrep -x claude`
 * @param {string} [procRoot] injectable for tests
 */
function listClaudePids(procRoot = '/proc') {
  if (process.platform === 'win32') {
    try {
      const out = execSync('tasklist /FI "IMAGENAME eq claude.exe" /FO CSV /NH', {
        encoding: 'utf8',
        timeout: 5000,
        windowsHide: true,
      });
      return parseTasklistPids(out);
    } catch (_e) {
      return [];
    }
  }
  try {
    const uid = typeof process.getuid === 'function' ? process.getuid() : -1;
    const pids = [];
    for (const entry of fs.readdirSync(procRoot)) {
      if (!/^\d+$/.test(entry)) continue;
      const pid = parseInt(entry, 10);
      if (pid === process.pid) continue;
      try {
        const dir = path.join(procRoot, entry);
        if (uid >= 0 && fs.statSync(dir).uid !== uid) continue;
        const comm = fs.readFileSync(path.join(dir, 'comm'), 'utf8').trim();
        if (comm === 'claude') pids.push(pid);
      } catch (_e) {
        /* process vanished / unreadable → skip */
      }
    }
    return pids;
  } catch (_e) {
    try {
      const out = execSync('pgrep -x claude', { encoding: 'utf8', timeout: 3000 });
      return out
        .split('\n')
        .map((s) => parseInt(s.trim(), 10))
        .filter((n) => Number.isFinite(n) && n > 0 && n !== process.pid);
    } catch (_e2) {
      return []; // pgrep absent or no match (exit 1) → nothing to kill
    }
  }
}

/**
 * PID of the `claude` process that spawned THIS hook (the current interactive
 * session), found by walking the parent chain until a comm of exactly
 * "claude". Returns 0 when it can't be identified (non-Linux, /proc
 * unreadable, or the hook wasn't launched by claude).
 *
 * Callers exclude this pid from the conflict SIGKILL: killing our own session's
 * raw-mode TUI leaves the terminal wedged (it never restores cooked mode), so
 * every relaunch re-wedges it — the reported hang. Enforcement for this very
 * session is the 'blocked' marker (PreToolUse denies every tool call) instead.
 * @param {string} [procRoot] injectable for tests
 * @returns {number}
 */
function currentClaudePid(procRoot = '/proc') {
  try {
    let pid = process.pid;
    for (let hops = 0; hops < 24 && pid > 1; hops++) {
      const dir = path.join(procRoot, String(pid));
      try {
        if (fs.readFileSync(path.join(dir, 'comm'), 'utf8').trim() === 'claude') {
          return pid;
        }
      } catch (_e) {
        /* comm vanished/unreadable → keep walking up */
      }
      let ppid = 0;
      try {
        const m = /^PPid:\s*(\d+)/m.exec(fs.readFileSync(path.join(dir, 'status'), 'utf8'));
        ppid = m ? parseInt(m[1], 10) : 0;
      } catch (_e) {
        break; // no status → can't walk further
      }
      if (!ppid || ppid === pid) break;
      pid = ppid;
    }
  } catch (_e) {
    /* fall through to 0 */
  }
  return 0;
}

/**
 * SIGKILL each pid INDIVIDUALLY (never a process group: this hook must
 * survive its parent's death as an orphan to send the Telegram report).
 * On Windows Node maps SIGKILL to TerminateProcess — same force semantics.
 * @param {number[]} pids
 * @returns {{killed: number[], failed: number[]}}
 */
function killPids(pids) {
  const killed = [];
  const failed = [];
  for (const pid of pids) {
    try {
      process.kill(pid, 'SIGKILL');
      killed.push(pid);
    } catch (_e) {
      failed.push(pid);
    }
  }
  return { killed, failed };
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

  // Resolved BEFORE the conflict check: the public IP is part of the holder
  // identity (hostnames collide — two PCs both named "pc"). Cached on disk for
  // 15 min, so this is usually instant.
  const { ip, loc } = await resolveNetInfo();

  const { state, messageId } = await readState(cfg);
  const cur = state.accounts[account];
  const age = nowSec() - (Number(cur && cur.ts) || 0);
  const active = cur && age < cfg.ttl;
  const ours = sameHolder(cur, machine, ip);

  // A holder on a DIFFERENT machine (hostname OR public IP differs) is a LIVE
  // conflict only while it has been seen recently (within TTL_FLOOR_SEC — long
  // enough to cover a slow tool call). Past that, but still inside the
  // configured ttl, the holder is treated as stale/dead: rather than SIGKILL
  // this machine on every launch (which left it "stuck stale" for up to the
  // full ttl and unable to re-enter Claude), we re-check the pinned state and
  // take the lock over here.
  const liveConflict = active && !ours && age < TTL_FLOOR_SEC;

  // Conflict: same account, held by a DIFFERENT machine, still fresh.
  // Policy: the lock holder is untouchable (state is READ-ONLY here) — this
  // machine kills its own Claude processes instead. Kill first, notify after,
  // so the Telegram report carries the real outcome; SIGKILL targets
  // individual pids, so this hook survives its parent's death as an orphan.
  if (liveConflict) {
    // This session is enforced by the marker (PreToolUse denies every tool
    // call). We additionally SIGKILL OTHER local claude sessions, but NEVER our
    // own TUI — killing its raw-mode terminal wedges the shell and every
    // relaunch re-wedges it. If our own claude can't be identified, kill
    // nothing and rely solely on the marker.
    writeMarker(sessionId, 'blocked');
    const myClaude = currentClaudePid();
    const { killed, failed } = myClaude
      ? killPids(listClaudePids().filter((p) => p !== myClaude))
      : { killed: [], failed: [] };
    appendHistory(
      'CONFLICT',
      `holder=${cur.machine}/${cur.ip || '?'}, killed=${killed.length}, failed=${failed.length}`
    );
    await notify(
      cfg,
      `⛔ <b>Conflict</b>\n` +
        `Account <b>${esc(account)}</b> đang được dùng ở <b>${esc(cur.machine)}</b>` +
        ` (${esc(cur.ip || '?')}${cur.loc ? ' · ' + esc(cur.loc) : ''}).\n` +
        `Máy <b>${esc(machine)}</b> (${esc(ip || '?')}) vừa mở Claude → phiên này đã bị chặn (mọi tool call bị từ chối)` +
        (killed.length ? ` + đã kill <b>${killed.length}</b> phiên Claude khác tại đây` : '') +
        (failed.length ? ` (<b>${failed.length}</b> kill fail)` : '') +
        `.`
    );
    // This session survives (its own claude is spared to keep the terminal
    // usable) but is blocked: surface why so Claude can tell the user.
    process.stdout.write(
      JSON.stringify({
        hookSpecificOutput: {
          hookEventName: 'SessionStart',
          additionalContext:
            `claude-session-monitor: account ${account} is already active on ${cur.machine} (${cur.ip || 'unknown ip'}). ` +
            `This session is blocked — every tool call will be denied until that session ends. ` +
            `${killed.length} other local Claude session(s) were sent SIGKILL.`,
        },
      })
    );
    return 0; // SessionStart cannot hard-block; PreToolUse enforces via the marker.
  }

  // Taking over a stale lock left by a DIFFERENT machine: don't inherit its
  // sessions, and announce the takeover so the group sees the machine change.
  const staleHolder = active && !ours ? cur.machine : null;
  if (staleHolder) {
    appendHistory('TAKEOVER', `stale holder=${staleHolder}/${cur.ip || '?'}, age=${age}s`);
  }

  // Free (or same machine) → acquire or join the lock. The lock is
  // reference-counted per session: only the FIRST session notifies; extra
  // sessions on the same machine just register silently. A stale holder on
  // another machine is dropped (its sessions are not carried over).
  const sessions = liveSessions(active && ours ? cur : null, cfg.ttl);
  const isFirst = Object.keys(sessions).length === 0;
  sessions[sessionId] = nowSec();

  state.accounts[account] = {
    machine,
    ip: ip || '',
    loc: loc || '',
    sessions,
    ts: nowSec(),
  };
  await writeState(cfg, state, messageId);
  writeMarker(sessionId, 'owner');
  if (isFirst) {
    appendHistory('START', `${ip || '?'}${loc ? ' · ' + loc : ''}`);
    await notify(
      cfg,
      staleHolder
        ? `♻️ <b>${esc(account)}</b> tiếp quản lock (holder cũ <b>${esc(staleHolder)}</b> stale)` +
            ` @ <b>${esc(machine)}</b> (${esc(ip || '?')}${loc ? ' · ' + esc(loc) : ''}).`
        : `✅ <b>${esc(account)}</b> mở session @ <b>${esc(machine)}</b>` +
            ` (${esc(ip || '?')}${loc ? ' · ' + esc(loc) : ''}).`
    );
  }
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
      const { ip } = await resolveNetInfo();
      const { state, messageId } = await readState(cfg);
      const cur = state.accounts[account];
      if (sameHolder(cur, getMachine(), ip)) {
        const sessions = liveSessions(cur, cfg.ttl);
        sessions[sessionId] = nowSec(); // refresh (or revive) this session
        cur.sessions = sessions;
        delete cur.session; // drop the legacy single-session field
        if (ip && !cur.ip) cur.ip = ip; // backfill an IP the start-time lookup missed
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
    const { ip } = await resolveNetInfo();
    const { state, messageId } = await readState(cfg);
    const cur = state.accounts[account];
    if (!sameHolder(cur, machine, ip)) return 0; // lock no longer ours

    const sessions = liveSessions(cur, cfg.ttl);
    delete sessions[sessionId];

    if (Object.keys(sessions).length > 0) {
      // Other sessions on this machine are still open → keep the lock, no noti.
      cur.sessions = sessions;
      delete cur.session; // drop the legacy single-session field
      await writeState(cfg, state, messageId);
      return 0;
    }

    // Last session closed → release the lock and notify once.
    delete state.accounts[account];
    await writeState(cfg, state, messageId);
    appendHistory('END', '');
    await notify(cfg, `👋 <b>${esc(account)}</b> đóng session @ <b>${esc(machine)}</b>.`);
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

  // After a conflict-kill the parent is gone and stdout is a broken pipe —
  // swallow the EPIPE instead of crashing before the Telegram report is sent.
  process.stdout.on('error', () => {});

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
  HISTORY_PATH,
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
  sameHolder,
  parseStateText,
  stateText,
  liveSessions,
  writeMarker,
  readMarker,
  removeMarker,
  appendHistory,
  parseTasklistPids,
  listClaudePids,
  currentClaudePid,
  killPids,
  readIpCache,
  writeIpCache,
  resolveNetInfo,
  onSessionStart,
  onPreToolUse,
  onSessionEnd,
  main,
};

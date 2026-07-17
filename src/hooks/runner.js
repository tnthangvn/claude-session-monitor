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
 *   node runner.js sessionstart   # acquire lock (or notify on conflict)
 *   node runner.js pretooluse     # heartbeat; repeat conflict reminders
 *   node runner.js sessionend     # release lock if we own it
 *
 * Design guarantees:
 *   - NOTIFY-ONLY: sessions are never blocked or killed; a cross-machine
 *     conflict just sends a Telegram warning.
 *   - FAIL-OPEN: any config/network/parse error → exit 0 (never break Claude).
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
const HISTORY_PATH = path.join(CONFIG_DIR, 'history.log');
const CLAUDE_JSON = path.join(HOME, '.claude.json');

const STATE_HEADER = '🔒 Claude session locks (auto — do not edit)';
const HEARTBEAT_SEC = 120; // refresh remote ts at most this often (from PreToolUse)
const TTL_FLOOR_SEC = 600; // a lock is "active" for at least 10 min of inactivity
const DEFAULT_TTL_SEC = 600; // when config has no usable timeout: 10 minutes
const CONFLICT_REMIND_SEC = 300; // re-notify a live conflict at most every 5 min

// Machine-wide throttle for conflict reminders: several conflicted sessions on
// the same machine must not each post their own reminder.
const REMIND_PATH = path.join(CONFIG_DIR, '.remind');

// Machine-local session bookkeeping. The pinned Telegram message is a slow,
// shared store: when several Claude sessions launch on ONE machine at almost the
// same instant they all read the state before any of them has written it back,
// so each believes it is the first and each posts its own ✅ — a notification
// storm. These local files are the source of truth for "how many sessions are
// live on THIS machine" and gate the open/close notifications atomically via the
// filesystem, independent of the remote round-trip.
//   - ACTIVE_DIR: one file per live owner session on this machine (name = safe
//     session id, contents = last-seen epoch). Its size is the local refcount.
//   - OPEN_NOTICE_PATH: a single machine-wide flag that exists exactly while a ✅
//     "session opened" notice is outstanding. Created with an exclusive `wx`
//     write so only ONE of N concurrent starters wins and notifies; removed with
//     a single unlink so only ONE of N concurrent enders posts the 👋.
const ACTIVE_DIR = path.join(CONFIG_DIR, 'active');
const OPEN_NOTICE_PATH = path.join(CONFIG_DIR, '.opennotice');
// Machine-wide throttle for remote `exp` refreshes: while several sessions are
// live, only ONE of them pushes the pinned message per HEARTBEAT_SEC window
// (they all extend the SAME account expiry, so one write per window is enough).
const PUSHED_PATH = path.join(CONFIG_DIR, '.pushed');
const NET_TIMEOUT_MS = 6000;
const WATCHDOG_MS = 9000; // absolute cap so Claude is never blocked by a hang

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
  const timeout = Number(parsed.timeout) || DEFAULT_TTL_SEC;
  return {
    botToken: decryptToken(parsed.botToken),
    groupId: String(parsed.groupId),
    ttl: timeout, // honor the configured timeout verbatim (no hard floor)
    stateMessageId: parsed.stateMessageId || null,
  };
}

// Absolute expiry (epoch MILLISECONDS) a holder stamps on the pinned message so
// any reader judges freshness by the HOLDER's timeout, not its own: exp is
// `now + timeout`, and a reader treats the entry as active while `Date.now() <
// exp`. Milliseconds so the stored number is a direct `new Date(exp)` timestamp.
function expiryFor(cfg) {
  return Date.now() + cfg.ttl * 1000;
}

/**
 * Whether an account entry is still within its holder-declared window. Uses the
 * absolute `exp` when present; falls back to the legacy `ts` (epoch seconds)
 * judged against the reader's ttl so old pinned messages still resolve.
 */
function isActive(cur, cfg) {
  if (!cur) return false;
  const exp = Number(cur.exp);
  if (Number.isFinite(exp)) return Date.now() < exp;
  const ts = Number(cur.ts) || 0;
  return ts > 0 && nowSec() - ts < cfg.ttl;
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
 * The raw MAC address of the primary physical NIC, or '' when none is usable.
 * Loopback and virtual adapters (docker/bridge/veth/vpn/vm) are skipped: their
 * MACs are random per container/boot and do not identify the machine. When a
 * host has several physical adapters the candidates are sorted by interface
 * name so the SAME one is chosen on every run (stable id).
 */
function primaryMac() {
  const ifaces = os.networkInterfaces();
  const virtual =
    /^(lo|docker|br-|veth|virbr|vnet|vmnet|vboxnet|tun|tap|utun|awdl|llw|bridge|zt|wg|tailscale)/i;
  const macs = [];
  for (const name of Object.keys(ifaces)) {
    if (virtual.test(name)) continue;
    for (const ni of ifaces[name] || []) {
      if (ni.internal) continue;
      const mac = (ni.mac || '').toLowerCase();
      if (!mac || mac === '00:00:00:00:00:00') continue;
      macs.push({ name, mac });
    }
  }
  if (macs.length === 0) return '';
  macs.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return macs[0].mac;
}

/**
 * A STABLE, HASHED machine id derived from the physical NIC MAC — '' when no
 * usable NIC exists (callers then fall back to a hostname-only identity).
 *
 * The public IP was previously part of the holder identity to disambiguate
 * colliding hostnames, but it is unstable: an office link can switch between two
 * public IPs on the SAME physical machine, which manufactured false
 * cross-machine conflicts. A NIC's MAC does not change when the IP switches, so
 * it is the reliable machine identity. The raw MAC is never stored or sent — it
 * is hashed with HMAC-SHA256 keyed by the local `.secret` (falling back to a
 * plain SHA-256 digest when the secret is absent), so the hardware address
 * cannot be recovered from the pinned Telegram state or the history log.
 */
function getMachineId() {
  const mac = primaryMac();
  if (!mac) return '';
  let key = null;
  try {
    key = fs.readFileSync(SECRET_PATH); // per-install 32-byte key
  } catch (_e) {
    /* secret not provisioned yet → unkeyed digest is still stable per machine */
  }
  const h = key ? crypto.createHmac('sha256', key) : crypto.createHash('sha256');
  return h.update(mac).digest('hex').slice(0, 16);
}

/**
 * Whether the lock entry `cur` belongs to THIS machine. Identity is the stable
 * hashed machine id (`mid`, from the physical NIC MAC): globally unique AND
 * unchanged when the public IP switches, so an office that alternates between
 * two public IPs on one machine no longer manufactures a false conflict. The
 * `mid` is only compared when BOTH sides have it; older entries (or a host with
 * no usable NIC) carry none, so the comparison falls back to the hostname alone
 * — never to the volatile IP, which was the source of the false conflicts.
 */
function sameHolder(cur, machine, mid) {
  if (!cur) return false;
  if (cur.mid && mid) return cur.mid === mid;
  return cur.machine === machine;
}

// --------------------------------------------------------------------------
// network (best-effort; never throws)
// --------------------------------------------------------------------------
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

/**
 * Read the shared state from the group's pinned message.
 * `pinned:false` means NO readable state is pinned right now (never pinned,
 * someone unpinned it, or another message was pinned on top) — the returned
 * messageId then falls back to the remembered stateMessageId so a write can
 * repair the situation by editing + RE-PINNING that same message.
 */
async function readState(cfg) {
  const chat = await tgApi(cfg.botToken, 'getChat', { chat_id: cfg.groupId });
  const pinned = chat && chat.ok && chat.result && chat.result.pinned_message;
  if (pinned && pinned.text) {
    const parsed = parseStateText(pinned.text);
    if (parsed) return { state: parsed, messageId: pinned.message_id, pinned: true };
  }
  return {
    state: { v: 1, accounts: {} },
    messageId: cfg.stateMessageId || null,
    pinned: false,
  };
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

/**
 * Persist the state. When `repin` is set (the state message is not currently
 * pinned — e.g. a human unpinned it), a successful edit is followed by
 * pinChatMessage on the SAME id: without this, edits land on an invisible
 * message and every machine sees an empty state (auto-access for everyone).
 */
async function writeState(cfg, state, messageId, repin) {
  const text = stateText(state);
  if (messageId) {
    const r = await tgApi(cfg.botToken, 'editMessageText', {
      chat_id: cfg.groupId,
      message_id: messageId,
      text,
    });
    // "message is not modified" is still a success for our purposes.
    if (r && (r.ok || (r.description || '').includes('not modified'))) {
      if (repin) {
        const p = await tgApi(cfg.botToken, 'pinChatMessage', {
          chat_id: cfg.groupId,
          message_id: messageId,
          disable_notification: true,
        });
        if (p && p.ok) {
          appendHistory('REPIN', `message_id=${messageId}`);
          await notify(
            cfg,
            `⚠️ State message bị unpin — đã pin lại (message_id ${messageId}).`
          );
        }
      }
      return messageId;
    }
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
//   line 1: role  = "owner" | "conflict"
//   line 2: ts    = last heartbeat / last conflict re-check epoch
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

// Machine-wide "last conflict reminder" timestamp (epoch seconds).
function readRemindTs() {
  try {
    return parseInt(fs.readFileSync(REMIND_PATH, 'utf8'), 10) || 0;
  } catch (_e) {
    return 0;
  }
}

function writeRemindTs() {
  try {
    fs.mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
    fs.writeFileSync(REMIND_PATH, `${nowSec()}\n`, { mode: 0o600 });
  } catch (_e) {
    /* best-effort */
  }
}

// Machine-wide "last remote exp refresh" timestamp (epoch seconds). Lets N live
// sessions coalesce their heartbeat pushes into one editMessageText per window.
function readPushTs() {
  try {
    return parseInt(fs.readFileSync(PUSHED_PATH, 'utf8'), 10) || 0;
  } catch (_e) {
    return 0;
  }
}

function writePushTs() {
  try {
    fs.mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
    fs.writeFileSync(PUSHED_PATH, `${nowSec()}\n`, { mode: 0o600 });
  } catch (_e) {
    /* best-effort */
  }
}

// --------------------------------------------------------------------------
// machine-local session refcount + atomic open/close notification gate
// --------------------------------------------------------------------------
function activePath(sessionId) {
  const safe = String(sessionId || 'unknown').replace(/[^a-zA-Z0-9_-]/g, '_');
  return path.join(ACTIVE_DIR, safe);
}

// Register (or refresh the heartbeat of) this session in the local active set.
function localActiveAdd(sessionId) {
  try {
    fs.mkdirSync(ACTIVE_DIR, { recursive: true, mode: 0o700 });
    fs.writeFileSync(activePath(sessionId), `${nowSec()}\n`, { mode: 0o600 });
  } catch (_e) {
    /* best-effort */
  }
}

function localActiveRemove(sessionId) {
  try {
    fs.unlinkSync(activePath(sessionId));
  } catch (_e) {
    /* best-effort */
  }
}

/**
 * Number of sessions still live on THIS machine, pruning entries whose last
 * heartbeat is older than `ttl` (a crashed session that never sent SessionEnd).
 */
function localActiveCount(ttl) {
  let n = 0;
  let names;
  try {
    names = fs.readdirSync(ACTIVE_DIR);
  } catch (_e) {
    return 0; // dir absent → nothing active
  }
  for (const name of names) {
    const p = path.join(ACTIVE_DIR, name);
    try {
      const ts = parseInt(fs.readFileSync(p, 'utf8'), 10) || 0;
      if (nowSec() - ts < ttl) n += 1;
      else fs.unlinkSync(p); // prune a stale (crashed) session
    } catch (_e) {
      /* unreadable entry → ignore */
    }
  }
  return n;
}

/**
 * Claim the right to post the ✅ "opened" notice for this machine. Returns true
 * for exactly ONE caller while no notice is outstanding: the exclusive `wx`
 * write means concurrent starters race on the filesystem, not over the network.
 * A notice left behind by a crash (older than `ttl`) is treated as orphaned and
 * re-claimed so the machine is not muted forever.
 */
function claimOpenNotice(ttl) {
  try {
    fs.mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
    fs.writeFileSync(OPEN_NOTICE_PATH, `${nowSec()}\n`, { flag: 'wx', mode: 0o600 });
    return true;
  } catch (_e) {
    try {
      const ts = parseInt(fs.readFileSync(OPEN_NOTICE_PATH, 'utf8'), 10) || 0;
      if (nowSec() - ts > ttl) {
        fs.writeFileSync(OPEN_NOTICE_PATH, `${nowSec()}\n`, { mode: 0o600 });
        return true; // orphaned notice → re-claim
      }
    } catch (_e2) {
      /* unreadable → treat as already claimed */
    }
    return false;
  }
}

/**
 * Clear the outstanding open notice. Returns true for exactly ONE caller (the
 * unlink succeeds once), so only that caller posts the 👋 "closed" notice even
 * when several sessions end at the same instant.
 */
function releaseOpenNotice() {
  try {
    fs.unlinkSync(OPEN_NOTICE_PATH);
    return true;
  } catch (_e) {
    return false;
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
  const mid = getMachineId();
  const sessionId = input.session_id || 'unknown';

  const { state, messageId, pinned } = await readState(cfg);
  const cur = state.accounts[account];
  const active = isActive(cur, cfg); // within the HOLDER-declared exp window?
  const ours = sameHolder(cur, machine, mid);

  // A holder on a DIFFERENT machine that is still within its own declared expiry
  // is a LIVE conflict. Once its `exp` has passed it is treated as free and this
  // session takes the lock over. No reader-side floor: the holder's timeout —
  // baked into `exp` — decides the window, so machines with different timeouts
  // no longer disagree about when a lock is stale.
  const liveConflict = active && !ours;

  // Conflict: same account, held by a DIFFERENT machine, still fresh.
  // Policy: NOTIFY-ONLY — the group gets a warning naming both machines, but
  // nothing is blocked or killed. The pinned state stays with the holder
  // (READ-ONLY here). The 'conflict' marker makes PreToolUse re-check the
  // holder and repeat the warning every CONFLICT_REMIND_SEC while the account
  // is still being used elsewhere — and take the lock over once it is free.
  if (liveConflict) {
    writeMarker(sessionId, 'conflict');
    writeRemindTs(); // the start notice counts as the first reminder
    appendHistory('CONFLICT', `holder=${cur.machine}`);
    await notify(
      cfg,
      `⚠️ <b>Conflict</b>\n` +
        `Account <b>${esc(account)}</b> đang được dùng ở <b>${esc(cur.machine)}</b>.\n` +
        `Máy <b>${esc(machine)}</b> vừa mở thêm một phiên Claude.`
    );
    // Surface the concurrent usage so Claude can mention it to the user.
    process.stdout.write(
      JSON.stringify({
        hookSpecificOutput: {
          hookEventName: 'SessionStart',
          additionalContext:
            `claude-session-monitor: account ${account} is also active on ${cur.machine}. ` +
            `A conflict notification was sent to the Telegram group (and will repeat while the conflict lasts); ` +
            `this session is NOT blocked.`,
        },
      })
    );
    return 0;
  }

  // Taking over an EXPIRED lock left by a DIFFERENT machine: don't inherit its
  // sessions, and announce the takeover so the group sees the machine change.
  const staleHolder = cur && !ours && !active ? cur.machine : null;
  if (staleHolder) {
    appendHistory('TAKEOVER', `expired holder=${staleHolder}`);
  }

  // Free (or same machine) → acquire or join the lock. The pinned message keeps
  // only identity (mid) + display label (machine) + expiry (exp = now + timeout);
  // the live session set is tracked locally (ACTIVE_DIR) so the message never
  // grows with per-session UUIDs.
  state.accounts[account] = { machine, mid, exp: expiryFor(cfg) };
  await writeState(cfg, state, messageId, !pinned);
  writeMarker(sessionId, 'owner');
  writePushTs(); // this write is the latest remote refresh (heartbeats coalesce off it)

  // Notify ONCE per machine-active period. The local refcount is the source of
  // truth: register this session, then let exactly one concurrent starter win
  // the open-notice claim. Extra sessions (whether they launched together or
  // joined later) register silently instead of each posting their own ✅.
  localActiveAdd(sessionId);
  if (claimOpenNotice(cfg.ttl)) {
    appendHistory('START', '');
    await notify(
      cfg,
      staleHolder
        ? `♻️ <b>${esc(account)}</b> tiếp quản lock (holder cũ <b>${esc(staleHolder)}</b> stale)` +
            ` @ <b>${esc(machine)}</b>.`
        : `✅ <b>${esc(account)}</b> mở session @ <b>${esc(machine)}</b>.`
    );
  }
  return 0;
}

async function onPreToolUse(cfg, input) {
  const sessionId = input.session_id || 'unknown';
  const m = readMarker(sessionId);

  // Conflict → throttled re-check: remind the group while the account is still
  // used elsewhere; take the lock over (and stop reminding) once it is free.
  if (m && m.role === 'conflict' && nowSec() - m.ts >= CONFLICT_REMIND_SEC) {
    writeMarker(sessionId, 'conflict'); // refresh local ts first (throttle)
    try {
      const account = getAccount();
      const machine = getMachine();
      const mid = getMachineId();
      const { state, messageId, pinned } = await readState(cfg);
      const cur = state.accounts[account];
      const ours = sameHolder(cur, machine, mid);

      if (cur && !ours && isActive(cur, cfg)) {
        // Still a live conflict. One reminder per machine per window: several
        // conflicted sessions here share the REMIND_PATH throttle.
        if (nowSec() - readRemindTs() >= CONFLICT_REMIND_SEC) {
          writeRemindTs();
          appendHistory('CONFLICT', `holder=${cur.machine} (reminder)`);
          await notify(
            cfg,
            `⚠️ <b>Conflict (nhắc lại)</b>\n` +
              `Account <b>${esc(account)}</b> vẫn đang được dùng ở <b>${esc(cur.machine)}</b>` +
              ` trong khi máy <b>${esc(machine)}</b> cũng đang chạy.`
          );
        }
      } else {
        // The other machine's lock expired → this session takes it over and
        // becomes a normal owner (reminders stop).
        state.accounts[account] = { machine, mid, exp: expiryFor(cfg) };
        await writeState(cfg, state, messageId, !pinned);
        writeMarker(sessionId, 'owner');
        localActiveAdd(sessionId);
        writePushTs();
        if (claimOpenNotice(cfg.ttl)) {
          appendHistory('START', '(after conflict)');
          await notify(
            cfg,
            `✅ <b>${esc(account)}</b> mở session @ <b>${esc(machine)}</b>` +
              ` — conflict trước đó đã kết thúc.`
          );
        }
      }
    } catch (_e) {
      /* reminder is best-effort */
    }
    return 0;
  }

  // Owner → keep the lock alive during long work. The local marker + active file
  // refresh every window (per-session, cheap); the REMOTE exp is refreshed at
  // most once per window MACHINE-WIDE, so N live sessions coalesce into a single
  // editMessageText instead of each re-writing the same expiry.
  if (m && m.role === 'owner' && nowSec() - m.ts >= HEARTBEAT_SEC) {
    writeMarker(sessionId, 'owner'); // refresh local ts first (fast)
    localActiveAdd(sessionId); // keep this session from being pruned as stale
    if (nowSec() - readPushTs() < HEARTBEAT_SEC) return 0; // another session already pushed
    writePushTs(); // claim this window; only this caller refreshes the remote exp
    try {
      const account = getAccount();
      const mid = getMachineId();
      const { state, messageId, pinned } = await readState(cfg);
      const cur = state.accounts[account];
      // `!cur` self-heals a LOST state (someone unpinned/deleted the state
      // message): this session verifiably owns the lock (owner marker), so its
      // entry is rebuilt and the write below re-pins the state message.
      if (!cur || sameHolder(cur, getMachine(), mid)) {
        // Re-emit the minimal shape (also strips any legacy sessions/session/ip).
        state.accounts[account] = { machine: getMachine(), mid, exp: expiryFor(cfg) };
        await writeState(cfg, state, messageId, !pinned);
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

  // Only release if we actually held the lock (a conflicted session that never
  // registered owns nothing).
  if (!m || m.role !== 'owner') return 0;

  // Drop this session from the local refcount first. Whether the group is
  // notified is decided by the LOCAL count, so the 👋 fires exactly once — when
  // the LAST session on this machine ends — no matter how the remote state races.
  localActiveRemove(sessionId);
  const stillActiveLocally = localActiveCount(cfg.ttl) > 0;

  try {
    const account = getAccount();
    const machine = getMachine();
    const mid = getMachineId();
    const { state, messageId, pinned } = await readState(cfg);
    const cur = state.accounts[account];
    if (!sameHolder(cur, machine, mid)) return 0; // lock no longer ours

    if (stillActiveLocally) {
      // Other sessions on this machine are still open → keep the lock, no noti.
      // Extend the expiry and re-emit the minimal shape (strips legacy fields).
      state.accounts[account] = { machine, mid, exp: expiryFor(cfg) };
      await writeState(cfg, state, messageId, !pinned);
      return 0;
    }

    // Last session on this machine closed → release the lock. Only the caller
    // that clears the open-notice flag posts the 👋, so concurrent ends collapse
    // to a single "closed" notice.
    delete state.accounts[account];
    await writeState(cfg, state, messageId, !pinned);
    if (releaseOpenNotice()) {
      appendHistory('END', '');
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

  // stdout may be a broken pipe if the parent went away — swallow the EPIPE
  // instead of crashing before the Telegram report is sent.
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
  CONFLICT_REMIND_SEC,
  REMIND_PATH,
  ACTIVE_DIR,
  OPEN_NOTICE_PATH,
  PUSHED_PATH,
  esc,
  markerPath,
  decryptToken,
  loadConfig,
  expiryFor,
  isActive,
  saveStateMessageId,
  getAccount,
  getMachine,
  primaryMac,
  getMachineId,
  sameHolder,
  parseStateText,
  stateText,
  liveSessions,
  writeMarker,
  readMarker,
  removeMarker,
  readRemindTs,
  writeRemindTs,
  readPushTs,
  writePushTs,
  localActiveAdd,
  localActiveRemove,
  localActiveCount,
  claimOpenNotice,
  releaseOpenNotice,
  appendHistory,
  onSessionStart,
  onPreToolUse,
  onSessionEnd,
  main,
};

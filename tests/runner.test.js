'use strict';

/**
 * Unit tests for src/hooks/runner.js — the self-contained hook runtime.
 *
 * runner.js captures its path constants (CONFIG_PATH, SECRET_PATH, CLAUDE_JSON)
 * from os.homedir() at REQUIRE time, so os.homedir() is spied to an isolated
 * temp directory BEFORE the module is required. The real ~/.claude is never
 * touched. Only pure/local logic is exercised here — no network calls.
 */

const os = require('os');
const path = require('path');
const fs = require('fs');
const https = require('https');
const { EventEmitter } = require('events');

const TMP_HOME = path.join(os.tmpdir(), `csm-runner-${process.pid}-${Date.now()}`);
fs.mkdirSync(path.join(TMP_HOME, '.claude', 'session-monitor'), { recursive: true });

// os.homedir() ignores $HOME under Jest's sandbox, so spy it BEFORE requiring the
// modules — both runner.js and config.js capture their paths at load time.
jest.spyOn(os, 'homedir').mockReturnValue(TMP_HOME);

const runner = require('../src/hooks/runner');
const config = require('../src/services/config'); // encrypts a token runner decrypts

// HARD GUARD: never allow the runtime under test to touch the real home.
if (!runner.CONFIG_PATH.startsWith(os.tmpdir())) {
  throw new Error(`ISOLATION FAILED: ${runner.CONFIG_PATH} is not under tmpdir`);
}

const CLAUDE_JSON = path.join(TMP_HOME, '.claude.json');
const RUNNER_TOKEN = '8158799098:AAG_secret_token_value_123456789012345';

function runnerConfig(overrides = {}) {
  return {
    version: '1.0.0',
    botToken: RUNNER_TOKEN,
    groupId: '-1003974360838',
    timeout: 1800,
    approvalMode: false,
    machineName: 'test-machine',
    installedAt: '2026-07-01T00:00:00.000Z',
    ...overrides,
  };
}

// A fresh, unique session id keeps marker files (which live in os.tmpdir(), not
// under HOME) from colliding across tests or parallel runs.
let sessionCounter = 0;
function freshSessionId(suffix = '') {
  sessionCounter += 1;
  return `csm-test-${process.pid}-${Date.now()}-${sessionCounter}${suffix}`;
}

beforeEach(() => {
  // Every test starts from a clean config directory and no ~/.claude.json.
  config.deleteConfig();
  try {
    fs.unlinkSync(CLAUDE_JSON);
  } catch (_e) {
    /* already absent */
  }
});

afterAll(() => {
  fs.rmSync(TMP_HOME, { recursive: true, force: true });
});

describe('esc (HTML escaping)', () => {
  test('escapes ampersand, less-than, and greater-than', () => {
    // Arrange
    const raw = 'a & b < c > d';

    // Act
    const escaped = runner.esc(raw);

    // Assert
    expect(escaped).toBe('a &amp; b &lt; c &gt; d');
  });

  test('coerces null and undefined to an empty string', () => {
    expect(runner.esc(null)).toBe('');
    expect(runner.esc(undefined)).toBe('');
  });
});

describe('stateText / parseStateText', () => {
  test('roundtrips an object and prefixes the state header', () => {
    // Arrange
    const state = {
      v: 1,
      accounts: {
        'x@y.com': { machine: 'laptop', ip: '1.2.3.4', session: 's1', ts: 123 },
      },
    };

    // Act
    const text = runner.stateText(state);
    const parsed = runner.parseStateText(text);

    // Assert
    expect(text.startsWith(runner.STATE_HEADER)).toBe(true);
    expect(parsed).toEqual(state);
  });

  test('returns null for text without a JSON object', () => {
    expect(runner.parseStateText('no braces')).toBeNull();
  });

  test('returns null when the JSON body is malformed', () => {
    expect(runner.parseStateText('header\n{bad json')).toBeNull();
  });

  test('returns null for valid JSON that lacks an accounts key', () => {
    expect(runner.parseStateText('header\n{"v":1}')).toBeNull();
  });
});

describe('liveSessions (multi-session refcount)', () => {
  const TTL = 1800;
  const now = () => Math.floor(Date.now() / 1000);

  test('returns an empty map for a null/absent account entry', () => {
    expect(runner.liveSessions(null, TTL)).toEqual({});
    expect(runner.liveSessions(undefined, TTL)).toEqual({});
  });

  test('keeps fresh sessions and drops stale ones', () => {
    // Arrange — one fresh session, one whose heartbeat is older than the ttl.
    const fresh = now();
    const stale = now() - TTL - 10;
    const cur = { machine: 'm1', sessions: { a: fresh, b: stale } };

    // Act
    const live = runner.liveSessions(cur, TTL);

    // Assert
    expect(live).toEqual({ a: fresh });
  });

  test('migrates the legacy single `session` field using the entry ts', () => {
    // Arrange — pre-multi-session state shape.
    const ts = now();
    const cur = { machine: 'm1', session: 'legacy-id', ts };

    // Act
    const live = runner.liveSessions(cur, TTL);

    // Assert
    expect(live).toEqual({ 'legacy-id': ts });
  });

  test('drops a legacy `session` whose entry ts is stale', () => {
    const cur = { machine: 'm1', session: 'legacy-id', ts: now() - TTL - 10 };
    expect(runner.liveSessions(cur, TTL)).toEqual({});
  });

  test('prefers the sessions map over the legacy field when both exist', () => {
    const ts = now();
    const cur = { machine: 'm1', session: 'old', ts, sessions: { new1: ts, new2: ts } };
    expect(runner.liveSessions(cur, TTL)).toEqual({ new1: ts, new2: ts });
  });
});

describe('markerPath', () => {
  test('returns a path under os.tmpdir() and sanitizes unsafe chars to "_"', () => {
    // Act
    const p = runner.markerPath('a/b c!@#');
    const base = path.basename(p);

    // Assert
    expect(p.startsWith(os.tmpdir())).toBe(true);
    expect(p).toBe(path.join(os.tmpdir(), 'claude-csm-a_b_c___.marker'));
    // No path separators or shell-unsafe chars leaked into the file name.
    expect(base).not.toMatch(/[^a-zA-Z0-9_.-]/);
  });
});

describe('markers (writeMarker / readMarker / removeMarker)', () => {
  test('writes an owner marker and reads back role plus a numeric ts', () => {
    // Arrange
    const id = freshSessionId();

    // Act
    runner.writeMarker(id, 'owner');
    const marker = runner.readMarker(id);

    // Assert
    expect(marker.role).toBe('owner');
    expect(typeof marker.ts).toBe('number');
    expect(marker.ts).toBeGreaterThan(0);

    runner.removeMarker(id);
  });

  test('overwriting an owner marker with blocked is reflected on read', () => {
    // Arrange
    const id = freshSessionId();
    runner.writeMarker(id, 'owner');

    // Act
    runner.writeMarker(id, 'blocked');
    const marker = runner.readMarker(id);

    // Assert
    expect(marker.role).toBe('blocked');

    runner.removeMarker(id);
  });

  test('removeMarker deletes the marker so a later read returns null', () => {
    // Arrange
    const id = freshSessionId();
    runner.writeMarker(id, 'owner');
    expect(runner.readMarker(id)).not.toBeNull();

    // Act
    runner.removeMarker(id);

    // Assert
    expect(runner.readMarker(id)).toBeNull();
  });

  test('roundtrips a session id containing slashes and special chars', () => {
    // Arrange — markerPath sanitizes, but write/read use the same mapping.
    const id = freshSessionId('/weird:id*name');

    // Act
    runner.writeMarker(id, 'owner');
    const marker = runner.readMarker(id);

    // Assert
    expect(marker.role).toBe('owner');
    expect(typeof marker.ts).toBe('number');

    runner.removeMarker(id);
    expect(runner.readMarker(id)).toBeNull();
  });
});

describe('decrypt compatibility + loadConfig', () => {
  test('decrypts a config saved by config.js and floors ttl to the timeout', () => {
    // Arrange — config.js encrypts the token; runner.js must decrypt it.
    config.saveConfig(runnerConfig());

    // Act
    const loaded = runner.loadConfig();

    // Assert — botToken match proves AES-GCM decrypt is compatible.
    expect(loaded).toEqual({
      botToken: RUNNER_TOKEN,
      groupId: '-1003974360838',
      ttl: 1800,
      stateMessageId: null,
    });
  });

  test('floors ttl to TTL_FLOOR_SEC when the configured timeout is smaller', () => {
    // Arrange
    config.saveConfig(runnerConfig({ timeout: 60 }));

    // Act
    const loaded = runner.loadConfig();

    // Assert
    expect(loaded.ttl).toBe(runner.TTL_FLOOR_SEC);
    expect(loaded.botToken).toBe(RUNNER_TOKEN);
  });
});

describe('saveStateMessageId', () => {
  test('persists stateMessageId while keeping the token encrypted at rest', () => {
    // Arrange
    config.saveConfig(runnerConfig());

    // Act
    runner.saveStateMessageId(4242);

    // Assert — the plaintext token must never reach disk.
    const raw = fs.readFileSync(runner.CONFIG_PATH, 'utf8');
    expect(raw).not.toContain(RUNNER_TOKEN);
    expect(typeof JSON.parse(raw).botToken).toBe('object');

    // And the id round-trips through a fresh decrypt-capable load.
    expect(runner.loadConfig().stateMessageId).toBe(4242);
  });
});

describe('getAccount', () => {
  test('returns the oauth email address when present', () => {
    // Arrange
    fs.writeFileSync(CLAUDE_JSON, JSON.stringify({ oauthAccount: { emailAddress: 'x@y.com' } }));

    // Act + Assert
    expect(runner.getAccount()).toBe('x@y.com');
  });

  test('falls back to the account uuid when there is no email', () => {
    // Arrange
    fs.writeFileSync(
      CLAUDE_JSON,
      JSON.stringify({ oauthAccount: { accountUuid: 'uuid-abc-123' } })
    );

    // Act + Assert
    expect(runner.getAccount()).toBe('uuid-abc-123');
  });

  test('returns "unknown-account" when ~/.claude.json is missing', () => {
    // Arrange — beforeEach already removed the file.

    // Act + Assert
    expect(runner.getAccount()).toBe('unknown-account');
  });
});

describe('public-IP cache', () => {
  beforeEach(() => {
    try {
      fs.unlinkSync(runner.IP_CACHE_PATH);
    } catch (_e) {
      /* ignore */
    }
  });

  test('readIpCache returns null when no cache file exists', () => {
    expect(runner.readIpCache()).toBeNull();
  });

  test('writeIpCache then readIpCache roundtrips ip, loc, and a numeric ts', () => {
    // Act
    runner.writeIpCache('116.110.29.22', 'Da Nang · Viettel');
    const cached = runner.readIpCache();

    // Assert
    expect(cached.ip).toBe('116.110.29.22');
    expect(cached.loc).toBe('Da Nang · Viettel');
    expect(Number.isFinite(cached.ts)).toBe(true);
  });

  test('cache file lives under the isolated session-monitor dir', () => {
    expect(runner.IP_CACHE_PATH.startsWith(os.tmpdir())).toBe(true);
    expect(runner.IP_CACHE_PATH.endsWith('.ipcache')).toBe(true);
  });

  test('resolveNetInfo returns the cached value without any network call when fresh', async () => {
    // Arrange — a fresh cache entry (ts = now).
    runner.writeIpCache('203.0.113.7', 'Hanoi · VNPT');

    // Act — must resolve fast from disk, never hitting the IP services.
    const started = Date.now();
    const info = await runner.resolveNetInfo();
    const elapsed = Date.now() - started;

    // Assert
    expect(info).toEqual({ ip: '203.0.113.7', loc: 'Hanoi · VNPT' });
    expect(elapsed).toBeLessThan(200);
  });

  test('readIpCache reflects a stale entry (old ts) so resolveNetInfo will refetch', () => {
    // Arrange — ensure the dir exists, then write a manually-staled entry.
    fs.mkdirSync(path.dirname(runner.IP_CACHE_PATH), { recursive: true });
    fs.writeFileSync(
      runner.IP_CACHE_PATH,
      JSON.stringify({ ip: '1.1.1.1', loc: 'old', ts: 1 })
    );

    // Act
    const cached = runner.readIpCache();

    // Assert — TTL window is far in the past, so this is stale.
    expect(cached.ts).toBe(1);
    expect(Math.floor(Date.now() / 1000) - cached.ts).toBeGreaterThan(runner.IP_CACHE_TTL_SEC);
  });
});

describe('appendHistory (runner-side local history)', () => {
  test('writes tab-separated lines that config.readHistory can parse', () => {
    // Act — write from the standalone runner, read via the CLI's parser.
    runner.appendHistory('CONFLICT', 'holder=machine-a, killed=2, failed=0');
    const rows = config.readHistory();

    // Assert
    const last = rows[rows.length - 1];
    expect(last.event).toBe('CONFLICT');
    expect(last.machine).toBe(os.hostname());
    expect(last.detail).toBe('holder=machine-a, killed=2, failed=0');
    expect(Number.isNaN(Date.parse(last.ts))).toBe(false);
  });

  test('sanitizes tabs and newlines in the detail so rows stay one-per-line', () => {
    // Act
    runner.appendHistory('START', 'a\tb\nc');
    const rows = config.readHistory();

    // Assert — the injected separators must not split the row.
    const last = rows[rows.length - 1];
    expect(last.event).toBe('START');
    expect(last.detail).toBe('a b c');
  });
});

describe('listClaudePids (conflict kill targeting)', () => {
  // A fake /proc: only numeric dirs whose comm is EXACTLY "claude" (and not
  // this process's own pid) may be returned.
  function fakeProc(entries) {
    const root = path.join(TMP_HOME, `proc-${Date.now()}-${Math.random()}`);
    for (const [pid, comm] of Object.entries(entries)) {
      fs.mkdirSync(path.join(root, pid), { recursive: true });
      if (comm !== null) fs.writeFileSync(path.join(root, pid, 'comm'), `${comm}\n`);
    }
    return root;
  }

  test('returns only pids whose comm is exactly "claude"', () => {
    // Arrange
    const root = fakeProc({ 101: 'claude', 202: 'node', 303: 'claude-helper' });

    // Act + Assert — no substring matches (a cmdline match would catch the
    // hook itself, whose path contains ".claude/").
    expect(runner.listClaudePids(root)).toEqual([101]);
  });

  test('skips non-numeric entries and dirs without a readable comm', () => {
    // Arrange
    const root = fakeProc({ 404: 'claude', 505: null });
    fs.mkdirSync(path.join(root, 'self'), { recursive: true });
    fs.writeFileSync(path.join(root, 'uptime'), '12345');

    // Act + Assert
    expect(runner.listClaudePids(root)).toEqual([404]);
  });

  test('excludes this process own pid even when its comm says claude', () => {
    // Arrange — the hook must never target itself.
    const root = fakeProc({ [process.pid]: 'claude', 606: 'claude' });

    // Act + Assert
    expect(runner.listClaudePids(root)).toEqual([606]);
  });

  test('a missing /proc root falls through to pgrep without throwing (darwin path)', () => {
    // Arrange — a root that does not exist forces the unix fallback branch.
    const root = path.join(TMP_HOME, 'no-such-proc');

    // Act + Assert — pgrep may or may not find real claude processes on the
    // CI box; the contract is: an array, never our own pid, never a throw.
    const pids = runner.listClaudePids(root);
    expect(Array.isArray(pids)).toBe(true);
    expect(pids).not.toContain(process.pid);
  });
});

describe('currentClaudePid (spare our own session from the conflict kill)', () => {
  // A fake /proc where each pid has a `comm` and a `status` (with PPid) so the
  // parent-chain walk can be exercised deterministically.
  function fakeProc(entries) {
    const root = path.join(TMP_HOME, `proc-cc-${Date.now()}-${Math.random()}`);
    for (const [pid, { comm, ppid }] of Object.entries(entries)) {
      fs.mkdirSync(path.join(root, pid), { recursive: true });
      if (comm !== null) fs.writeFileSync(path.join(root, pid, 'comm'), `${comm}\n`);
      fs.writeFileSync(path.join(root, pid, 'status'), `Name:\t${comm}\nPPid:\t${ppid}\n`);
    }
    return root;
  }

  test('walks up the parent chain and returns the nearest claude ancestor', () => {
    // Arrange — this hook (node) ← bash wrapper ← claude ← init.
    const root = fakeProc({
      [process.pid]: { comm: 'node', ppid: 900 },
      900: { comm: 'bash', ppid: 800 },
      800: { comm: 'claude', ppid: 1 },
    });

    // Act + Assert
    expect(runner.currentClaudePid(root)).toBe(800);
  });

  test('returns 0 when no claude ancestor exists (e.g. run under jest)', () => {
    // Arrange — a chain that never hits a claude comm.
    const root = fakeProc({
      [process.pid]: { comm: 'node', ppid: 900 },
      900: { comm: 'bash', ppid: 1 },
    });

    // Act + Assert
    expect(runner.currentClaudePid(root)).toBe(0);
  });

  test('returns 0 without throwing when /proc is missing', () => {
    const root = path.join(TMP_HOME, 'no-such-proc-cc');
    expect(runner.currentClaudePid(root)).toBe(0);
  });
});

describe('parseTasklistPids (Windows tasklist CSV)', () => {
  test('extracts pids from claude.exe rows only, case-insensitively', () => {
    // Arrange — realistic `tasklist /FO CSV /NH` output.
    const csv = [
      '"claude.exe","1234","Console","1","145,678 K"',
      '"Claude.EXE","5678","Console","1","98,304 K"',
      '"node.exe","9999","Console","1","50,000 K"',
      '"claude-helper.exe","4321","Console","1","10,000 K"',
    ].join('\r\n');

    // Act + Assert
    expect(runner.parseTasklistPids(csv)).toEqual([1234, 5678]);
  });

  test('returns [] for the no-match INFO sentence and empty input', () => {
    expect(
      runner.parseTasklistPids(
        'INFO: No tasks are running which match the specified criteria.'
      )
    ).toEqual([]);
    expect(runner.parseTasklistPids('')).toEqual([]);
    expect(runner.parseTasklistPids(null)).toEqual([]);
  });

  test('excludes this process own pid', () => {
    // Arrange — if the hook somehow shows up as claude.exe, never self-kill.
    const csv = `"claude.exe","${process.pid}","Console","1","1,000 K"`;
    expect(runner.parseTasklistPids(csv)).toEqual([]);
  });
});

describe('onSessionStart — lock check against the pinned state message', () => {
  const ACCOUNT = 'x@y.com';
  const TTL = 1800; // runnerConfig() timeout

  // ---- fake Telegram transport -------------------------------------------
  // Replaces https.request so tests fully control what the "pinned message"
  // contains (exactly what a human can fake by chatting + pinning manually)
  // and capture every Bot API call the runner makes.
  let apiCalls;
  let stdoutSpy;
  let killSpy;

  function mockTelegram(routes) {
    jest.spyOn(https, 'request').mockImplementation((options, cb) => {
      let body = '';
      const req = {
        on: () => req,
        setTimeout: () => req,
        destroy: () => {},
        write: (chunk) => {
          body += chunk;
        },
        end: () => {
          const method = String(options.path).split('/').pop();
          const params = body ? JSON.parse(body) : {};
          apiCalls.push({ method, params });
          const result = routes[method]
            ? routes[method](params)
            : { ok: true, result: {} };
          const res = new EventEmitter();
          cb(res);
          process.nextTick(() => {
            res.emit('data', JSON.stringify(result));
            res.emit('end');
          });
        },
      };
      return req;
    });
    // Any stray public-IP lookup fails fast instead of hitting the network.
    jest.spyOn(https, 'get').mockImplementation(() => {
      const req = {
        on: (ev, fn) => {
          if (ev === 'error') process.nextTick(() => fn(new Error('offline')));
          return req;
        },
        setTimeout: () => req,
        destroy: () => {},
      };
      return req;
    });
  }

  function pinnedChat(stateObj, messageId = 555) {
    return {
      getChat: () => ({
        ok: true,
        result: {
          pinned_message: {
            message_id: messageId,
            text: `${runner.STATE_HEADER}\n${JSON.stringify(stateObj)}`,
          },
        },
      }),
    };
  }

  function heldByOtherMachine(ts = Math.floor(Date.now() / 1000)) {
    return {
      v: 1,
      accounts: {
        [ACCOUNT]: {
          machine: 'may-gia-lap',
          ip: '1.2.3.4',
          loc: 'Test · Fake',
          sessions: { 'fake-1': ts },
          ts,
        },
      },
    };
  }

  // The exact JSON the user hand-pinned while testing conflict manually (see
  // image.png): one real session id, Da Nang / Viettel. `machine` and `ts` are
  // parameterized so the same real-world shape drives both the same-machine
  // (join) and cross-machine (conflict) outcomes.
  const REAL_SESSION_ID = '797c2a4b-61bf-485b-93e1-1b2c3d4e5f60';
  function realWorldState({ machine, ts = Math.floor(Date.now() / 1000) }) {
    return {
      v: 1,
      accounts: {
        [ACCOUNT]: {
          machine,
          ip: '116.110.29.22',
          loc: 'Da Nang · Viettel Corporation',
          sessions: { [REAL_SESSION_ID]: ts },
          ts,
        },
      },
    };
  }

  const sent = (method) => apiCalls.filter((c) => c.method === method);

  // Drives the real handler with the runtime's own decrypted config.
  const runnerOnSessionStart = (input) =>
    runner.onSessionStart(runner.loadConfig(), input);

  beforeEach(() => {
    apiCalls = [];
    config.saveConfig(runnerConfig());
    fs.writeFileSync(CLAUDE_JSON, JSON.stringify({ oauthAccount: { emailAddress: ACCOUNT } }));
    runner.writeIpCache('203.0.113.7', 'Test · Cache'); // keep acquire path offline
    // SAFETY: never let the conflict branch SIGKILL real processes under jest.
    killSpy = jest.spyOn(process, 'kill').mockImplementation(() => true);
    stdoutSpy = jest.spyOn(process.stdout, 'write').mockImplementation(() => true);
  });

  afterEach(() => {
    killSpy.mockRestore();
    stdoutSpy.mockRestore();
    https.request.mockRestore();
    https.get.mockRestore();
  });

  test('lock held by ANOTHER machine → blocks this session, spares own TUI, state untouched', async () => {
    // Arrange — the exact scenario a human can fake: a pinned message whose
    // JSON says the account is active on a different machine, fresh ts.
    const id = freshSessionId();
    mockTelegram(pinnedChat(heldByOtherMachine()));

    // Act
    const rc = await runnerOnSessionStart({ session_id: id });

    // Assert — exit code and the local block marker (the real enforcement).
    expect(rc).toBe(0);
    expect(runner.readMarker(id).role).toBe('blocked');

    // The current session's own claude is ALWAYS spared (killing its raw-mode
    // TUI wedges the terminal). Any kills that do happen (other local sessions)
    // are individual SIGKILLs and never target us. NB: this suite may run
    // inside a real Claude session, so some kills can legitimately occur.
    const spared = runner.currentClaudePid();
    for (const [pid, sig] of killSpy.mock.calls) {
      expect(sig).toBe('SIGKILL');
      expect(pid).toBeGreaterThan(0); // a pid, never a process group (-pgid)
      expect(pid).not.toBe(process.pid);
      if (spared) expect(pid).not.toBe(spared);
    }

    // Telegram: exactly one ⛔ notify reporting the block.
    const notifies = sent('sendMessage');
    expect(notifies).toHaveLength(1);
    expect(notifies[0].params.text).toContain('⛔');
    expect(notifies[0].params.text).toContain('đã bị chặn');
    expect(notifies[0].params.text).toContain('may-gia-lap');

    // The holder's lock is NEVER stolen or cleared: no state writes at all.
    expect(sent('editMessageText')).toHaveLength(0);
    expect(sent('pinChatMessage')).toHaveLength(0);

    // Local history recorded the conflict with the holder and (zero) kill counts.
    const rows = config.readHistory();
    const last = rows[rows.length - 1];
    expect(last.event).toBe('CONFLICT');
    expect(last.detail).toMatch(/^holder=may-gia-lap\/1\.2\.3\.4, killed=\d+, failed=\d+$/);

    runner.removeMarker(id);
  });

  test('a manually-crafted pinned message (any header text) is honored', async () => {
    // Arrange — no bot header at all, just pasted JSON: parseStateText only
    // needs the first "{" and an accounts key.
    const id = freshSessionId();
    mockTelegram({
      getChat: () => ({
        ok: true,
        result: {
          pinned_message: {
            message_id: 556,
            text: `fake tay\n${JSON.stringify(heldByOtherMachine())}`,
          },
        },
      }),
    });

    // Act
    const rc = await runnerOnSessionStart({ session_id: id });

    // Assert — treated exactly like a bot-written lock.
    expect(rc).toBe(0);
    expect(runner.readMarker(id).role).toBe('blocked');
    expect(sent('sendMessage')[0].params.text).toContain('⛔');

    runner.removeMarker(id);
  });

  test('lock held by THIS machine (same hostname AND same IP) → joins silently, no kill, no notify', async () => {
    // Arrange — same hostname, same public IP (the cached 203.0.113.7),
    // another live session already refcounted.
    const now = Math.floor(Date.now() / 1000);
    const id = freshSessionId();
    mockTelegram(
      pinnedChat({
        v: 1,
        accounts: {
          [ACCOUNT]: {
            machine: os.hostname(),
            ip: '203.0.113.7',
            loc: '',
            sessions: { 'other-live': now },
            ts: now,
          },
        },
      })
    );

    // Act
    const rc = await runnerOnSessionStart({ session_id: id });

    // Assert
    expect(rc).toBe(0);
    expect(runner.readMarker(id).role).toBe('owner');
    expect(killSpy).not.toHaveBeenCalled();
    expect(sent('sendMessage')).toHaveLength(0); // not the first session → silent
    // The refreshed state keeps BOTH sessions on this machine.
    const written = JSON.parse(
      sent('editMessageText')[0].params.text.slice(
        sent('editMessageText')[0].params.text.indexOf('{')
      )
    );
    expect(Object.keys(written.accounts[ACCOUNT].sessions).sort()).toEqual(
      ['other-live', id].sort()
    );

    runner.removeMarker(id);
  });

  test('STALE lock from another machine (ts beyond ttl) → acquires, no kill', async () => {
    // Arrange — the fake holder's ts expired: fail-open by design.
    const id = freshSessionId();
    mockTelegram(pinnedChat(heldByOtherMachine(Math.floor(Date.now() / 1000) - TTL - 60)));

    // Act
    const rc = await runnerOnSessionStart({ session_id: id });

    // Assert
    expect(rc).toBe(0);
    expect(runner.readMarker(id).role).toBe('owner');
    expect(killSpy).not.toHaveBeenCalled();
    // First session on this machine → one ✅ notify + a state write.
    expect(sent('sendMessage')).toHaveLength(1);
    expect(sent('sendMessage')[0].params.text).toContain('✅');
    expect(sent('editMessageText')).toHaveLength(1);

    runner.removeMarker(id);
  });

  test('STALE holder within ttl (no heartbeat > 10min) → takes over, no kill', async () => {
    // Arrange — the holder is still inside the configured ttl (1800s) but has
    // not been seen for longer than TTL_FLOOR_SEC (600s): a crashed/idle holder
    // that never released. Re-entry must NOT SIGKILL this machine forever.
    const staleAge = runner.TTL_FLOOR_SEC + 120; // > floor, still < ttl (1800)
    const id = freshSessionId();
    mockTelegram(pinnedChat(heldByOtherMachine(Math.floor(Date.now() / 1000) - staleAge)));

    // Act
    const rc = await runnerOnSessionStart({ session_id: id });

    // Assert — this machine owns the lock now, nothing was killed.
    expect(rc).toBe(0);
    expect(runner.readMarker(id).role).toBe('owner');
    expect(killSpy).not.toHaveBeenCalled();

    // A takeover notice was sent and the state was rewritten to this machine,
    // dropping the stale holder's sessions.
    const notifies = sent('sendMessage');
    expect(notifies).toHaveLength(1);
    expect(notifies[0].params.text).toContain('♻️');
    expect(notifies[0].params.text).toContain('may-gia-lap'); // the stale holder
    const edits = sent('editMessageText');
    expect(edits).toHaveLength(1);
    const written = JSON.parse(edits[0].params.text.slice(edits[0].params.text.indexOf('{')));
    expect(written.accounts[ACCOUNT].machine).toBe(os.hostname());
    expect(Object.keys(written.accounts[ACCOUNT].sessions)).toEqual([id]);

    // History recorded the takeover with the stale holder + age.
    const rows = config.readHistory();
    const takeover = rows.reverse().find((r) => r.event === 'TAKEOVER');
    expect(takeover).toBeDefined();
    expect(takeover.detail).toMatch(/^stale holder=may-gia-lap\/1\.2\.3\.4, age=\d+s$/);

    runner.removeMarker(id);
  });

  test('UNPINNED state (nothing pinned) → fail-open: acquires and pins fresh state', async () => {
    // Arrange — getChat returns no pinned_message; stateMessageId is null.
    const id = freshSessionId();
    mockTelegram({
      getChat: () => ({ ok: true, result: {} }),
      sendMessage: (params) =>
        params.disable_notification
          ? { ok: true, result: { message_id: 777 } } // the new state message
          : { ok: true, result: {} }, // the ✅ notify
    });

    // Act
    const rc = await runnerOnSessionStart({ session_id: id });

    // Assert — owner, a fresh state message was created AND pinned.
    expect(rc).toBe(0);
    expect(runner.readMarker(id).role).toBe('owner');
    expect(killSpy).not.toHaveBeenCalled();
    expect(sent('pinChatMessage')).toHaveLength(1);
    expect(sent('pinChatMessage')[0].params.message_id).toBe(777);
    expect(runner.loadConfig().stateMessageId).toBe(777);

    runner.removeMarker(id);
  });

  // ---- real-world repro from the hand-pinned JSON (image.png) --------------
  // PC A and PC B are DIFFERENT machines that share the hostname "pc". The
  // holder identity is therefore hostname AND public IP: a matching hostname
  // with a different IP is a different machine and must conflict.

  test('same hostname but DIFFERENT public IP → conflict fires and blocks (PC A vs PC B)', async () => {
    // The pinned holder says machine=<this hostname> ip=116.110.29.22 while
    // this machine's cached public IP is 203.0.113.7 → different machine.
    const id = freshSessionId();
    mockTelegram(pinnedChat(realWorldState({ machine: os.hostname() })));

    // Act
    const rc = await runnerOnSessionStart({ session_id: id });

    // Assert — blocked, ⛔ names the holder with BOTH IPs, state untouched.
    expect(rc).toBe(0);
    expect(runner.readMarker(id).role).toBe('blocked');
    const notifies = sent('sendMessage');
    expect(notifies).toHaveLength(1);
    expect(notifies[0].params.text).toContain('⛔');
    expect(notifies[0].params.text).toContain('116.110.29.22'); // holder's IP
    expect(notifies[0].params.text).toContain('203.0.113.7'); // this machine's IP
    expect(sent('editMessageText')).toHaveLength(0);
    expect(sent('pinChatMessage')).toHaveLength(0);

    runner.removeMarker(id);
  });

  test('same hostname, holder has NO recorded IP → falls back to hostname match and joins', async () => {
    // The holder's start-time IP lookup failed (ip: ''): never manufacture a
    // conflict from missing data — hostname comparison decides alone.
    const now = Math.floor(Date.now() / 1000);
    const id = freshSessionId();
    mockTelegram(
      pinnedChat({
        v: 1,
        accounts: {
          [ACCOUNT]: {
            machine: os.hostname(),
            ip: '',
            loc: '',
            sessions: { 'other-live': now },
            ts: now,
          },
        },
      })
    );

    // Act
    const rc = await runnerOnSessionStart({ session_id: id });

    // Assert — joined as owner, no conflict.
    expect(rc).toBe(0);
    expect(runner.readMarker(id).role).toBe('owner');
    expect(killSpy).not.toHaveBeenCalled();
    expect(sent('sendMessage')).toHaveLength(0);

    runner.removeMarker(id);
  });

  test('same hostname, OUR IP lookup fails → falls back to hostname match and joins', async () => {
    // No usable local IP (empty cache + offline): hostname comparison decides.
    const now = Math.floor(Date.now() / 1000);
    const id = freshSessionId();
    runner.writeIpCache('', ''); // fresh cache entry with an unknown IP
    mockTelegram(
      pinnedChat({
        v: 1,
        accounts: {
          [ACCOUNT]: {
            machine: os.hostname(),
            ip: '9.9.9.9',
            loc: '',
            sessions: { 'other-live': now },
            ts: now,
          },
        },
      })
    );

    // Act
    const rc = await runnerOnSessionStart({ session_id: id });

    // Assert — joined as owner, no conflict.
    expect(rc).toBe(0);
    expect(runner.readMarker(id).role).toBe('owner');
    expect(killSpy).not.toHaveBeenCalled();
    expect(sent('sendMessage')).toHaveLength(0);

    runner.removeMarker(id);
  });

  test('FIX: same JSON but "machine" ≠ this host → conflict fires and blocks', async () => {
    // The correct way to exercise conflict: the pinned "machine" must differ
    // from the real hostname. Anything but os.hostname() works.
    const id = freshSessionId();
    const otherMachine = `${os.hostname()}-remote`;
    mockTelegram(pinnedChat(realWorldState({ machine: otherMachine })));

    // Act
    const rc = await runnerOnSessionStart({ session_id: id });

    // Assert — this session is blocked and a ⛔ conflict names the holder.
    expect(rc).toBe(0);
    expect(runner.readMarker(id).role).toBe('blocked');
    const notifies = sent('sendMessage');
    expect(notifies).toHaveLength(1);
    expect(notifies[0].params.text).toContain('⛔');
    expect(notifies[0].params.text).toContain(otherMachine);

    // Read-only: the holder's lock is never overwritten on conflict.
    expect(sent('editMessageText')).toHaveLength(0);
    expect(sent('pinChatMessage')).toHaveLength(0);

    runner.removeMarker(id);
  });
});

describe('killPids', () => {
  test('SIGKILLs a live process and reports it in `killed`', async () => {
    // Arrange — a real disposable child that would otherwise live 60s.
    const { spawn } = require('child_process');
    const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)']);
    const exited = new Promise((resolve) => child.on('exit', (_c, sig) => resolve(sig)));

    // Act
    const res = runner.killPids([child.pid]);

    // Assert
    expect(res.killed).toEqual([child.pid]);
    expect(res.failed).toEqual([]);
    await expect(exited).resolves.toBe('SIGKILL');
  });

  test('reports a nonexistent pid in `failed` without throwing', () => {
    // Arrange — spawn+reap a child so its pid is guaranteed dead.
    const { spawnSync } = require('child_process');
    const dead = spawnSync(process.execPath, ['-e', '']).pid;

    // Act
    const res = runner.killPids([dead]);

    // Assert
    expect(res.killed).toEqual([]);
    expect(res.failed).toEqual([dead]);
  });

  test('returns empty results for an empty pid list', () => {
    expect(runner.killPids([])).toEqual({ killed: [], failed: [] });
  });
});

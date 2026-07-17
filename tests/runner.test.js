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

  test('rewriting a marker refreshes its content on read', () => {
    // Arrange
    const id = freshSessionId();
    runner.writeMarker(id, 'owner');
    const first = runner.readMarker(id);

    // Act — rewrite (as the heartbeat does) and read back.
    runner.writeMarker(id, 'owner');
    const marker = runner.readMarker(id);

    // Assert
    expect(marker.role).toBe('owner');
    expect(marker.ts).toBeGreaterThanOrEqual(first.ts);

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

  test('honors the configured timeout verbatim as ttl (no hard floor)', () => {
    // Arrange
    config.saveConfig(runnerConfig({ timeout: 60 }));

    // Act
    const loaded = runner.loadConfig();

    // Assert — ttl now tracks the config timeout exactly.
    expect(loaded.ttl).toBe(60);
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

describe('appendHistory (runner-side local history)', () => {
  test('writes tab-separated lines that config.readHistory can parse', () => {
    // Act — write from the standalone runner, read via the CLI's parser.
    runner.appendHistory('CONFLICT', 'holder=machine-a/1.2.3.4');
    const rows = config.readHistory();

    // Assert
    const last = rows[rows.length - 1];
    expect(last.event).toBe('CONFLICT');
    expect(last.machine).toBe(os.hostname());
    expect(last.detail).toBe('holder=machine-a/1.2.3.4');
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
  function realWorldState({ machine, mid, ip = '116.110.29.22', ts = Math.floor(Date.now() / 1000) }) {
    return {
      v: 1,
      accounts: {
        [ACCOUNT]: {
          machine,
          ...(mid ? { mid } : {}),
          ip,
          loc: 'Da Nang · Viettel Corporation',
          sessions: { [REAL_SESSION_ID]: ts },
          ts,
        },
      },
    };
  }

  // A deterministic MAC-derived machine id: force one physical NIC so both the
  // runtime under test and the fixtures agree on getMachineId() regardless of
  // the host/CI hardware. Returns { mid, restore } — call restore() when done.
  function withFakeNic(mac) {
    const spy = jest
      .spyOn(os, 'networkInterfaces')
      .mockReturnValue({
        lo: [{ address: '127.0.0.1', mac: '00:00:00:00:00:00', internal: true, family: 'IPv4' }],
        eth0: [{ address: '10.0.0.2', mac, internal: false, family: 'IPv4' }],
      });
    return { mid: runner.getMachineId(), restore: () => spy.mockRestore() };
  }

  const sent = (method) => apiCalls.filter((c) => c.method === method);

  // Simulate that another Claude session already opened on THIS machine: it
  // registered in the local refcount and claimed the open-notice. A new session
  // that then joins must stay silent (the ✅ was already posted for this period).
  const simulateMachineAlreadyOpen = (otherId = 'other-live') => {
    runner.localActiveAdd(otherId);
    runner.claimOpenNotice(TTL);
  };

  // Drives the real handler with the runtime's own decrypted config.
  const runnerOnSessionStart = (input) =>
    runner.onSessionStart(runner.loadConfig(), input);

  beforeEach(() => {
    apiCalls = [];
    config.saveConfig(runnerConfig());
    fs.writeFileSync(CLAUDE_JSON, JSON.stringify({ oauthAccount: { emailAddress: ACCOUNT } }));
    // SAFETY NET: the runner must never signal any process; the spy both
    // guards jest and lets tests assert process.kill is untouched.
    killSpy = jest.spyOn(process, 'kill').mockImplementation(() => true);
    stdoutSpy = jest.spyOn(process.stdout, 'write').mockImplementation(() => true);
  });

  afterEach(() => {
    killSpy.mockRestore();
    stdoutSpy.mockRestore();
    https.request.mockRestore();
  });

  test('lock held by ANOTHER machine → notify-only conflict, no kill, no marker, state untouched', async () => {
    // Arrange — the exact scenario a human can fake: a pinned message whose
    // JSON says the account is active on a different machine, fresh ts.
    const id = freshSessionId();
    mockTelegram(pinnedChat(heldByOtherMachine()));

    // Act
    const rc = await runnerOnSessionStart({ session_id: id });

    // Assert — session runs on: exit 0, a 'conflict' marker (so PreToolUse can
    // keep reminding), and absolutely no process is killed.
    expect(rc).toBe(0);
    expect(runner.readMarker(id).role).toBe('conflict');
    expect(killSpy).not.toHaveBeenCalled();

    // Telegram: exactly one ⚠️ warning naming the holder.
    const notifies = sent('sendMessage');
    expect(notifies).toHaveLength(1);
    expect(notifies[0].params.text).toContain('⚠️');
    expect(notifies[0].params.text).toContain('may-gia-lap');

    // The holder's lock is NEVER stolen or cleared: no state writes at all.
    expect(sent('editMessageText')).toHaveLength(0);
    expect(sent('pinChatMessage')).toHaveLength(0);

    // Local history recorded the conflict with the holder.
    const rows = config.readHistory();
    const last = rows[rows.length - 1];
    expect(last.event).toBe('CONFLICT');
    expect(last.detail).toBe('holder=may-gia-lap');
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

    // Assert — treated exactly like a bot-written lock: conflict warning sent.
    expect(rc).toBe(0);
    expect(runner.readMarker(id).role).toBe('conflict');
    expect(killSpy).not.toHaveBeenCalled();
    expect(sent('sendMessage')[0].params.text).toContain('⚠️');

    runner.removeMarker(id);
  });

  test('lock held by THIS machine (same hostname AND same IP) → joins silently, no kill, no notify', async () => {
    // Arrange — same hostname, another live session already open on this machine.
    const now = Math.floor(Date.now() / 1000);
    const id = freshSessionId();
    simulateMachineAlreadyOpen();
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
    // Remote state is minimal {machine, mid, ts} — no per-session map. Both
    // sessions live in the machine-local ACTIVE_DIR refcount instead.
    const written = JSON.parse(
      sent('editMessageText')[0].params.text.slice(
        sent('editMessageText')[0].params.text.indexOf('{')
      )
    );
    expect(written.accounts[ACCOUNT].sessions).toBeUndefined();
    expect(written.accounts[ACCOUNT].machine).toBe(os.hostname());
    expect(runner.localActiveCount(TTL)).toBe(2); // other-live + id

    runner.removeMarker(id);
  });

  test('EXPIRED lock from another machine (past exp) → takes over with ♻️', async () => {
    // Arrange — the fake holder is past its declared expiry (legacy ts beyond ttl).
    const id = freshSessionId();
    mockTelegram(pinnedChat(heldByOtherMachine(Math.floor(Date.now() / 1000) - TTL - 60)));

    // Act
    const rc = await runnerOnSessionStart({ session_id: id });

    // Assert — expired foreign holder → this machine takes over as owner.
    expect(rc).toBe(0);
    expect(runner.readMarker(id).role).toBe('owner');
    expect(killSpy).not.toHaveBeenCalled();
    expect(sent('sendMessage')).toHaveLength(1);
    expect(sent('sendMessage')[0].params.text).toContain('♻️'); // takeover notice
    expect(sent('sendMessage')[0].params.text).toContain('may-gia-lap'); // expired holder
    const edits = sent('editMessageText');
    expect(edits).toHaveLength(1);
    const written = JSON.parse(edits[0].params.text.slice(edits[0].params.text.indexOf('{')));
    expect(written.accounts[ACCOUNT].machine).toBe(os.hostname());
    expect(written.accounts[ACCOUNT].sessions).toBeUndefined();
    expect(Number.isFinite(written.accounts[ACCOUNT].exp)).toBe(true); // holder-declared expiry

    // History recorded the takeover.
    const rows = config.readHistory();
    const takeover = rows.reverse().find((r) => r.event === 'TAKEOVER');
    expect(takeover).toBeDefined();
    expect(takeover.detail).toMatch(/^expired holder=may-gia-lap$/);

    runner.removeMarker(id);
  });

  test('holder still within its declared window → conflict warning, NOT stolen', async () => {
    // Arrange — a holder that has NOT expired (seen within its ttl). With no
    // reader-side floor, an active holder is protected: this machine WARNS
    // instead of stealing the lock (fixes early takeover across mismatched ttls).
    const withinWindow = 660; // < ttl (1800) → still active
    const id = freshSessionId();
    mockTelegram(pinnedChat(heldByOtherMachine(Math.floor(Date.now() / 1000) - withinWindow)));

    // Act
    const rc = await runnerOnSessionStart({ session_id: id });

    // Assert — conflict marker + ⚠️, holder state left untouched.
    expect(rc).toBe(0);
    expect(runner.readMarker(id).role).toBe('conflict');
    expect(killSpy).not.toHaveBeenCalled();
    const notifies = sent('sendMessage');
    expect(notifies).toHaveLength(1);
    expect(notifies[0].params.text).toContain('⚠️');
    expect(notifies[0].params.text).toContain('may-gia-lap');
    expect(sent('editMessageText')).toHaveLength(0); // read-only on conflict

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

  test('UNPIN sabotage: acquire edits the remembered state message AND re-pins it', async () => {
    // Someone unpinned the state message. getChat shows nothing pinned, but the
    // config remembers the message id — the write must edit THAT message and
    // pin it back, otherwise the state stays invisible and every machine gets
    // silent auto-access forever.
    const id = freshSessionId();
    runner.saveStateMessageId(555); // remembered from a previous write
    mockTelegram({ getChat: () => ({ ok: true, result: {} }) });

    // Act
    const rc = await runnerOnSessionStart({ session_id: id });

    // Assert — owner; state written to message 555 and RE-PINNED (same id).
    expect(rc).toBe(0);
    expect(runner.readMarker(id).role).toBe('owner');
    expect(sent('editMessageText')[0].params.message_id).toBe(555);
    const pins = sent('pinChatMessage');
    expect(pins).toHaveLength(1);
    expect(pins[0].params.message_id).toBe(555);
    // The group is told the pin was restored (plus the normal ✅ start notice).
    const texts = sent('sendMessage').map((c) => c.params.text);
    expect(texts.some((t) => t.includes('⚠️') && t.includes('pin lại'))).toBe(true);

    runner.removeMarker(id);
  });

  test('HEARTBEAT self-heal: owner rebuilds a lost/unpinned state and re-pins it', async () => {
    // The state message vanished (unpinned/deleted) while this machine holds
    // the lock. The owner's next heartbeat must rebuild its entry and re-pin —
    // this is what closes the "unpin → everyone auto-accesses" hole between
    // session starts.
    const id = freshSessionId();
    runner.saveStateMessageId(555);
    // Owner marker with a stale local ts so the remote heartbeat actually runs.
    fs.writeFileSync(
      runner.markerPath(id),
      `owner\n${Math.floor(Date.now() / 1000) - runner.HEARTBEAT_SEC - 5}\n`
    );
    mockTelegram({ getChat: () => ({ ok: true, result: {} }) }); // state GONE

    // Act
    const rc = await runner.onPreToolUse(runner.loadConfig(), { session_id: id });

    // Assert — entry rebuilt for this machine + session and re-pinned.
    expect(rc).toBe(0);
    const edit = sent('editMessageText')[0].params;
    expect(edit.message_id).toBe(555);
    const written = JSON.parse(edit.text.slice(edit.text.indexOf('{')));
    expect(written.accounts[ACCOUNT].machine).toBe(os.hostname());
    expect(written.accounts[ACCOUNT].sessions).toBeUndefined(); // minimal remote shape
    expect(sent('pinChatMessage')[0].params.message_id).toBe(555);

    runner.removeMarker(id);
  });

  // ---- MAC-based identity: IP switches must NOT manufacture conflicts -------
  // Identity is the stable hashed machine id (`mid`, from the NIC MAC), not the
  // public IP. Two machines sharing a hostname have DIFFERENT mids → conflict;
  // one machine whose office link switches IP keeps its mid → no conflict.

  test('same hostname, DIFFERENT machine id (mid) → conflict warning fires (PC A vs PC B)', async () => {
    // The pinned holder shares this hostname but carries a foreign mid → a
    // genuinely different physical machine.
    const id = freshSessionId();
    const nic = withFakeNic('aa:bb:cc:dd:ee:01'); // this machine's NIC
    mockTelegram(
      pinnedChat(realWorldState({ machine: os.hostname(), mid: 'ffffffffffffffff' }))
    );

    // Act
    const rc = await runnerOnSessionStart({ session_id: id });

    // Assert — notify-only conflict: ⚠️ names the holder, marker set, no kill,
    // holder state untouched.
    expect(rc).toBe(0);
    expect(runner.readMarker(id).role).toBe('conflict');
    expect(killSpy).not.toHaveBeenCalled();
    const notifies = sent('sendMessage');
    expect(notifies).toHaveLength(1);
    expect(notifies[0].params.text).toContain('⚠️');
    expect(notifies[0].params.text).toContain(ACCOUNT); // names the conflicted account
    expect(sent('editMessageText')).toHaveLength(0);
    expect(sent('pinChatMessage')).toHaveLength(0);

    nic.restore();
    runner.removeMarker(id);
  });

  test('same machine, public IP SWITCHED (same mid, different IP) → joins, NO conflict', async () => {
    // The office link flipped from 116.110.29.22 to this session's 203.0.113.7
    // on the SAME physical machine. Old IP-based identity fired a false
    // conflict; MAC-based identity recognises the same mid and joins silently.
    const id = freshSessionId();
    const nic = withFakeNic('aa:bb:cc:dd:ee:01');
    simulateMachineAlreadyOpen();
    mockTelegram(
      pinnedChat(realWorldState({ machine: os.hostname(), mid: nic.mid, ip: '116.110.29.22' }))
    );

    // Act
    const rc = await runnerOnSessionStart({ session_id: id });

    // Assert — joined as owner, no ⚠️ conflict, nothing killed.
    expect(rc).toBe(0);
    expect(runner.readMarker(id).role).toBe('owner');
    expect(killSpy).not.toHaveBeenCalled();
    expect(sent('sendMessage')).toHaveLength(0);

    nic.restore();
    runner.removeMarker(id);
  });

  test('same hostname, holder has NO recorded IP → falls back to hostname match and joins', async () => {
    // The holder's start-time IP lookup failed (ip: ''): never manufacture a
    // conflict from missing data — hostname comparison decides alone.
    const now = Math.floor(Date.now() / 1000);
    const id = freshSessionId();
    simulateMachineAlreadyOpen();
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
    // No usable local IP: hostname comparison decides.
    const now = Math.floor(Date.now() / 1000);
    const id = freshSessionId();
    simulateMachineAlreadyOpen();
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

  test('FIX: same JSON but "machine" ≠ this host → conflict warning fires', async () => {
    // The correct way to exercise conflict: the pinned "machine" must differ
    // from the real hostname. Anything but os.hostname() works.
    const id = freshSessionId();
    const otherMachine = `${os.hostname()}-remote`;
    mockTelegram(pinnedChat(realWorldState({ machine: otherMachine })));

    // Act
    const rc = await runnerOnSessionStart({ session_id: id });

    // Assert — a ⚠️ conflict warning names the holder; nothing is blocked.
    expect(rc).toBe(0);
    expect(runner.readMarker(id).role).toBe('conflict');
    expect(killSpy).not.toHaveBeenCalled();
    const notifies = sent('sendMessage');
    expect(notifies).toHaveLength(1);
    expect(notifies[0].params.text).toContain('⚠️');
    expect(notifies[0].params.text).toContain(otherMachine);

    // Read-only: the holder's lock is never overwritten on conflict.
    expect(sent('editMessageText')).toHaveLength(0);
    expect(sent('pinChatMessage')).toHaveLength(0);

    runner.removeMarker(id);
  });
});


describe('onPreToolUse — conflict reminders (notify-only spam guard)', () => {
  const ACCOUNT = 'x@y.com';

  let apiCalls;

  // Same fake Telegram transport as the onSessionStart suite: full control of
  // the pinned message, every Bot API call captured.
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

  const sent = (method) => apiCalls.filter((c) => c.method === method);

  /** Write a marker whose ts is already older than the remind interval. */
  function agedConflictMarker(id, ageSec = runner.CONFLICT_REMIND_SEC + 30) {
    fs.writeFileSync(
      runner.markerPath(id),
      `conflict\n${Math.floor(Date.now() / 1000) - ageSec}\n`
    );
  }

  function clearRemindThrottle() {
    try {
      fs.unlinkSync(runner.REMIND_PATH);
    } catch (_e) {
      /* absent */
    }
  }

  beforeEach(() => {
    apiCalls = [];
    config.saveConfig(runnerConfig());
    fs.writeFileSync(CLAUDE_JSON, JSON.stringify({ oauthAccount: { emailAddress: ACCOUNT } }));
    clearRemindThrottle();
  });

  afterEach(() => {
    https.request.mockRestore();
  });

  test('conflict still live + interval elapsed → sends one ⚠️ reminder, state untouched', async () => {
    // Arrange — an aged conflict marker and a holder still fresh on the pin.
    const id = freshSessionId();
    agedConflictMarker(id);
    mockTelegram(pinnedChat(heldByOtherMachine()));

    // Act
    const rc = await runner.onPreToolUse(runner.loadConfig(), { session_id: id });

    // Assert — one reminder naming the holder; still a conflict marker; the
    // holder's lock was not touched.
    expect(rc).toBe(0);
    expect(runner.readMarker(id).role).toBe('conflict');
    const notifies = sent('sendMessage');
    expect(notifies).toHaveLength(1);
    expect(notifies[0].params.text).toContain('nhắc lại');
    expect(notifies[0].params.text).toContain('may-gia-lap');
    expect(sent('editMessageText')).toHaveLength(0);

    // History logged the reminder.
    const rows = config.readHistory();
    expect(rows[rows.length - 1].event).toBe('CONFLICT');
    expect(rows[rows.length - 1].detail).toContain('(reminder)');

    runner.removeMarker(id);
  });

  test('inside the per-session interval → does nothing (no network, no notify)', async () => {
    // Arrange — a FRESH conflict marker (ts = now).
    const id = freshSessionId();
    runner.writeMarker(id, 'conflict');
    mockTelegram(pinnedChat(heldByOtherMachine()));

    // Act
    const rc = await runner.onPreToolUse(runner.loadConfig(), { session_id: id });

    // Assert — throttled: not a single Bot API call.
    expect(rc).toBe(0);
    expect(apiCalls).toHaveLength(0);
    expect(runner.readMarker(id).role).toBe('conflict');

    runner.removeMarker(id);
  });

  test('machine-wide throttle: a second conflicted session does NOT double-post', async () => {
    // Arrange — the machine already reminded just now (REMIND_PATH fresh),
    // but THIS session's marker is old enough to re-check.
    const id = freshSessionId();
    agedConflictMarker(id);
    runner.writeRemindTs(); // another session reminded moments ago
    mockTelegram(pinnedChat(heldByOtherMachine()));

    // Act
    const rc = await runner.onPreToolUse(runner.loadConfig(), { session_id: id });

    // Assert — the state was re-checked but no duplicate reminder was sent.
    expect(rc).toBe(0);
    expect(sent('sendMessage')).toHaveLength(0);
    expect(runner.readMarker(id).role).toBe('conflict');

    runner.removeMarker(id);
  });

  test('holder released the lock → takes over as owner, notifies ✅, reminders stop', async () => {
    // Arrange — aged conflict marker, but the pinned state is now EMPTY.
    const id = freshSessionId();
    agedConflictMarker(id);
    mockTelegram(pinnedChat({ v: 1, accounts: {} }));

    // Act
    const rc = await runner.onPreToolUse(runner.loadConfig(), { session_id: id });

    // Assert — the session registered itself and became a normal owner.
    expect(rc).toBe(0);
    expect(runner.readMarker(id).role).toBe('owner');
    const edits = sent('editMessageText');
    expect(edits).toHaveLength(1);
    const written = JSON.parse(edits[0].params.text.slice(edits[0].params.text.indexOf('{')));
    expect(written.accounts[ACCOUNT].machine).toBe(os.hostname());
    expect(written.accounts[ACCOUNT].sessions).toBeUndefined(); // minimal remote shape

    const notifies = sent('sendMessage');
    expect(notifies).toHaveLength(1);
    expect(notifies[0].params.text).toContain('✅');
    expect(notifies[0].params.text).toContain('conflict trước đó đã kết thúc');

    runner.removeMarker(id);
  });

  test('holder EXPIRED (past its window) → conflicted session takes over as owner', async () => {
    // Arrange — the holder is past its declared expiry (legacy ts beyond ttl).
    const id = freshSessionId();
    agedConflictMarker(id);
    mockTelegram(
      pinnedChat(heldByOtherMachine(Math.floor(Date.now() / 1000) - 1800 - 60)) // past ttl (1800)
    );

    // Act
    const rc = await runner.onPreToolUse(runner.loadConfig(), { session_id: id });

    // Assert — owner now; the expired holder's entry was replaced.
    expect(rc).toBe(0);
    expect(runner.readMarker(id).role).toBe('owner');
    const edits = sent('editMessageText');
    expect(edits).toHaveLength(1);
    const written = JSON.parse(edits[0].params.text.slice(edits[0].params.text.indexOf('{')));
    expect(written.accounts[ACCOUNT].machine).toBe(os.hostname());
    expect(written.accounts[ACCOUNT].sessions).toBeUndefined(); // minimal remote shape

    runner.removeMarker(id);
  });
});

// --------------------------------------------------------------------------
// The core fix for the "notification storm": several Claude sessions launching
// on ONE machine must not each post a ✅, and the 👋 must fire only once — when
// the LAST of them ends. The gate is a machine-local refcount + an atomic
// open-notice flag, so it holds even when the slow pinned-message round-trip
// races (every concurrent starter reads the state while it is still empty).
// --------------------------------------------------------------------------
describe('notify once per machine-active period (local refcount gate)', () => {
  const ACCOUNT = 'x@y.com';
  const TTL = 1800; // runnerConfig() timeout

  let apiCalls;
  let stored; // the current in-memory "pinned" state object (null = nothing pinned)
  let killSpy;
  let stdoutSpy;

  // A STATEFUL fake Telegram transport: getChat returns whatever the last
  // editMessageText / fresh sendMessage stored, so the refcount can be exercised
  // across a real start→end lifecycle.
  function mockStatefulTelegram() {
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
          const parseState = (t) => {
            const i = String(t || '').indexOf('{');
            return i >= 0 ? JSON.parse(String(t).slice(i)) : null;
          };
          let result = { ok: true, result: {} };
          if (method === 'getChat') {
            result = stored
              ? {
                  ok: true,
                  result: {
                    pinned_message: {
                      message_id: 555,
                      text: `${runner.STATE_HEADER}\n${JSON.stringify(stored)}`,
                    },
                  },
                }
              : { ok: true, result: {} };
          } else if (method === 'editMessageText') {
            const s = parseState(params.text);
            if (s) stored = s;
            result = { ok: true, result: { message_id: params.message_id || 555 } };
          } else if (method === 'sendMessage') {
            if (params.disable_notification) {
              const s = parseState(params.text); // a fresh state message
              if (s) stored = s;
              result = { ok: true, result: { message_id: 555 } };
            } else {
              result = { ok: true, result: { message_id: 1 } }; // a human-facing notice
            }
          }
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
  }

  // Human-facing notices only (the silent disable_notification state writes are
  // bookkeeping, not what the group sees).
  const notices = () =>
    apiCalls.filter((c) => c.method === 'sendMessage' && !c.params.disable_notification);
  const withEmoji = (e) => notices().filter((c) => String(c.params.text).includes(e));

  beforeEach(() => {
    apiCalls = [];
    stored = null;
    config.saveConfig(runnerConfig());
    fs.writeFileSync(CLAUDE_JSON, JSON.stringify({ oauthAccount: { emailAddress: ACCOUNT } }));
    killSpy = jest.spyOn(process, 'kill').mockImplementation(() => true);
    stdoutSpy = jest.spyOn(process.stdout, 'write').mockImplementation(() => true);
    mockStatefulTelegram();
  });

  afterEach(() => {
    killSpy.mockRestore();
    stdoutSpy.mockRestore();
    https.request.mockRestore();
  });

  test('claimOpenNotice wins once; releaseOpenNotice clears it once', () => {
    expect(runner.claimOpenNotice(TTL)).toBe(true); // first claimer wins
    expect(runner.claimOpenNotice(TTL)).toBe(false); // notice already outstanding
    expect(runner.releaseOpenNotice()).toBe(true); // cleared by exactly one caller
    expect(runner.releaseOpenNotice()).toBe(false); // nothing left to clear
    expect(runner.claimOpenNotice(TTL)).toBe(true); // can be claimed again next period
  });

  test('three sessions that all read empty state post exactly one ✅', async () => {
    // Arrange — the race: each start observes the pinned message while it is
    // still empty (resetting `stored` before each call), the exact condition
    // that made every session think it was the first.
    const cfg = runner.loadConfig();
    const ids = [freshSessionId(), freshSessionId(), freshSessionId()];

    // Act
    for (const id of ids) {
      stored = null;
      await runner.onSessionStart(cfg, { session_id: id });
    }

    // Assert — one ✅ for the whole burst, all three counted locally.
    expect(withEmoji('✅')).toHaveLength(1);
    expect(runner.localActiveCount(TTL)).toBe(3);

    ids.forEach((id) => runner.removeMarker(id));
  });

  test('👋 fires only when the LAST of several sessions ends', async () => {
    // Arrange — three sessions open on this machine (one ✅).
    const cfg = runner.loadConfig();
    const ids = [freshSessionId(), freshSessionId(), freshSessionId()];
    for (const id of ids) await runner.onSessionStart(cfg, { session_id: id });
    expect(withEmoji('✅')).toHaveLength(1);
    apiCalls.length = 0; // focus assertions on the close phase

    // Act + Assert — the first two ends are silent…
    await runner.onSessionEnd(cfg, { session_id: ids[0] });
    await runner.onSessionEnd(cfg, { session_id: ids[1] });
    expect(withEmoji('👋')).toHaveLength(0);
    expect(runner.localActiveCount(TTL)).toBe(1);

    // …only the last end posts the single 👋.
    await runner.onSessionEnd(cfg, { session_id: ids[2] });
    expect(withEmoji('👋')).toHaveLength(1);
    expect(runner.localActiveCount(TTL)).toBe(0);
  });

  test('a fresh session after everyone left opens a new period with its own ✅', async () => {
    const cfg = runner.loadConfig();
    const a = freshSessionId();
    await runner.onSessionStart(cfg, { session_id: a });
    await runner.onSessionEnd(cfg, { session_id: a });
    expect(withEmoji('✅')).toHaveLength(1);
    expect(withEmoji('👋')).toHaveLength(1);

    const b = freshSessionId();
    await runner.onSessionStart(cfg, { session_id: b });
    expect(withEmoji('✅')).toHaveLength(2); // a genuinely new active period
    runner.removeMarker(b);
  });
});

describe('exp-based freshness (holder-declared expiry)', () => {
  test('expiryFor returns a future epoch in MILLISECONDS', () => {
    const before = Date.now();
    const exp = runner.expiryFor({ ttl: 3600 });
    // ms (not seconds): ~now + 3.6M ms, and comfortably larger than a seconds value.
    expect(exp).toBeGreaterThanOrEqual(before + 3600 * 1000);
    expect(exp).toBeLessThan(before + 3600 * 1000 + 5000);
  });

  test('isActive uses exp when present (future = active, past = expired)', () => {
    const cfg = { ttl: 1800 };
    expect(runner.isActive({ exp: Date.now() + 60_000 }, cfg)).toBe(true);
    expect(runner.isActive({ exp: Date.now() - 1 }, cfg)).toBe(false);
    expect(runner.isActive(null, cfg)).toBe(false);
  });

  test('isActive falls back to legacy ts (seconds) against the reader ttl', () => {
    const cfg = { ttl: 1800 };
    const now = Math.floor(Date.now() / 1000);
    expect(runner.isActive({ ts: now - 100 }, cfg)).toBe(true); // within ttl
    expect(runner.isActive({ ts: now - 1900 }, cfg)).toBe(false); // beyond ttl
  });

  test('readPushTs/writePushTs roundtrip a machine-wide push timestamp', () => {
    config.deleteConfig();
    expect(runner.readPushTs()).toBe(0);
    runner.writePushTs();
    expect(runner.readPushTs()).toBeGreaterThan(0);
  });
});

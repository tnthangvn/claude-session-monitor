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

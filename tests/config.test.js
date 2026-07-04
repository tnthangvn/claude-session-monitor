'use strict';

/**
 * Unit tests for src/services/config.js.
 *
 * config.js resolves all paths from os.homedir() at REQUIRE time, so HOME is
 * redirected into an isolated temp directory BEFORE the module is required.
 * The real ~/.claude is never touched.
 */

const os = require('os');
const path = require('path');
const fs = require('fs');

const TMP_HOME = path.join(os.tmpdir(), `csm-config-${process.pid}-${Date.now()}`);
fs.mkdirSync(path.join(TMP_HOME, '.claude'), { recursive: true });

// os.homedir() ignores $HOME under Jest's sandbox, so spy it BEFORE requiring the
// module — config.js captures its path constants from os.homedir() at load time.
jest.spyOn(os, 'homedir').mockReturnValue(TMP_HOME);

const config = require('../src/services/config');

// HARD GUARD: never allow writes to the real home.
if (!config.CONFIG_DIR.startsWith(os.tmpdir())) {
  throw new Error(`ISOLATION FAILED: ${config.CONFIG_DIR} is not under tmpdir`);
}

const PLAINTEXT_TOKEN = '123456789:ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';

function sampleConfig(overrides = {}) {
  return {
    version: '1.0.0',
    botToken: PLAINTEXT_TOKEN,
    groupId: '-1001234567890',
    timeout: 300,
    approvalMode: false,
    machineName: 'test-machine',
    installedAt: '2026-07-01T00:00:00.000Z',
    ...overrides,
  };
}

beforeEach(() => {
  // Start each test from a clean config directory for full isolation.
  config.deleteConfig();
});

afterAll(() => {
  fs.rmSync(TMP_HOME, { recursive: true, force: true });
});

describe('exported constants', () => {
  test('resolve paths inside the isolated HOME', () => {
    expect(config.CONFIG_DIR).toBe(path.join(TMP_HOME, '.claude', 'session-monitor'));
    expect(config.CONFIG_PATH).toBe(path.join(config.CONFIG_DIR, 'config.json'));
    expect(config.HISTORY_PATH).toBe(path.join(config.CONFIG_DIR, 'history.log'));
  });

  test('exposes the default timeout', () => {
    expect(config.DEFAULT_TIMEOUT).toBe(600);
  });
});

describe('configExists', () => {
  test('is false before any save', () => {
    expect(config.configExists()).toBe(false);
  });

  test('is true after a save', () => {
    config.saveConfig(sampleConfig());
    expect(config.configExists()).toBe(true);
  });
});

describe('saveConfig / loadConfig roundtrip', () => {
  test('round-trips all fields with a decrypted plaintext token', () => {
    // Arrange
    const original = sampleConfig();

    // Act
    config.saveConfig(original);
    const loaded = config.loadConfig();

    // Assert
    expect(loaded.botToken).toBe(PLAINTEXT_TOKEN);
    expect(loaded.groupId).toBe(original.groupId);
    expect(loaded.timeout).toBe(original.timeout);
    expect(loaded.machineName).toBe(original.machineName);
    expect(loaded.version).toBe(original.version);
  });

  test('never writes the plaintext token to disk (encrypted at rest)', () => {
    // Arrange + Act
    config.saveConfig(sampleConfig());
    const raw = fs.readFileSync(config.CONFIG_PATH, 'utf8');
    const parsed = JSON.parse(raw);

    // Assert
    expect(raw).not.toContain(PLAINTEXT_TOKEN);
    expect(typeof parsed.botToken).toBe('object');
    expect(parsed.botToken).toEqual(
      expect.objectContaining({
        iv: expect.any(String),
        tag: expect.any(String),
        data: expect.any(String),
      })
    );
  });

  test('does not mutate the caller-supplied config object', () => {
    // Arrange
    const original = sampleConfig();

    // Act
    config.saveConfig(original);

    // Assert — caller still holds the plaintext token.
    expect(original.botToken).toBe(PLAINTEXT_TOKEN);
  });

  test('returns the path it wrote to', () => {
    expect(config.saveConfig(sampleConfig())).toBe(config.CONFIG_PATH);
  });

  test('throws when given a non-object config', () => {
    expect(() => config.saveConfig(null)).toThrow(/requires a config object/);
    expect(() => config.saveConfig('nope')).toThrow(/requires a config object/);
  });
});

describe('loadConfig error handling', () => {
  test('throws when the config file is missing', () => {
    expect(() => config.loadConfig()).toThrow(/Config not found/);
  });

  test('throws "corrupt" when the config file is not valid JSON', () => {
    // Arrange
    fs.mkdirSync(config.CONFIG_DIR, { recursive: true });
    fs.writeFileSync(config.CONFIG_PATH, '{ this is not json');

    // Act + Assert
    expect(() => config.loadConfig()).toThrow(/corrupt/);
  });

  test('throws "corrupt" when the encrypted token payload is tampered with', () => {
    // Arrange — save a valid config, then corrupt the ciphertext.
    config.saveConfig(sampleConfig());
    const parsed = JSON.parse(fs.readFileSync(config.CONFIG_PATH, 'utf8'));
    parsed.botToken.data = Buffer.from('tampered-ciphertext').toString('base64');
    fs.writeFileSync(config.CONFIG_PATH, JSON.stringify(parsed));

    // Act + Assert
    expect(() => config.loadConfig()).toThrow(/corrupt/);
  });
});

describe('appendHistory / readHistory', () => {
  test('appends a row and reads it back parsed', () => {
    // Act
    const ok = config.appendHistory('START', 'machine-a', 'new session');
    const rows = config.readHistory();

    // Assert
    expect(ok).toBe(true);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual(
      expect.objectContaining({
        event: 'START',
        machine: 'machine-a',
        detail: 'new session',
      })
    );
    expect(rows[0].ts).not.toBe('');
  });

  test('sanitizes tabs and newlines in fields', () => {
    // Act
    config.appendHistory('CON\tFLICT', 'mach\nine', 'de\rtail');
    const rows = config.readHistory();

    // Assert — the record is still exactly 4 columns (no field injection).
    expect(rows).toHaveLength(1);
    expect(rows[0].event).toBe('CON FLICT');
    expect(rows[0].machine).toBe('mach ine');
    expect(rows[0].detail).toBe('de tail');
  });

  test('coerces undefined/null fields to empty strings', () => {
    config.appendHistory('START', undefined, null);
    const rows = config.readHistory();
    expect(rows[0].machine).toBe('');
    expect(rows[0].detail).toBe('');
  });

  test('returns the last N rows when a limit is supplied', () => {
    // Arrange
    config.appendHistory('START', 'm1', 'one');
    config.appendHistory('CONFLICT', 'm2', 'two');
    config.appendHistory('START', 'm3', 'three');

    // Act
    const lastTwo = config.readHistory(2);

    // Assert
    expect(lastTwo).toHaveLength(2);
    expect(lastTwo[0].machine).toBe('m2');
    expect(lastTwo[1].machine).toBe('m3');
  });

  test('returns all rows when the limit is not smaller than the count', () => {
    config.appendHistory('START', 'm1', 'one');
    config.appendHistory('START', 'm2', 'two');
    expect(config.readHistory(5)).toHaveLength(2);
  });

  test('returns an empty array when no history file exists', () => {
    expect(config.readHistory()).toEqual([]);
  });
});

describe('deleteConfig', () => {
  test('removes the config directory and reports success', () => {
    // Arrange
    config.saveConfig(sampleConfig());
    expect(config.configExists()).toBe(true);

    // Act
    const ok = config.deleteConfig();

    // Assert
    expect(ok).toBe(true);
    expect(config.configExists()).toBe(false);
    expect(fs.existsSync(config.CONFIG_DIR)).toBe(false);
  });

  test('is safe to call when nothing exists', () => {
    expect(config.deleteConfig()).toBe(true);
  });
});

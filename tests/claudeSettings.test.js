'use strict';

/**
 * Unit tests for src/services/claudeSettings.js.
 * HOME is redirected before the module is required so SETTINGS_PATH resolves
 * into an isolated temp directory. Each test starts from a clean ~/.claude.
 */

const os = require('os');
const path = require('path');
const fs = require('fs');

const TMP_HOME = path.join(os.tmpdir(), `csm-settings-${process.pid}-${Date.now()}`);
fs.mkdirSync(path.join(TMP_HOME, '.claude'), { recursive: true });

// os.homedir() ignores $HOME under Jest's sandbox, so spy it BEFORE requiring the
// module — claudeSettings.js captures SETTINGS_PATH from os.homedir() at load time.
jest.spyOn(os, 'homedir').mockReturnValue(TMP_HOME);

const claudeSettings = require('../src/services/claudeSettings');

// HARD GUARD: never allow writes to the real home.
if (!claudeSettings.SETTINGS_PATH.startsWith(os.tmpdir())) {
  throw new Error(`ISOLATION FAILED: ${claudeSettings.SETTINGS_PATH} is not under tmpdir`);
}

const CLAUDE_DIR = path.join(TMP_HOME, '.claude');
const HOOK_COMMAND = path.join(CLAUDE_DIR, 'hooks', 'check-session-telegram.sh');

/** Write a settings.json object into the isolated home. */
function writeSettings(obj) {
  fs.mkdirSync(CLAUDE_DIR, { recursive: true });
  fs.writeFileSync(claudeSettings.SETTINGS_PATH, JSON.stringify(obj, null, 2));
}

beforeEach(() => {
  // Wipe the whole isolated ~/.claude so backups/settings never leak across tests.
  fs.rmSync(CLAUDE_DIR, { recursive: true, force: true });
});

afterAll(() => {
  fs.rmSync(TMP_HOME, { recursive: true, force: true });
});

describe('readSettings', () => {
  test('returns an empty object when the file is missing', () => {
    expect(claudeSettings.readSettings()).toEqual({});
  });

  test('returns an empty object when the file is blank', () => {
    writeSettings({});
    fs.writeFileSync(claudeSettings.SETTINGS_PATH, '   ');
    expect(claudeSettings.readSettings()).toEqual({});
  });

  test('parses valid JSON', () => {
    writeSettings({ theme: 'dark' });
    expect(claudeSettings.readSettings()).toEqual({ theme: 'dark' });
  });

  test('throws a friendly error on invalid JSON', () => {
    fs.mkdirSync(CLAUDE_DIR, { recursive: true });
    fs.writeFileSync(claudeSettings.SETTINGS_PATH, '{ not valid json');
    expect(() => claudeSettings.readSettings()).toThrow(/not valid JSON/);
  });
});

describe('backupSettings', () => {
  test('returns null when there is nothing to back up', () => {
    expect(claudeSettings.backupSettings()).toBeNull();
  });

  test('creates a timestamped backup when a file exists', () => {
    writeSettings({ theme: 'dark' });
    const backupPath = claudeSettings.backupSettings();
    expect(backupPath).toMatch(/settings\.json\.backup-/);
    expect(fs.existsSync(backupPath)).toBe(true);
  });
});

describe('installHook', () => {
  test('installs the hook and hasHook reports it present', () => {
    // Act
    const result = claudeSettings.installHook(HOOK_COMMAND);

    // Assert
    expect(result.alreadyPresent).toBe(false);
    expect(result.settingsPath).toBe(claudeSettings.SETTINGS_PATH);
    expect(claudeSettings.hasHook(HOOK_COMMAND)).toBe(true);
  });

  test('has no backup on first install (no prior settings file)', () => {
    const result = claudeSettings.installHook(HOOK_COMMAND);
    expect(result.backupPath).toBeNull();
  });

  test('is idempotent — a second install reports alreadyPresent', () => {
    // Arrange
    claudeSettings.installHook(HOOK_COMMAND);

    // Act
    const second = claudeSettings.installHook(HOOK_COMMAND);

    // Assert
    expect(second.alreadyPresent).toBe(true);
    expect(second.backupPath).toBeNull();
  });

  test('backs up an existing settings file before mutating it', () => {
    // Arrange
    writeSettings({ theme: 'dark' });

    // Act
    const result = claudeSettings.installHook(HOOK_COMMAND);

    // Assert
    expect(result.backupPath).not.toBeNull();
    expect(fs.existsSync(result.backupPath)).toBe(true);
  });

  test('preserves unrelated settings keys', () => {
    // Arrange
    writeSettings({ theme: 'dark', telemetry: false });

    // Act
    claudeSettings.installHook(HOOK_COMMAND);
    const settings = claudeSettings.readSettings();

    // Assert
    expect(settings.theme).toBe('dark');
    expect(settings.telemetry).toBe(false);
    expect(settings.hooks.PreToolUse).toHaveLength(1);
  });

  test('throws when the command is not a string', () => {
    expect(() => claudeSettings.installHook()).toThrow(/requires the hook command/);
    expect(() => claudeSettings.installHook(42)).toThrow(/requires the hook command/);
  });
});

describe('hasHook', () => {
  test('matches our script by heuristic when no command is passed', () => {
    claudeSettings.installHook(HOOK_COMMAND);
    expect(claudeSettings.hasHook()).toBe(true);
  });

  test('returns false when no settings exist', () => {
    expect(claudeSettings.hasHook(HOOK_COMMAND)).toBe(false);
  });
});

describe('previewHook', () => {
  test('describes the planned PreToolUse entry without writing anything', () => {
    const preview = claudeSettings.previewHook(HOOK_COMMAND);
    expect(preview).toEqual({
      settingsPath: claudeSettings.SETTINGS_PATH,
      event: 'PreToolUse',
      matcher: '*',
      command: HOOK_COMMAND,
      alreadyPresent: false,
      settingsExists: false,
    });
    // No file was created by previewing.
    expect(fs.existsSync(claudeSettings.SETTINGS_PATH)).toBe(false);
  });

  test('reflects an already-registered hook and an existing settings file', () => {
    claudeSettings.installHook(HOOK_COMMAND);
    const preview = claudeSettings.previewHook(HOOK_COMMAND);
    expect(preview.alreadyPresent).toBe(true);
    expect(preview.settingsExists).toBe(true);
  });

  test('throws when the command is not a string', () => {
    expect(() => claudeSettings.previewHook()).toThrow(/requires the hook command/);
    expect(() => claudeSettings.previewHook(42)).toThrow(/requires the hook command/);
  });
});

describe('removeHook', () => {
  test('removes our entry and prunes the now-empty group and hooks tree', () => {
    // Arrange
    claudeSettings.installHook(HOOK_COMMAND);

    // Act
    const result = claudeSettings.removeHook();
    const settings = claudeSettings.readSettings();

    // Assert
    expect(result.removed).toBe(true);
    expect(settings.hooks).toBeUndefined();
    expect(claudeSettings.hasHook(HOOK_COMMAND)).toBe(false);
  });

  test('preserves unrelated hook groups and top-level keys', () => {
    // Arrange — an unrelated PreToolUse hook plus ours.
    writeSettings({
      theme: 'dark',
      hooks: {
        PreToolUse: [
          { matcher: '*', hooks: [{ type: 'command', command: '/other-tool.sh' }] },
        ],
      },
    });
    claudeSettings.installHook(HOOK_COMMAND);

    // Act
    const result = claudeSettings.removeHook();
    const settings = claudeSettings.readSettings();

    // Assert — ours is gone, the unrelated group and theme remain.
    expect(result.removed).toBe(true);
    expect(settings.theme).toBe('dark');
    expect(settings.hooks.PreToolUse).toHaveLength(1);
    expect(settings.hooks.PreToolUse[0].hooks[0].command).toBe('/other-tool.sh');
  });

  test('backs up settings before removing', () => {
    claudeSettings.installHook(HOOK_COMMAND);
    const result = claudeSettings.removeHook();
    expect(result.backupPath).not.toBeNull();
    expect(fs.existsSync(result.backupPath)).toBe(true);
  });

  test('reports not-removed when there is no settings file', () => {
    const result = claudeSettings.removeHook();
    expect(result.removed).toBe(false);
    expect(result.backupPath).toBeNull();
  });

  test('reports not-removed when our hook is not present', () => {
    writeSettings({ theme: 'dark' });
    const result = claudeSettings.removeHook();
    expect(result.removed).toBe(false);
  });
});

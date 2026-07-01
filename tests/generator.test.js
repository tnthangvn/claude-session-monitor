'use strict';

/**
 * Unit tests for src/services/generator.js.
 * HOME is redirected before the module is required so HOOK_DIR / HOOK_PATH and
 * the embedded HISTORY_PATH all resolve into an isolated temp directory.
 */

const os = require('os');
const path = require('path');
const fs = require('fs');

const TMP_HOME = path.join(os.tmpdir(), `csm-generator-${process.pid}-${Date.now()}`);
fs.mkdirSync(path.join(TMP_HOME, '.claude'), { recursive: true });

// os.homedir() ignores $HOME under Jest's sandbox, so spy it BEFORE requiring the
// module — generator.js captures HOOK_DIR/HOOK_PATH/HISTORY_PATH from os.homedir()
// at load time.
jest.spyOn(os, 'homedir').mockReturnValue(TMP_HOME);

const generator = require('../src/services/generator');

// HARD GUARD: never allow writes to the real home.
if (!generator.HOOK_DIR.startsWith(os.tmpdir())) {
  throw new Error(`ISOLATION FAILED: ${generator.HOOK_DIR} is not under tmpdir`);
}

const sampleConfig = {
  botToken: '123456789:SECRET-TOKEN-VALUE',
  groupId: '-1001234567890',
  timeout: 450,
};

beforeEach(() => {
  generator.removeHookScript();
});

afterAll(() => {
  fs.rmSync(TMP_HOME, { recursive: true, force: true });
});

describe('generateHookScript', () => {
  test('leaves no unresolved {{...}} placeholders', () => {
    const script = generator.generateHookScript(sampleConfig);
    expect(script).not.toMatch(/\{\{[^}]+\}\}/);
  });

  test('embeds the bot token, group id and timeout', () => {
    const script = generator.generateHookScript(sampleConfig);
    expect(script).toContain('BOT_TOKEN="123456789:SECRET-TOKEN-VALUE"');
    expect(script).toContain('GROUP_ID="-1001234567890"');
    expect(script).toContain('TIMEOUT="450"');
  });

  test('embeds the isolated history log path', () => {
    const script = generator.generateHookScript(sampleConfig);
    expect(script).toContain(path.join(TMP_HOME, '.claude', 'session-monitor', 'history.log'));
  });
});

describe('installHookScript', () => {
  test('writes the script to HOOK_PATH and returns that path', () => {
    // Act
    const result = generator.installHookScript(sampleConfig);

    // Assert
    expect(result).toBe(generator.HOOK_PATH);
    expect(fs.existsSync(generator.HOOK_PATH)).toBe(true);
  });

  test('creates HOOK_DIR when it does not exist', () => {
    generator.installHookScript(sampleConfig);
    expect(fs.existsSync(generator.HOOK_DIR)).toBe(true);
  });

  test('written content matches generateHookScript output', () => {
    generator.installHookScript(sampleConfig);
    const onDisk = fs.readFileSync(generator.HOOK_PATH, 'utf8');
    expect(onDisk).toBe(generator.generateHookScript(sampleConfig));
  });

  test('marks the script executable with mode 0755', () => {
    generator.installHookScript(sampleConfig);
    const mode = fs.statSync(generator.HOOK_PATH).mode & 0o777;
    expect(mode).toBe(0o755);
  });
});

describe('removeHookScript', () => {
  test('returns true when a script was removed', () => {
    generator.installHookScript(sampleConfig);
    expect(generator.removeHookScript()).toBe(true);
    expect(fs.existsSync(generator.HOOK_PATH)).toBe(false);
  });

  test('returns false when there is nothing to remove', () => {
    expect(generator.removeHookScript()).toBe(false);
  });
});

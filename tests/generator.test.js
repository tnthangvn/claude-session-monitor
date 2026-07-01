'use strict';

/**
 * Unit tests for src/services/generator.js (self-contained runtime installer).
 *
 * os.homedir() is spied BEFORE requiring the module so RUNTIME_DIR / RUNNER_PATH
 * / HOOK_DIR all resolve into an isolated temp directory. Jest ignores $HOME
 * under its sandbox, so spying os.homedir() is the reliable isolation seam.
 */

const os = require('os');
const path = require('path');
const fs = require('fs');

const TMP_HOME = path.join(os.tmpdir(), `csm-gen-${process.pid}-${Date.now()}`);
fs.mkdirSync(path.join(TMP_HOME, '.claude'), { recursive: true });

jest.spyOn(os, 'homedir').mockReturnValue(TMP_HOME);

const generator = require('../src/services/generator');

// HARD GUARD: never allow writes to the real home.
if (!generator.RUNNER_PATH.startsWith(os.tmpdir())) {
  throw new Error(`ISOLATION FAILED: ${generator.RUNNER_PATH} is not under tmpdir`);
}

// Source runtime shipped with the package — installed copies must be identical.
const SOURCE_RUNNER = path.join(__dirname, '..', 'src', 'hooks', 'runner.js');

const EVENT_ARGS = {
  SessionStart: 'sessionstart',
  PreToolUse: 'pretooluse',
  SessionEnd: 'sessionend',
};

const mode = (p) => fs.statSync(p).mode & 0o777;

beforeEach(() => {
  generator.removeRuntime();
});

afterAll(() => {
  fs.rmSync(TMP_HOME, { recursive: true, force: true });
});

describe('installRuntime', () => {
  test('writes runner.js at RUNNER_PATH with mode 0755', () => {
    const result = generator.installRuntime();

    expect(result.runnerPath).toBe(generator.RUNNER_PATH);
    expect(fs.existsSync(generator.RUNNER_PATH)).toBe(true);
    expect(mode(generator.RUNNER_PATH)).toBe(0o755);
  });

  test('writes all three wrappers with mode 0755', () => {
    const { wrappers } = generator.installRuntime();

    for (const key of Object.keys(EVENT_ARGS)) {
      const wrapperPath = wrappers[key];
      expect(fs.existsSync(wrapperPath)).toBe(true);
      expect(mode(wrapperPath)).toBe(0o755);
    }
  });

  test('each wrapper bakes the absolute RUNNER_PATH, correct event arg, and node guard', () => {
    generator.installRuntime();

    for (const [key, arg] of Object.entries(EVENT_ARGS)) {
      const content = fs.readFileSync(generator.WRAPPERS[key], 'utf8');
      expect(content).toContain(generator.RUNNER_PATH);
      expect(content).toContain(`exec node "${generator.RUNNER_PATH}" ${arg}`);
      expect(content).toContain('command -v node >/dev/null 2>&1 || exit 0');
    }
  });

  test('the copied runner.js is byte-identical to the source', () => {
    generator.installRuntime();
    const copied = fs.readFileSync(generator.RUNNER_PATH);
    const source = fs.readFileSync(SOURCE_RUNNER);
    expect(copied.equals(source)).toBe(true);
  });
});

describe('WRAPPERS map', () => {
  test('points at the three files under HOOK_DIR', () => {
    expect(generator.WRAPPERS.SessionStart).toBe(
      path.join(generator.HOOK_DIR, 'csm-session-start.sh')
    );
    expect(generator.WRAPPERS.PreToolUse).toBe(
      path.join(generator.HOOK_DIR, 'csm-pretooluse.sh')
    );
    expect(generator.WRAPPERS.SessionEnd).toBe(
      path.join(generator.HOOK_DIR, 'csm-session-end.sh')
    );
  });
});

describe('removeRuntime', () => {
  test('deletes the runner and wrappers and returns true, then false', () => {
    generator.installRuntime();

    expect(generator.removeRuntime()).toBe(true);
    expect(fs.existsSync(generator.RUNNER_PATH)).toBe(false);
    for (const key of Object.keys(EVENT_ARGS)) {
      expect(fs.existsSync(generator.WRAPPERS[key])).toBe(false);
    }

    // Nothing left to remove on the second call.
    expect(generator.removeRuntime()).toBe(false);
  });
});

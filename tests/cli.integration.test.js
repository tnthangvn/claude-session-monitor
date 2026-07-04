'use strict';

/**
 * Integration tests that drive the real bin/cli.js as a child process.
 * HOME is redirected to an isolated temp dir so the CLI never reads or writes
 * the real ~/.claude. Calls that exit non-zero throw from execFileSync and are
 * inspected via err.status / err.stdout / err.stderr.
 */

const os = require('os');
const path = require('path');
const fs = require('fs');
const { execFileSync } = require('child_process');

const TMP_HOME = path.join(os.tmpdir(), `csm-cli-${process.pid}-${Date.now()}`);
const CLI_PATH = path.join(__dirname, '..', 'bin', 'cli.js');
const PKG_VERSION = require('../package.json').version;

const ENV = { ...process.env, HOME: TMP_HOME, USERPROFILE: TMP_HOME };

/** Run the CLI, returning stdout. Throws (with .status/.stdout/.stderr) on non-zero exit. */
function runCli(args) {
  return execFileSync('node', [CLI_PATH, ...args], {
    env: ENV,
    encoding: 'utf8',
  });
}

beforeAll(() => {
  fs.mkdirSync(TMP_HOME, { recursive: true });
});

afterAll(() => {
  fs.rmSync(TMP_HOME, { recursive: true, force: true });
});

describe('claude-session-monitor CLI', () => {
  test('--version prints the package version', () => {
    const out = runCli(['--version']);
    expect(out.trim()).toBe(PKG_VERSION);
  });

  test('--help lists all commands', () => {
    const out = runCli(['--help']);
    for (const command of ['init', 'status', 'test', 'logs', 'remove-account', 'uninstall']) {
      expect(out).toContain(command);
    }
    expect(out).toContain('Monitor and guard Claude Code sessions');
  });

  test('status on an empty HOME reports not-configured and exits 0', () => {
    const out = runCli(['status']);
    expect(out).toContain('Not configured');
    expect(out).toContain('claude-session-monitor init');
  });

  test('an unknown option exits non-zero with an error message', () => {
    // Arrange + Act
    let error;
    try {
      runCli(['--definitely-not-a-flag']);
    } catch (err) {
      error = err;
    }

    // Assert
    expect(error).toBeDefined();
    expect(error.status).not.toBe(0);
    const combined = `${error.stdout || ''}${error.stderr || ''}`;
    expect(combined).toContain('unknown option');
  });
});

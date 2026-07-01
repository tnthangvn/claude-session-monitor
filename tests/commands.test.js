'use strict';

/**
 * In-process unit tests for the command modules (src/commands/*).
 *
 * These exercise the command handlers directly (the child-process CLI
 * integration test cannot contribute coverage), lifting global line/function
 * coverage over the configured thresholds.
 *
 * HOME is redirected before requiring anything so config/generator/settings all
 * resolve into an isolated temp dir. inquirer and the telegram service are
 * mocked so no prompts block and no network is touched.
 */

const os = require('os');
const path = require('path');
const fs = require('fs');

const TMP_HOME = path.join(os.tmpdir(), `csm-commands-${process.pid}-${Date.now()}`);
fs.mkdirSync(path.join(TMP_HOME, '.claude'), { recursive: true });
process.env.USER = 'csm-cmd-user'; // isolates the /tmp lock file path

// os.homedir() ignores $HOME under Jest's sandbox, so spy it BEFORE requiring the
// modules under test. config/generator/claudeSettings capture their path constants
// from os.homedir() at load; one spy on the shared os instance covers them all.
jest.spyOn(os, 'homedir').mockReturnValue(TMP_HOME);

jest.mock('inquirer', () => ({ prompt: jest.fn() }));
jest.mock('../src/services/telegram', () => ({
  getBotInfo: jest.fn(),
  testConnection: jest.fn(),
  sendMessage: jest.fn(),
  sendApprovalPrompt: jest.fn(),
}));

const inquirer = require('inquirer');
const telegram = require('../src/services/telegram');
const config = require('../src/services/config');
const generator = require('../src/services/generator');
const claudeSettings = require('../src/services/claudeSettings');

// HARD GUARD: never allow writes to the real home.
if (!config.CONFIG_DIR.startsWith(os.tmpdir())) {
  throw new Error(`ISOLATION FAILED: ${config.CONFIG_DIR} is not under tmpdir`);
}

const { status } = require('../src/commands/status');
const { logs } = require('../src/commands/logs');
const { test: testCmd } = require('../src/commands/test');
const { uninstall } = require('../src/commands/uninstall');
const { init } = require('../src/commands/init');

const CLAUDE_DIR = path.join(TMP_HOME, '.claude');
const LOCK_PATH = `/tmp/claude-session-${process.env.USER}.lock`;
const PLAINTEXT_TOKEN = '123456789:ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';

function sampleConfig(overrides = {}) {
  return {
    version: '1.0.0',
    botToken: PLAINTEXT_TOKEN,
    groupId: '-1001234567890',
    timeout: 300,
    approvalMode: true,
    machineName: 'test-machine',
    installedAt: '2026-07-01T00:00:00.000Z',
    ...overrides,
  };
}

function answers(overrides = {}) {
  return {
    botToken: PLAINTEXT_TOKEN,
    groupId: '-1001234567890',
    timeout: 300,
    approvalMode: false,
    installHook: true,
    ...overrides,
  };
}

let logSpy;
let errSpy;

/** Concatenate everything written to console.log/error for substring assertions. */
function output() {
  const logLines = logSpy.mock.calls.map((args) => args.join(' '));
  const errLines = errSpy.mock.calls.map((args) => args.join(' '));
  return logLines.concat(errLines).join('\n');
}

beforeEach(() => {
  // Clean, isolated state for every test.
  fs.rmSync(CLAUDE_DIR, { recursive: true, force: true });
  fs.rmSync(LOCK_PATH, { force: true });

  inquirer.prompt.mockReset();
  telegram.getBotInfo.mockReset();
  telegram.testConnection.mockReset();
  telegram.sendMessage.mockReset();
  telegram.sendApprovalPrompt.mockReset();

  logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
  errSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  jest.restoreAllMocks();
  fs.rmSync(LOCK_PATH, { force: true });
  process.exitCode = 0; // command handlers may set this; never fail the runner.
});

afterAll(() => {
  fs.rmSync(TMP_HOME, { recursive: true, force: true });
});

describe('status command', () => {
  test('reports not-configured when no config exists', async () => {
    await status();
    expect(output()).toContain('Not configured');
  });

  test('reports a corrupt config and sets a failing exit code', async () => {
    // Arrange
    fs.mkdirSync(config.CONFIG_DIR, { recursive: true });
    fs.writeFileSync(config.CONFIG_PATH, '{ broken json');

    // Act
    await status();

    // Assert
    expect(output()).toContain('Could not read configuration');
    expect(process.exitCode).toBe(1);
  });

  test('renders the full report with no active lock and no history', async () => {
    // Arrange
    config.saveConfig(sampleConfig());

    // Act
    await status();

    // Assert
    const out = output();
    expect(out).toContain('Configuration');
    expect(out).toContain('Hook health');
    expect(out).toContain('None');
    expect(out).toContain('No session history yet');
  });

  test('shows an active session within timeout (plain lock format)', async () => {
    // Arrange
    config.saveConfig(sampleConfig());
    const now = Math.floor(Date.now() / 1000);
    fs.writeFileSync(LOCK_PATH, `host-a\n${now}\n`);

    // Act
    await status();

    // Assert
    const out = output();
    expect(out).toContain('Locked by');
    expect(out).toContain('host-a');
    expect(out).toContain('within timeout');
  });

  test('shows an expired session for a stale lock', async () => {
    // Arrange — timestamp far in the past.
    config.saveConfig(sampleConfig());
    const old = Math.floor(Date.now() / 1000) - 100000;
    fs.writeFileSync(LOCK_PATH, `host-b\n${old}\n`);

    // Act
    await status();

    // Assert
    expect(output()).toContain('expired');
  });

  test('parses a JSON-form lock file', async () => {
    // Arrange
    config.saveConfig(sampleConfig());
    const now = Math.floor(Date.now() / 1000);
    fs.writeFileSync(LOCK_PATH, JSON.stringify({ machine: 'json-host', ts: now }));

    // Act
    await status();

    // Assert
    expect(output()).toContain('json-host');
  });

  test('handles a lock file with no usable timestamp', async () => {
    // Arrange
    config.saveConfig(sampleConfig());
    fs.writeFileSync(LOCK_PATH, 'host-c\nnot-a-number');

    // Act
    await status();

    // Assert
    expect(output()).toContain('unknown (no timestamp in lock)');
  });

  test('handles an empty/malformed lock file', async () => {
    // Arrange
    config.saveConfig(sampleConfig());
    fs.writeFileSync(LOCK_PATH, '   ');

    // Act
    await status();

    // Assert
    expect(output()).toContain('empty or malformed');
  });

  test('renders recent history entries when present', async () => {
    // Arrange
    config.saveConfig(sampleConfig());
    config.appendHistory('START', 'host-a', 'new session');
    config.appendHistory('CONFLICT', 'host-b', 'conflict with host-a');

    // Act
    await status();

    // Assert
    const out = output();
    expect(out).toContain('Recent history');
    expect(out).toContain('host-a');
    expect(out).toContain('host-b');
  });
});

describe('logs command', () => {
  test('reports not-configured when no config exists', async () => {
    await logs({});
    expect(output()).toContain('Not configured');
  });

  test('reports no history when the log is empty', async () => {
    config.saveConfig(sampleConfig());
    await logs({});
    expect(output()).toContain('No session history yet');
  });

  test('prints entries and a summary of START/CONFLICT counts', async () => {
    // Arrange
    config.saveConfig(sampleConfig());
    config.appendHistory('START', 'host-a', 'new session');
    config.appendHistory('CONFLICT', 'host-b', 'conflict');
    config.appendHistory('OTHER', 'host-c', '');

    // Act
    await logs({});

    // Assert
    const out = output();
    expect(out).toContain('Showing 3 of 3 entries');
    expect(out).toContain('1 START');
    expect(out).toContain('1 CONFLICT');
  });

  test('respects the --lines limit', async () => {
    // Arrange
    config.saveConfig(sampleConfig());
    config.appendHistory('START', 'm1', 'a');
    config.appendHistory('START', 'm2', 'b');
    config.appendHistory('START', 'm3', 'c');

    // Act
    await logs({ lines: '2' });

    // Assert
    expect(output()).toContain('Showing 2 of 3 entries');
  });

  test('falls back to the default limit for an invalid --lines value', async () => {
    // Arrange
    config.saveConfig(sampleConfig());
    config.appendHistory('START', 'm1', 'a');

    // Act
    await logs({ lines: 'not-a-number' });

    // Assert
    expect(output()).toContain('Showing 1 of 1 entries');
  });
});

describe('test command', () => {
  test('reports not-configured when no config exists', async () => {
    await testCmd();
    expect(output()).toContain('Not configured');
  });

  test('reports a corrupt config and fails', async () => {
    fs.mkdirSync(config.CONFIG_DIR, { recursive: true });
    fs.writeFileSync(config.CONFIG_PATH, 'not json');
    await testCmd();
    expect(output()).toContain('Could not read configuration');
    expect(process.exitCode).toBe(1);
  });

  test('reports a failed connection with troubleshooting', async () => {
    // Arrange
    config.saveConfig(sampleConfig());
    telegram.testConnection.mockRejectedValue(new Error('bot not in group'));

    // Act
    await testCmd();

    // Assert
    const out = output();
    expect(out).toContain('Connection failed');
    expect(out).toContain('Troubleshooting');
    expect(process.exitCode).toBe(1);
  });

  test('reports a failed send after a good connection', async () => {
    // Arrange
    config.saveConfig(sampleConfig());
    telegram.testConnection.mockResolvedValue({
      bot: { username: 'test_bot' },
      chat: { title: 'My Group' },
    });
    telegram.sendMessage.mockRejectedValue(new Error('rate limited'));

    // Act
    await testCmd();

    // Assert
    expect(output()).toContain('Could not send the test message');
    expect(process.exitCode).toBe(1);
  });

  test('confirms success when connection and send both work', async () => {
    // Arrange
    config.saveConfig(sampleConfig());
    telegram.testConnection.mockResolvedValue({
      bot: { username: 'test_bot' },
      chat: { title: 'My Group' },
    });
    telegram.sendMessage.mockResolvedValue({ ok: true });

    // Act
    await testCmd();

    // Assert
    const out = output();
    expect(out).toContain('@test_bot');
    expect(out).toContain('My Group');
    expect(out).toContain('Test message sent');
  });

  test('uses fallback bot/chat labels when fields are missing', async () => {
    // Arrange
    config.saveConfig(sampleConfig());
    telegram.testConnection.mockResolvedValue({
      bot: { first_name: 'Fallback Bot' },
      chat: { id: '-100' },
    });
    telegram.sendMessage.mockResolvedValue({ ok: true });

    // Act
    await testCmd();

    // Assert
    const out = output();
    expect(out).toContain('Fallback Bot');
    expect(out).toContain('-100');
  });
});

describe('uninstall command', () => {
  test('cancels when the user declines the confirmation', async () => {
    // Arrange
    inquirer.prompt.mockResolvedValue({ confirmed: false });

    // Act
    await uninstall({});

    // Assert
    expect(output()).toContain('Uninstall cancelled');
    expect(inquirer.prompt).toHaveBeenCalledTimes(1);
  });

  test('removes hook, script and config with --yes when all present', async () => {
    // Arrange — install everything first.
    const cfg = sampleConfig();
    config.saveConfig(cfg);
    generator.installHookScript(cfg);
    claudeSettings.installHook(generator.HOOK_PATH);

    // Act
    await uninstall({ yes: true });

    // Assert
    const out = output();
    expect(out).toContain('Uninstalling claude-session-monitor');
    expect(out).toContain('Removed 3 item(s)');
    expect(config.configExists()).toBe(false);
    expect(fs.existsSync(generator.HOOK_PATH)).toBe(false);
  });

  test('runs via an interactive confirmation with nothing installed', async () => {
    // Arrange
    inquirer.prompt.mockResolvedValue({ confirmed: true });

    // Act
    await uninstall({});

    // Assert — the generated script step reports nothing to remove.
    expect(output()).toContain('nothing to remove');
  });

  test('warns (without throwing) when a removal step fails', async () => {
    // Arrange
    jest
      .spyOn(claudeSettings, 'removeHook')
      .mockImplementation(() => {
        throw new Error('permission denied');
      });

    // Act
    await uninstall({ yes: true });

    // Assert
    expect(output()).toContain('failed: permission denied');
  });
});

describe('init command', () => {
  test('completes setup and installs the hook (no prior config)', async () => {
    // Arrange
    inquirer.prompt.mockResolvedValue(answers({ installHook: true }));
    telegram.testConnection.mockResolvedValue({
      bot: { username: 'test_bot' },
      chat: { title: 'My Group' },
    });
    telegram.sendMessage.mockResolvedValue({ ok: true });

    // Act
    await init({});

    // Assert
    const out = output();
    expect(out).toContain('Configuration saved');
    expect(out).toContain('Hook script installed');
    expect(out).toContain('is set up');
    expect(config.configExists()).toBe(true);
    expect(fs.existsSync(generator.HOOK_PATH)).toBe(true);
    expect(claudeSettings.hasHook()).toBe(true);
  });

  test('overwrites with --force, skips the hook, tolerates a notify failure', async () => {
    // Arrange — an existing config, force overwrite, no hook, notify rejects.
    config.saveConfig(sampleConfig());
    inquirer.prompt.mockResolvedValue(answers({ installHook: false }));
    telegram.testConnection.mockResolvedValue({
      bot: { username: 'test_bot' },
      chat: { title: 'My Group' },
    });
    telegram.sendMessage.mockRejectedValue(new Error('network down'));

    // Act
    await init({ force: true });

    // Assert
    const out = output();
    expect(out).toContain('Skipped hook installation');
    expect(out).toContain('Could not send the confirmation message');
    expect(fs.existsSync(generator.HOOK_PATH)).toBe(false);
  });

  test('aborts when the user declines to overwrite an existing config', async () => {
    // Arrange
    config.saveConfig(sampleConfig());
    inquirer.prompt.mockResolvedValueOnce({ overwrite: false });

    // Act
    await init({});

    // Assert
    expect(output()).toContain('Setup aborted');
    expect(inquirer.prompt).toHaveBeenCalledTimes(1);
  });

  test('continues when the user confirms overwrite', async () => {
    // Arrange — first prompt confirms overwrite, second returns answers.
    config.saveConfig(sampleConfig());
    inquirer.prompt
      .mockResolvedValueOnce({ overwrite: true })
      .mockResolvedValueOnce(answers({ installHook: false }));
    telegram.testConnection.mockResolvedValue({
      bot: { username: 'test_bot' },
      chat: { title: 'My Group' },
    });
    telegram.sendMessage.mockResolvedValue({ ok: true });

    // Act
    await init({});

    // Assert
    expect(output()).toContain('is set up');
    expect(inquirer.prompt).toHaveBeenCalledTimes(2);
  });

  test('aborts setup with a failing exit code when the connection test fails', async () => {
    // Arrange
    inquirer.prompt.mockResolvedValue(answers());
    telegram.testConnection.mockRejectedValue(new Error('invalid token'));

    // Act
    await init({});

    // Assert
    expect(output()).toContain('Aborting setup');
    expect(process.exitCode).toBe(1);
    expect(config.configExists()).toBe(false);
  });

  test('--dry-run previews the hook + settings paths without writing or prompting', async () => {
    // Act — no prompt/telegram mocks are configured; dry run must not use them.
    await init({ dryRun: true });

    // Assert — the preview names the exact hook script and settings file.
    const out = output();
    expect(out).toContain('no files will be written');
    expect(out).toContain(generator.HOOK_PATH);
    expect(out).toContain(claudeSettings.SETTINGS_PATH);
    expect(out).toContain('PreToolUse');

    // Nothing was created, prompted, or sent.
    expect(config.configExists()).toBe(false);
    expect(fs.existsSync(generator.HOOK_PATH)).toBe(false);
    expect(inquirer.prompt).not.toHaveBeenCalled();
    expect(telegram.testConnection).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(0);
  });

  test('--dry-run flags an existing config as an overwrite (still no writes/prompts)', async () => {
    // Arrange
    config.saveConfig(sampleConfig());

    // Act
    await init({ dryRun: true });

    // Assert
    expect(output()).toContain('OVERWRITE');
    expect(inquirer.prompt).not.toHaveBeenCalled();
    expect(fs.existsSync(generator.HOOK_PATH)).toBe(false);
  });

  test('reports a hook installation failure but keeps the saved config', async () => {
    // Arrange
    inquirer.prompt.mockResolvedValue(answers({ installHook: true }));
    telegram.testConnection.mockResolvedValue({
      bot: { username: 'test_bot' },
      chat: { title: 'My Group' },
    });
    telegram.sendMessage.mockResolvedValue({ ok: true });
    jest.spyOn(generator, 'installHookScript').mockImplementation(() => {
      throw new Error('disk full');
    });

    // Act
    await init({});

    // Assert
    const out = output();
    expect(out).toContain('Hook installation failed');
    expect(config.configExists()).toBe(true);
  });
});

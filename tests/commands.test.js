'use strict';

/**
 * In-process unit tests for the command modules (src/commands/*) under the
 * redesigned account-lock hook system.
 *
 * HOME is redirected (via an os.homedir() spy) BEFORE requiring anything so
 * config/generator/claudeSettings resolve their path constants into an isolated
 * temp dir. inquirer, the telegram service, and the telegramState service are
 * mocked so no prompts block and no network is touched. config, generator, and
 * claudeSettings run for real under the temp HOME.
 */

const os = require('os');
const path = require('path');
const fs = require('fs');

const TMP_HOME = path.join(os.tmpdir(), `csm-commands-${process.pid}-${Date.now()}`);
fs.mkdirSync(path.join(TMP_HOME, '.claude'), { recursive: true });

// os.homedir() ignores $HOME under Jest's sandbox, so spy it BEFORE requiring the
// modules under test. config/generator/claudeSettings capture their path constants
// from os.homedir() at load; one spy on the shared os instance covers them all.
jest.spyOn(os, 'homedir').mockReturnValue(TMP_HOME);

jest.mock('inquirer', () => ({ prompt: jest.fn() }));
jest.mock('../src/services/telegram', () => ({
  testConnection: jest.fn(),
  sendMessage: jest.fn(),
}));
jest.mock('../src/services/telegramState', () => ({
  ensureStateMessage: jest.fn(),
  readState: jest.fn(),
  writeState: jest.fn(),
}));

const inquirer = require('inquirer');
const telegram = require('../src/services/telegram');
const telegramState = require('../src/services/telegramState');
const config = require('../src/services/config');
const generator = require('../src/services/generator');
const claudeSettings = require('../src/services/claudeSettings');

// HARD GUARD: never allow writes to the real home.
if (!config.CONFIG_DIR.startsWith(os.tmpdir())) {
  throw new Error(`ISOLATION FAILED: ${config.CONFIG_DIR} is not under tmpdir`);
}

const { status } = require('../src/commands/status');
const { uninstall } = require('../src/commands/uninstall');
const { init } = require('../src/commands/init');
const { upgrade } = require('../src/commands/upgrade');
const { removeAccount } = require('../src/commands/removeAccount');

const CLAUDE_DIR = path.join(TMP_HOME, '.claude');
const PLAINTEXT_TOKEN = '123456789:ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';

function sampleConfig(overrides = {}) {
  return {
    version: '1.0.0',
    botToken: PLAINTEXT_TOKEN,
    groupId: '-1001234567890',
    timeout: 1800,
    machineName: 'test-machine',
    installedAt: '2026-07-01T00:00:00.000Z',
    ...overrides,
  };
}

function answers(overrides = {}) {
  return {
    botToken: PLAINTEXT_TOKEN,
    groupId: '-1001234567890',
    timeout: 1800,
    installHook: true,
    ...overrides,
  };
}

function goodConnection() {
  return { bot: { username: 'test_bot' }, chat: { title: 'My Group' } };
}

/** Register the three account-lock hooks (mirrors what init does). */
function installAllHooks() {
  generator.installRuntime();
  claudeSettings.installHooks({
    SessionStart: generator.WRAPPERS.SessionStart,
    PreToolUse: generator.WRAPPERS.PreToolUse,
    SessionEnd: generator.WRAPPERS.SessionEnd,
  });
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

  inquirer.prompt.mockReset();
  telegram.testConnection.mockReset();
  telegram.sendMessage.mockReset();
  telegramState.ensureStateMessage.mockReset();
  telegramState.readState.mockReset();
  telegramState.writeState.mockReset();

  logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
  errSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  jest.restoreAllMocks();
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

  test('shows one active account from the shared state', async () => {
    // Arrange
    config.saveConfig(sampleConfig({ stateMessageId: 42 }));
    const now = Math.floor(Date.now() / 1000);
    telegramState.readState.mockResolvedValue({
      state: {
        v: 1,
        accounts: {
          'dev@example.com': {
            machine: 'host-a',
            ip: '203.0.113.7',
            loc: 'Hanoi · VNPT',
            session: 'sess-1',
            ts: now - 120,
          },
        },
      },
      messageId: 42,
    });

    // Act
    await status();

    // Assert
    const out = output();
    expect(out).toContain('Configuration');
    expect(out).toContain('Hook health');
    expect(out).toContain('Shared lock state');
    expect(out).toContain('dev@example.com');
    expect(out).toContain('host-a');
    expect(out).toContain('203.0.113.7');
    expect(out).toContain('42'); // stateMessageId shown
  });

  test('reports "No active sessions" when the shared state is empty', async () => {
    // Arrange
    config.saveConfig(sampleConfig());
    telegramState.readState.mockResolvedValue({
      state: { v: 1, accounts: {} },
      messageId: null,
    });

    // Act
    await status();

    // Assert
    const out = output();
    expect(out).toContain('No active sessions');
    expect(out).toContain('not created yet'); // no stateMessageId persisted
  });

  test('warns (without throwing) when the shared state cannot be read', async () => {
    // Arrange
    config.saveConfig(sampleConfig());
    telegramState.readState.mockRejectedValue(new Error('network down'));

    // Act + Assert (must not throw)
    await expect(status()).resolves.toBeUndefined();
    const out = output();
    expect(out).toContain('Could not read shared state');
    expect(out).toContain('network down');
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

  test('removes hooks, runtime, and config with --yes when all present', async () => {
    // Arrange — install everything first.
    config.saveConfig(sampleConfig());
    installAllHooks();
    expect(claudeSettings.hasHooks()).toBe(true);
    expect(fs.existsSync(generator.RUNNER_PATH)).toBe(true);

    // Act
    await uninstall({ yes: true });

    // Assert
    const out = output();
    expect(out).toContain('Uninstalling claude-session-monitor');
    expect(out).toContain('Removed 3 item(s)');
    expect(claudeSettings.hasHooks()).toBe(false);
    expect(fs.existsSync(generator.RUNNER_PATH)).toBe(false);
    expect(config.configExists()).toBe(false);
  });

  test('warns (without throwing) when a removal step fails', async () => {
    // Arrange
    jest.spyOn(claudeSettings, 'removeHooks').mockImplementation(() => {
      throw new Error('permission denied');
    });

    // Act
    await uninstall({ yes: true });

    // Assert
    expect(output()).toContain('failed: permission denied');
  });
});

describe('init command', () => {
  test('completes setup, installs the runtime + hooks, pins state, persists the id', async () => {
    // Arrange
    inquirer.prompt.mockResolvedValue(answers({ installHook: true }));
    telegram.testConnection.mockResolvedValue(goodConnection());
    telegramState.ensureStateMessage.mockResolvedValue(4242);
    telegram.sendMessage.mockResolvedValue({ ok: true });

    // Act
    await init({});

    // Assert — config + runtime + hooks + pinned state id.
    const out = output();
    expect(out).toContain('Configuration saved');
    expect(out).toContain('Runtime installed');
    expect(out).toContain('is set up');

    expect(config.configExists()).toBe(true);
    expect(fs.existsSync(generator.RUNNER_PATH)).toBe(true);
    Object.values(generator.WRAPPERS).forEach((wrapper) => {
      expect(fs.existsSync(wrapper)).toBe(true);
    });
    expect(claudeSettings.hasHooks()).toBe(true);

    expect(telegramState.ensureStateMessage).toHaveBeenCalledTimes(1);
    const saved = config.loadConfig();
    expect(saved.stateMessageId).toBe(4242);
  });

  test('keeps config + hooks and warns when the bot cannot pin the state message', async () => {
    // Arrange
    inquirer.prompt.mockResolvedValue(answers({ installHook: true }));
    telegram.testConnection.mockResolvedValue(goodConnection());
    telegramState.ensureStateMessage.mockRejectedValue(
      new Error('could not PIN it — make the bot an Admin with the "Pin Messages" permission')
    );
    telegram.sendMessage.mockResolvedValue({ ok: true });

    // Act + Assert (must not throw)
    await expect(init({})).resolves.toBeUndefined();

    const out = output();
    expect(out).toContain('Pin Messages');
    expect(config.configExists()).toBe(true);
    expect(claudeSettings.hasHooks()).toBe(true);

    // The state id was NOT persisted (pin failed).
    const saved = config.loadConfig();
    expect(saved.stateMessageId).toBeUndefined();
  });

  test('aborts with a failing exit code when the connection test fails', async () => {
    // Arrange
    inquirer.prompt.mockResolvedValue(answers());
    telegram.testConnection.mockRejectedValue(new Error('invalid token'));

    // Act
    await init({});

    // Assert
    const out = output();
    expect(out).toContain('Aborting setup');
    expect(process.exitCode).toBe(1);
    expect(config.configExists()).toBe(false);
    expect(telegramState.ensureStateMessage).not.toHaveBeenCalled();
  });

  test('reuses an existing config, skipping the token/group/timeout prompts', async () => {
    // Arrange — a full config already exists; only installHook is prompted.
    config.saveConfig(sampleConfig());
    inquirer.prompt.mockResolvedValue({ installHook: false });
    telegram.testConnection.mockResolvedValue(goodConnection());

    // Act
    await init({});

    // Assert — no overwrite prompt; reused values drive the connection test.
    const out = output();
    expect(out).toContain('Existing config found');
    expect(telegram.testConnection).toHaveBeenCalledWith(PLAINTEXT_TOKEN, '-1001234567890');
    expect(config.configExists()).toBe(true);
  });

  test('with --force, re-prompts for every value instead of reusing', async () => {
    // Arrange — config exists, but --force ignores it and asks for everything.
    config.saveConfig(sampleConfig({ groupId: '-1009999999999' }));
    inquirer.prompt.mockResolvedValue(answers({ installHook: false }));
    telegram.testConnection.mockResolvedValue(goodConnection());

    // Act
    await init({ force: true });

    // Assert — the freshly-entered group id (not the saved one) is used.
    const out = output();
    expect(out).not.toContain('Existing config found');
    expect(telegram.testConnection).toHaveBeenCalledWith(PLAINTEXT_TOKEN, '-1001234567890');
  });

  test('reuses config and continues, tolerating a notify failure', async () => {
    // Arrange — config exists; hooks skipped; the confirmation message fails.
    config.saveConfig(sampleConfig());
    inquirer.prompt.mockResolvedValue({ installHook: false });
    telegram.testConnection.mockResolvedValue(goodConnection());
    telegram.sendMessage.mockRejectedValue(new Error('network down'));

    // Act
    await init({});

    // Assert
    const out = output();
    expect(out).toContain('Skipped hook installation');
    expect(out).toContain('Could not send the confirmation message');
    expect(out).toContain('is set up');
    expect(fs.existsSync(generator.RUNNER_PATH)).toBe(false);
  });

  test('fresh install notifies "installed", re-init notifies "updated"', async () => {
    // Arrange — no config yet: this is a fresh install.
    inquirer.prompt.mockResolvedValue(answers({ installHook: false }));
    telegram.testConnection.mockResolvedValue(goodConnection());
    telegram.sendMessage.mockResolvedValue({ ok: true });

    // Act — first run.
    await init({});

    // Assert — the notification says "installed".
    expect(telegram.sendMessage).toHaveBeenCalledWith(
      expect.anything(),
      expect.stringContaining('installed on')
    );

    // Act — second run over the existing config (an update).
    telegram.sendMessage.mockClear();
    inquirer.prompt.mockResolvedValue({ installHook: false });
    await init({});

    // Assert — the notification now says "updated".
    expect(telegram.sendMessage).toHaveBeenCalledWith(
      expect.anything(),
      expect.stringContaining('updated on')
    );
    expect(telegram.sendMessage).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.stringContaining('installed on')
    );
  });
});

describe('upgrade command', () => {
  test('re-installs the runtime + hooks and notifies "updated" without prompting', async () => {
    // Arrange — a configured machine (config only; runtime not yet present).
    config.saveConfig(sampleConfig());
    telegram.sendMessage.mockResolvedValue({ ok: true });

    // Act
    await upgrade();

    // Assert — runtime + wrappers + hooks are (re)installed from the package.
    expect(fs.existsSync(generator.RUNNER_PATH)).toBe(true);
    Object.values(generator.WRAPPERS).forEach((wrapper) => {
      expect(fs.existsSync(wrapper)).toBe(true);
    });
    expect(claudeSettings.hasHooks()).toBe(true);

    // No wizard: inquirer must never be consulted.
    expect(inquirer.prompt).not.toHaveBeenCalled();

    // The group notification is the "updated" variant, with the version.
    const pkg = require('../package.json');
    expect(telegram.sendMessage).toHaveBeenCalledWith(
      expect.anything(),
      `🔄 claude-session-monitor updated on test-machine (v${pkg.version})`
    );

    expect(output()).toContain('upgraded to');
  });

  test('refuses to run when not configured, pointing at init', async () => {
    // Arrange — beforeEach wiped the config dir.

    // Act
    await upgrade();

    // Assert
    expect(output()).toContain('Not configured');
    expect(process.exitCode).toBe(1);
    expect(telegram.sendMessage).not.toHaveBeenCalled();
    expect(fs.existsSync(generator.RUNNER_PATH)).toBe(false);
  });

  test('tolerates a notify failure and still reports the upgrade', async () => {
    // Arrange
    config.saveConfig(sampleConfig());
    telegram.sendMessage.mockRejectedValue(new Error('network down'));

    // Act
    await upgrade();

    // Assert — artifacts installed; failure surfaced as a warning only.
    expect(fs.existsSync(generator.RUNNER_PATH)).toBe(true);
    const out = output();
    expect(out).toContain('Could not send the confirmation message');
    expect(out).toContain('upgraded to');
  });
});

describe('remove-account command', () => {
  const LOCKED_STATE = () => ({
    state: {
      v: 1,
      accounts: {
        'you@example.com': {
          machine: 'pc-a',
          ip: '1.2.3.4',
          loc: 'Hanoi · VNPT',
          sessions: { 's1': 1750000000, 's2': 1750000100 },
          ts: 1750000100,
        },
        'other@example.com': {
          machine: 'pc-b',
          ip: '5.6.7.8',
          loc: '',
          sessions: { 's3': 1750000000 },
          ts: 1750000000,
        },
      },
    },
    messageId: 555,
  });

  test('removes the named account from the pinned state and notifies the group', async () => {
    // Arrange — two accounts hold locks; we clear the crashed one.
    config.saveConfig(sampleConfig());
    telegramState.readState.mockResolvedValue(LOCKED_STATE());
    telegramState.writeState.mockResolvedValue(555);
    telegram.sendMessage.mockResolvedValue({ ok: true });

    // Act
    await removeAccount('you@example.com');

    // Assert — the state written back keeps ONLY the other account.
    expect(telegramState.writeState).toHaveBeenCalledTimes(1);
    const [, writtenState, messageId] = telegramState.writeState.mock.calls[0];
    expect(Object.keys(writtenState.accounts)).toEqual(['other@example.com']);
    expect(messageId).toBe(555);

    // The group is told about the manual unlock, naming account + machine.
    expect(telegram.sendMessage).toHaveBeenCalledTimes(1);
    const noticeText = telegram.sendMessage.mock.calls[0][1];
    expect(noticeText).toContain('🔓');
    expect(noticeText).toContain('you@example.com');
    expect(noticeText).toContain('pc-a');

    // Local history records the manual removal.
    const rows = config.readHistory();
    const last = rows[rows.length - 1];
    expect(last.event).toBe('REMOVE');
    expect(last.detail).toBe('account=you@example.com, holder=pc-a/1.2.3.4');

    expect(output()).toContain('Removed the lock for you@example.com');
    expect(process.exitCode).toBe(0);
  });

  test('unknown account → exits 1 and lists the accounts that DO hold locks', async () => {
    // Arrange
    config.saveConfig(sampleConfig());
    telegramState.readState.mockResolvedValue(LOCKED_STATE());

    // Act
    await removeAccount('nobody@example.com');

    // Assert — nothing was written or notified; the user sees what exists.
    expect(telegramState.writeState).not.toHaveBeenCalled();
    expect(telegram.sendMessage).not.toHaveBeenCalled();
    const out = output();
    expect(out).toContain('No lock found for account "nobody@example.com"');
    expect(out).toContain('you@example.com');
    expect(out).toContain('other@example.com');
    expect(process.exitCode).toBe(1);
  });

  test('empty shared state → exits 1 with a nothing-to-remove message', async () => {
    // Arrange
    config.saveConfig(sampleConfig());
    telegramState.readState.mockResolvedValue({ state: { v: 1, accounts: {} }, messageId: null });

    // Act
    await removeAccount('you@example.com');

    // Assert
    expect(telegramState.writeState).not.toHaveBeenCalled();
    expect(output()).toContain('no locks at all');
    expect(process.exitCode).toBe(1);
  });

  test('refuses to run when not configured, pointing at init', async () => {
    // Arrange — beforeEach wiped the config dir.

    // Act
    await removeAccount('you@example.com');

    // Assert
    expect(output()).toContain('Not configured');
    expect(process.exitCode).toBe(1);
    expect(telegramState.readState).not.toHaveBeenCalled();
  });

  test('a notify failure does not fail the removal (state write is the real fix)', async () => {
    // Arrange
    config.saveConfig(sampleConfig());
    telegramState.readState.mockResolvedValue(LOCKED_STATE());
    telegramState.writeState.mockResolvedValue(555);
    telegram.sendMessage.mockRejectedValue(new Error('network down'));

    // Act
    await removeAccount('you@example.com');

    // Assert — removed + warned, exit stays 0.
    expect(telegramState.writeState).toHaveBeenCalledTimes(1);
    const out = output();
    expect(out).toContain('Telegram notice could not be sent');
    expect(out).toContain('Removed the lock for you@example.com');
    expect(process.exitCode).toBe(0);
  });
});

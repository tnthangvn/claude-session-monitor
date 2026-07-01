'use strict';

const inquirer = require('inquirer');
const chalk = require('chalk');
const os = require('os');
const fs = require('fs');
const path = require('path');

const config = require('../services/config');
const telegram = require('../services/telegram');
const telegramState = require('../services/telegramState');
const generator = require('../services/generator');
const claudeSettings = require('../services/claudeSettings');
const {
  isValidBotToken,
  isValidGroupId,
  isValidTimeout,
  normalizeGroupId,
} = require('../utils/validators');

const CONFIG_VERSION = '1.0.0';
const DEFAULT_TIMEOUT = 1800;

/**
 * Print a section header for clearer, sectioned wizard output.
 * @param {string} title
 */
function section(title) {
  console.log('');
  console.log(chalk.bold.cyan(title));
  console.log(chalk.dim('─'.repeat(Math.max(title.length, 24))));
}

/**
 * Print a two-column labelled row inside a section.
 * @param {string} label
 * @param {string} value
 */
function row(label, value) {
  console.log(`  ${chalk.bold(label.padEnd(14))} ${value}`);
}

/**
 * Ask whether to overwrite an existing configuration.
 * @returns {Promise<boolean>} true if the wizard should continue
 */
async function confirmOverwrite() {
  console.log(chalk.yellow('⚠ A configuration already exists.'));
  const { overwrite } = await inquirer.prompt([
    {
      type: 'confirm',
      name: 'overwrite',
      message: 'Overwrite the existing configuration?',
      default: false,
    },
  ]);
  return overwrite;
}

/**
 * Collect setup answers from the user.
 * @returns {Promise<object>} the raw prompt answers
 */
async function collectAnswers() {
  return inquirer.prompt([
    {
      type: 'input',
      name: 'botToken',
      message: 'Telegram bot token:',
      validate: (value) =>
        isValidBotToken(value)
          ? true
          : 'That does not look like a valid bot token (expected format 123456789:ABC...).',
    },
    {
      type: 'input',
      name: 'groupId',
      message: 'Telegram group ID (a negative number, e.g. -1001234567890):',
      validate: (value) =>
        isValidGroupId(value)
          ? true
          : 'Group ID must be a negative number. Supergroup IDs start with -100.',
    },
    {
      type: 'number',
      name: 'timeout',
      message: 'Session lock timeout in seconds:',
      default: DEFAULT_TIMEOUT,
      validate: (value) =>
        isValidTimeout(value) ? true : 'Timeout must be a positive number of seconds.',
    },
    {
      type: 'confirm',
      name: 'installHook',
      message: 'Install the account-lock hooks now?',
      default: true,
    },
  ]);
}

/**
 * Verify the Telegram connection, printing progress and errors.
 * @param {string} botToken
 * @param {string} groupId
 * @returns {Promise<object|null>} test result, or null on failure
 */
async function verifyConnection(botToken, groupId) {
  console.log(chalk.dim('… Testing the Telegram connection, please wait.'));
  try {
    const result = await telegram.testConnection(botToken, groupId);
    const botName = result && result.bot ? result.bot.username || result.bot.first_name : 'bot';
    const chatTitle = result && result.chat ? result.chat.title || result.chat.id : 'group';
    console.log(chalk.green(`✓ Connected as @${botName} to "${chatTitle}".`));
    return result;
  } catch (err) {
    const message = err && err.message ? err.message : String(err);
    console.log(chalk.red(`✖ Telegram test failed: ${message}`));
    console.log(
      chalk.yellow(
        'Make sure the bot is added to the group, is a group Admin, and the group id is correct.'
      )
    );
    return null;
  }
}

/**
 * Remove any previously installed hooks (including the legacy single PreToolUse
 * `check-session-telegram.sh` from earlier versions) so re-running init is
 * idempotent and upgrades leave no stale hook behind.
 */
function cleanupLegacy() {
  try {
    claudeSettings.removeHooks();
  } catch (_e) {
    /* best-effort */
  }
  const legacyScript = path.join(os.homedir(), '.claude', 'hooks', 'check-session-telegram.sh');
  try {
    if (fs.existsSync(legacyScript)) {
      fs.unlinkSync(legacyScript);
      console.log(chalk.dim('  Removed legacy hook script (check-session-telegram.sh).'));
    }
  } catch (_e) {
    /* best-effort */
  }
}

/**
 * Install the runtime + register the three account-lock hooks in Claude settings.
 * @returns {{ runnerPath: string, wrappers: object }}
 */
function installHookArtifacts() {
  cleanupLegacy();
  const runtime = generator.installRuntime();
  claudeSettings.installHooks({
    SessionStart: generator.WRAPPERS.SessionStart,
    PreToolUse: generator.WRAPPERS.PreToolUse,
    SessionEnd: generator.WRAPPERS.SessionEnd,
  });
  console.log(chalk.green(`✓ Runtime installed at ${runtime.runnerPath}`));
  console.log(chalk.green(`✓ Registered SessionStart / PreToolUse / SessionEnd hooks`));
  console.log(chalk.green(`  ${claudeSettings.SETTINGS_PATH}`));
  return runtime;
}

/**
 * Create + pin the shared-state message and persist its id into the config.
 * Never throws: a failure (typically the bot lacking Pin permission) prints a
 * clear warning and leaves the installed config + hooks in place.
 * @param {object} cfg persisted configuration (mutated with stateMessageId)
 */
async function setupSharedState(cfg) {
  try {
    const stateMessageId = await telegramState.ensureStateMessage(cfg);
    cfg.stateMessageId = stateMessageId;
    config.saveConfig(cfg);
    console.log(chalk.green(`✓ Shared-state message pinned (id ${stateMessageId}).`));
  } catch (err) {
    const message = err && err.message ? err.message : String(err);
    console.log(chalk.yellow(`⚠ Could not create the pinned shared-state message: ${message}`));
    console.log(
      chalk.yellow(
        'Promote the bot to Admin in your group with the "Pin Messages" permission, then run ' +
          '`claude-session-monitor init --force` again to finish setup.'
      )
    );
    console.log(
      chalk.dim('Your configuration and hooks are installed; only the shared lock is pending.')
    );
  }
}

/**
 * Send a best-effort installation notification to the group.
 * @param {object} cfg persisted configuration
 */
async function notifyInstalled(cfg) {
  try {
    await telegram.sendMessage(
      cfg,
      `✅ claude-session-monitor installed on ${cfg.machineName}`
    );
  } catch (err) {
    const message = err && err.message ? err.message : String(err);
    console.log(chalk.yellow(`⚠ Could not send the confirmation message: ${message}`));
  }
}

/**
 * Print the final, sectioned success summary.
 * @param {object} cfg persisted configuration
 * @param {boolean} hookInstalled whether the hooks were installed this run
 */
function printSummary(cfg, hookInstalled) {
  section('Done');
  console.log(chalk.green.bold(`✓ claude-session-monitor is set up on ${cfg.machineName}.`));

  section('Configuration');
  row('Config file', config.CONFIG_PATH);

  if (hookInstalled) {
    section('Runtime & hooks');
    row('Runtime', generator.RUNTIME_DIR);
    row('Runner', generator.RUNNER_PATH);
    row('SessionStart', generator.WRAPPERS.SessionStart);
    row('PreToolUse', generator.WRAPPERS.PreToolUse);
    row('SessionEnd', generator.WRAPPERS.SessionEnd);
  }

  section('Requirement');
  console.log(
    chalk.yellow(
      '  The bot MUST be a group Admin with the "Pin Messages" permission. The shared'
    )
  );
  console.log(
    chalk.yellow('  account lock lives in a single pinned message in your group.')
  );

  console.log('');
  console.log(chalk.bold('Next steps:'));
  console.log(`  ${chalk.cyan('claude-session-monitor status')}  ${chalk.dim('# review your setup')}`);
  console.log(`  ${chalk.cyan('claude-session-monitor test')}    ${chalk.dim('# send a test message')}`);
  console.log('');
}

/**
 * Preview the paths init would create, without prompting, writing, or contacting
 * Telegram. Keeps the `--dry-run` flag honest under the account-lock design.
 */
function printDryRun() {
  section('claude-session-monitor · setup (dry run)');
  console.log(chalk.yellow('Dry run: no files will be written and no messages will be sent.'));

  section('Configuration file');
  row('Path', config.CONFIG_PATH);
  row(
    'Action',
    config.configExists()
      ? chalk.yellow('would OVERWRITE the existing config')
      : chalk.green('would create a new config')
  );

  section('Runtime & hooks');
  row('Runtime', generator.RUNTIME_DIR);
  row('Runner', generator.RUNNER_PATH);
  row('SessionStart', generator.WRAPPERS.SessionStart);
  row('PreToolUse', generator.WRAPPERS.PreToolUse);
  row('SessionEnd', generator.WRAPPERS.SessionEnd);
  row('Settings', claudeSettings.SETTINGS_PATH);

  console.log('');
  console.log(chalk.dim('Run `claude-session-monitor init` (without --dry-run) to apply these changes.'));
}

/**
 * Interactive setup wizard for the account-lock hook system.
 * @param {{ force?: boolean, dryRun?: boolean }} [options]
 */
async function init(options = {}) {
  if (options.dryRun) {
    printDryRun();
    return;
  }

  section('claude-session-monitor · setup');

  if (config.configExists() && !options.force) {
    const proceed = await confirmOverwrite();
    if (!proceed) {
      console.log(chalk.yellow('Setup aborted. Existing configuration left untouched.'));
      return;
    }
  }

  const answers = await collectAnswers();

  section('Verify connection');
  const testResult = await verifyConnection(answers.botToken, answers.groupId);
  if (!testResult) {
    console.log(
      chalk.red('Aborting setup. Fix the Telegram configuration and run init again.')
    );
    process.exitCode = 1;
    return;
  }

  const cfg = {
    version: CONFIG_VERSION,
    botToken: answers.botToken,
    groupId: normalizeGroupId(answers.groupId),
    timeout: answers.timeout,
    machineName: os.hostname(),
    installedAt: new Date().toISOString(),
  };

  section('Save configuration');
  const savedPath = config.saveConfig(cfg);
  console.log(chalk.green(`✓ Configuration saved to ${savedPath}`));

  let hookInstalled = false;
  if (answers.installHook) {
    section('Install account-lock hooks');
    try {
      installHookArtifacts();
      hookInstalled = true;
    } catch (err) {
      const message = err && err.message ? err.message : String(err);
      console.log(chalk.red(`✖ Hook installation failed: ${message}`));
      console.log(chalk.yellow('You can retry hook installation later by running init again.'));
    }

    if (hookInstalled) {
      section('Shared state');
      await setupSharedState(cfg);
    }
  } else {
    console.log(chalk.dim('Skipped hook installation (you can run init again to add it).'));
  }

  section('Notify group');
  await notifyInstalled(cfg);

  printSummary(cfg, hookInstalled);
}

module.exports = { init };

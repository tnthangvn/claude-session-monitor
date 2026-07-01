'use strict';

const fs = require('fs');
const os = require('os');
const inquirer = require('inquirer');
const chalk = require('chalk');

const config = require('../services/config');
const telegram = require('../services/telegram');
const generator = require('../services/generator');
const claudeSettings = require('../services/claudeSettings');
const { isValidBotToken, isValidGroupId, isValidTimeout, normalizeGroupId } = require('../utils/validators');

const CONFIG_VERSION = '1.0.0';
const DEFAULT_TIMEOUT = 300;

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
          : 'Group ID must be a negative number. Add the bot to your group and use its chat id.',
    },
    {
      type: 'number',
      name: 'timeout',
      message: 'Approval timeout in seconds:',
      default: DEFAULT_TIMEOUT,
      validate: (value) =>
        isValidTimeout(value) ? true : 'Timeout must be a positive number of seconds.',
    },
    {
      type: 'confirm',
      name: 'approvalMode',
      message: 'Require group approval on conflict?',
      default: false,
    },
    {
      type: 'confirm',
      name: 'installHook',
      message: 'Install the Claude Code PreToolUse hook now?',
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
        'Make sure the bot is added to the group, is an admin, and the group id is correct.'
      )
    );
    return null;
  }
}

/**
 * Install the generated hook script and register it in Claude settings.
 * @param {object} cfg persisted configuration
 */
function installHookArtifacts(cfg) {
  const hookPath = generator.installHookScript(cfg);
  claudeSettings.installHook(generator.HOOK_PATH);
  console.log(chalk.green(`✓ Hook script installed at ${hookPath}`));
  console.log(chalk.green(`✓ Registered hook in ${claudeSettings.SETTINGS_PATH}`));
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
 * Print a two-column plan row.
 * @param {string} label
 * @param {string} value
 */
function planRow(label, value) {
  console.log(`  ${chalk.bold(label.padEnd(12))} ${value}`);
}

/**
 * Preview every file init would create/modify and the exact Claude Code hook it
 * would register — without prompting, writing, or contacting Telegram.
 */
function printDryRun() {
  section('claude-session-monitor · setup (dry run)');
  console.log(chalk.yellow('Dry run: no files will be written and no messages will be sent.'));

  section('Configuration file');
  const cfgExists = config.configExists();
  planRow('Path', config.CONFIG_PATH);
  planRow(
    'Action',
    cfgExists
      ? chalk.yellow('would OVERWRITE the existing config')
      : chalk.green('would create a new config')
  );

  section('Hook script');
  const scriptExists = fs.existsSync(generator.HOOK_PATH);
  planRow('Path', generator.HOOK_PATH);
  planRow('Directory', generator.HOOK_DIR);
  planRow(
    'Action',
    scriptExists
      ? chalk.yellow('would OVERWRITE the existing hook script')
      : chalk.green('would create the hook script (mode 0755)')
  );

  section('Claude Code hook registration');
  const preview = claudeSettings.previewHook(generator.HOOK_PATH);
  planRow('Settings', preview.settingsPath);
  planRow('Event', preview.event);
  planRow('Matcher', preview.matcher);
  planRow('Command', preview.command);
  planRow(
    'Action',
    preview.alreadyPresent
      ? chalk.dim('already registered — no change')
      : preview.settingsExists
        ? chalk.green('would add a PreToolUse hook (existing settings backed up first)')
        : chalk.green('would create settings.json and add a PreToolUse hook')
  );

  console.log('');
  console.log(chalk.dim('Run `claude-session-monitor init` (without --dry-run) to apply these changes.'));
}

/**
 * Interactive setup wizard.
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
    approvalMode: answers.approvalMode,
    machineName: os.hostname(),
    installedAt: new Date().toISOString(),
  };

  section('Save configuration');
  const savedPath = config.saveConfig(cfg);
  console.log(chalk.green(`✓ Configuration saved to ${savedPath}`));

  if (answers.installHook) {
    section('Install hook');
    try {
      installHookArtifacts(cfg);
    } catch (err) {
      const message = err && err.message ? err.message : String(err);
      console.log(chalk.red(`✖ Hook installation failed: ${message}`));
      console.log(chalk.yellow('You can retry hook installation later by running init again.'));
    }
  } else {
    console.log(chalk.dim('Skipped hook installation (you can run init again to add it).'));
  }

  section('Notify group');
  await notifyInstalled(cfg);

  section('Done');
  console.log(chalk.green.bold(`✓ claude-session-monitor is set up on ${cfg.machineName}.`));
  console.log('');
  console.log(chalk.bold('Next steps:'));
  console.log(`  ${chalk.cyan('claude-session-monitor status')}  ${chalk.dim('# review your setup')}`);
  console.log(`  ${chalk.cyan('claude-session-monitor test')}    ${chalk.dim('# send a test message')}`);
  console.log('');
}

module.exports = { init };

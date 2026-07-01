'use strict';

const inquirer = require('inquirer');
const chalk = require('chalk');

const config = require('../services/config');
const generator = require('../services/generator');
const claudeSettings = require('../services/claudeSettings');

/**
 * Run a single removal step, reporting success or a non-fatal warning.
 * Each step is independent: a failure is warned about and never aborts the rest.
 * @param {string} label human-readable description
 * @param {Function} fn () => boolean  (truthy result means "something was removed")
 * @param {string[]} removed accumulator of successfully removed items
 */
function runStep(label, fn, removed) {
  try {
    const didRemove = fn();
    if (didRemove) {
      console.log(chalk.green(`✓ ${label}`));
      removed.push(label);
    } else {
      console.log(chalk.dim(`• ${label}: nothing to remove.`));
    }
  } catch (err) {
    const message = err && err.message ? err.message : String(err);
    console.log(chalk.yellow(`⚠ ${label} failed: ${message}`));
  }
}

/**
 * Remove the account-lock hooks, the runtime, and the local configuration.
 * The pinned shared-state message in Telegram is intentionally left as-is.
 * @param {{ yes?: boolean }} [options]
 */
async function uninstall(options = {}) {
  if (!options.yes) {
    const { confirmed } = await inquirer.prompt([
      {
        type: 'confirm',
        name: 'confirmed',
        message: 'Remove the account-lock hooks, runtime, and configuration?',
        default: false,
      },
    ]);
    if (!confirmed) {
      console.log(chalk.yellow('Uninstall cancelled. Nothing was removed.'));
      return;
    }
  }

  console.log(chalk.bold.cyan('Uninstalling claude-session-monitor'));
  console.log('');

  const removed = [];
  runStep(
    'Removed account-lock hooks from Claude settings',
    () => claudeSettings.removeHooks().removed,
    removed
  );
  runStep('Removed session-monitor runtime', () => generator.removeRuntime(), removed);
  runStep(
    'Deleted configuration',
    () => {
      const existed = config.configExists();
      config.deleteConfig();
      return existed;
    },
    removed
  );

  console.log('');
  if (removed.length === 0) {
    console.log(chalk.yellow('Nothing needed to be removed.'));
  } else {
    console.log(chalk.green.bold(`✓ Done. Removed ${removed.length} item(s).`));
  }
  console.log(
    chalk.dim(
      'The pinned shared-state message in your Telegram group was left as-is; ' +
        'unpin it manually if you no longer need it.'
    )
  );
}

module.exports = { uninstall };

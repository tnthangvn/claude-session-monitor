'use strict';

const inquirer = require('inquirer');
const chalk = require('chalk');

const config = require('../services/config');
const generator = require('../services/generator');
const claudeSettings = require('../services/claudeSettings');

/**
 * Run a single removal step, reporting success or a non-fatal warning.
 * @param {string} label human-readable description
 * @param {Function} fn () => any
 * @param {string[]} removed accumulator of successfully removed items
 */
function runStep(label, fn, removed) {
  try {
    const result = fn();
    if (result === false) {
      console.log(chalk.dim(`• ${label}: nothing to remove.`));
    } else {
      console.log(chalk.green(`✓ ${label}`));
      removed.push(label);
    }
  } catch (err) {
    const message = err && err.message ? err.message : String(err);
    console.log(chalk.yellow(`⚠ ${label} failed: ${message}`));
  }
}

/**
 * Remove the hook, generated script, and configuration.
 * @param {{ yes?: boolean }} [options]
 */
async function uninstall(options = {}) {
  if (!options.yes) {
    const { confirmed } = await inquirer.prompt([
      {
        type: 'confirm',
        name: 'confirmed',
        message: 'Remove the Claude Code hook, generated script, and configuration?',
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
  runStep('Removed hook from Claude settings', () => claudeSettings.removeHook(), removed);
  runStep('Removed generated hook script', () => generator.removeHookScript(), removed);
  runStep('Deleted configuration', () => config.deleteConfig(), removed);

  console.log('');
  if (removed.length === 0) {
    console.log(chalk.yellow('Nothing needed to be removed.'));
  } else {
    console.log(chalk.green.bold(`✓ Done. Removed ${removed.length} item(s).`));
  }
  console.log(
    chalk.dim(
      'A backup of your Claude settings was created before changes were applied ' +
        `(see ${claudeSettings.SETTINGS_PATH}.bak or similar).`
    )
  );
}

module.exports = { uninstall };

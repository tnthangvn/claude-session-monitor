'use strict';

const chalk = require('chalk');

const config = require('../services/config');
const generator = require('../services/generator');
const { installHookArtifacts, notifyInstalled } = require('./init');

/**
 * Non-interactive upgrade: reuse the saved configuration, re-install the
 * runtime (runner.js + wrappers) and re-register the hooks so the machine runs
 * the latest shipped code, then notify the group with an "updated" message.
 *
 * Unlike `init`, this never prompts and never touches the Telegram bot
 * token/group settings — it only refreshes the installed artifacts.
 */
async function upgrade() {
  console.log('');
  console.log(chalk.bold.cyan('claude-session-monitor · upgrade'));

  if (!config.configExists()) {
    console.log(chalk.yellow('Not configured yet. Run: claude-session-monitor init'));
    process.exitCode = 1;
    return;
  }

  let cfg;
  try {
    cfg = config.loadConfig();
  } catch (err) {
    console.log(chalk.red(`✖ Could not read configuration: ${err.message}`));
    console.log(chalk.yellow('The config file may be corrupt. Re-run: claude-session-monitor init'));
    process.exitCode = 1;
    return;
  }

  try {
    installHookArtifacts();
  } catch (err) {
    const message = err && err.message ? err.message : String(err);
    console.log(chalk.red(`✖ Upgrade failed: ${message}`));
    process.exitCode = 1;
    return;
  }

  await notifyInstalled(cfg, true);

  const version = require('../../package.json').version;
  console.log('');
  console.log(
    chalk.green.bold(
      `✓ claude-session-monitor upgraded to v${version} on ${cfg.machineName}.`
    )
  );
  console.log(chalk.dim(`  Runtime: ${generator.RUNNER_PATH}`));
  console.log('');
}

module.exports = { upgrade };

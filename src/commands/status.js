'use strict';

const fs = require('fs');
const chalk = require('chalk');

const config = require('../services/config');
const generator = require('../services/generator');
const claudeSettings = require('../services/claudeSettings');
const telegramState = require('../services/telegramState');
const { maskToken, formatDuration, formatTimestamp } = require('../utils/formatters');

/**
 * Print a two-column labelled row.
 * @param {string} label
 * @param {string} value
 */
function row(label, value) {
  console.log(`  ${chalk.bold(label.padEnd(16))} ${value}`);
}

/**
 * Print a section header.
 * @param {string} title
 */
function section(title) {
  console.log('');
  console.log(chalk.bold.cyan(title));
}

/**
 * Render the configuration summary block.
 * @param {object} cfg
 */
function printConfig(cfg) {
  section('Configuration');
  row('Version', require('../../package.json').version);
  row('Bot token', maskToken(cfg.botToken));
  row('Group ID', String(cfg.groupId));
  row('Timeout', `${cfg.timeout}s`);
  row('Machine', cfg.machineName);
  row('Installed', formatTimestamp(cfg.installedAt));
  row(
    'State message',
    cfg.stateMessageId ? String(cfg.stateMessageId) : chalk.dim('not created yet')
  );
}

/**
 * Render the hook-health block for the account-lock runtime.
 */
function printHookHealth() {
  section('Hook health');
  const registered = claudeSettings.hasHooks();
  const runnerExists = fs.existsSync(generator.RUNNER_PATH);
  row(
    'Settings hooks',
    registered ? chalk.green('✓ registered') : chalk.red('✗ not registered')
  );
  row(
    'Runtime',
    runnerExists
      ? chalk.green(`✓ ${generator.RUNNER_PATH}`)
      : chalk.red(`✗ missing (${generator.RUNNER_PATH})`)
  );
}

/**
 * Render one active-account row from the shared state.
 * @param {string} account
 * @param {object} info { machine, mid, exp }
 * @param {number} nowSeconds
 */
function printAccountRow(account, info, nowSeconds) {
  const machine = info.machine || 'unknown';
  // Current entries carry an absolute `exp` (epoch MS). Legacy entries only had
  // `ts` (epoch seconds); fall back to showing how long ago it was seen.
  const exp = Number(info.exp);
  const ts = Number(info.ts);
  let freshness;
  if (Number.isFinite(exp)) {
    freshness = `${formatDuration(Math.max(0, Math.floor(exp / 1000) - nowSeconds))} left`;
  } else if (Number.isFinite(ts)) {
    freshness = `${formatDuration(nowSeconds - ts)} ago`;
  } else {
    freshness = chalk.dim('unknown');
  }
  // The pinned state no longer carries per-session details, so a count is shown
  // ONLY for legacy entries that still have it.
  const sessionCount =
    info.sessions && typeof info.sessions === 'object'
      ? Object.keys(info.sessions).length
      : info.session
        ? 1
        : null;

  console.log(`  ${chalk.bold(account)}`);
  row('  Machine', machine);
  if (sessionCount !== null) row('  Sessions', String(sessionCount));
  row('  Expires in', freshness);
}

/**
 * Render the shared account-lock state (a table of active accounts).
 * @param {object} cfg
 */
async function printSharedState(cfg) {
  section('Shared lock state');

  let result;
  try {
    result = await telegramState.readState(cfg);
  } catch (err) {
    const message = err && err.message ? err.message : String(err);
    console.log(chalk.yellow(`  Could not read shared state: ${message}`));
    return;
  }

  const accounts = (result && result.state && result.state.accounts) || {};
  const keys = Object.keys(accounts);
  if (keys.length === 0) {
    console.log(chalk.dim('  No active sessions.'));
    return;
  }

  const nowSeconds = Math.floor(Date.now() / 1000);
  keys.forEach((account) => printAccountRow(account, accounts[account] || {}, nowSeconds));
}

/**
 * Show configuration, hook health, and the shared account-lock state.
 */
async function status() {
  if (!config.configExists()) {
    console.log(chalk.yellow('Not configured. Run: claude-session-monitor init'));
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

  printConfig(cfg);
  printHookHealth();
  await printSharedState(cfg);
  console.log('');
}

module.exports = { status };

'use strict';

const fs = require('fs');
const os = require('os');
const chalk = require('chalk');

const config = require('../services/config');
const generator = require('../services/generator');
const claudeSettings = require('../services/claudeSettings');
const { maskToken, formatDuration, formatTimestamp } = require('../utils/formatters');

/**
 * Resolve the current user's session lock file path.
 * @returns {string}
 */
function lockFilePath() {
  const user = process.env.USER || os.userInfo().username;
  return `/tmp/claude-session-${user}.lock`;
}

/**
 * Print a two-column labelled row.
 * @param {string} label
 * @param {string} value
 */
function row(label, value) {
  console.log(`  ${chalk.bold(label.padEnd(14))} ${value}`);
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
  row('Bot token', maskToken(cfg.botToken));
  row('Group ID', String(cfg.groupId));
  row('Timeout', `${cfg.timeout}s`);
  row('Approval mode', cfg.approvalMode ? chalk.green('on') : chalk.dim('off'));
  row('Machine', cfg.machineName);
  row('Installed', formatTimestamp(cfg.installedAt));
}

/**
 * Render the hook health block.
 */
function printHookHealth() {
  section('Hook health');
  const registered = claudeSettings.hasHook();
  const scriptExists = fs.existsSync(generator.HOOK_PATH);
  row(
    'Settings hook',
    registered ? chalk.green('✓ registered') : chalk.red('✗ not registered')
  );
  row(
    'Hook script',
    scriptExists
      ? chalk.green(`✓ ${generator.HOOK_PATH}`)
      : chalk.red(`✗ missing (${generator.HOOK_PATH})`)
  );
}

/**
 * Parse a lock file's contents into { machine, ts }.
 * Supports "machine epoch" and JSON forms defensively.
 * @param {string} raw
 * @returns {{ machine: string, ts: number }|null}
 */
function parseLock(raw) {
  const trimmed = (raw || '').trim();
  if (!trimmed) return null;

  try {
    const parsed = JSON.parse(trimmed);
    if (parsed && typeof parsed === 'object') {
      const ts = Number(parsed.ts || parsed.epoch || parsed.time);
      return { machine: parsed.machine || 'unknown', ts: Number.isFinite(ts) ? ts : NaN };
    }
  } catch (err) {
    // Not JSON — fall through to whitespace parsing.
  }

  const parts = trimmed.split(/\s+/);
  const machine = parts[0] || 'unknown';
  const ts = Number(parts[1]);
  return { machine, ts };
}

/**
 * Render the active-session block from the lock file.
 * @param {object} cfg
 */
function printActiveSession(cfg) {
  section('Active session');
  const lockPath = lockFilePath();

  if (!fs.existsSync(lockPath)) {
    console.log(chalk.dim('  None — no active session lock found.'));
    return;
  }

  let raw = '';
  try {
    raw = fs.readFileSync(lockPath, 'utf8');
  } catch (err) {
    console.log(chalk.yellow(`  Lock file present but unreadable: ${err.message}`));
    return;
  }

  const parsed = parseLock(raw);
  if (!parsed) {
    console.log(chalk.yellow('  Lock file present but empty or malformed.'));
    return;
  }

  row('Locked by', parsed.machine);

  if (!Number.isFinite(parsed.ts)) {
    row('Elapsed', chalk.dim('unknown (no timestamp in lock)'));
    return;
  }

  // Lock timestamps are epoch seconds; formatDuration expects milliseconds.
  const elapsedMs = Date.now() - parsed.ts * 1000;
  const withinTimeout = elapsedMs <= cfg.timeout * 1000;
  row('Elapsed', formatDuration(elapsedMs));
  row(
    'Status',
    withinTimeout ? chalk.green('within timeout') : chalk.red('expired (past timeout)')
  );
}

/**
 * Render the recent-history block.
 */
function printRecentHistory() {
  section('Recent history');
  const rows = config.readHistory(5);
  if (!rows || rows.length === 0) {
    console.log(chalk.dim('  No session history yet.'));
    return;
  }
  rows.forEach((entry) => {
    const when = formatTimestamp(entry.ts);
    const event = entry.event === 'START'
      ? chalk.green(entry.event)
      : entry.event === 'CONFLICT'
        ? chalk.red(entry.event)
        : chalk.dim(entry.event);
    const detail = entry.detail ? chalk.dim(`— ${entry.detail}`) : '';
    console.log(`  ${chalk.dim(when)}  ${event}  ${entry.machine} ${detail}`.trimEnd());
  });
}

/**
 * Show configuration, hook health, active session, and recent history.
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
  printActiveSession(cfg);
  printRecentHistory();
  console.log('');
}

module.exports = { status };

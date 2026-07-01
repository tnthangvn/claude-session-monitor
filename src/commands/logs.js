'use strict';

const chalk = require('chalk');

const config = require('../services/config');
const { formatTimestamp } = require('../utils/formatters');

const DEFAULT_LINES = 20;

/**
 * Colour an event name as a fixed-width badge.
 * @param {string} event
 * @returns {string}
 */
function eventBadge(event) {
  const name = event || 'UNKNOWN';
  const padded = name.padEnd(9);
  if (name === 'START') return chalk.green(padded);
  if (name === 'CONFLICT') return chalk.red(padded);
  return chalk.dim(padded);
}

/**
 * Coerce the requested line count to a positive integer.
 * @param {*} value
 * @returns {number}
 */
function resolveLimit(value) {
  const parsed = parseInt(value, 10);
  if (Number.isFinite(parsed) && parsed > 0) return parsed;
  return DEFAULT_LINES;
}

/**
 * Pretty-print recent session history.
 * @param {{ lines?: number|string }} [options]
 */
async function logs(options = {}) {
  if (!config.configExists()) {
    console.log(chalk.yellow('Not configured. Run: claude-session-monitor init'));
    return;
  }

  const all = config.readHistory();
  if (!all || all.length === 0) {
    console.log(chalk.dim('No session history yet.'));
    return;
  }

  const limit = resolveLimit(options.lines);
  const recent = all.slice(-limit);

  let startCount = 0;
  let conflictCount = 0;

  recent.forEach((entry) => {
    if (entry.event === 'START') startCount += 1;
    else if (entry.event === 'CONFLICT') conflictCount += 1;

    const when = chalk.dim(formatTimestamp(entry.ts));
    const badge = eventBadge(entry.event);
    const machine = chalk.bold(entry.machine || 'unknown');
    const detail = entry.detail ? chalk.dim(`— ${entry.detail}`) : '';
    console.log(`${when}  ${badge}  ${machine} ${detail}`.trimEnd());
  });

  console.log('');
  console.log(
    `${chalk.dim(`Showing ${recent.length} of ${all.length} entries ·`)} ` +
      `${chalk.green(`${startCount} START`)}${chalk.dim(' · ')}${chalk.red(`${conflictCount} CONFLICT`)}`
  );
}

module.exports = { logs };

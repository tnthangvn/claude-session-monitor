'use strict';

const os = require('os');

const chalk = require('chalk');

const config = require('../services/config');
const telegram = require('../services/telegram');
const telegramState = require('../services/telegramState');

/** Minimal HTML escaping for Telegram parse_mode: 'HTML'. */
function esc(s) {
  return String(s === undefined || s === null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/** One-line description of a lock entry: machine (ip · loc)[, N session(s)]. */
function describeEntry(entry) {
  const where = [entry.ip, entry.loc].filter(Boolean).join(' · ');
  // Current entries carry no per-session map; only legacy ones still have a count.
  const sessions =
    entry.sessions && typeof entry.sessions === 'object'
      ? Object.keys(entry.sessions).length
      : entry.session
        ? 1
        : null;
  const suffix = sessions === null ? '' : `, ${sessions} session(s)`;
  return `${entry.machine || '?'}${where ? ` (${where})` : ''}${suffix}`;
}

/**
 * Remove one account's lock entry from the pinned shared state.
 *
 * Recovery tool for the power-loss / crash case: a machine that dies without
 * a clean SessionEnd leaves its lock in the pinned message until the TTL
 * expires. This clears the entry immediately so other machines start clean.
 *
 * @param {string} account the account key as shown in `status` (usually the email)
 * @param {object} options { yes?: boolean } — reserved for future use
 */
async function removeAccount(account, options = {}) {
  if (!config.configExists()) {
    console.log(chalk.yellow('Not configured. Run: claude-session-monitor init'));
    process.exitCode = 1;
    return;
  }

  let cfg;
  try {
    cfg = config.loadConfig();
  } catch (err) {
    console.log(chalk.red(`✖ Could not read configuration: ${err.message}`));
    console.log(chalk.yellow('Re-run: claude-session-monitor init'));
    process.exitCode = 1;
    return;
  }

  const target = String(account || '').trim();
  if (!target) {
    console.log(chalk.yellow('Pass the account to remove, e.g.: claude-session-monitor remove-account you@example.com'));
    process.exitCode = 1;
    return;
  }

  console.log(chalk.dim('… Reading the shared lock state from the pinned message.'));
  const { state, messageId } = await telegramState.readState(cfg);
  const accounts = state.accounts || {};
  const names = Object.keys(accounts);

  if (!Object.prototype.hasOwnProperty.call(accounts, target)) {
    console.log(chalk.yellow(`✖ No lock found for account "${target}".`));
    if (names.length) {
      console.log('Accounts currently holding a lock:');
      for (const name of names) {
        console.log(`  - ${name}  →  ${describeEntry(accounts[name])}`);
      }
    } else {
      console.log(chalk.dim('The shared state has no locks at all — nothing to remove.'));
    }
    process.exitCode = 1;
    return;
  }

  const removed = accounts[target];
  delete accounts[target];
  await telegramState.writeState(cfg, state, messageId);
  config.appendHistory(
    'REMOVE',
    os.hostname(),
    `account=${target}, holder=${removed.machine || '?'}/${removed.ip || '?'}`
  );

  // Best-effort group notice so everyone sees the manual unlock; the state
  // write above is the real fix, so a notify failure must not fail the command.
  try {
    await telegram.sendMessage(
      cfg,
      `🔓 Lock của <b>${esc(target)}</b> @ <b>${esc(removed.machine || '?')}</b>` +
        ` (${esc(removed.ip || '?')}) đã được gỡ thủ công (remove-account).`
    );
  } catch (_err) {
    console.log(chalk.yellow('⚠ Lock removed, but the Telegram notice could not be sent.'));
  }

  console.log(chalk.green.bold(`✓ Removed the lock for ${target}`));
  console.log(chalk.dim(`  was: ${describeEntry(removed)}`));
}

module.exports = { removeAccount };

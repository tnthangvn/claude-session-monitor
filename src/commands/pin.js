'use strict';

const chalk = require('chalk');

const config = require('../services/config');
const telegramState = require('../services/telegramState');

/**
 * Pin one message of data onto the Telegram group.
 *
 * The text is pinned VERBATIM. With --state the lock-state header is
 * prepended so the text is byte-compatible with the shared session-lock
 * message that the hook runtime reads.
 *
 * @param {string[]} parts positional words, joined with spaces
 * @param {object} options { state?: boolean, new?: boolean }
 */
async function pin(parts, options = {}) {
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

  let text = (parts || []).join(' ').trim();
  if (!text) {
    console.log(chalk.yellow('Nothing to pin — pass the data line as an argument.'));
    process.exitCode = 1;
    return;
  }

  if (options.state) {
    text = `${telegramState.STATE_HEADER}\n${text}`;
    if (!telegramState.parseStateText(text)) {
      console.log(
        chalk.yellow(
          '⚠ The data does not parse as lock state (expected JSON with an "accounts" key); pinning it anyway.'
        )
      );
    }
  }

  console.log(chalk.dim('… Pinning the message onto the group.'));
  const { messageId, mode } = await telegramState.pinText(cfg, text, {
    forceNew: Boolean(options.new),
  });

  const verb = mode === 'edited' ? 'Updated the pinned message' : 'Created and pinned a new message';
  console.log(chalk.green.bold(`✓ ${verb} (message_id: ${messageId}).`));
}

module.exports = { pin };

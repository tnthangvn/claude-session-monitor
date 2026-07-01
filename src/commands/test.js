'use strict';

const chalk = require('chalk');

const config = require('../services/config');
const telegram = require('../services/telegram');

/**
 * Print troubleshooting hints for a failed Telegram interaction.
 */
function printTroubleshooting() {
  console.log('');
  console.log(chalk.bold('Troubleshooting:'));
  console.log(chalk.dim('  • Is the bot a member of the target group?'));
  console.log(chalk.dim('  • Does the bot have admin rights in the group?'));
  console.log(chalk.dim('  • Is the group ID correct (a negative number)?'));
  console.log(chalk.dim('  • Has the bot token been revoked or rotated?'));
}

/**
 * Verify the Telegram connection and send a test message.
 */
async function test() {
  if (!config.configExists()) {
    console.log(chalk.yellow('Not configured. Run: claude-session-monitor init'));
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

  console.log(chalk.dim('… Verifying the Telegram connection.'));
  let result;
  try {
    result = await telegram.testConnection(cfg.botToken, cfg.groupId);
  } catch (err) {
    console.log(chalk.red(`✖ Connection failed: ${err.message}`));
    printTroubleshooting();
    process.exitCode = 1;
    return;
  }

  const botName = result && result.bot ? result.bot.username || result.bot.first_name : 'bot';
  const chatTitle = result && result.chat ? result.chat.title || result.chat.id : 'group';
  console.log(chalk.green(`✓ Bot: @${botName}`));
  console.log(chalk.green(`✓ Chat: ${chatTitle}`));

  console.log(chalk.dim('… Sending a test message.'));
  try {
    await telegram.sendMessage(cfg, '🧪 Test message from claude-session-monitor');
  } catch (err) {
    console.log(chalk.red(`✖ Could not send the test message: ${err.message}`));
    printTroubleshooting();
    process.exitCode = 1;
    return;
  }

  console.log(chalk.green.bold('✓ Test message sent. Check your Telegram group.'));
}

module.exports = { test };

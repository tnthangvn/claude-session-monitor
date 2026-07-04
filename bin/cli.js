#!/usr/bin/env node

'use strict';

const { Command } = require('commander');
const chalk = require('chalk');
const pkg = require('../package.json');

/**
 * Wrap an async command handler so any thrown error is reported cleanly
 * and the process exits non-zero without an ugly stack trace.
 *
 * @param {Function} handler async (options) => Promise<void>
 * @returns {Function} commander-compatible action handler
 */
function runner(handler) {
  return async (...args) => {
    try {
      await handler(...args);
    } catch (err) {
      const message = err && err.message ? err.message : String(err);
      console.error(chalk.red(`✖ ${message}`));
      process.exitCode = 1;
    }
  };
}

const program = new Command();

program
  .name('claude-session-monitor')
  .version(pkg.version, '-v, --version', 'output the current version')
  .description(
    'Monitor and guard Claude Code sessions across machines via Telegram approvals.'
  );

program
  .command('init')
  .description('Interactive setup wizard (bot token, group, hook install)')
  .option('--force', 'overwrite an existing configuration without asking')
  .option('--dry-run', 'preview which hook would be installed and where, without making changes')
  .action(runner((options) => require('../src/commands/init').init(options)));

program
  .command('upgrade')
  .alias('force-update')
  .description('Re-install the runtime + hooks from the current package (keeps config)')
  .action(runner(() => require('../src/commands/upgrade').upgrade()));

program
  .command('status')
  .description('Show current configuration, hook health, and recent activity')
  .action(runner((options) => require('../src/commands/status').status(options)));

program
  .command('test')
  .description('Verify the Telegram connection and send a test message')
  .action(runner((options) => require('../src/commands/test').test(options)));

program
  .command('logs')
  .description('Show recent session history')
  .option('-n, --lines <n>', 'number of history entries to show', '20')
  .action(runner((options) => require('../src/commands/logs').logs(options)));

program
  .command('pin')
  .description('Pin one message of data onto the group (edits the current pinned message in place)')
  .argument('<text...>', 'the data line to pin, verbatim')
  .option('--state', 'prepend the session-lock header so the hook reads it as shared state')
  .option('--new', 'always send and pin a fresh message instead of editing the pinned one')
  .action(runner((text, options) => require('../src/commands/pin').pin(text, options)));

program
  .command('remove-account')
  .description(
    'Remove one account\'s lock from the pinned shared state (recovery after a crash / power loss)'
  )
  .argument('<account>', 'the account key shown in `status` (usually the email)')
  .action(runner((account, options) => require('../src/commands/removeAccount').removeAccount(account, options)));

program
  .command('uninstall')
  .description('Remove the hook, generated script, and configuration')
  .option('--yes', 'skip the confirmation prompt')
  .action(runner((options) => require('../src/commands/uninstall').uninstall(options)));

program.showHelpAfterError();

// Default behaviour when no subcommand is provided: show help.
program.action(() => {
  program.help();
});

program.parseAsync(process.argv).catch((err) => {
  const message = err && err.message ? err.message : String(err);
  console.error(chalk.red(`✖ ${message}`));
  process.exitCode = 1;
});

'use strict';

/**
 * Hook script generator service.
 * Reads the bash template, substitutes config values into placeholders,
 * and installs / removes the generated hook script.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const HOOK_DIR = path.join(os.homedir(), '.claude', 'hooks');
const HOOK_PATH = path.join(HOOK_DIR, 'check-session-telegram.sh');

// Runtime history log location (kept in sync with the shared contract).
const HISTORY_PATH = path.join(os.homedir(), '.claude', 'session-monitor', 'history.log');

// Template lives at <project-root>/templates/hook-script.sh
const TEMPLATE_PATH = path.join(__dirname, '..', '..', 'templates', 'hook-script.sh');

/**
 * Read the bash template and substitute every placeholder with config values.
 * @param {object} config config object (botToken, groupId, timeout)
 * @returns {string} the fully-resolved bash script
 * @throws {Error} if any placeholder remains unresolved
 */
function generateHookScript(config) {
  const template = fs.readFileSync(TEMPLATE_PATH, 'utf8');

  const replacements = {
    '{{BOT_TOKEN}}': String(config.botToken),
    '{{GROUP_ID}}': String(config.groupId),
    '{{TIMEOUT}}': String(config.timeout),
    '{{HISTORY_PATH}}': HISTORY_PATH,
  };

  let script = template;
  for (const [placeholder, value] of Object.entries(replacements)) {
    script = script.split(placeholder).join(value);
  }

  // Defensive: ensure no template placeholder survived substitution.
  const leftover = script.match(/\{\{[^}]+\}\}/);
  if (leftover) {
    throw new Error(`Unresolved placeholder in generated hook script: ${leftover[0]}`);
  }

  return script;
}

/**
 * Generate and install the hook script at HOOK_PATH.
 * Creates HOOK_DIR if needed and marks the script executable (0755).
 * @param {object} config config object
 * @returns {string} the installed hook path
 */
function installHookScript(config) {
  const script = generateHookScript(config);
  fs.mkdirSync(HOOK_DIR, { recursive: true });
  fs.writeFileSync(HOOK_PATH, script, { mode: 0o755 });
  // writeFileSync honors mode only on creation; enforce it explicitly.
  fs.chmodSync(HOOK_PATH, 0o755);
  return HOOK_PATH;
}

/**
 * Remove the installed hook script if present.
 * @returns {boolean} true if a file was removed, false if nothing existed
 */
function removeHookScript() {
  if (fs.existsSync(HOOK_PATH)) {
    fs.unlinkSync(HOOK_PATH);
    return true;
  }
  return false;
}

module.exports = {
  HOOK_DIR,
  HOOK_PATH,
  generateHookScript,
  installHookScript,
  removeHookScript,
};

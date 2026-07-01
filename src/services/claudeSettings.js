'use strict';

/**
 * claudeSettings.js — safe integration with the Claude Code CLI settings file.
 *
 * Injects / removes a PreToolUse hook entry in ~/.claude/settings.json without
 * disturbing the user's existing configuration. Every mutation makes a timestamped
 * backup first and validates JSON integrity before writing.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const CLAUDE_DIR = path.join(os.homedir(), '.claude');
const SETTINGS_PATH = path.join(CLAUDE_DIR, 'settings.json');

const HOOK_EVENT = 'PreToolUse';
const DEFAULT_MATCHER = '*';

// Multi-hook support: the three Claude Code events we manage together.
const MULTI_HOOK_EVENTS = ['SessionStart', 'PreToolUse', 'SessionEnd'];

// Matchers used per event when appending our hook group.
const SESSION_START_MATCHER = 'startup|resume|clear|compact';

// A command string is "ours" if it references any of these markers. Includes the
// legacy single-hook script so removeHooks/hasHooks also clean up old installs.
const OUR_COMMAND_MARKERS = [
  'session-monitor/runner.js',
  'csm-session-start.sh',
  'csm-pretooluse.sh',
  'csm-session-end.sh',
  'check-session-telegram.sh',
];

/**
 * Read the current settings.json. Returns an empty object when the file does
 * not exist. Throws a friendly error when the file exists but is invalid JSON.
 */
function readSettings() {
  if (!fs.existsSync(SETTINGS_PATH)) {
    return {};
  }
  let raw;
  try {
    raw = fs.readFileSync(SETTINGS_PATH, 'utf8');
  } catch (err) {
    throw new Error(`Unable to read ${SETTINGS_PATH}: ${err.message}`);
  }
  if (raw.trim() === '') {
    return {};
  }
  try {
    return JSON.parse(raw);
  } catch (err) {
    throw new Error(
      `Claude settings file is not valid JSON (${SETTINGS_PATH}): ${err.message}. ` +
        'Fix or remove it before installing the hook.'
    );
  }
}

/**
 * Create a timestamped backup of settings.json next to the original.
 * Returns the backup path, or null when there is nothing to back up.
 */
function backupSettings() {
  if (!fs.existsSync(SETTINGS_PATH)) {
    return null;
  }
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupPath = `${SETTINGS_PATH}.backup-${stamp}`;
  fs.copyFileSync(SETTINGS_PATH, backupPath);
  return backupPath;
}

/** Write settings atomically (temp file + rename) with 0600 permissions. */
function writeSettings(settings) {
  if (!fs.existsSync(CLAUDE_DIR)) {
    fs.mkdirSync(CLAUDE_DIR, { recursive: true, mode: 0o700 });
  }
  const serialized = `${JSON.stringify(settings, null, 2)}\n`;
  // Validate before persisting.
  JSON.parse(serialized);
  const tmpPath = `${SETTINGS_PATH}.tmp-${process.pid}`;
  fs.writeFileSync(tmpPath, serialized, { mode: 0o600 });
  fs.renameSync(tmpPath, SETTINGS_PATH);
  return SETTINGS_PATH;
}

/** Normalize the hooks tree so hooks[HOOK_EVENT] is always an array. */
function getEventGroups(settings) {
  const hooks = settings.hooks || {};
  const groups = hooks[HOOK_EVENT];
  return Array.isArray(groups) ? groups : [];
}

/** Does any PreToolUse group already run the given command? */
function hasHook(command) {
  let settings;
  try {
    settings = readSettings();
  } catch (_err) {
    return false;
  }
  const target = command || null;
  return getEventGroups(settings).some((group) =>
    Array.isArray(group.hooks)
      ? group.hooks.some(
          (h) => h && h.type === 'command' && (target ? h.command === target : isOurCommand(h.command))
        )
      : false
  );
}

/** Heuristic used when no explicit command is provided: match our hook script name. */
function isOurCommand(command) {
  return typeof command === 'string' && command.includes('check-session-telegram.sh');
}

/**
 * Idempotently install a PreToolUse command hook.
 * Backs up the existing settings first, preserves all other configuration.
 * Returns { settingsPath, backupPath, alreadyPresent }.
 */
function installHook(hookCommand) {
  if (!hookCommand || typeof hookCommand !== 'string') {
    throw new Error('installHook requires the hook command (absolute path) as a string.');
  }

  const settings = readSettings();

  if (hasHook(hookCommand)) {
    return { settingsPath: SETTINGS_PATH, backupPath: null, alreadyPresent: true };
  }

  const backupPath = backupSettings();

  // Immutable-ish update: clone the pieces we touch.
  const nextHooks = { ...(settings.hooks || {}) };
  const groups = getEventGroups(settings).slice();
  groups.push({
    matcher: DEFAULT_MATCHER,
    hooks: [{ type: 'command', command: hookCommand }],
  });
  nextHooks[HOOK_EVENT] = groups;

  const nextSettings = { ...settings, hooks: nextHooks };
  writeSettings(nextSettings);

  return { settingsPath: SETTINGS_PATH, backupPath, alreadyPresent: false };
}

/**
 * Describe what installHook(hookCommand) would do, without writing anything.
 * Used by `init --dry-run` to show exactly which hook lands where.
 * @param {string} hookCommand absolute path to the hook script
 * @returns {{ settingsPath: string, event: string, matcher: string, command: string,
 *            alreadyPresent: boolean, settingsExists: boolean }}
 */
function previewHook(hookCommand) {
  if (!hookCommand || typeof hookCommand !== 'string') {
    throw new Error('previewHook requires the hook command (absolute path) as a string.');
  }
  return {
    settingsPath: SETTINGS_PATH,
    event: HOOK_EVENT,
    matcher: DEFAULT_MATCHER,
    command: hookCommand,
    alreadyPresent: hasHook(hookCommand),
    settingsExists: fs.existsSync(SETTINGS_PATH),
  };
}

/**
 * Remove our PreToolUse hook. Drops any command entry pointing at the
 * check-session-telegram.sh script and prunes now-empty groups.
 * Returns { removed, settingsPath, backupPath }.
 */
function removeHook() {
  if (!fs.existsSync(SETTINGS_PATH)) {
    return { removed: false, settingsPath: SETTINGS_PATH, backupPath: null };
  }

  const settings = readSettings();
  const groups = getEventGroups(settings);
  if (groups.length === 0) {
    return { removed: false, settingsPath: SETTINGS_PATH, backupPath: null };
  }

  let removed = false;
  const nextGroups = groups
    .map((group) => {
      if (!Array.isArray(group.hooks)) {
        return group;
      }
      const filtered = group.hooks.filter((h) => {
        const isOurs = h && h.type === 'command' && isOurCommand(h.command);
        if (isOurs) {
          removed = true;
        }
        return !isOurs;
      });
      return { ...group, hooks: filtered };
    })
    // Drop groups that no longer have any hooks left.
    .filter((group) => !Array.isArray(group.hooks) || group.hooks.length > 0);

  if (!removed) {
    return { removed: false, settingsPath: SETTINGS_PATH, backupPath: null };
  }

  const backupPath = backupSettings();

  const nextHooks = { ...(settings.hooks || {}) };
  if (nextGroups.length > 0) {
    nextHooks[HOOK_EVENT] = nextGroups;
  } else {
    delete nextHooks[HOOK_EVENT];
  }

  const nextSettings = { ...settings };
  if (Object.keys(nextHooks).length > 0) {
    nextSettings.hooks = nextHooks;
  } else {
    delete nextSettings.hooks;
  }

  writeSettings(nextSettings);
  return { removed: true, settingsPath: SETTINGS_PATH, backupPath };
}

// ---------------------------------------------------------------------------
// Multi-hook API — manage SessionStart / PreToolUse / SessionEnd together.
// ---------------------------------------------------------------------------

/** Broad "ours" detection across all managed events (incl. the legacy script). */
function isOurMultiCommand(command) {
  return (
    typeof command === 'string' && OUR_COMMAND_MARKERS.some((marker) => command.includes(marker))
  );
}

/** Return hooks[event] as an array (empty when absent or malformed). */
function getGroupsForEvent(settings, event) {
  const hooks = settings.hooks || {};
  const groups = hooks[event];
  return Array.isArray(groups) ? groups : [];
}

/** Build the hook group we append for a given event. */
function buildGroupForEvent(event, command) {
  const hookEntry = { type: 'command', command };
  if (event === 'SessionStart') {
    return { matcher: SESSION_START_MATCHER, hooks: [hookEntry] };
  }
  if (event === 'PreToolUse') {
    return { matcher: DEFAULT_MATCHER, hooks: [hookEntry] };
  }
  // SessionEnd — no matcher.
  return { hooks: [hookEntry] };
}

/** Does an event already contain a group running exactly this command? */
function commandPresentForEvent(settings, event, command) {
  return getGroupsForEvent(settings, event).some(
    (group) =>
      Array.isArray(group.hooks) &&
      group.hooks.some((h) => h && h.type === 'command' && h.command === command)
  );
}

/**
 * Idempotently install our hooks across the managed events.
 * @param {{ SessionStart?: string, PreToolUse?: string, SessionEnd?: string }} map
 * @returns {{ settingsPath: string, backupPath: string|null, alreadyPresent: boolean }}
 *   alreadyPresent is true only when every requested hook was already present.
 */
function installHooks(map) {
  if (!map || typeof map !== 'object') {
    throw new Error('installHooks requires a map of { event: command } entries.');
  }

  const settings = readSettings();
  const events = MULTI_HOOK_EVENTS.filter((event) =>
    Object.prototype.hasOwnProperty.call(map, event)
  );

  const toAdd = events.filter((event) => {
    const command = map[event];
    if (!command || typeof command !== 'string') {
      throw new Error(`installHooks: command for ${event} must be a non-empty string.`);
    }
    return !commandPresentForEvent(settings, event, command);
  });

  if (toAdd.length === 0) {
    return { settingsPath: SETTINGS_PATH, backupPath: null, alreadyPresent: true };
  }

  const backupPath = backupSettings();

  const nextHooks = { ...(settings.hooks || {}) };
  toAdd.forEach((event) => {
    const groups = getGroupsForEvent(settings, event).slice();
    groups.push(buildGroupForEvent(event, map[event]));
    nextHooks[event] = groups;
  });

  const nextSettings = { ...settings, hooks: nextHooks };
  writeSettings(nextSettings);

  return { settingsPath: SETTINGS_PATH, backupPath, alreadyPresent: false };
}

/**
 * Remove all of our hook entries across the managed events. Prunes emptied
 * groups, emptied event arrays, and an emptied `hooks` key. Also removes the
 * legacy single PreToolUse check-session-telegram.sh entry.
 * @returns {{ removed: boolean, settingsPath: string, backupPath: string|null }}
 */
function removeHooks() {
  if (!fs.existsSync(SETTINGS_PATH)) {
    return { removed: false, settingsPath: SETTINGS_PATH, backupPath: null };
  }

  const settings = readSettings();
  if (!settings.hooks || typeof settings.hooks !== 'object') {
    return { removed: false, settingsPath: SETTINGS_PATH, backupPath: null };
  }

  let removed = false;
  const nextHooks = { ...settings.hooks };

  MULTI_HOOK_EVENTS.forEach((event) => {
    const groups = getGroupsForEvent(settings, event);
    if (groups.length === 0) {
      return;
    }

    const nextGroups = groups
      .map((group) => {
        if (!Array.isArray(group.hooks)) {
          return group;
        }
        const filtered = group.hooks.filter((h) => {
          const isOurs = h && h.type === 'command' && isOurMultiCommand(h.command);
          if (isOurs) {
            removed = true;
          }
          return !isOurs;
        });
        return { ...group, hooks: filtered };
      })
      // Drop groups whose hooks list is now empty.
      .filter((group) => !Array.isArray(group.hooks) || group.hooks.length > 0);

    if (nextGroups.length > 0) {
      nextHooks[event] = nextGroups;
    } else {
      delete nextHooks[event];
    }
  });

  if (!removed) {
    return { removed: false, settingsPath: SETTINGS_PATH, backupPath: null };
  }

  const backupPath = backupSettings();

  const nextSettings = { ...settings };
  if (Object.keys(nextHooks).length > 0) {
    nextSettings.hooks = nextHooks;
  } else {
    delete nextSettings.hooks;
  }

  writeSettings(nextSettings);
  return { removed: true, settingsPath: SETTINGS_PATH, backupPath };
}

/** True when any of our commands is present in any managed event. */
function hasHooks() {
  let settings;
  try {
    settings = readSettings();
  } catch (_err) {
    return false;
  }
  return MULTI_HOOK_EVENTS.some((event) =>
    getGroupsForEvent(settings, event).some(
      (group) =>
        Array.isArray(group.hooks) &&
        group.hooks.some((h) => h && h.type === 'command' && isOurMultiCommand(h.command))
    )
  );
}

module.exports = {
  SETTINGS_PATH,
  readSettings,
  backupSettings,
  installHook,
  removeHook,
  hasHook,
  previewHook,
  installHooks,
  removeHooks,
  hasHooks,
};

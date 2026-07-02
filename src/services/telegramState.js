'use strict';

/**
 * telegramState.js — CLI-side access to the shared session-lock state.
 *
 * The authoritative store is a SINGLE pinned message in the Telegram group whose
 * text is `<header>\n<json>`. The standalone hook runtime (src/hooks/runner.js)
 * reads/writes the same message with Node built-ins; this module mirrors that
 * format using axios so CLI commands (init, status) can create and display it.
 *
 * IMPORTANT: keep STATE_HEADER and the parse/serialize rules byte-compatible
 * with src/hooks/runner.js.
 */

const axios = require('axios');

const STATE_HEADER = '🔒 Claude session locks (auto — do not edit)';
const REQUEST_TIMEOUT_MS = 10000;

function apiUrl(token, method) {
  return `https://api.telegram.org/bot${token}/${method}`;
}

/** Extract a { v, accounts } object from a pinned message's text, or null. */
function parseStateText(text) {
  if (!text) return null;
  const i = text.indexOf('{');
  if (i < 0) return null;
  try {
    const o = JSON.parse(text.slice(i));
    if (o && typeof o === 'object' && o.accounts) return o;
  } catch (_e) {
    /* not our state message */
  }
  return null;
}

/** Serialize state to the pinned-message text form. */
function stateText(state) {
  return `${STATE_HEADER}\n${JSON.stringify(state)}`;
}

function friendlyError(err, fallback) {
  const desc = err && err.response && err.response.data && err.response.data.description;
  return new Error(desc ? `${fallback}: ${desc}` : `${fallback}: ${err.message}`);
}

/**
 * Read the shared state from the group's pinned message.
 * @param {object} config { botToken, groupId, stateMessageId? }
 * @returns {Promise<{ state: {v:number, accounts:object}, messageId: number|null }>}
 */
async function readState(config) {
  let res;
  try {
    res = await axios.get(apiUrl(config.botToken, 'getChat'), {
      params: { chat_id: config.groupId },
      timeout: REQUEST_TIMEOUT_MS,
    });
  } catch (err) {
    throw friendlyError(err, 'Could not read shared state (getChat failed)');
  }
  const pinned = res.data && res.data.result && res.data.result.pinned_message;
  if (pinned && pinned.text) {
    const parsed = parseStateText(pinned.text);
    if (parsed) return { state: parsed, messageId: pinned.message_id };
  }
  return { state: { v: 1, accounts: {} }, messageId: config.stateMessageId || null };
}

/**
 * Overwrite the pinned state message (or create+pin one if missing).
 * @returns {Promise<number>} the message id used
 */
async function writeState(config, state, messageId) {
  const text = stateText(state);
  if (messageId) {
    try {
      await axios.post(
        apiUrl(config.botToken, 'editMessageText'),
        { chat_id: config.groupId, message_id: messageId, text },
        { timeout: REQUEST_TIMEOUT_MS }
      );
      return messageId;
    } catch (err) {
      const desc = err.response && err.response.data && err.response.data.description;
      if (desc && desc.includes('not modified')) return messageId;
      // fall through to (re)create
    }
  }
  return createAndPin(config, text);
}

async function createAndPin(config, text) {
  let sent;
  try {
    sent = await axios.post(
      apiUrl(config.botToken, 'sendMessage'),
      { chat_id: config.groupId, text, disable_notification: true },
      { timeout: REQUEST_TIMEOUT_MS }
    );
  } catch (err) {
    throw friendlyError(err, 'Could not create the shared-state message');
  }
  const messageId = sent.data && sent.data.result && sent.data.result.message_id;
  try {
    await axios.post(
      apiUrl(config.botToken, 'pinChatMessage'),
      { chat_id: config.groupId, message_id: messageId, disable_notification: true },
      { timeout: REQUEST_TIMEOUT_MS }
    );
  } catch (err) {
    throw friendlyError(
      err,
      'Created the state message but could not PIN it — make the bot an Admin with the "Pin Messages" permission'
    );
  }
  return messageId;
}

/**
 * Pin one arbitrary line/message of text onto the group.
 *
 * By default the currently pinned message is edited in place (keeps the same
 * message id, so the hook keeps reading the same message). When nothing is
 * pinned, the pinned message is not editable by this bot, or `forceNew` is
 * set, a fresh message is sent and pinned instead.
 *
 * @param {object} config { botToken, groupId }
 * @param {string} text the exact text to pin (verbatim, no header added)
 * @param {{ forceNew?: boolean }} [options]
 * @returns {Promise<{ messageId: number, mode: 'edited'|'created' }>}
 */
async function pinText(config, text, options = {}) {
  if (!options.forceNew) {
    let res;
    try {
      res = await axios.get(apiUrl(config.botToken, 'getChat'), {
        params: { chat_id: config.groupId },
        timeout: REQUEST_TIMEOUT_MS,
      });
    } catch (err) {
      throw friendlyError(err, 'Could not read the group (getChat failed)');
    }
    const pinned = res.data && res.data.result && res.data.result.pinned_message;
    if (pinned && pinned.message_id) {
      try {
        await axios.post(
          apiUrl(config.botToken, 'editMessageText'),
          { chat_id: config.groupId, message_id: pinned.message_id, text },
          { timeout: REQUEST_TIMEOUT_MS }
        );
        return { messageId: pinned.message_id, mode: 'edited' };
      } catch (err) {
        const desc = err.response && err.response.data && err.response.data.description;
        if (desc && desc.includes('not modified')) {
          return { messageId: pinned.message_id, mode: 'edited' };
        }
        // Pinned message is not editable by this bot → create + pin a fresh one.
      }
    }
  }
  const messageId = await createAndPin(config, text);
  return { messageId, mode: 'created' };
}

/**
 * Ensure a GENUINELY pinned state message exists. Returns its message id.
 *
 * Only a message actually returned by getChat.pinned_message counts — a stale
 * config.stateMessageId is NOT trusted, because an unpinned message cannot be
 * read back (the Bot API has no getMessage). When nothing is pinned, this
 * creates + pins a fresh state message, which throws a clear "Pin Messages"
 * error if the bot is not an Admin with pin rights (the core requirement).
 * @returns {Promise<number>}
 */
async function ensureStateMessage(config) {
  let res;
  try {
    res = await axios.get(apiUrl(config.botToken, 'getChat'), {
      params: { chat_id: config.groupId },
      timeout: REQUEST_TIMEOUT_MS,
    });
  } catch (err) {
    throw friendlyError(err, 'Could not read the group (getChat failed)');
  }
  const pinned = res.data && res.data.result && res.data.result.pinned_message;
  if (pinned && parseStateText(pinned.text)) {
    return pinned.message_id;
  }
  // Nothing usable is pinned → create + pin one (throws if the bot can't pin).
  return createAndPin(config, stateText({ v: 1, accounts: {} }));
}

module.exports = {
  STATE_HEADER,
  parseStateText,
  stateText,
  readState,
  writeState,
  pinText,
  ensureStateMessage,
};

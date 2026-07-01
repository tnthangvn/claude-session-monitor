'use strict';

/**
 * Telegram Bot API service.
 * Wraps axios calls to the Telegram Bot API and surfaces user-friendly errors.
 */

const axios = require('axios');

const API_BASE = 'https://api.telegram.org';
const REQUEST_TIMEOUT_MS = 10000;
const MAX_ATTEMPTS = 3;
// Exponential backoff delays (ms) applied BEFORE the 2nd and 3rd attempts.
const BACKOFF_DELAYS_MS = [300, 900];

/**
 * Build the Telegram Bot API URL for a given token + method.
 * @param {string} token
 * @param {string} method
 * @returns {string}
 */
function apiUrl(token, method) {
  return `${API_BASE}/bot${token}/${method}`;
}

/**
 * Sleep helper for backoff.
 * @param {number} ms
 * @returns {Promise<void>}
 */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Extract the most helpful message from an axios error.
 * Prefers Telegram's `description` field when present.
 * @param {Error} error
 * @returns {string}
 */
function describeAxiosError(error) {
  if (error && error.response && error.response.data && error.response.data.description) {
    return String(error.response.data.description);
  }
  if (error && error.code) {
    return `${error.code}${error.message ? ` - ${error.message}` : ''}`;
  }
  return error && error.message ? error.message : 'Unknown error';
}

/**
 * Determine whether an axios error is worth retrying
 * (network failure, timeout, or 5xx from Telegram).
 * @param {Error} error
 * @returns {boolean}
 */
function isRetryableError(error) {
  // No response => network / timeout / DNS error => retryable.
  if (!error || !error.response) {
    return true;
  }
  const status = error.response.status;
  return typeof status === 'number' && status >= 500 && status < 600;
}

/**
 * Verify a bot token by calling getMe.
 * @param {string} botToken
 * @returns {Promise<object>} the bot info (response.data.result)
 * @throws {Error} friendly error on failure
 */
async function getBotInfo(botToken) {
  try {
    const response = await axios.get(apiUrl(botToken, 'getMe'), {
      timeout: REQUEST_TIMEOUT_MS,
    });
    return response.data.result;
  } catch (error) {
    throw new Error(`Invalid bot token or network error: ${describeAxiosError(error)}`);
  }
}

/**
 * Verify that the token is valid AND that the bot can reach the group.
 * Uses getChat (does not spam the group with a message).
 * @param {string} botToken
 * @param {string} groupId
 * @returns {Promise<{ ok: true, bot: object, chat: object }>}
 * @throws {Error} friendly error explaining the likely cause
 */
async function testConnection(botToken, groupId) {
  let bot;
  try {
    const meResponse = await axios.get(apiUrl(botToken, 'getMe'), {
      timeout: REQUEST_TIMEOUT_MS,
    });
    bot = meResponse.data.result;
  } catch (error) {
    throw new Error(
      `Invalid bot token or network error: ${describeAxiosError(error)}`
    );
  }

  try {
    const chatResponse = await axios.get(apiUrl(botToken, 'getChat'), {
      params: { chat_id: groupId },
      timeout: REQUEST_TIMEOUT_MS,
    });
    const chat = chatResponse.data.result;
    return { ok: true, bot, chat };
  } catch (error) {
    const detail = describeAxiosError(error);
    throw new Error(
      `Could not reach group "${groupId}": ${detail}. ` +
        'Likely causes: the bot is not a member of the group, the group ID is wrong ' +
        '(remember supergroup IDs start with -100), or the bot lacks permission to read the chat.'
    );
  }
}

/**
 * Send a message to the configured group, with retry + exponential backoff.
 * @param {object} config config object (uses config.groupId)
 * @param {string} text HTML-formatted message text
 * @param {object} [opts] extra sendMessage fields (merged in / override defaults)
 * @returns {Promise<object>} response.data
 * @throws {Error} friendly error on repeated failure
 */
async function sendMessage(config, text, opts = {}) {
  const payload = {
    chat_id: config.groupId,
    text,
    parse_mode: 'HTML',
    ...opts,
  };

  let lastError;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
    if (attempt > 0) {
      const delay = BACKOFF_DELAYS_MS[attempt - 1] || BACKOFF_DELAYS_MS[BACKOFF_DELAYS_MS.length - 1];
      await sleep(delay);
    }
    try {
      const response = await axios.post(apiUrl(config.botToken, 'sendMessage'), payload, {
        timeout: REQUEST_TIMEOUT_MS,
      });
      return response.data;
    } catch (error) {
      lastError = error;
      if (!isRetryableError(error) || attempt === MAX_ATTEMPTS - 1) {
        break;
      }
    }
  }

  throw new Error(`Failed to send Telegram message: ${describeAxiosError(lastError)}`);
}

/**
 * Send a message carrying an inline keyboard with approve / deny buttons.
 * @param {object} config config object
 * @param {{ requestId: string, machine: string, ip?: string }} params
 * @returns {Promise<object>} response.data
 */
async function sendApprovalPrompt(config, { requestId, machine, ip }) {
  const lines = [
    '🔐 <b>Session approval requested</b>',
    `<b>Machine:</b> ${machine}`,
  ];
  if (ip) {
    lines.push(`<b>IP:</b> ${ip}`);
  }
  lines.push(`<b>Request ID:</b> <code>${requestId}</code>`);

  const inlineKeyboard = {
    inline_keyboard: [
      [
        { text: '✅ Approve', callback_data: `approve_${requestId}_${machine}` },
        { text: '❌ Deny', callback_data: `deny_${requestId}_${machine}` },
      ],
    ],
  };

  return sendMessage(config, lines.join('\n'), {
    reply_markup: inlineKeyboard,
  });
}

module.exports = {
  getBotInfo,
  testConnection,
  sendMessage,
  sendApprovalPrompt,
};

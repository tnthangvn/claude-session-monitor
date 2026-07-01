'use strict';

/**
 * Pure validation helpers for session-monitor configuration.
 * No side effects, no I/O.
 */

// Telegram bot token: numeric bot id, ':', then a long secret.
const BOT_TOKEN_REGEX = /^\d{6,}:[A-Za-z0-9_-]{30,}$/;

// Telegram group ids are negative integers.
const GROUP_ID_REGEX = /^-\d+$/;

const MIN_TIMEOUT = 10;
const MAX_TIMEOUT = 86400;

/**
 * Validate a Telegram bot token.
 * @param {*} token
 * @returns {boolean}
 */
function isValidBotToken(token) {
  if (typeof token !== 'string') {
    return false;
  }
  return BOT_TOKEN_REGEX.test(token.trim());
}

/**
 * Validate a Telegram group id (negative integer as string or number).
 * @param {*} id
 * @returns {boolean}
 */
function isValidGroupId(id) {
  if (id === null || id === undefined) {
    return false;
  }
  if (typeof id !== 'string' && typeof id !== 'number') {
    return false;
  }
  return GROUP_ID_REGEX.test(String(id).trim());
}

/**
 * Validate a timeout in seconds: integer between 10 and 86400 inclusive.
 * @param {*} n
 * @returns {boolean}
 */
function isValidTimeout(n) {
  if (typeof n !== 'number' || !Number.isInteger(n)) {
    return false;
  }
  return n >= MIN_TIMEOUT && n <= MAX_TIMEOUT;
}

/**
 * Normalize a group id to a trimmed string.
 * @param {*} id
 * @returns {string}
 */
function normalizeGroupId(id) {
  return String(id).trim();
}

module.exports = {
  isValidBotToken,
  isValidGroupId,
  isValidTimeout,
  normalizeGroupId,
};

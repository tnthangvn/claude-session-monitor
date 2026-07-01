'use strict';

/**
 * Pure formatting helpers for display of tokens, durations, and timestamps.
 * No side effects, no I/O.
 */

const MASK_PREFIX_LEN = 6;
const MASK_SUFFIX_LEN = 4;

const SECONDS_PER_HOUR = 3600;
const SECONDS_PER_MINUTE = 60;

const MS_THRESHOLD = 1e12; // epoch values >= this are treated as milliseconds

/**
 * Mask a secret token, showing the first 6 and last 4 characters.
 * Handles short and empty values safely.
 * @param {*} token
 * @returns {string}
 */
function maskToken(token) {
  if (typeof token !== 'string' || token.length === 0) {
    return '';
  }
  // Too short to reveal both ends without overlap: mask everything.
  if (token.length <= MASK_PREFIX_LEN + MASK_SUFFIX_LEN) {
    return '*'.repeat(token.length);
  }
  const prefix = token.slice(0, MASK_PREFIX_LEN);
  const suffix = token.slice(-MASK_SUFFIX_LEN);
  return `${prefix}...${suffix}`;
}

/**
 * Format a duration in seconds as a human-readable string, e.g. "2h 5m 3s".
 * Zero and negative values return "0s".
 * @param {number} seconds
 * @returns {string}
 */
function formatDuration(seconds) {
  const total = Number(seconds);
  if (!Number.isFinite(total) || total <= 0) {
    return '0s';
  }

  const whole = Math.floor(total);
  const hours = Math.floor(whole / SECONDS_PER_HOUR);
  const minutes = Math.floor((whole % SECONDS_PER_HOUR) / SECONDS_PER_MINUTE);
  const secs = whole % SECONDS_PER_MINUTE;

  const parts = [];
  if (hours > 0) {
    parts.push(`${hours}h`);
  }
  if (minutes > 0) {
    parts.push(`${minutes}m`);
  }
  if (secs > 0 || parts.length === 0) {
    parts.push(`${secs}s`);
  }

  return parts.join(' ');
}

/**
 * Coerce a variety of inputs into a Date, or null if not parseable.
 * Accepts Date | ISO string | epoch seconds/ms.
 * @param {*} value
 * @returns {Date|null}
 */
function toDate(value) {
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value;
  }

  if (typeof value === 'number' && Number.isFinite(value)) {
    // Heuristic: small numbers are epoch seconds, large are milliseconds.
    const ms = value >= MS_THRESHOLD ? value : value * 1000;
    const date = new Date(ms);
    return Number.isNaN(date.getTime()) ? null : date;
  }

  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (trimmed === '') {
      return null;
    }
    // Numeric string → treat as epoch.
    if (/^\d+$/.test(trimmed)) {
      return toDate(Number(trimmed));
    }
    const date = new Date(trimmed);
    return Number.isNaN(date.getTime()) ? null : date;
  }

  return null;
}

/**
 * Format a timestamp into a readable local string. Defensive: returns a
 * safe fallback for unparseable input.
 * @param {Date|string|number} dateOrIsoOrEpoch
 * @returns {string}
 */
function formatTimestamp(dateOrIsoOrEpoch) {
  const date = toDate(dateOrIsoOrEpoch);
  if (!date) {
    return 'Invalid date';
  }
  return date.toLocaleString();
}

module.exports = {
  maskToken,
  formatDuration,
  formatTimestamp,
};

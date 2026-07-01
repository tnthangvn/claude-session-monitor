'use strict';

/**
 * Unit tests for src/utils/formatters.js — pure functions, no I/O.
 * Timestamp assertions compare against the module-independent
 * `Date#toLocaleString()` so they stay timezone-agnostic.
 */

const {
  maskToken,
  formatDuration,
  formatTimestamp,
} = require('../src/utils/formatters');

describe('maskToken', () => {
  test('shows first 6 and last 4 chars of a long token', () => {
    // Arrange
    const token = '123456789:ABCDEFGHIJKLMNOP';

    // Act
    const masked = maskToken(token);

    // Assert
    expect(masked).toBe('123456...MNOP');
  });

  test('masks a token that is exactly 10 chars entirely', () => {
    expect(maskToken('0123456789')).toBe('**********');
  });

  test('masks a short token entirely with same-length asterisks', () => {
    expect(maskToken('abc')).toBe('***');
  });

  test('returns empty string for empty input', () => {
    expect(maskToken('')).toBe('');
  });

  test('returns empty string for non-string input', () => {
    expect(maskToken(null)).toBe('');
    expect(maskToken(undefined)).toBe('');
    expect(maskToken(1234567890)).toBe('');
  });

  test('reveals both ends once longer than the mask window', () => {
    expect(maskToken('abcdefghijk')).toBe('abcdef...hijk');
  });
});

describe('formatDuration', () => {
  test('returns "0s" for zero', () => {
    expect(formatDuration(0)).toBe('0s');
  });

  test('returns "0s" for negative values', () => {
    expect(formatDuration(-5)).toBe('0s');
  });

  test('returns "0s" for non-finite values', () => {
    expect(formatDuration(NaN)).toBe('0s');
    expect(formatDuration(Infinity)).toBe('0s');
  });

  test('formats seconds only', () => {
    expect(formatDuration(45)).toBe('45s');
  });

  test('formats whole minutes without a seconds part', () => {
    expect(formatDuration(60)).toBe('1m');
  });

  test('formats minutes and seconds', () => {
    expect(formatDuration(125)).toBe('2m 5s');
  });

  test('formats whole hours only', () => {
    expect(formatDuration(3600)).toBe('1h');
  });

  test('formats hours, minutes and seconds', () => {
    expect(formatDuration(3661)).toBe('1h 1m 1s');
  });

  test('floors fractional seconds', () => {
    expect(formatDuration(45.9)).toBe('45s');
  });

  test('coerces a numeric string', () => {
    expect(formatDuration('60')).toBe('1m');
  });
});

describe('formatTimestamp', () => {
  test('formats a Date instance', () => {
    const date = new Date('2026-07-01T12:00:00Z');
    expect(formatTimestamp(date)).toBe(date.toLocaleString());
  });

  test('formats an ISO string', () => {
    const iso = '2026-07-01T12:00:00Z';
    expect(formatTimestamp(iso)).toBe(new Date(iso).toLocaleString());
  });

  test('treats a small number as epoch seconds', () => {
    const epochSeconds = 1000000000; // < 1e12 -> seconds
    expect(formatTimestamp(epochSeconds)).toBe(
      new Date(epochSeconds * 1000).toLocaleString()
    );
  });

  test('treats a large number as epoch milliseconds', () => {
    const epochMs = 1600000000000; // >= 1e12 -> milliseconds
    expect(formatTimestamp(epochMs)).toBe(new Date(epochMs).toLocaleString());
  });

  test('treats a numeric string as an epoch value', () => {
    expect(formatTimestamp('1000000000')).toBe(
      new Date(1000000000 * 1000).toLocaleString()
    );
  });

  test('returns "Invalid date" for an unparseable string', () => {
    expect(formatTimestamp('not-a-date')).toBe('Invalid date');
  });

  test('returns "Invalid date" for an empty string', () => {
    expect(formatTimestamp('   ')).toBe('Invalid date');
  });

  test('returns "Invalid date" for null and undefined', () => {
    expect(formatTimestamp(null)).toBe('Invalid date');
    expect(formatTimestamp(undefined)).toBe('Invalid date');
  });

  test('returns "Invalid date" for an invalid Date instance', () => {
    expect(formatTimestamp(new Date('nonsense'))).toBe('Invalid date');
  });
});

'use strict';

/**
 * Unit tests for src/utils/validators.js — pure functions, no I/O.
 * AAA (Arrange-Act-Assert) structure throughout.
 */

const {
  isValidBotToken,
  isValidGroupId,
  isValidTimeout,
  normalizeGroupId,
} = require('../src/utils/validators');

// A syntactically valid Telegram bot token: 9-digit id, ':', 36-char secret.
const VALID_TOKEN = '123456789:ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';

describe('isValidBotToken', () => {
  test('accepts a well-formed bot token', () => {
    expect(isValidBotToken(VALID_TOKEN)).toBe(true);
  });

  test('accepts a token with surrounding whitespace (trimmed)', () => {
    expect(isValidBotToken(`   ${VALID_TOKEN}   `)).toBe(true);
  });

  test('accepts tokens whose secret uses underscores and hyphens', () => {
    expect(isValidBotToken('987654321:AA-bb_cc-dd_ee-ff_gg-hh_ii-jj_kk-ll')).toBe(true);
  });

  test('rejects a token with too few id digits', () => {
    expect(isValidBotToken('12345:ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789')).toBe(false);
  });

  test('rejects a token whose secret is too short', () => {
    expect(isValidBotToken('123456789:ABC')).toBe(false);
  });

  test('rejects a token with no colon separator', () => {
    expect(isValidBotToken('123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789')).toBe(false);
  });

  test('rejects an empty string', () => {
    expect(isValidBotToken('')).toBe(false);
  });

  test('rejects non-string inputs', () => {
    expect(isValidBotToken(null)).toBe(false);
    expect(isValidBotToken(undefined)).toBe(false);
    expect(isValidBotToken(123456789)).toBe(false);
    expect(isValidBotToken({ token: VALID_TOKEN })).toBe(false);
  });
});

describe('isValidGroupId', () => {
  test('accepts a negative integer string', () => {
    expect(isValidGroupId('-1001234567890')).toBe(true);
  });

  test('accepts a negative integer number', () => {
    expect(isValidGroupId(-100)).toBe(true);
  });

  test('accepts a negative id with surrounding whitespace', () => {
    expect(isValidGroupId('  -100  ')).toBe(true);
  });

  test('rejects a positive number', () => {
    expect(isValidGroupId('100')).toBe(false);
    expect(isValidGroupId(100)).toBe(false);
  });

  test('rejects a non-integer negative value', () => {
    expect(isValidGroupId('-12.5')).toBe(false);
  });

  test('rejects null and undefined', () => {
    expect(isValidGroupId(null)).toBe(false);
    expect(isValidGroupId(undefined)).toBe(false);
  });

  test('rejects non-string, non-number types', () => {
    expect(isValidGroupId({})).toBe(false);
    expect(isValidGroupId(true)).toBe(false);
    expect(isValidGroupId(['-100'])).toBe(false);
  });

  test('rejects a non-numeric string', () => {
    expect(isValidGroupId('abc')).toBe(false);
  });
});

describe('isValidTimeout', () => {
  test('accepts the minimum boundary (10)', () => {
    expect(isValidTimeout(10)).toBe(true);
  });

  test('accepts the maximum boundary (86400)', () => {
    expect(isValidTimeout(86400)).toBe(true);
  });

  test('accepts a typical value', () => {
    expect(isValidTimeout(300)).toBe(true);
  });

  test('rejects values below the minimum', () => {
    expect(isValidTimeout(9)).toBe(false);
  });

  test('rejects values above the maximum', () => {
    expect(isValidTimeout(86401)).toBe(false);
  });

  test('rejects non-integer numbers', () => {
    expect(isValidTimeout(10.5)).toBe(false);
  });

  test('rejects NaN and non-number types', () => {
    expect(isValidTimeout(NaN)).toBe(false);
    expect(isValidTimeout('300')).toBe(false);
    expect(isValidTimeout(null)).toBe(false);
  });
});

describe('normalizeGroupId', () => {
  test('stringifies a numeric id', () => {
    expect(normalizeGroupId(-100)).toBe('-100');
  });

  test('trims surrounding whitespace from a string id', () => {
    expect(normalizeGroupId('  -1001234567890  ')).toBe('-1001234567890');
  });

  test('returns a trimmed string unchanged when already clean', () => {
    expect(normalizeGroupId('-42')).toBe('-42');
  });
});

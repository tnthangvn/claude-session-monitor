'use strict';

/**
 * File-based configuration persistence for session-monitor.
 *
 * The Telegram bot token is encrypted at rest using AES-256-GCM. The
 * encryption key is generated once (32 random bytes) and stored at
 * SECRET_PATH with mode 0600. config.json stores the token as an object
 * { iv, tag, data } (all base64) rather than plaintext.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const CONFIG_DIR = path.join(os.homedir(), '.claude', 'session-monitor');
const CONFIG_PATH = path.join(CONFIG_DIR, 'config.json');
const HISTORY_PATH = path.join(CONFIG_DIR, 'history.log');
const SECRET_PATH = path.join(CONFIG_DIR, '.secret');

const DEFAULT_TIMEOUT = 600;

// Encryption parameters.
const ALGORITHM = 'aes-256-gcm';
const KEY_BYTES = 32;
const IV_BYTES = 12; // 96-bit nonce is standard for GCM.

// File permission modes.
const DIR_MODE = 0o700;
const FILE_MODE = 0o600;

/**
 * Ensure CONFIG_DIR exists with restrictive permissions.
 */
function ensureConfigDir() {
  fs.mkdirSync(CONFIG_DIR, { recursive: true, mode: DIR_MODE });
}

/**
 * Load the encryption key, generating and persisting it on first use.
 * @returns {Buffer} 32-byte key
 */
function ensureKey() {
  ensureConfigDir();
  if (fs.existsSync(SECRET_PATH)) {
    const key = fs.readFileSync(SECRET_PATH);
    if (key.length === KEY_BYTES) {
      return key;
    }
    // Corrupt/short key: regenerate rather than fail hard on save.
  }
  const key = crypto.randomBytes(KEY_BYTES);
  fs.writeFileSync(SECRET_PATH, key, { mode: FILE_MODE });
  return key;
}

/**
 * Read the existing encryption key. Throws if it is missing or invalid,
 * since decryption cannot proceed without it.
 * @returns {Buffer}
 */
function readKey() {
  if (!fs.existsSync(SECRET_PATH)) {
    throw new Error('Encryption key is missing; cannot decrypt config.');
  }
  const key = fs.readFileSync(SECRET_PATH);
  if (key.length !== KEY_BYTES) {
    throw new Error('Encryption key is corrupt; expected 32 bytes.');
  }
  return key;
}

/**
 * Encrypt a plaintext string with AES-256-GCM.
 * @param {string} plaintext
 * @param {Buffer} key
 * @returns {{ iv: string, tag: string, data: string }}
 */
function encryptToken(plaintext, key) {
  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  const encrypted = Buffer.concat([
    cipher.update(String(plaintext), 'utf8'),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();
  return {
    iv: iv.toString('base64'),
    tag: tag.toString('base64'),
    data: encrypted.toString('base64'),
  };
}

/**
 * Decrypt a { iv, tag, data } object back to plaintext.
 * @param {{ iv: string, tag: string, data: string }} payload
 * @param {Buffer} key
 * @returns {string}
 */
function decryptToken(payload, key) {
  if (!payload || typeof payload !== 'object') {
    throw new Error('Encrypted token is missing or malformed.');
  }
  const { iv, tag, data } = payload;
  if (!iv || !tag || !data) {
    throw new Error('Encrypted token is incomplete.');
  }
  const decipher = crypto.createDecipheriv(
    ALGORITHM,
    key,
    Buffer.from(iv, 'base64')
  );
  decipher.setAuthTag(Buffer.from(tag, 'base64'));
  const decrypted = Buffer.concat([
    decipher.update(Buffer.from(data, 'base64')),
    decipher.final(),
  ]);
  return decrypted.toString('utf8');
}

/**
 * Whether config.json exists on disk.
 * @returns {boolean}
 */
function configExists() {
  return fs.existsSync(CONFIG_PATH);
}

/**
 * Load the config, decrypting the bot token to plaintext.
 * @returns {object} config with plaintext botToken
 */
function loadConfig() {
  if (!configExists()) {
    throw new Error(`Config not found at ${CONFIG_PATH}. Run setup first.`);
  }

  let raw;
  try {
    raw = fs.readFileSync(CONFIG_PATH, 'utf8');
  } catch (err) {
    throw new Error(`Unable to read config file: ${err.message}`);
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`Config file is corrupt: ${err.message}`);
  }

  const key = readKey();

  let botToken;
  try {
    botToken = decryptToken(parsed.botToken, key);
  } catch (err) {
    throw new Error(`Config file is corrupt: ${err.message}`);
  }

  return Object.assign({}, parsed, { botToken });
}

/**
 * Persist config, encrypting the bot token at rest.
 * Does not mutate the caller's object.
 * @param {object} config
 * @returns {string} the path written
 */
function saveConfig(config) {
  if (!config || typeof config !== 'object') {
    throw new Error('saveConfig requires a config object.');
  }

  ensureConfigDir();
  const key = ensureKey();

  const encrypted = encryptToken(config.botToken, key);
  const toWrite = Object.assign({}, config, { botToken: encrypted });

  try {
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(toWrite, null, 2), {
      mode: FILE_MODE,
    });
  } catch (err) {
    throw new Error(`Unable to write config file: ${err.message}`);
  }

  return CONFIG_PATH;
}

/**
 * Append a tab-separated history line. Best-effort; never throws.
 * @param {string} event
 * @param {string} machine
 * @param {string} detail
 * @returns {boolean} success
 */
function appendHistory(event, machine, detail) {
  try {
    ensureConfigDir();
    const ts = new Date().toISOString();
    const safe = (v) => String(v === undefined || v === null ? '' : v)
      .replace(/[\t\n\r]/g, ' ');
    const line = `${ts}\t${safe(event)}\t${safe(machine)}\t${safe(detail)}\n`;
    fs.appendFileSync(HISTORY_PATH, line);
    return true;
  } catch (err) {
    return false;
  }
}

/**
 * Read parsed history rows, newest last. Optional limit returns last N.
 * @param {number} [limit]
 * @returns {Array<{ ts: string, event: string, machine: string, detail: string }>}
 */
function readHistory(limit) {
  if (!fs.existsSync(HISTORY_PATH)) {
    return [];
  }

  let raw;
  try {
    raw = fs.readFileSync(HISTORY_PATH, 'utf8');
  } catch (err) {
    return [];
  }

  const rows = raw
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => {
      const [ts, event, machine, detail] = line.split('\t');
      return {
        ts: ts || '',
        event: event || '',
        machine: machine || '',
        detail: detail || '',
      };
    });

  if (typeof limit === 'number' && limit >= 0 && limit < rows.length) {
    return rows.slice(rows.length - limit);
  }
  return rows;
}

/**
 * Remove the entire config directory.
 * @returns {boolean} success
 */
function deleteConfig() {
  try {
    fs.rmSync(CONFIG_DIR, { recursive: true, force: true });
    return true;
  } catch (err) {
    return false;
  }
}

module.exports = {
  CONFIG_DIR,
  CONFIG_PATH,
  HISTORY_PATH,
  DEFAULT_TIMEOUT,
  configExists,
  loadConfig,
  saveConfig,
  appendHistory,
  readHistory,
  deleteConfig,
};

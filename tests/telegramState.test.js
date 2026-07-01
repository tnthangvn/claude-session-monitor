'use strict';

/**
 * Unit tests for src/services/telegramState.js (the CLI-side shared-state store).
 * axios is fully mocked — no network calls.
 */

jest.mock('axios');
const axios = require('axios');
const telegramState = require('../src/services/telegramState');

const CONFIG = { botToken: '123:ABC', groupId: '-1001', stateMessageId: null };

function pinnedGetChat(text) {
  return { data: { ok: true, result: { pinned_message: { message_id: 42, text } } } };
}

beforeEach(() => {
  axios.get = jest.fn();
  axios.post = jest.fn();
});

describe('parseStateText / stateText', () => {
  test('stateText is header + JSON and roundtrips through parseStateText', () => {
    const state = { v: 1, accounts: { 'a@b.com': { machine: 'pc', ts: 5 } } };
    const text = telegramState.stateText(state);
    expect(text.startsWith(telegramState.STATE_HEADER)).toBe(true);
    expect(telegramState.parseStateText(text)).toEqual(state);
  });

  test('parseStateText returns null for non-state text', () => {
    expect(telegramState.parseStateText('no braces here')).toBeNull();
    expect(telegramState.parseStateText('header\n{not json')).toBeNull();
    expect(telegramState.parseStateText(telegramState.stateText({ v: 1 }))).toBeNull(); // no accounts key
    expect(telegramState.parseStateText('')).toBeNull();
  });
});

describe('readState', () => {
  test('parses the pinned state message and returns its id', async () => {
    const state = { v: 1, accounts: { 'x@y.com': { machine: 'm1', ts: 9 } } };
    axios.get.mockResolvedValue(pinnedGetChat(telegramState.stateText(state)));

    const result = await telegramState.readState(CONFIG);

    expect(result.messageId).toBe(42);
    expect(result.state).toEqual(state);
    expect(axios.get).toHaveBeenCalledWith(
      expect.stringContaining('/getChat'),
      expect.objectContaining({ params: { chat_id: '-1001' } })
    );
  });

  test('returns an empty state when there is no (parseable) pinned message', async () => {
    axios.get.mockResolvedValue({ data: { ok: true, result: {} } });

    const result = await telegramState.readState({ ...CONFIG, stateMessageId: 7 });

    expect(result.state).toEqual({ v: 1, accounts: {} });
    expect(result.messageId).toBe(7); // falls back to configured id
  });

  test('throws a friendly error when getChat fails', async () => {
    axios.get.mockRejectedValue({
      response: { data: { description: 'chat not found' } },
      message: 'Request failed',
    });

    await expect(telegramState.readState(CONFIG)).rejects.toThrow(/chat not found/);
  });
});

describe('writeState', () => {
  test('edits the existing pinned message and returns its id', async () => {
    axios.post.mockResolvedValue({ data: { ok: true } });

    const id = await telegramState.writeState(CONFIG, { v: 1, accounts: {} }, 42);

    expect(id).toBe(42);
    expect(axios.post).toHaveBeenCalledWith(
      expect.stringContaining('/editMessageText'),
      expect.objectContaining({ chat_id: '-1001', message_id: 42 }),
      expect.any(Object)
    );
  });

  test('treats "message is not modified" as success', async () => {
    axios.post.mockRejectedValue({
      response: { data: { description: 'Bad Request: message is not modified' } },
      message: 'x',
    });

    const id = await telegramState.writeState(CONFIG, { v: 1, accounts: {} }, 42);
    expect(id).toBe(42);
  });

  test('recreates and pins when there is no message id', async () => {
    axios.post
      .mockResolvedValueOnce({ data: { ok: true, result: { message_id: 99 } } }) // sendMessage
      .mockResolvedValueOnce({ data: { ok: true } }); // pinChatMessage

    const id = await telegramState.writeState(CONFIG, { v: 1, accounts: {} }, null);

    expect(id).toBe(99);
    expect(axios.post).toHaveBeenCalledWith(
      expect.stringContaining('/sendMessage'),
      expect.any(Object),
      expect.any(Object)
    );
    expect(axios.post).toHaveBeenCalledWith(
      expect.stringContaining('/pinChatMessage'),
      expect.objectContaining({ message_id: 99 }),
      expect.any(Object)
    );
  });

  test('surfaces a Pin-permission error when pinning fails', async () => {
    axios.post
      .mockResolvedValueOnce({ data: { ok: true, result: { message_id: 5 } } }) // sendMessage
      .mockRejectedValueOnce({
        response: { data: { description: 'not enough rights to pin' } },
        message: 'x',
      });

    await expect(
      telegramState.writeState(CONFIG, { v: 1, accounts: {} }, null)
    ).rejects.toThrow(/Pin Messages/);
  });
});

describe('ensureStateMessage', () => {
  test('returns the existing pinned message id without creating a new one', async () => {
    axios.get.mockResolvedValue(pinnedGetChat(telegramState.stateText({ v: 1, accounts: {} })));

    const id = await telegramState.ensureStateMessage(CONFIG);

    expect(id).toBe(42);
    expect(axios.post).not.toHaveBeenCalled();
  });

  test('creates + pins an empty state when none exists', async () => {
    axios.get.mockResolvedValue({ data: { ok: true, result: {} } });
    axios.post
      .mockResolvedValueOnce({ data: { ok: true, result: { message_id: 77 } } }) // sendMessage
      .mockResolvedValueOnce({ data: { ok: true } }); // pin

    const id = await telegramState.ensureStateMessage({ ...CONFIG, stateMessageId: null });

    expect(id).toBe(77);
  });
});

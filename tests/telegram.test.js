'use strict';

/**
 * Unit tests for src/services/telegram.js with axios fully mocked.
 * No network access occurs. Retry delays are short (300ms / 900ms) so the
 * retry tests run with real timers in well under the Jest default timeout.
 */

jest.mock('axios');

const axios = require('axios');
const telegram = require('../src/services/telegram');

const BOT_TOKEN = '123456789:ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
const GROUP_ID = '-1001234567890';
const CONFIG = { botToken: BOT_TOKEN, groupId: GROUP_ID };

beforeEach(() => {
  // Fresh mocks each test — resets implementation, queues and call history.
  axios.get = jest.fn();
  axios.post = jest.fn();
});

describe('getBotInfo', () => {
  test('returns the bot info on success', async () => {
    // Arrange
    const botInfo = { id: 42, is_bot: true, username: 'test_bot' };
    axios.get.mockResolvedValue({ data: { ok: true, result: botInfo } });

    // Act
    const result = await telegram.getBotInfo(BOT_TOKEN);

    // Assert
    expect(result).toEqual(botInfo);
    expect(axios.get).toHaveBeenCalledWith(
      expect.stringContaining(`/bot${BOT_TOKEN}/getMe`),
      expect.objectContaining({ timeout: expect.any(Number) })
    );
  });

  test('throws a friendly error using Telegram description', async () => {
    // Arrange
    axios.get.mockRejectedValue({ response: { data: { description: 'Unauthorized' } } });

    // Act + Assert
    await expect(telegram.getBotInfo(BOT_TOKEN)).rejects.toThrow(
      /Invalid bot token or network error: Unauthorized/
    );
  });
});

describe('testConnection', () => {
  test('returns { ok, bot, chat } when both getMe and getChat succeed', async () => {
    // Arrange
    const bot = { id: 1, username: 'test_bot' };
    const chat = { id: GROUP_ID, title: 'My Group' };
    axios.get
      .mockResolvedValueOnce({ data: { result: bot } }) // getMe
      .mockResolvedValueOnce({ data: { result: chat } }); // getChat

    // Act
    const result = await telegram.testConnection(BOT_TOKEN, GROUP_ID);

    // Assert
    expect(result).toEqual({ ok: true, bot, chat });
    expect(axios.get).toHaveBeenCalledTimes(2);
  });

  test('throws a bot-token error when getMe fails', async () => {
    axios.get.mockRejectedValue({ response: { data: { description: 'Unauthorized' } } });
    await expect(telegram.testConnection(BOT_TOKEN, GROUP_ID)).rejects.toThrow(
      /Invalid bot token or network error/
    );
  });

  test('throws a friendly group error when getChat fails', async () => {
    // Arrange — getMe succeeds, getChat fails.
    axios.get
      .mockResolvedValueOnce({ data: { result: { id: 1, username: 'test_bot' } } })
      .mockRejectedValueOnce({ response: { data: { description: 'chat not found' } } });

    // Act + Assert
    await expect(telegram.testConnection(BOT_TOKEN, GROUP_ID)).rejects.toThrow(
      new RegExp(`Could not reach group "${GROUP_ID}": chat not found`)
    );
  });
});

describe('sendMessage', () => {
  test('posts an HTML message and returns response data on success', async () => {
    // Arrange
    axios.post.mockResolvedValue({ data: { ok: true, result: { message_id: 7 } } });

    // Act
    const data = await telegram.sendMessage(CONFIG, 'hello');

    // Assert
    expect(data).toEqual({ ok: true, result: { message_id: 7 } });
    expect(axios.post).toHaveBeenCalledTimes(1);
    const [, payload] = axios.post.mock.calls[0];
    expect(payload).toEqual(
      expect.objectContaining({
        chat_id: GROUP_ID,
        text: 'hello',
        parse_mode: 'HTML',
      })
    );
  });

  test('merges extra options into the payload', async () => {
    axios.post.mockResolvedValue({ data: { ok: true } });
    await telegram.sendMessage(CONFIG, 'hi', { disable_notification: true });
    const [, payload] = axios.post.mock.calls[0];
    expect(payload.disable_notification).toBe(true);
  });

  test('retries after a 5xx error and then succeeds', async () => {
    // Arrange — first attempt fails with a retryable 502, second succeeds.
    axios.post
      .mockRejectedValueOnce({ response: { status: 502 } })
      .mockResolvedValueOnce({ data: { ok: true } });

    // Act
    const data = await telegram.sendMessage(CONFIG, 'retry me');

    // Assert
    expect(data).toEqual({ ok: true });
    expect(axios.post).toHaveBeenCalledTimes(2);
  });

  test('gives up after MAX_ATTEMPTS on repeated 5xx errors', async () => {
    // Arrange — every attempt returns a retryable 500.
    axios.post.mockRejectedValue({ response: { status: 500 } });

    // Act + Assert
    await expect(telegram.sendMessage(CONFIG, 'always fails')).rejects.toThrow(
      /Failed to send Telegram message/
    );
    expect(axios.post).toHaveBeenCalledTimes(3);
  });

  test('does not retry on a non-retryable 4xx error', async () => {
    // Arrange
    axios.post.mockRejectedValue({
      response: { status: 400, data: { description: 'Bad Request' } },
    });

    // Act + Assert
    await expect(telegram.sendMessage(CONFIG, 'bad')).rejects.toThrow(
      /Failed to send Telegram message: Bad Request/
    );
    expect(axios.post).toHaveBeenCalledTimes(1);
  });
});

describe('sendApprovalPrompt', () => {
  test('builds approve/deny callback_data with request id and machine', async () => {
    // Arrange
    axios.post.mockResolvedValue({ data: { ok: true } });

    // Act
    await telegram.sendApprovalPrompt(CONFIG, {
      requestId: 'req42',
      machine: 'laptop',
      ip: '10.0.0.1',
    });

    // Assert — inspect the payload handed to axios.post.
    const [, payload] = axios.post.mock.calls[0];
    const buttons = payload.reply_markup.inline_keyboard[0];
    expect(buttons[0].callback_data).toBe('approve_req42_laptop');
    expect(buttons[1].callback_data).toBe('deny_req42_laptop');
    expect(payload.text).toContain('laptop');
    expect(payload.text).toContain('10.0.0.1');
    expect(payload.text).toContain('req42');
  });

  test('omits the IP line when no ip is provided', async () => {
    axios.post.mockResolvedValue({ data: { ok: true } });
    await telegram.sendApprovalPrompt(CONFIG, { requestId: 'r1', machine: 'srv' });
    const [, payload] = axios.post.mock.calls[0];
    expect(payload.text).not.toContain('IP:');
    expect(payload.reply_markup.inline_keyboard[0][0].callback_data).toBe('approve_r1_srv');
  });
});

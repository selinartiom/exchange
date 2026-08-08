const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const { verifyTelegramWebAppInitData } = require('../src/telegramAuth');

function signInitData(fields, botToken) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(fields)) {
    params.set(key, typeof value === 'string' ? value : JSON.stringify(value));
  }

  const dataCheckString = [...params.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${key}=${value}`)
    .join('\n');

  const secretKey = crypto.createHmac('sha256', 'WebAppData').update(botToken).digest();
  const hash = crypto.createHmac('sha256', secretKey).update(dataCheckString).digest('hex');
  params.set('hash', hash);
  return params.toString();
}

describe('verifyTelegramWebAppInitData', () => {
  test('accepts valid Telegram Mini App initData', () => {
    const initData = signInitData(
      {
        auth_date: String(Math.floor(Date.now() / 1000)),
        query_id: 'AAEAAAE',
        user: { id: 42, first_name: 'Alice', username: 'alice' },
      },
      'test-token'
    );

    const user = verifyTelegramWebAppInitData(initData, 'test-token');
    assert.equal(user.id, 42);
    assert.equal(user.username, 'alice');
  });

  test('rejects tampered initData', () => {
    const initData = signInitData(
      {
        auth_date: String(Math.floor(Date.now() / 1000)),
        user: { id: 42, first_name: 'Alice', username: 'alice' },
      },
      'test-token'
    ).replace('alice', 'mallory');

    assert.equal(verifyTelegramWebAppInitData(initData, 'test-token'), null);
  });
});

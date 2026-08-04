const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { requireCsrf } = require('../src/middleware/csrf');

function mockReqRes(headerToken, sessionToken) {
  const req = { headers: {}, session: { csrfToken: sessionToken } };
  if (headerToken !== undefined) req.headers['x-csrf-token'] = headerToken;
  let statusCode = null;
  let jsonBody = null;
  const res = {
    status(code) {
      statusCode = code;
      return this;
    },
    json(body) {
      jsonBody = body;
      return this;
    },
  };
  return { req, res, getStatus: () => statusCode, getJson: () => jsonBody };
}

describe('requireCsrf', () => {
  test('пропускает запрос с совпадающим токеном', () => {
    const { req, res, getStatus } = mockReqRes('secret123', 'secret123');
    let nextCalled = false;
    requireCsrf(req, res, () => {
      nextCalled = true;
    });
    assert.equal(nextCalled, true);
    assert.equal(getStatus(), null);
  });

  test('отклоняет запрос без заголовка (403)', () => {
    const { req, res, getStatus } = mockReqRes(undefined, 'secret123');
    let nextCalled = false;
    requireCsrf(req, res, () => {
      nextCalled = true;
    });
    assert.equal(nextCalled, false);
    assert.equal(getStatus(), 403);
  });

  test('отклоняет запрос с неверным токеном (403)', () => {
    const { req, res, getStatus } = mockReqRes('wrong-token', 'secret123');
    let nextCalled = false;
    requireCsrf(req, res, () => {
      nextCalled = true;
    });
    assert.equal(nextCalled, false);
    assert.equal(getStatus(), 403);
  });
});

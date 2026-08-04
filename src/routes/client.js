const express = require('express');
const crypto = require('crypto');
const { requireClient } = require('../middleware/clientAuth');
const { requireCsrf } = require('../middleware/csrf');
const { authLimiter } = require('../middleware/rateLimit');
const { listOrders } = require('../db');

const router = express.Router();

/**
 * Проверка данных Telegram Login Widget по алгоритму из документации Telegram:
 * https://core.telegram.org/widgets/login#checking-authorization
 * secret_key = SHA256(bot_token)
 * data_check_string = отсортированные "key=value" через \n (без hash)
 * hash должен совпадать с HMAC-SHA256(data_check_string, secret_key)
 */
function verifyTelegramAuth(payload) {
  const { hash, ...fields } = payload;
  if (!hash) return false;

  const dataCheckString = Object.keys(fields)
    .sort()
    .map((key) => `${key}=${fields[key]}`)
    .join('\n');

  const secretKey = crypto.createHash('sha256').update(process.env.BOT_TOKEN).digest();
  const computedHash = crypto.createHmac('sha256', secretKey).update(dataCheckString).digest('hex');

  if (computedHash !== hash) return false;

  // Данные виджета старше суток — считаем протухшими
  const authDate = parseInt(fields.auth_date, 10);
  if (!authDate || Date.now() / 1000 - authDate > 86400) return false;

  return true;
}

router.post('/telegram', authLimiter, (req, res) => {
  if (!process.env.BOT_TOKEN) {
    return res.status(500).json({ error: 'BOT_TOKEN не настроен на сервере' });
  }
  const payload = req.body || {};
  if (!verifyTelegramAuth(payload)) {
    return res.status(401).json({ error: 'Не удалось подтвердить вход через Telegram' });
  }

  req.session.clientTelegramId = Number(payload.id);
  req.session.clientUsername = payload.username || null;
  req.session.clientFirstName = payload.first_name || null;

  res.json({
    ok: true,
    user: { id: payload.id, username: payload.username, firstName: payload.first_name },
  });
});

router.post('/logout', requireCsrf, (req, res) => {
  req.session.clientTelegramId = null;
  req.session.clientUsername = null;
  req.session.clientFirstName = null;
  res.json({ ok: true });
});

router.get('/me', requireClient, (req, res) => {
  res.json({
    id: req.session.clientTelegramId,
    username: req.session.clientUsername,
    firstName: req.session.clientFirstName,
  });
});

router.get('/me/orders', requireClient, async (req, res) => {
  const orders = await listOrders({ telegramId: req.session.clientTelegramId });
  res.json(orders);
});

module.exports = router;

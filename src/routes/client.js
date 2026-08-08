const express = require('express');
const { requireClient } = require('../middleware/clientAuth');
const { requireCsrf } = require('../middleware/csrf');
const { authLimiter } = require('../middleware/rateLimit');
const { listOrders } = require('../db');
const { verifyTelegramLogin, verifyTelegramWebAppInitData } = require('../telegramAuth');

const router = express.Router();

function setClientSession(req, user) {
  req.session.clientTelegramId = Number(user.id);
  req.session.clientUsername = user.username || null;
  req.session.clientFirstName = user.first_name || user.firstName || null;
}

router.post('/telegram', authLimiter, (req, res) => {
  if (!process.env.BOT_TOKEN) {
    return res.status(500).json({ error: 'BOT_TOKEN is not configured on the server' });
  }

  const payload = req.body || {};
  if (!verifyTelegramLogin(payload)) {
    return res.status(401).json({ error: 'Could not verify Telegram login' });
  }

  setClientSession(req, payload);

  res.json({
    ok: true,
    user: { id: payload.id, username: payload.username, firstName: payload.first_name },
  });
});

router.post('/telegram-webapp', authLimiter, (req, res) => {
  if (!process.env.BOT_TOKEN) {
    return res.status(500).json({ error: 'BOT_TOKEN is not configured on the server' });
  }

  const user = verifyTelegramWebAppInitData(req.body?.initData);
  if (!user?.id) {
    return res.status(401).json({ error: 'Could not verify Telegram Mini App' });
  }

  setClientSession(req, user);

  res.json({
    ok: true,
    user: { id: user.id, username: user.username, firstName: user.first_name },
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

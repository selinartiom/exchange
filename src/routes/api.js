const express = require('express');
const { nanoid } = require('nanoid');
const { getBoardRates, quote } = require('../rates');
const { createOrder, getSettings, getOrder, findRecentDuplicateOrder } = require('../db');
const { readLimiter, createOrderLimiter } = require('../middleware/rateLimit');
const { requireCsrf } = require('../middleware/csrf');

const router = express.Router();

router.get('/rates', readLimiter, async (req, res) => {
  try {
    const board = await getBoardRates();
    res.json(board);
  } catch (err) {
    console.error(err);
    res.status(502).json({ error: 'Не удалось получить курсы' });
  }
});

router.post('/quote', readLimiter, async (req, res) => {
  const { fromAsset, toAsset, amount } = req.body || {};
  const amt = parseFloat(amount);
  if (!fromAsset || !toAsset || !(amt > 0)) {
    return res.status(400).json({ error: 'Укажите fromAsset, toAsset и amount > 0' });
  }
  try {
    const result = await quote({ fromAsset, toAsset, amount: amt });
    const settings = await getSettings();
    res.json({ ...result, quoteTtlMinutes: settings.quoteTtlMinutes });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.post('/orders', createOrderLimiter, requireCsrf, async (req, res) => {
  const { fromAsset, toAsset, amount, contact } = req.body || {};
  const amt = parseFloat(amount);
  if (!fromAsset || !toAsset || !(amt > 0)) {
    return res.status(400).json({ error: 'Укажите fromAsset, toAsset и amount > 0' });
  }
  try {
    const telegramId = req.session?.clientTelegramId || null;
    const username = req.session?.clientUsername || null;

    // Защита от случайного двойного клика/повторной отправки формы — если
    // точно такая же заявка от того же клиента уже создана в последние
    // 15 секунд, отдаём её вместо того, чтобы плодить дубли.
    const duplicate = await findRecentDuplicateOrder({
      fromAsset,
      toAsset,
      amountIn: amt,
      telegramId,
      contact: contact || null,
      withinSeconds: 15,
    });
    if (duplicate) {
      const botUsername = process.env.BOT_USERNAME || 'nexchange_md_bot';
      return res.json({
        order: duplicate,
        telegramDeepLink: `https://t.me/${botUsername}?start=order_${duplicate.id}`,
        deduplicated: true,
      });
    }

    const result = await quote({ fromAsset, toAsset, amount: amt });
    const settings = await getSettings();
    const quoteExpiresAt = new Date(Date.now() + settings.quoteTtlMinutes * 60 * 1000).toISOString();

    const order = await createOrder({
      id: nanoid(8),
      source: 'site',
      actor: 'site',
      telegramId,
      username,
      contact: contact || null,
      fromAsset,
      toAsset,
      amountIn: amt,
      amountOut: result.amountOut,
      rateUsed: result.rateUsed,
      status: 'AWAITING_PAYMENT',
      quoteExpiresAt,
      createdAt: new Date().toISOString(),
    });

    // Уведомляем операторов сразу, не дожидаясь, пока клиент откроет бота
    require('../botBridge').notifyAdminsNewOrder?.(order).catch((err) =>
      console.error('Не удалось уведомить админов о новой заявке:', err.message)
    );

    const botUsername = process.env.BOT_USERNAME || 'nexchange_md_bot';
    res.json({
      order,
      // диплинк открывает бота и сразу подхватывает эту заявку (см. bot start-payload)
      telegramDeepLink: `https://t.me/${botUsername}?start=order_${order.id}`,
    });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.get('/orders/:id', readLimiter, async (req, res) => {
  const order = await getOrder(req.params.id);
  if (!order) return res.status(404).json({ error: 'Заявка не найдена' });
  res.json(order);
});

module.exports = router;

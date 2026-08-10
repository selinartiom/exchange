const express = require('express');
const { nanoid } = require('nanoid');
const { getBoardRates, quote } = require('../rates');
const {
  attachPaymentToOrder,
  createOrder,
  findRecentDuplicateOrder,
  getOrder,
  getOrderByPaymentId,
  getSettings,
  logEvent,
  updateOrder,
} = require('../db');
const { readLimiter, createOrderLimiter } = require('../middleware/rateLimit');
const { requireCsrf } = require('../middleware/csrf');
const {
  createPaymentForOrder,
  isConfigured: isNowPaymentsConfigured,
  isSupportedAsset: isNowPaymentsSupportedAsset,
  mapIpnStatusToOrderStatus,
  verifyIpnSignature,
} = require('../payments/nowpayments');

const router = express.Router();

function paymentPayload(order) {
  if (!order?.paymentProvider) return null;
  return {
    provider: order.paymentProvider,
    paymentId: order.paymentId,
    status: order.paymentStatus,
    paymentUrl: order.paymentUrl,
    payAddress: order.payAddress,
    payAmount: order.payAmount,
    payCurrency: order.payCurrency,
    purchaseId: order.paymentPurchaseId,
  };
}

async function maybeCreateNowPaymentsPayment(order) {
  if (!isNowPaymentsConfigured() || !isNowPaymentsSupportedAsset(order.fromAsset)) return { order };
  if (order.paymentId) return { order, payment: paymentPayload(order) };
  const payment = await createPaymentForOrder(order);
  const updated = await attachPaymentToOrder(order.id, payment);
  return { order: updated, payment: paymentPayload(updated) };
}

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
      let duplicateWithPayment = duplicate;
      let payment = paymentPayload(duplicate);
      let paymentError = null;
      try {
        const result = await maybeCreateNowPaymentsPayment(duplicate);
        duplicateWithPayment = result.order;
        payment = result.payment || paymentPayload(result.order);
      } catch (err) {
        paymentError = err.message;
        console.error(`NOWPayments: failed to create payment for duplicate order #${duplicate.id}:`, err.message);
      }
      return res.json({
        order: duplicateWithPayment,
        telegramDeepLink: `https://t.me/${botUsername}?start=order_${duplicateWithPayment.id}`,
        nowPayments: payment,
        paymentError,
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
    let orderWithPayment = order;
    let payment = null;
    let paymentError = null;
    try {
      const result = await maybeCreateNowPaymentsPayment(order);
      orderWithPayment = result.order;
      payment = result.payment || paymentPayload(result.order);
    } catch (err) {
      paymentError = err.message;
      await logEvent(order.id, 'PAYMENT_CREATE_FAILED', 'nowpayments', { error: err.message }).catch(() => {});
      console.error(`NOWPayments: failed to create payment for order #${order.id}:`, err.message);
    }
    res.json({
      order: orderWithPayment,
      // диплинк открывает бота и сразу подхватывает эту заявку (см. bot start-payload)
      telegramDeepLink: `https://t.me/${botUsername}?start=order_${orderWithPayment.id}`,
      nowPayments: payment,
      paymentError,
    });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.post('/orders/:id/nowpayments', createOrderLimiter, requireCsrf, async (req, res) => {
  try {
    const order = await getOrder(req.params.id);
    if (!order) return res.status(404).json({ error: 'Заявка не найдена' });
    if (order.status !== 'AWAITING_PAYMENT') {
      return res.status(400).json({ error: 'Платёж можно создать только для заявки в ожидании оплаты' });
    }
    if (!isNowPaymentsSupportedAsset(order.fromAsset)) {
      return res.status(400).json({ error: `NOWPayments не подключён для ${order.fromAsset}` });
    }
    const result = await maybeCreateNowPaymentsPayment(order);
    res.json({ order: result.order, nowPayments: result.payment || paymentPayload(result.order) });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.post('/payments/nowpayments/ipn', async (req, res) => {
  const signature = req.headers['x-nowpayments-sig'];
  if (!verifyIpnSignature(req.body || {}, signature)) {
    return res.status(401).json({ error: 'Invalid IPN signature' });
  }

  const ipn = req.body || {};
  const orderId = ipn.order_id ? String(ipn.order_id) : null;
  const paymentId = ipn.payment_id ? String(ipn.payment_id) : null;
  const order = orderId ? await getOrder(orderId) : paymentId ? await getOrderByPaymentId(paymentId) : null;
  if (!order) return res.status(404).json({ error: 'Order not found' });

  const nextStatus = mapIpnStatusToOrderStatus(ipn.payment_status, order.status);
  const patch = {
    paymentStatus: ipn.payment_status || order.paymentStatus,
    paymentRaw: ipn,
  };
  if (nextStatus !== order.status) patch.status = nextStatus;
  if (ipn.pay_amount !== undefined) patch.payAmount = ipn.pay_amount;
  if (ipn.pay_currency) patch.payCurrency = ipn.pay_currency;
  if (ipn.purchase_id) patch.paymentPurchaseId = String(ipn.purchase_id);

  const updated = await updateOrder(order.id, patch);
  await logEvent(order.id, 'PAYMENT_IPN', 'nowpayments', {
    paymentId,
    paymentStatus: ipn.payment_status,
    orderStatus: updated.status,
    payAmount: ipn.pay_amount,
    payCurrency: ipn.pay_currency,
  });

  if (updated.status === 'AWAITING_CONFIRMATION' && order.status !== 'AWAITING_CONFIRMATION') {
    const bridge = require('../botBridge');
    const text = [
      `NOWPayments: оплата по заявке #${updated.id} обнаружена.`,
      `${updated.amountIn} ${updated.fromAsset} → ${updated.amountOut} ${updated.toAsset}`,
      `Статус платежа: ${updated.paymentStatus || ipn.payment_status}`,
      `Payment ID: ${updated.paymentId || paymentId}`,
    ].join('\n');
    const adminIds = (process.env.ADMIN_IDS || '').split(',').map((s) => s.trim()).filter(Boolean);
    for (const adminId of adminIds) bridge.sendTelegramMessage(adminId, text).catch(() => {});
  }

  res.json({ ok: true });
});

router.get('/orders/:id', readLimiter, async (req, res) => {
  const order = await getOrder(req.params.id);
  if (!order) return res.status(404).json({ error: 'Заявка не найдена' });
  res.json(order);
});

module.exports = router;

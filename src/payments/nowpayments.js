const crypto = require('crypto');
const axios = require('axios');
const { getBoardRates } = require('../rates');

const API_BASE = process.env.NOWPAYMENTS_API_BASE || 'https://api.nowpayments.io/v1';

const CURRENCY_BY_ASSET = {
  BTC: process.env.NOWPAYMENTS_CURRENCY_BTC || 'btc',
  USDT: process.env.NOWPAYMENTS_CURRENCY_USDT || 'usdttrc20',
  TON: process.env.NOWPAYMENTS_CURRENCY_TON || 'ton',
};

function isConfigured() {
  return Boolean(process.env.NOWPAYMENTS_API_KEY);
}

function getPayCurrency(asset) {
  return CURRENCY_BY_ASSET[asset] || null;
}

function isSupportedAsset(asset) {
  return Boolean(getPayCurrency(asset));
}

function publicOrderUrl(orderId) {
  const base = process.env.PUBLIC_URL || process.env.MINI_APP_URL || 'https://exmoney.online';
  return `${base.replace(/\/$/, '')}/?order=${encodeURIComponent(orderId)}`;
}

async function estimateUsdAmount(order) {
  if (order.fromAsset === 'USDT') return order.amountIn;
  const board = await getBoardRates();
  const assetRate = board.assets?.[order.fromAsset]?.mid;
  if (!assetRate || !board.usdMdl) return order.amountIn;
  return Number(((order.amountIn * assetRate) / board.usdMdl).toFixed(2));
}

async function createPaymentForOrder(order) {
  if (!isConfigured()) {
    const err = new Error('NOWPayments API key is not configured');
    err.code = 'NOWPAYMENTS_NOT_CONFIGURED';
    throw err;
  }

  const payCurrency = getPayCurrency(order.fromAsset);
  if (!payCurrency) {
    const err = new Error(`NOWPayments does not support ${order.fromAsset} for this flow`);
    err.code = 'NOWPAYMENTS_UNSUPPORTED_ASSET';
    throw err;
  }

  const priceAmount = await estimateUsdAmount(order);
  const callbackUrl =
    process.env.NOWPAYMENTS_IPN_CALLBACK_URL ||
    `${(process.env.PUBLIC_URL || 'https://exmoney.online').replace(/\/$/, '')}/api/payments/nowpayments/ipn`;

  const payload = {
    price_amount: priceAmount,
    price_currency: 'usd',
    pay_amount: order.amountIn,
    pay_currency: payCurrency,
    ipn_callback_url: callbackUrl,
    order_id: order.id,
    order_description: `EXMONEY order #${order.id}: ${order.amountIn} ${order.fromAsset} to ${order.amountOut} ${order.toAsset}`,
  };

  const { data } = await axios.post(`${API_BASE}/payment`, payload, {
    headers: {
      'x-api-key': process.env.NOWPAYMENTS_API_KEY,
      'Content-Type': 'application/json',
    },
    timeout: 15000,
  });

  return {
    provider: 'nowpayments',
    paymentId: data.payment_id ? String(data.payment_id) : null,
    paymentStatus: data.payment_status || 'waiting',
    payAddress: data.pay_address || null,
    payAmount: data.pay_amount !== undefined ? Number(data.pay_amount) : order.amountIn,
    payCurrency: data.pay_currency || payCurrency,
    purchaseId: data.purchase_id ? String(data.purchase_id) : null,
    paymentUrl: data.invoice_url || data.payment_url || null,
    raw: data,
  };
}

function sortObject(value) {
  if (Array.isArray(value)) return value.map(sortObject);
  if (!value || typeof value !== 'object') return value;
  return Object.keys(value)
    .sort()
    .reduce((acc, key) => {
      acc[key] = sortObject(value[key]);
      return acc;
    }, {});
}

function signIpnPayload(payload, secret = process.env.NOWPAYMENTS_IPN_SECRET || '') {
  const sorted = JSON.stringify(sortObject(payload));
  return crypto.createHmac('sha512', secret).update(sorted).digest('hex');
}

function verifyIpnSignature(payload, signature) {
  const secret = process.env.NOWPAYMENTS_IPN_SECRET;
  if (!secret || !signature) return false;
  const expected = signIpnPayload(payload, secret);
  const actual = String(signature);
  if (expected.length !== actual.length) return false;
  return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(actual));
}

function mapIpnStatusToOrderStatus(paymentStatus, currentStatus) {
  const status = String(paymentStatus || '').toLowerCase();
  if (['finished', 'confirmed', 'sending'].includes(status)) return 'AWAITING_CONFIRMATION';
  if (['failed', 'refunded'].includes(status)) return 'REJECTED';
  if (['expired'].includes(status)) return 'EXPIRED';
  return currentStatus;
}

module.exports = {
  createPaymentForOrder,
  getPayCurrency,
  isConfigured,
  isSupportedAsset,
  mapIpnStatusToOrderStatus,
  publicOrderUrl,
  signIpnPayload,
  verifyIpnSignature,
};

const {
  listOrdersAwaitingCryptoDeposit,
  updateOrder,
  logEvent,
  getSettings,
  markOrderCryptoMatch,
} = require('./db');
const { checkAddressDeposit } = require('./blockchain/btcExplorer');
const { fetchIncomingTransactions } = require('./blockchain/ton');
const { sendOrderUpdate } = require('./botBridge');

// Публичные блокчейн-API — с лимитами по частоте запросов, не долбим чаще раза в 2 минуты
const CHECK_INTERVAL_MS = 2 * 60 * 1000;

/**
 * BTC: у каждой заявки, если настроен xpub, свой уникальный адрес — поэтому
 * сопоставление платежа с заявкой однозначное, достаточно проверить сумму
 * и число подтверждений. Без xpub эта проверка просто ничего не делает —
 * общий кошелёк без выделенных адресов нельзя надёжно сопоставить.
 */
async function checkBtcOrders(settings) {
  if (!settings.walletBtcXpub) return;
  const orders = await listOrdersAwaitingCryptoDeposit({ assets: ['BTC'] });

  for (const order of orders) {
    if (!order.depositAddress) continue;
    try {
      const deposit = await checkAddressDeposit(order.depositAddress);
      if (!deposit) continue;

      // Допуск 1% — на случай, если клиент округлил сумму или сеть удержала часть на комиссию
      if (deposit.amountBtc < order.amountIn * 0.99) continue;

      await markOrderCryptoMatch(order.id, { txHash: deposit.txid, confirmations: deposit.confirmations });

      const required = settings.requiredConfirmationsBtc || 1;
      if (deposit.confirmations >= required && order.status === 'AWAITING_PAYMENT') {
        const updated = await updateOrder(order.id, { status: 'AWAITING_CONFIRMATION' });
        await logEvent(order.id, 'AUTO_DETECTED', 'blockchain:btc', {
          txid: deposit.txid,
          amountBtc: deposit.amountBtc,
          confirmations: deposit.confirmations,
        });
        console.log(`BTC-платёж по заявке #${order.id} обнаружен автоматически (${deposit.txid})`);
        await sendOrderUpdate({ ...updated, status: 'AUTO_DETECTED' }).catch(() => {});
      }
    } catch (err) {
      console.error(`Ошибка проверки BTC-адреса для заявки #${order.id}:`, err.message);
    }
  }
}

/**
 * TON/USDT: общий кошелёк, сопоставление по комментарию к переводу (в нём
 * должен быть ID заявки — это указано клиенту в тексте с реквизитами).
 * Один запрос к toncenter на все заявки сразу, а не по одному — экономим
 * лимит бесплатного API.
 *
 * NB: USDT на TON — это джеттон (не нативный перевод TON), а сообщения
 * джеттон-переводов требуют отдельного разбора структуры транзакции.
 * Здесь этого разбора нет — авто-детекция сейчас работает только для
 * нативных TON-переводов. Для USDT-TON заявки по-прежнему подтверждаются
 * оператором вручную, как раньше.
 */
async function checkTonOrders(settings) {
  if (!settings.walletTon) return;
  const orders = await listOrdersAwaitingCryptoDeposit({ assets: ['TON'] });
  if (!orders.length) return;

  let txs;
  try {
    txs = await fetchIncomingTransactions(settings.walletTon, settings.tonApiKey);
  } catch (err) {
    console.error('Ошибка запроса транзакций TON (toncenter):', err.message);
    return;
  }

  for (const order of orders) {
    const match = txs.find((tx) => tx.comment === order.id);
    if (!match) continue;

    const amountTon = match.amountNano / 1e9;
    if (amountTon < order.amountIn * 0.99) continue;

    await markOrderCryptoMatch(order.id, { txHash: match.hash, confirmations: 1 });

    if (order.status === 'AWAITING_PAYMENT') {
      const updated = await updateOrder(order.id, { status: 'AWAITING_CONFIRMATION' });
      await logEvent(order.id, 'AUTO_DETECTED', 'blockchain:ton', { txHash: match.hash, amountTon });
      console.log(`TON-платёж по заявке #${order.id} обнаружен автоматически (комментарий совпал)`);
      await sendOrderUpdate({ ...updated, status: 'AUTO_DETECTED' }).catch(() => {});
    }
  }
}

function startBlockchainWatcher() {
  async function tick() {
    try {
      const settings = await getSettings();
      await Promise.all([checkBtcOrders(settings), checkTonOrders(settings)]);
    } catch (err) {
      console.error('Ошибка воркера блокчейн-проверки:', err.message);
    }
  }
  tick();
  const timer = setInterval(tick, CHECK_INTERVAL_MS);
  return () => clearInterval(timer);
}

module.exports = { startBlockchainWatcher };

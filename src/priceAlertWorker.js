const { listAllActiveAlerts, deactivateAlert } = require('./db');
const { getBoardRates } = require('./rates');
const { sendTelegramMessage } = require('./botBridge');

// Курсы и так кэшируются на 30 сек внутри rates.js — раз в 5 минут более чем достаточно
const CHECK_INTERVAL_MS = 5 * 60 * 1000;

function isTriggered(alert, currentPrice) {
  return alert.direction === 'above' ? currentPrice >= alert.targetPriceMdl : currentPrice <= alert.targetPriceMdl;
}

async function checkPriceAlerts() {
  const alerts = await listAllActiveAlerts();
  if (!alerts.length) return;

  let board;
  try {
    board = await getBoardRates();
  } catch (err) {
    console.error('Не удалось получить курсы для проверки подписок:', err.message);
    return;
  }

  for (const alert of alerts) {
    const rate = board.assets[alert.asset];
    if (!rate) continue;

    // "Уведомить, когда выше X" — обычно смотрит тот, кто хочет ПРОДАТЬ актив
    // (ждёт высокой цены) — ему важен наш курс покупки (buy, сколько мы платим).
    // "Уведомить, когда ниже X" — смотрит тот, кто хочет КУПИТЬ (ждёт просадки)
    // — ему важен наш курс продажи (sell, сколько он заплатит).
    const currentPrice = alert.direction === 'above' ? rate.buy : rate.sell;
    if (!isTriggered(alert, currentPrice)) continue;

    const dirLabel = alert.direction === 'above' ? 'поднялся выше' : 'опустился ниже';
    await sendTelegramMessage(
      alert.telegramId,
      `🔔 Курс ${alert.asset} ${dirLabel} ${alert.targetPriceMdl} MDL (сейчас ${currentPrice.toFixed(2)}).\n\n` +
        `Оформить обмен — /exchange`
    );
    await deactivateAlert(alert.id);
    console.log(`Подписка #${alert.id} сработала: ${alert.asset} ${dirLabel} ${alert.targetPriceMdl}`);
  }
}

function startPriceAlertWorker() {
  async function tick() {
    try {
      await checkPriceAlerts();
    } catch (err) {
      console.error('Ошибка воркера подписок на курс:', err.message);
    }
  }
  tick();
  const timer = setInterval(tick, CHECK_INTERVAL_MS);
  return () => clearInterval(timer);
}

module.exports = { startPriceAlertWorker };

const { expireStaleOrders } = require('./db');
const { sendOrderUpdate } = require('./botBridge');

const CHECK_INTERVAL_MS = 60 * 1000; // раз в минуту достаточно — окно фиксации курса обычно 15 минут

/**
 * Периодически ищет заявки, у которых истекло время фиксации курса (quote_expires_at),
 * а клиент так и не нажал «Я оплатил» — переводит их в EXPIRED и уведомляет клиента,
 * если он был известен (telegramId привязан).
 *
 * Работает только в том процессе, где вызвана — обычно это npm start (сайт),
 * так как он постоянно поднят. Если сайт не запущен, протухание просто не
 * проверяется до его следующего старта (заявки всё равно физически нельзя
 * оплатить после истечения — это лишь смена статуса и уведомление).
 */
function startExpiryWorker() {
  async function tick() {
    try {
      const expired = await expireStaleOrders();
      for (const order of expired) {
        console.log(`Заявка #${order.id} просрочена (курс истёк)`);
        if (order.telegramId) {
          await sendOrderUpdate(order).catch(() => {});
        }
      }
    } catch (err) {
      console.error('Ошибка при проверке просроченных заявок:', err.message);
    }
  }

  tick(); // сразу при старте, не дожидаясь первого интервала
  const timer = setInterval(tick, CHECK_INTERVAL_MS);
  return () => clearInterval(timer);
}

module.exports = { startExpiryWorker };

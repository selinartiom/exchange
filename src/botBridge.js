const axios = require('axios');

/**
 * Сайт/админка и бот — разные процессы, но оба видят одну и ту же PostgreSQL
 * и один и тот же BOT_TOKEN. Чтобы админ мог подтвердить заявку прямо из
 * веб-панели (а не только через кнопки в Telegram), шлём клиенту сообщение
 * напрямую через Bot API, без запуска самого Telegraf.
 */

const ADMIN_IDS = (process.env.ADMIN_IDS || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

async function sendTelegramMessage(chatId, text) {
  const token = process.env.BOT_TOKEN;
  if (!token) return;
  try {
    await axios.post(`https://api.telegram.org/bot${token}/sendMessage`, {
      chat_id: chatId,
      text,
    });
  } catch (err) {
    console.error(`Не удалось отправить сообщение в Telegram (chat_id=${chatId}):`, err.message);
  }
}

async function sendOrderUpdate(order) {
  if (!order.telegramId) return; // заявка с сайта без Telegram ID — некому слать, просто выходим

  const text =
    order.status === 'COMPLETED'
      ? `Заявка #${order.id} подтверждена. ${order.amountOut} ${order.toAsset} отправлены на ваши реквизиты.`
      : order.status === 'REJECTED'
      ? `Заявка #${order.id} отклонена оператором. Если это ошибка — напишите в поддержку.`
      : order.status === 'EXPIRED'
      ? `Заявка #${order.id} просрочена — время фиксации курса истекло. Оформите новую заявку.`
      : order.status === 'AUTO_DETECTED'
      ? `Платёж по заявке #${order.id} автоматически обнаружен в блокчейне. Осталось дождаться подтверждения оператора.`
      : null;
  if (!text) return;

  await sendTelegramMessage(order.telegramId, text);
}

/**
 * Уведомляет всех операторов (ADMIN_IDS) о новой заявке, оформленной на сайте —
 * не дожидаясь, пока клиент сам откроет бота. Само подтверждение оплаты
 * по-прежнему происходит либо в боте (кнопка «Я оплатил»), либо в админке.
 */
async function notifyAdminsNewOrder(order) {
  if (!ADMIN_IDS.length) return;
  const text = [
    `🆕 Новая заявка с сайта #${order.id}`,
    `${order.amountIn} ${order.fromAsset} → ${order.amountOut} ${order.toAsset}`,
    order.contact ? `Контакт: ${order.contact}` : 'Контакт не указан',
    `Статус: ждёт, пока клиент оплатит и подтвердит в боте`,
  ].join('\n');

  for (const adminId of ADMIN_IDS) {
    await sendTelegramMessage(adminId, text);
  }
}

module.exports = { sendOrderUpdate, notifyAdminsNewOrder, sendTelegramMessage };

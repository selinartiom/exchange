require('dotenv').config();
const { Telegraf, Scenes, session, Markup } = require('telegraf');
const { wizard, presentExistingOrder } = require('./exchangeWizard');
const { alertWizard } = require('./alertWizard');
const { getBoardRates } = require('../src/rates');
const {
  getOrder,
  updateOrder,
  listOrders,
  logEvent,
  listActiveAlertsForUser,
  cancelPriceAlert,
} = require('../src/db');

if (!process.env.BOT_TOKEN) {
  console.error('BOT_TOKEN не задан. Скопируйте .env.example в .env и заполните.');
  process.exit(1);
}

if (!process.env.DATABASE_URL) {
  console.error(
    'DATABASE_URL не задан. Пример: postgresql://nexchange:пароль@адрес-сервера-бд:5432/nexchange\n' +
      'Если БД на отдельном сервере — используйте её IP/домен, не localhost.'
  );
  process.exit(1);
}

const ADMIN_IDS = (process.env.ADMIN_IDS || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean)
  .map(Number);

const bot = new Telegraf(process.env.BOT_TOKEN);
const stage = new Scenes.Stage([wizard, alertWizard]);

bot.use(session());
bot.use(stage.middleware());

bot.start(async (ctx) => {
  const payload = ctx.startPayload; // например "order_AbC123xy"
  if (payload?.startsWith('order_')) {
    const id = payload.replace('order_', '');
    const order = await getOrder(id);
    if (order && order.status === 'AWAITING_PAYMENT') {
      // Заявка была создана на сайте без telegramId — привязываем её к этому чату
      let toShow = order;
      if (!order.telegramId) {
        toShow = await updateOrder(id, { telegramId: ctx.from.id, username: ctx.from.username || null });
      }
      return presentExistingOrder(ctx, toShow);
    }
    if (order && order.status === 'EXPIRED') {
      return ctx.reply(`Заявка #${id} просрочена — курс был зафиксирован на ограниченное время. Оформите новую: /exchange`);
    }
  }

  return ctx.reply(
    'EXMONEY — обмен крипты и MDL в Кишинёве.\n\n' +
      '/rates — текущее табло курсов\n' +
      '/exchange — оформить заявку на обмен\n' +
      '/alert — подписаться на уведомление о курсе\n' +
      '/myalerts — мои подписки на курс\n' +
      '/status <id> — статус заявки',
    Markup.keyboard([['/rates', '/exchange']]).resize()
  );
});

bot.command('rates', async (ctx) => {
  try {
    const board = await getBoardRates();
    const lines = Object.entries(board.assets).map(
      ([sym, r]) => `${sym}/MDL   покупка ${r.buy.toFixed(2)}   продажа ${r.sell.toFixed(2)}`
    );
    await ctx.reply(['Курсы (обновлено только что):', ...lines].join('\n'));
  } catch (err) {
    console.error(err);
    await ctx.reply('Не удалось получить курсы, попробуйте позже.');
  }
});

bot.command('exchange', (ctx) => ctx.scene.enter('exchange-wizard'));
bot.command('alert', (ctx) => ctx.scene.enter('alert-wizard'));

bot.command('myalerts', async (ctx) => {
  const alerts = await listActiveAlertsForUser(ctx.from.id);
  if (!alerts.length) {
    return ctx.reply('У вас нет активных подписок на курс. Оформить — /alert');
  }
  for (const a of alerts) {
    const dirLabel = a.direction === 'above' ? 'выше' : 'ниже';
    await ctx.reply(
      `#${a.id}: ${a.asset} ${dirLabel} ${a.targetPriceMdl} MDL`,
      Markup.inlineKeyboard([Markup.button.callback('Отменить', `cancel_alert:${a.id}`)])
    );
  }
});

bot.action(/^cancel_alert:(\d+)$/, async (ctx) => {
  const id = parseInt(ctx.match[1], 10);
  const ok = await cancelPriceAlert(id, ctx.from.id);
  await ctx.answerCbQuery(ok ? 'Подписка отменена' : 'Не найдена');
  if (ok) await ctx.editMessageText(`Подписка #${id} отменена.`);
});

bot.command('status', async (ctx) => {
  const id = ctx.message.text.split(' ')[1];
  if (!id) return ctx.reply('Укажите номер заявки: /status ABC12345');
  const order = await getOrder(id);
  if (!order) return ctx.reply('Заявка не найдена.');
  ctx.reply(
    `Заявка #${order.id}\n${order.amountIn} ${order.fromAsset} → ${order.amountOut} ${order.toAsset}\nСтатус: ${statusLabel(order.status)}`
  );
});

// Клиент нажал «Я оплатил» — уведомляем админов с кнопками подтверждения
bot.action(/^paid:(.+)$/, async (ctx) => {
  const id = ctx.match[1];
  const order = await getOrder(id);
  if (!order) return ctx.answerCbQuery('Заявка не найдена');

  await updateOrder(id, { status: 'AWAITING_CONFIRMATION' });
  await logEvent(id, 'PAID_CLICKED', `bot:${ctx.from.id}`);
  await ctx.answerCbQuery();
  await ctx.editMessageText(
    `Заявка #${id}: ждём подтверждения оператора. Обычно это занимает до 15 минут.`
  );

  for (const adminId of ADMIN_IDS) {
    await bot.telegram.sendMessage(
      adminId,
      [
        `Новая оплата по заявке #${order.id}`,
        `От: @${order.username || order.telegramId}`,
        `${order.amountIn} ${order.fromAsset} → ${order.amountOut} ${order.toAsset}`,
      ].join('\n'),
      Markup.inlineKeyboard([
        Markup.button.callback('Подтвердить и выплатить', `admin_confirm:${order.id}`),
        Markup.button.callback('Отклонить', `admin_reject:${order.id}`),
      ])
    );
  }
});

// Админ подтверждает поступление средств
bot.action(/^admin_confirm:(.+)$/, async (ctx) => {
  if (!ADMIN_IDS.includes(ctx.from.id)) return ctx.answerCbQuery('Недостаточно прав');
  const id = ctx.match[1];
  const order = await updateOrder(id, { status: 'COMPLETED', confirmedBy: String(ctx.from.id) });
  await logEvent(id, 'CONFIRMED', `admin:${ctx.from.id}`);
  await ctx.answerCbQuery('Подтверждено');
  await ctx.editMessageText(`Заявка #${id} подтверждена и закрыта.`);
  if (order.telegramId) {
    await bot.telegram.sendMessage(
      order.telegramId,
      `Заявка #${id} подтверждена. ${order.amountOut} ${order.toAsset} отправлены на ваши реквизиты.`
    );
  }
});

bot.action(/^admin_reject:(.+)$/, async (ctx) => {
  if (!ADMIN_IDS.includes(ctx.from.id)) return ctx.answerCbQuery('Недостаточно прав');
  const id = ctx.match[1];
  const order = await updateOrder(id, { status: 'REJECTED', rejectedBy: String(ctx.from.id) });
  await logEvent(id, 'REJECTED', `admin:${ctx.from.id}`);
  await ctx.answerCbQuery('Отклонено');
  await ctx.editMessageText(`Заявка #${id} отклонена.`);
  if (order.telegramId) {
    await bot.telegram.sendMessage(
      order.telegramId,
      `Заявка #${id} отклонена оператором. Если это ошибка — напишите в поддержку.`
    );
  }
});

bot.command('pending', async (ctx) => {
  if (!ADMIN_IDS.includes(ctx.from.id)) return;
  const orders = await listOrders({ status: 'AWAITING_CONFIRMATION' });
  if (!orders.length) return ctx.reply('Нет заявок, ожидающих подтверждения.');
  ctx.reply(orders.map((o) => `#${o.id} — ${o.amountIn} ${o.fromAsset} → ${o.amountOut} ${o.toAsset}`).join('\n'));
});

function statusLabel(status) {
  return (
    {
      AWAITING_PAYMENT: 'ожидает оплаты от клиента',
      AWAITING_CONFIRMATION: 'проверяется оператором',
      COMPLETED: 'выполнена',
      REJECTED: 'отклонена',
      EXPIRED: 'просрочена (курс истёк)',
    }[status] || status
  );
}

bot.catch((err, ctx) => {
  console.error(`Ошибка для ${ctx.updateType}`, err);
});

bot.launch();
console.log('EXMONEY bot запущен');

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));

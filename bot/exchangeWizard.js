const { Scenes, Markup } = require('telegraf');
const { nanoid } = require('nanoid');
const { quote } = require('../src/rates');
const { createOrder, getSettings, findRecentDuplicateOrder, ensureBtcDepositAddress } = require('../src/db');

const ASSETS = ['MDL', 'BTC', 'USDT', 'TON'];

const assetKeyboard = (excluded) =>
  Markup.inlineKeyboard(
    ASSETS.filter((a) => a !== excluded).map((a) => Markup.button.callback(a, `asset:${a}`)),
    { columns: 3 }
  );

const wizard = new Scenes.WizardScene(
  'exchange-wizard',

  // Шаг 1: спросить, что отдаёт клиент
  async (ctx) => {
    await ctx.reply(
      'Что вы отдаёте?\n\nВыберите валюту, которую хотите обменять.',
      assetKeyboard(null)
    );
    return ctx.wizard.next();
  },

  // Шаг 2: сохранить fromAsset, спросить что клиент хочет получить
  async (ctx) => {
    const data = ctx.callbackQuery?.data;
    if (!data?.startsWith('asset:')) {
      await ctx.reply('Пожалуйста, выберите валюту кнопкой выше.');
      return;
    }
    await ctx.answerCbQuery();
    const fromAsset = data.split(':')[1];
    ctx.wizard.state.fromAsset = fromAsset;

    await ctx.editMessageText(`Вы отдаёте: ${fromAsset}`);
    await ctx.reply('Что вы хотите получить?', assetKeyboard(fromAsset));
    return ctx.wizard.next();
  },

  // Шаг 3: сохранить toAsset, спросить сумму
  async (ctx) => {
    const data = ctx.callbackQuery?.data;
    if (!data?.startsWith('asset:')) {
      await ctx.reply('Пожалуйста, выберите валюту кнопкой выше.');
      return;
    }
    await ctx.answerCbQuery();
    const toAsset = data.split(':')[1];
    ctx.wizard.state.toAsset = toAsset;

    await ctx.editMessageText(`Вы получаете: ${toAsset}`);
    await ctx.reply(
      `Введите сумму в ${ctx.wizard.state.fromAsset}, которую хотите обменять (например: 150):`
    );
    return ctx.wizard.next();
  },

  // Шаг 4: посчитать котировку, показать подтверждение
  async (ctx) => {
    const raw = ctx.message?.text?.replace(',', '.').trim();
    const amount = parseFloat(raw);
    if (!raw || isNaN(amount) || amount <= 0) {
      await ctx.reply('Введите число больше нуля, например: 150');
      return;
    }

    const { fromAsset, toAsset } = ctx.wizard.state;
    let result;
    try {
      result = await quote({ fromAsset, toAsset, amount });
    } catch (err) {
      console.error(err);
      await ctx.reply('Не удалось получить курс. Попробуйте ещё раз чуть позже: /exchange');
      return ctx.scene.leave();
    }

    const settings = await getSettings();
    const ttlMinutes = settings.quoteTtlMinutes || 15;

    ctx.wizard.state.amount = amount;
    ctx.wizard.state.quote = result;
    ctx.wizard.state.quoteExpiresAt = Date.now() + ttlMinutes * 60 * 1000;

    await ctx.reply(
      [
        `Заявка на обмен:`,
        `${amount} ${fromAsset} → ${result.amountOut} ${toAsset}`,
        ``,
        `Курс зафиксирован на ${ttlMinutes} минут.`,
        needsKyc(fromAsset, toAsset, amount, result, settings.noKycLimitEur)
          ? 'Сумма превышает лимит без верификации — оператор запросит документ, удостоверяющий личность.'
          : null,
      ]
        .filter(Boolean)
        .join('\n'),
      Markup.inlineKeyboard([
        Markup.button.callback('Подтвердить заявку', 'confirm_order'),
        Markup.button.callback('Отменить', 'cancel_order'),
      ])
    );
    return ctx.wizard.next();
  },

  // Шаг 5: подтверждение, создание заявки, уведомление админов
  async (ctx) => {
    const data = ctx.callbackQuery?.data;
    if (data === 'cancel_order') {
      await ctx.answerCbQuery();
      await ctx.editMessageText('Заявка отменена.');
      return ctx.scene.leave();
    }
    if (data !== 'confirm_order') {
      await ctx.reply('Нажмите «Подтвердить заявку» или «Отменить».');
      return;
    }
    await ctx.answerCbQuery();

    if (Date.now() > ctx.wizard.state.quoteExpiresAt) {
      await ctx.editMessageText('Курс устарел. Оформите заявку заново: /exchange');
      return ctx.scene.leave();
    }

    const { fromAsset, toAsset, amount, quote: q } = ctx.wizard.state;
    const settings = await getSettings();

    // Защита от двойного тапа по кнопке — Telegram может прислать callback дважды
    const duplicate = await findRecentDuplicateOrder({
      fromAsset,
      toAsset,
      amountIn: amount,
      telegramId: ctx.from.id,
      withinSeconds: 15,
    });
    if (duplicate) {
      await ctx.editMessageText(
        `Заявка #${duplicate.id} уже создана.\n\n${await requisitesFor(duplicate, settings)}`,
        Markup.inlineKeyboard([Markup.button.callback('Я оплатил', `paid:${duplicate.id}`)])
      );
      return ctx.scene.leave();
    }

    const order = await createOrder({
      id: nanoid(8),
      source: 'bot',
      actor: `bot:${ctx.from.id}`,
      telegramId: ctx.from.id,
      username: ctx.from.username || null,
      fromAsset,
      toAsset,
      amountIn: amount,
      amountOut: q.amountOut,
      rateUsed: q.rateUsed,
      status: 'AWAITING_PAYMENT',
      quoteExpiresAt: new Date(ctx.wizard.state.quoteExpiresAt).toISOString(),
      createdAt: new Date().toISOString(),
    });

    await ctx.editMessageText(
      [
        `Заявка #${order.id} создана.`,
        ``,
        await requisitesFor(order, settings),
        ``,
        `После отправки средств нажмите «Я оплатил» — оператор подтвердит поступление и отправит ${toAsset}.`,
      ].join('\n'),
      Markup.inlineKeyboard([Markup.button.callback('Я оплатил', `paid:${order.id}`)])
    );

    return ctx.scene.leave();
  }
);

function needsKyc(fromAsset, toAsset, amount, result, noKycLimitEur) {
  // Грубая оценка эквивалента в евро через MDL-плечо котировки (для MVP; в проде — отдельный курс EUR).
  const eurApprox = toAsset === 'MDL' ? result.amountOut / 19 : fromAsset === 'MDL' ? amount / 19 : null;
  return eurApprox !== null && eurApprox > (noKycLimitEur || 500);
}

async function requisitesFor(order, settings) {
  const fromAsset = order.fromAsset;

  if (fromAsset === 'MDL') {
    return [
      'Переведите сумму на карту:',
      `${settings.bankCardNumber} (${settings.bankCardHolder})`,
      `Либо наличными: ${settings.cashPickupAddress}`,
    ].join('\n');
  }

  if (fromAsset === 'BTC') {
    const uniqueAddress = await ensureBtcDepositAddress(order.id);
    if (uniqueAddress) {
      return [
        'Отправьте BTC на адрес (уникальный для этой заявки — платёж будет подтверждён автоматически после подтверждений сети):',
        uniqueAddress,
      ].join('\n');
    }
    // xpub не настроен в админке — общий кошелёк, без авто-детекции
    return `Отправьте BTC на адрес:\n${settings.walletBtc}`;
  }

  if (fromAsset === 'TON') {
    return [
      `Отправьте TON на адрес:`,
      settings.walletTon,
      ``,
      `ВАЖНО: укажите в комментарии к переводу код заявки — ${order.id} — без него платёж не будет подтверждён автоматически.`,
    ].join('\n');
  }

  // USDT на TON — джеттон, авто-детекции пока нет (см. blockchainWatcher.js), подтверждение вручную
  return `Отправьте ${fromAsset} на адрес:\n${settings.walletUsdtTon}`;
}

/**
 * Показывает готовую заявку (созданную заранее, например с сайта) с реквизитами —
 * используется для диплинка ?start=order_<id>, минуя шаги мастера.
 */
async function presentExistingOrder(ctx, order) {
  const settings = await getSettings();
  await ctx.reply(
    [
      `Заявка #${order.id}`,
      `${order.amountIn} ${order.fromAsset} → ${order.amountOut} ${order.toAsset}`,
      ``,
      await requisitesFor(order, settings),
      ``,
      `После отправки средств нажмите «Я оплатил» — оператор подтвердит поступление и отправит ${order.toAsset}.`,
    ].join('\n'),
    Markup.inlineKeyboard([Markup.button.callback('Я оплатил', `paid:${order.id}`)])
  );
}

module.exports = { wizard, presentExistingOrder };

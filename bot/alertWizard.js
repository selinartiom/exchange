const { Scenes, Markup } = require('telegraf');
const { createPriceAlert } = require('../src/db');

const ASSETS = ['BTC', 'USDT', 'TON'];

const alertWizard = new Scenes.WizardScene(
  'alert-wizard',

  // Шаг 1: выбрать актив
  async (ctx) => {
    await ctx.reply(
      'За каким курсом следить?',
      Markup.inlineKeyboard(
        ASSETS.map((a) => Markup.button.callback(a, `alert_asset:${a}`)),
        { columns: 3 }
      )
    );
    return ctx.wizard.next();
  },

  // Шаг 2: выбрать направление
  async (ctx) => {
    const data = ctx.callbackQuery?.data;
    if (!data?.startsWith('alert_asset:')) {
      await ctx.reply('Пожалуйста, выберите актив кнопкой выше.');
      return;
    }
    await ctx.answerCbQuery();
    const asset = data.split(':')[1];
    ctx.wizard.state.asset = asset;

    await ctx.editMessageText(`Актив: ${asset}`);
    await ctx.reply(
      'Уведомить, когда курс:',
      Markup.inlineKeyboard([
        Markup.button.callback('Поднимется выше', 'alert_dir:above'),
        Markup.button.callback('Опустится ниже', 'alert_dir:below'),
      ])
    );
    return ctx.wizard.next();
  },

  // Шаг 3: запросить целевую цену
  async (ctx) => {
    const data = ctx.callbackQuery?.data;
    if (!data?.startsWith('alert_dir:')) {
      await ctx.reply('Пожалуйста, выберите направление кнопкой выше.');
      return;
    }
    await ctx.answerCbQuery();
    const direction = data.split(':')[1];
    ctx.wizard.state.direction = direction;

    const dirLabel = direction === 'above' ? 'выше' : 'ниже';
    await ctx.editMessageText(`Уведомить, когда курс ${dirLabel}…`);
    await ctx.reply(`Введите целевую цену в MDL (например: 2000000):`);
    return ctx.wizard.next();
  },

  // Шаг 4: сохранить подписку
  async (ctx) => {
    const raw = ctx.message?.text?.replace(',', '.').trim();
    const price = parseFloat(raw);
    if (!raw || isNaN(price) || price <= 0) {
      await ctx.reply('Введите число больше нуля, например: 2000000');
      return;
    }

    const { asset, direction } = ctx.wizard.state;
    const alert = await createPriceAlert({
      telegramId: ctx.from.id,
      asset,
      direction,
      targetPriceMdl: price,
    });

    const dirLabel = direction === 'above' ? 'поднимется выше' : 'опустится ниже';
    await ctx.reply(
      `Готово. Пришлю сообщение, когда курс ${asset} ${dirLabel} ${price} MDL.\n\n` +
        `Посмотреть все подписки — /myalerts (подписка #${alert.id})`
    );
    return ctx.scene.leave();
  }
);

module.exports = { alertWizard };

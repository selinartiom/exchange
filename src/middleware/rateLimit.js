const rateLimit = require('express-rate-limit');

// Общий, довольно щедрый лимит на чтение (курсы, котировка) — защита от
// примитивного скрапинга/DoS, не мешает нормальному использованию калькулятора.
const readLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: parseInt(process.env.RATE_LIMIT_READ_PER_MINUTE || '60', 10),
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Слишком много запросов, попробуйте обновить страницу через минуту' },
});

// Создание заявки — дороже для оператора (реальная сумма, реквизиты),
// лимит жёстче: не более 5 заявок в 10 минут с одного IP.
const createOrderLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  limit: parseInt(process.env.RATE_LIMIT_ORDERS_PER_10_MINUTES || '5', 10),
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Слишком много заявок подряд. Подождите пару минут или напишите оператору.' },
});

// Логин в админку и вход в кабинет — защита от подбора пароля / брутфорса.
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Слишком много попыток входа. Попробуйте через 15 минут.' },
});

module.exports = { readLimiter, createOrderLimiter, authLimiter };

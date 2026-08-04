const { Pool } = require('pg');

/**
 * NB: здесь намеренно нет проверки на отсутствие DATABASE_URL с process.exit —
 * это ломало бы любой код (включая тесты), который лишь транзитивно требует
 * db.js, даже не обращаясь к БД. Явная проверка с понятным сообщением и
 * жёстким выходом — в src/server.js и bot/bot.js, в точках входа приложения.
 */
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  // Для управляемых БД (RDS, DO, Timeweb и т.п.) обычно нужен SSL — включайте через .env при необходимости
  ssl: process.env.DATABASE_SSL === 'true' ? { rejectUnauthorized: false } : false,
  max: 10,
});

pool.on('error', (err) => {
  console.error('Неожиданная ошибка соединения с PostgreSQL:', err.message);
});

module.exports = pool;

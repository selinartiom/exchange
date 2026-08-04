require('dotenv').config();

if (!process.env.DATABASE_URL) {
  console.error(
    'DATABASE_URL не задан. Пример: postgresql://nexchange:пароль@адрес-сервера-бд:5432/nexchange\n' +
      'Если БД на отдельном сервере — используйте её IP/домен, не localhost.'
  );
  process.exit(1);
}

const express = require('express');
const session = require('express-session');
const cors = require('cors');
const helmet = require('helmet');
const path = require('path');

const apiRouter = require('./routes/api');
const adminRouter = require('./routes/admin');
const clientRouter = require('./routes/client');
const { startExpiryWorker } = require('./expiryWorker');
const { startBlockchainWatcher } = require('./blockchainWatcher');
const { startPriceAlertWorker } = require('./priceAlertWorker');
const { ensureCsrfToken } = require('./middleware/csrf');
const { ensureBootstrapAdmin } = require('./db');

if (!process.env.ADMIN_PASSWORD_HASH || process.env.ADMIN_PASSWORD_HASH.includes('replace-with')) {
  console.warn(
    '⚠️  ADMIN_PASSWORD_HASH не настроен. Выполните: npm run hash-password -- "ваш-пароль" и вставьте хэш в .env'
  );
}

// Разовая миграция: если в БД ещё нет ни одного админа, а в .env заданы
// ADMIN_USERNAME/ADMIN_PASSWORD_HASH — создаём владельца автоматически.
// Дальше админов можно заводить через саму админку (Настройки → Админы).
ensureBootstrapAdmin(process.env.ADMIN_USERNAME, process.env.ADMIN_PASSWORD_HASH).catch((err) =>
  console.error('Не удалось создать стартового админа:', err.message)
);

const app = express();

// Если сервер стоит за nginx/Caddy — включите TRUST_PROXY=true в .env,
// иначе rate limiting будет считать все запросы с одного IP (адреса прокси).
if (process.env.TRUST_PROXY === 'true') {
  app.set('trust proxy', 1);
}

app.use(
  helmet({
    // Сайт использует инлайн-скрипты в public/*.html — строгий CSP их сломает.
    // Остальные защитные заголовки (X-Frame-Options, X-Content-Type-Options,
    // HSTS и т.д.) helmet включает по умолчанию.
    contentSecurityPolicy: false,
  })
);
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(
  session({
    secret: process.env.SESSION_SECRET || 'insecure-dev-secret',
    resave: false,
    saveUninitialized: false,
    cookie: { maxAge: 30 * 24 * 60 * 60 * 1000 }, // 30 дней — сессией пользуются и клиенты кабинета
  })
);
app.use(ensureCsrfToken);

// Фронтенд один раз забирает токен и кладёт его в заголовок X-CSRF-Token
// на все изменяющие запросы (см. requireCsrf в routes/admin.js, api.js, client.js)
app.get('/api/csrf-token', (req, res) => {
  res.json({ csrfToken: req.session.csrfToken });
});

app.use('/api', apiRouter);
app.use('/api/auth', clientRouter);
app.use('/admin', adminRouter);

// Публичный сайт — статика из /public (index.html и т.д.)
app.use(express.static(path.join(__dirname, '..', 'public')));

app.listen(process.env.PORT || 3000, () => {
  console.log(`NexChange.md запущен: http://localhost:${process.env.PORT || 3000}`);
  console.log(`Админка: http://localhost:${process.env.PORT || 3000}/admin`);
});

startExpiryWorker();
startBlockchainWatcher();
startPriceAlertWorker();
